/**
 * Does the circuit make sense, before anyone orders a board? Each known chip's pins, limits and
 * required parts around it come from its datasheet; this reads the design's nets and judges them.
 * It knows nothing about how the board was routed. A chip it has no datasheet for is named as not
 * covered, never passed. Passing means the wiring and the arithmetic hold, not that a motor turned.
 */
export const PCB_ERC = String.raw`
# ---- electrical check: the design's nets against the parts' datasheets ------------------------
def _value(text):
    # "4k7" 4700, "7k15" 7150, "100n" 1e-7, "5m" 0.005, "10" 10; the first number in the text.
    m = re.match(r"\s*(\d+(?:\.\d+)?)([pnumkKMR]?)(\d*)", str(text or ""))
    if not m: return None
    scale = {"p": 1e-12, "n": 1e-9, "u": 1e-6, "m": 1e-3, "k": 1e3, "K": 1e3, "M": 1e6, "R": 1.0, "": 1.0}[m.group(2)]
    return float(m.group(1) + ("." + m.group(3) if m.group(3) else "")) * scale
def _rating(text):
    m = re.search(r"(\d+(?:\.\d+)?)\s*V\b", str(text or ""))
    return float(m.group(1)) if m else None
def _is(p, *kinds): return re.match(r"(%s)" % "|".join(kinds), p.fp.upper()) is not None

ERC_PASSED = []; ERC_FAILED = []; ERC_UNCOVERED = []; ERC_NOTES = []
def _ok(rule, text): ERC_PASSED.append({"rule": rule, "detail": text})
def _bad(rule, text): ERC_FAILED.append({"rule": rule, "detail": text})
def _judge(cond, rule, good, wrong):
    if cond: _ok(rule, good)
    else: _bad(rule, wrong)
    return cond

def _net_of(ref, pin):
    i = pin_net.get("%s.%s" % (ref, pin))
    return nets[i]["name"] if i is not None else None
def _pins(name):
    for n in nets:
        if n["name"] == name: return n["pins"]
    return []
def _parts_on(name):
    return [(refs[a.split(".", 1)[0]], a.split(".", 1)[1]) for a in _pins(name)]
def _two(p):
    # The nets of a two-pad part, in pad order.
    return _net_of(p.ref, "1"), _net_of(p.ref, "2")
def _between(a, b, *kinds):
    # Two-pad parts of these kinds with one end on each net.
    return [p for p in parts if len(p.pads) == 2 and _is(p, *kinds) and {*_two(p)} == {a, b}]
def _through_r(name):
    # A net and whatever a single series resistor on it leads to.
    out = {name}
    for p, _ in _parts_on(name):
        if _is(p, "R0", "R1") and len(p.pads) == 2:
            for other in _two(p):
                if other: out.add(other)
    return out

GROUND = next((n["name"] for n in nets if n["name"].upper() in ("GND", "VSS", "0V")), None)
RAILS = dict(P.get("rails") or {})
if GROUND: RAILS[GROUND] = 0.0

CHIPS = {
    "IR2104": {"1": "VCC", "2": "IN", "3": "SD", "4": "COM", "5": "LO", "6": "VS", "7": "HO", "8": "VB"},
    "MP1584": {"1": "SW", "2": "EN", "3": "COMP", "4": "FB", "5": "GND", "6": "FREQ", "7": "VIN", "8": "BST"},
    "AMS1117": {"1": "GND", "2": "OUT", "3": "IN"},
    "LM358": {"1": "OUT1", "2": "IN1-", "3": "IN1+", "4": "GND", "5": "IN2+", "6": "IN2-", "7": "OUT2", "8": "V+"},
    "NE555": {"1": "GND", "2": "TRIG", "3": "OUT", "4": "RESET", "5": "CV", "6": "THR", "7": "DIS", "8": "VCC"},
    "ATMEGA1284": {"1": "MOSI", "2": "MISO", "3": "SCK", "4": "RESET", "5": "VCC", "6": "GND", "7": "XTAL2", "8": "XTAL1", "17": "VCC", "18": "GND", "27": "AVCC", "28": "GND", "29": "AREF", "38": "VCC", "39": "GND"},
}
MCU_PWM = {"43": "OC0A", "44": "OC0B", "14": "OC1A", "13": "OC1B", "16": "OC2A", "15": "OC2B"}
MCU_ADC = {str(37 - k): "ADC%d" % k for k in range(8)}
FETS = {"BSC060N10": 100.0}
def _chip(p):
    v = (p.value or "").upper()
    return next((k for k in CHIPS if v.startswith(k)), None)
def _function(chip, ref, name):
    return [k for k, f in CHIPS[chip].items() if f == name]
def _on(ref, chip, name):
    k = _function(chip, ref, name)
    return _net_of(ref, k[0]) if k else None

# Regulators first: what they make is a rail the others are judged against.
for p in parts:
    if _chip(p) == "MP1584":
        fb, sw = _on(p.ref, "MP1584", "FB"), _on(p.ref, "MP1584", "SW")
        coil = next((c for c, _ in _parts_on(sw) if _is(c, "L")), None) if sw else None
        out = next((n for n in _two(coil) if n != sw), None) if coil else None
        top = _between(out, fb, "R") if out and fb else []
        bottom = _between(fb, GROUND, "R") if fb else []
        if top and bottom and _value(top[0].value) and _value(bottom[0].value):
            RAILS[out] = round(0.8 * (1 + _value(top[0].value) / _value(bottom[0].value)), 2)
    if _chip(p) == "AMS1117":
        m = re.search(r"-(\d+(?:\.\d+)?)", p.value or "")
        if m and _on(p.ref, "AMS1117", "OUT"): RAILS[_on(p.ref, "AMS1117", "OUT")] = float(m.group(1))

for p in parts:
    chip = _chip(p)
    if chip:
        for pin, name in CHIPS[chip].items():
            _judge(_net_of(p.ref, pin) is not None, "%s %s connected" % (p.ref, name), "%s pin %s (%s) is connected" % (p.ref, pin, name), "%s pin %s (%s) is not connected to anything" % (p.ref, pin, name))
    elif _is(p, "SOIC", "TSSOP", "TQFP", "SOT23", "SOT223", "DIP", "PQFN") and (p.value or "").upper() not in FETS:
        ERC_UNCOVERED.append("%s (%s)" % (p.ref, p.value or p.fp))

for n in nets:
    if len(n["pins"]) == 1:
        ref, pin = n["pins"][0].split(".", 1)
        if not _is(refs[ref], "PAD_TH", "TESTPOINT", "HEADER", "JST"):
            ERC_NOTES.append("Net %s reaches only %s.%s" % (n["name"], ref, pin))

def _rail_between(rule, net, low, high, who):
    v = RAILS.get(net)
    if v is None: _bad(rule, "%s: nothing says what voltage net %s carries" % (who, net)); return
    _judge(low <= v <= high, rule, "%s runs from %s at %g V (allowed %g to %g V)" % (who, net, v, low, high), "%s runs from %s at %g V, outside %g to %g V" % (who, net, v, low, high))
def _decoupled(p, net):
    near = [c for c in _between(net, GROUND, "C") if abs(c.x - p.x) + abs(c.y - p.y) <= 15]
    _judge(bool(near), "%s decoupling" % p.ref, "%s has %s on %s within 15 mm" % (p.ref, near[0].ref if near else "", net), "%s has no capacitor from %s to ground within 15 mm" % (p.ref, net))

for p in parts:
    chip = _chip(p)
    if chip == "MP1584":
        vin, sw, bst, en, fb, gnd, freq, comp = [_on(p.ref, chip, k) for k in ("VIN", "SW", "BST", "EN", "FB", "GND", "FREQ", "COMP")]
        _rail_between("%s input" % p.ref, vin, 4.5, 28, p.ref)
        _judge(gnd == GROUND, "%s ground" % p.ref, "%s GND is on ground" % p.ref, "%s GND is on %s" % (p.ref, gnd))
        _judge(bool(_between(bst, sw, "C")), "%s bootstrap" % p.ref, "%s has its capacitor from BST to SW" % p.ref, "%s has no capacitor from BST to SW" % p.ref)
        catch = [d for d in _between(sw, GROUND, "D0", "D1", "SOD") if _net_of(d.ref, "1") == sw]
        _judge(bool(catch), "%s catch diode" % p.ref, "%s has a catch diode, cathode on SW" % p.ref, "%s needs a diode from ground to SW, cathode on SW (pad 1)" % p.ref)
        _judge(any(c for c, _ in _parts_on(sw) if _is(c, "L")), "%s inductor" % p.ref, "%s has an inductor on SW" % p.ref, "%s has no inductor on SW" % p.ref)
        _judge(bool(_between(en, vin, "R")), "%s enable" % p.ref, "%s EN goes to VIN through a resistor" % p.ref, "%s EN must go to VIN through a resistor (or be driven)" % p.ref)
        _judge(bool(_between(freq, GROUND, "R")), "%s frequency" % p.ref, "%s FREQ has its resistor to ground" % p.ref, "%s FREQ needs a resistor to ground" % p.ref)
        _judge(any(c for c, _ in _parts_on(comp) if _is(c, "R", "C0", "C1")), "%s compensation" % p.ref, "%s COMP has its network" % p.ref, "%s COMP needs a compensation network" % p.ref)
        _decoupled(p, vin)
    elif chip == "AMS1117":
        vin, out, gnd = [_on(p.ref, chip, k) for k in ("IN", "OUT", "GND")]
        vout = RAILS.get(out, 0)
        _rail_between("%s input" % p.ref, vin, vout + 1.3, 15, p.ref)
        _judge(gnd == GROUND, "%s ground" % p.ref, "%s GND is on ground" % p.ref, "%s GND is on %s" % (p.ref, gnd))
        _judge(bool(_between(out, GROUND, "C")), "%s output capacitor" % p.ref, "%s output has its capacitor" % p.ref, "%s output needs a capacitor" % p.ref)
        _decoupled(p, vin)
    elif chip == "IR2104":
        vcc, ins, sd, com, lo, vs, ho, vb = [_on(p.ref, chip, k) for k in ("VCC", "IN", "SD", "COM", "LO", "VS", "HO", "VB")]
        _rail_between("%s supply" % p.ref, vcc, 10, 20, p.ref)
        _judge(com == GROUND, "%s ground" % p.ref, "%s COM is on ground" % p.ref, "%s COM is on %s" % (p.ref, com))
        _judge(bool(_between(vb, vs, "C")), "%s bootstrap capacitor" % p.ref, "%s has its capacitor from VB to VS" % p.ref, "%s needs a capacitor from VB to VS" % p.ref)
        boot = [d for d in _between(vb, vcc, "D0", "D1", "SOD") if _net_of(d.ref, "1") == vb]
        _judge(bool(boot), "%s bootstrap diode" % p.ref, "%s bootstrap diode points from VCC to VB" % p.ref, "%s needs a diode from VCC to VB, cathode on VB (pad 1)" % p.ref)
        _decoupled(p, vcc)
        def gate_of(net):
            return next((f for f in parts if (f.value or "").upper() in FETS and _net_of(f.ref, "4") in _through_r(net)), None)
        hi, low = gate_of(ho), gate_of(lo)
        if _judge(hi is not None, "%s high side" % p.ref, "%s HO drives %s" % (p.ref, hi.ref if hi else ""), "%s HO reaches no MOSFET gate" % p.ref):
            _judge(_net_of(hi.ref, "1") == vs, "%s high side source" % p.ref, "%s source is on VS (%s)" % (hi.ref, vs), "%s source is on %s, not VS (%s)" % (hi.ref, _net_of(hi.ref, "1"), vs))
            rail = RAILS.get(_net_of(hi.ref, "5")); rated = FETS[hi.value.upper()]
            if rail is not None: _judge(rail <= 0.8 * rated, "%s voltage" % hi.ref, "%s sees %g V of its %g V" % (hi.ref, rail, rated), "%s sees %g V, over 80%% of its %g V" % (hi.ref, rail, rated))
        if _judge(low is not None, "%s low side" % p.ref, "%s LO drives %s" % (p.ref, low.ref if low else ""), "%s LO reaches no MOSFET gate" % p.ref):
            _judge(_net_of(low.ref, "5") == vs, "%s low side drain" % p.ref, "%s drain is on VS (%s)" % (low.ref, vs), "%s drain is on %s, not VS (%s)" % (low.ref, _net_of(low.ref, "5"), vs))
        for name, net in (("IN", ins), ("SD", sd)):
            _judge(bool(_between(net, GROUND, "R")), "%s %s default" % (p.ref, name), "%s %s stays low until driven" % (p.ref, name), "%s %s floats when nothing drives it: add a resistor to ground" % (p.ref, name))
    elif chip == "LM358":
        vp, gnd = _on(p.ref, chip, "V+"), _on(p.ref, chip, "GND")
        _rail_between("%s supply" % p.ref, vp, 3, 32, p.ref)
        _judge(gnd == GROUND, "%s ground" % p.ref, "%s GND is on ground" % p.ref, "%s GND is on %s" % (p.ref, gnd))
        _decoupled(p, vp)
        for ch in ("1", "2"):
            plus, minus, out = [_on(p.ref, chip, k) for k in ("IN%s+" % ch, "IN%s-" % ch, "OUT%s" % ch)]
            who = "%s channel %s" % (p.ref, ch)
            if minus == out and plus: _ok(who, "%s is a follower" % who); continue
            fb, down = _between(minus, out, "R") if minus and out else [], _between(minus, GROUND, "R") if minus else []
            ok_ = _judge(bool(fb), "%s feedback" % who, "%s has feedback from its output" % who, "%s has no feedback resistor from output to minus input" % who)
            if ok_ and down and plus != GROUND:
                gain = 1 + _value(fb[0].value) / _value(down[0].value)
                _ok("%s gain" % who, "%s is non-inverting with gain %.0f" % (who, gain))
                shunt = [r for r, _ in _parts_on(plus) if _is(r, "R2512")]
                if shunt and RAILS.get(vp) is not None:
                    span = (RAILS[vp] - 1.5) / gain / _value(shunt[0].value)
                    _judge(span >= 5, "%s range" % who, "%s reads up to %.1f A on %s" % (who, span, shunt[0].ref), "%s saturates at %.1f A on %s" % (who, span, shunt[0].ref))
            elif ok_ and plus == GROUND:
                _bad("%s single supply" % who, "%s has its plus input on ground: with one supply it can only drive to 0 V" % who)
    elif chip == "ATMEGA1284":
        supply = [_net_of(p.ref, k) for k in _function(chip, p.ref, "VCC")] + [_on(p.ref, chip, "AVCC")]
        _judge(len(set(supply)) == 1, "%s supply pins" % p.ref, "%s has all VCC pins and AVCC on %s" % (p.ref, supply[0]), "%s has its VCC pins on different nets: %s" % (p.ref, sorted(set(str(s) for s in supply))))
        _rail_between("%s supply" % p.ref, supply[0], 1.8, 5.5, p.ref)
        grounds = {_net_of(p.ref, k) for k in _function(chip, p.ref, "GND")}
        _judge(grounds == {GROUND}, "%s ground" % p.ref, "%s has every GND pin on ground" % p.ref, "%s GND pins are on %s" % (p.ref, sorted(str(g) for g in grounds)))
        _decoupled(p, supply[0])
        _judge(bool(_between(_on(p.ref, chip, "AREF"), GROUND, "C")), "%s AREF" % p.ref, "%s AREF has its capacitor" % p.ref, "%s AREF needs a capacitor to ground" % p.ref)
        reset = _on(p.ref, chip, "RESET")
        _judge(bool(_between(reset, supply[0], "R")), "%s reset" % p.ref, "%s RESET is pulled up" % p.ref, "%s RESET needs a pull-up" % p.ref)
        x1, x2 = _on(p.ref, chip, "XTAL1"), _on(p.ref, chip, "XTAL2")
        xtal = next((c for c, _ in _parts_on(x1) if _is(c, "XTAL")), None) if x1 else None
        if _judge(xtal is not None and x2 in [_net_of(xtal.ref, k) for k, *_ in xtal.pads], "%s crystal" % p.ref, "%s has a crystal across XTAL1 and XTAL2" % p.ref, "%s needs a crystal across XTAL1 and XTAL2" % p.ref):
            mhz = (_value(xtal.value) or 0) / 1e6; v = RAILS.get(supply[0], 0)
            limit = 4 + (v - 1.8) / 0.9 * 6 if v <= 2.7 else min(20, 10 + (v - 2.7) / 1.8 * 10)
            _judge(mhz <= limit, "%s clock" % p.ref, "%g MHz is within %.1f MHz at %g V" % (mhz, limit, v), "%g MHz is over the %.1f MHz this chip allows at %g V" % (mhz, limit, v))
            _judge(bool(_between(x1, GROUND, "C")) and bool(_between(x2, GROUND, "C")), "%s load capacitors" % p.ref, "%s crystal has both load capacitors" % p.ref, "%s crystal needs a load capacitor on each side" % p.ref)
        # Signals the chip must make or read on particular pins.
        for d in parts:
            if _chip(d) == "IR2104":
                pin = next((a.split(".", 1)[1] for a in _pins(_on(d.ref, "IR2104", "IN")) if a.startswith(p.ref + ".")), None)
                _judge(pin in MCU_PWM, "%s PWM" % d.ref, "%s IN comes from %s pin %s (%s)" % (d.ref, p.ref, pin, MCU_PWM.get(pin)), "%s IN comes from %s pin %s, which has no PWM output" % (d.ref, p.ref, pin))
                pin = next((a.split(".", 1)[1] for a in _pins(_on(d.ref, "IR2104", "SD")) if a.startswith(p.ref + ".")), None)
                _judge(pin is not None, "%s shutdown" % d.ref, "%s SD comes from %s pin %s" % (d.ref, p.ref, pin), "%s SD is not driven by %s" % (d.ref, p.ref))
            if _chip(d) == "LM358":
                for ch in ("1", "2"):
                    out = _on(d.ref, "LM358", "OUT%s" % ch)
                    pin = next((a.split(".", 1)[1] for a in _pins(out) if a.startswith(p.ref + ".")), None) if out else None
                    if pin is not None: _judge(pin in MCU_ADC, "%s reading" % d.ref, "%s output %s reaches %s" % (d.ref, ch, MCU_ADC.get(pin)), "%s output %s reaches %s pin %s, which has no ADC" % (d.ref, ch, p.ref, pin))
        for name in ("MOSI", "MISO", "SCK"):
            net = _on(p.ref, chip, name)
            if net and any(a.split(".", 1)[0].startswith("J") for a in _pins(net)): _ok("%s %s" % (p.ref, name), "%s pin %s reaches the connector" % (p.ref, name))
    elif chip == "NE555":
        vcc, gnd, rst = [_on(p.ref, chip, k) for k in ("VCC", "GND", "RESET")]
        _judge(gnd == GROUND, "%s ground" % p.ref, "%s GND is on ground" % p.ref, "%s GND is on %s" % (p.ref, gnd))
        _judge(rst == vcc, "%s reset" % p.ref, "%s RESET is held high" % p.ref, "%s RESET is on %s, not VCC" % (p.ref, rst))

for p in parts:
    if _is(p, "LED") and len(p.pads) == 2:
        k, a = _two(p)
        if k is None or a is None: continue
        if GROUND and GROUND in (k, a):
            if not _judge(k == GROUND, "%s polarity" % p.ref, "%s cathode (pad 1) is on ground" % p.ref, "%s has its anode on ground; pad 1 is the cathode" % p.ref): continue
            r = next((x for x, _ in _parts_on(a) if _is(x, "R")), None)
            if _judge(r is not None, "%s resistor" % p.ref, "%s has a series resistor" % p.ref, "%s has no series resistor" % p.ref):
                drive = RAILS.get(next((n for n in _two(r) if n != a), None))
                if drive is None:
                    drive = max((RAILS.get(_net_of(q.ref, "5"), 0) for q in parts if _chip(q) == "ATMEGA1284"), default=0) or next((v for n, v in RAILS.items() if v and v <= 5.5), None)
                if drive and _value(r.value):
                    ma = (drive - 2.0) / _value(r.value) * 1000
                    _judge(ma <= 20, "%s current" % p.ref, "%s draws %.1f mA" % (p.ref, ma), "%s draws %.1f mA, more than a pin can give" % (p.ref, ma))
    if _is(p, "CAPE") and len(p.pads) == 2:
        plus, minus = _two(p)
        vp, vm = RAILS.get(plus), RAILS.get(minus)
        if vp is not None and vm is not None:
            _judge(vp >= vm, "%s polarity" % p.ref, "%s plus (pad 1) is on %s" % (p.ref, plus), "%s has its plus (pad 1) on the lower side" % p.ref)
            rated = _rating(p.value)
            if rated: _judge(abs(vp - vm) <= 0.8 * rated, "%s voltage" % p.ref, "%s sees %g V of its %g V" % (p.ref, abs(vp - vm), rated), "%s sees %g V, over 80%% of its %g V" % (p.ref, abs(vp - vm), rated))

_covered = bool(ERC_PASSED or ERC_FAILED)
ELECTRICAL = {"rules_passed": len(ERC_PASSED), "failed": ERC_FAILED, "not_covered": ERC_UNCOVERED, "notes": ERC_NOTES, "rails": RAILS, "covered": _covered, "passed": _covered and not ERC_FAILED}
# Text, not a table: a .csv here would count as a data result, and this is a report for the person.
with open("/output/electrical_check.txt", "w") as _f:
    _f.write("Electrical check against the parts' datasheets. Wiring and arithmetic, not a bench test.\n\n")
    for r in ERC_FAILED: _f.write("FAILED  %s\n" % r["detail"])
    for r in ERC_PASSED: _f.write("passed  %s\n" % r["detail"])
    for u in ERC_UNCOVERED: _f.write("not covered  %s: no datasheet rules for this part\n" % u)
    for n in ERC_NOTES: _f.write("note  %s\n" % n)
`;
