/**
 * Does the circuit on the board turn a motor? A SPICE run of the design's own nets, on the bot's
 * computer: every resistor, capacitor, inductor, diode and MOSFET the design names goes in with the
 * net its pads are on, so a wrong connection in the design is a wrong connection here. The chips are
 * behavioural models (they do what their datasheets say on the pins the design connected), and a
 * model of a 24 V motor with its rotor physics hangs on the phase and hall nets. KiCad's own libngspice
 * does the sums. It says nothing about the layout's stray effects, heat, or real parts on a bench.
 */

export const MOTOR_SIM = String.raw`#!/usr/bin/env python3
# Simulates the board's own netlist driving a motor, with KiCad's ngspice. Usage: simulate_motor.py design.json out_dir
import ctypes, glob, json, math, re, sys

design = json.load(open(sys.argv[1])); out = sys.argv[2]
PWM_HZ, DUTY, STOP = 20000.0, 0.55, 0.06
parts = {p["ref"]: p for p in design["parts"]}
pad_net = {}
for n in design["nets"]:
    for pin in n["pins"]: pad_net[pin] = n["name"]
serial = {}
def node(ref, pin):
    # A pad on no net is its own node: it floats, as it would on the board.
    name = pad_net.get("%s.%s" % (ref, pin))
    if name is None: name = serial.setdefault("%s.%s" % (ref, pin), "nc_%s_%s" % (ref, pin))
    return "0" if name == "GND" else "n_" + re.sub(r"\W", "_", name)
def value(text):
    m = re.match(r"\s*(\d+(?:\.\d+)?)([pnumkKMR]?)(\d*)", text or "")
    if not m: return None
    return float(m.group(1) + ("." + m.group(3) if m.group(3) else "")) * {"p": 1e-12, "n": 1e-9, "u": 1e-6, "m": 1e-3, "k": 1e3, "K": 1e3, "M": 1e6, "R": 1.0, "": 1.0}[m.group(2)]

deck = ["* board netlist, motor and chip models",
        ".func clip(x,a,b) {max(a,min(x,b))}",
        ".model DSW D(Is=1e-9 N=1.2 Rs=0.05 BV=100 Cjo=10p Tt=5n)",
        ".model DLED D(Is=1e-18 N=2 Rs=5)",
        ".model SWFET SW(Vt=3.0 Vh=0.5 Ron=0.006 Roff=1e6)",
        ".option method=gear reltol=0.01 abstol=1e-4 vntol=1e-3 chgtol=1e-12 itl4=100 rshunt=1e9",
        "Vsupply supply 0 PULSE(0 %g 0 2m)" % float((design.get("rails") or {}).get("VM", 24)), "R_supply supply n_VM 0.05"]
drivers = []; amps = []; mcu = None; buck = None; reg = None
for ref, p in parts.items():
    fp = p["footprint"].upper(); val = (p.get("value") or "").upper()
    if re.match(r"(R0|R1|R2)", fp) and value(p.get("value")): deck.append("R%s %s %s %g" % (ref, node(ref, 1), node(ref, 2), value(p["value"])))
    elif re.match(r"(C0|C1|CAPE)", fp) and value(p.get("value")): deck.append("C%s %s %s %g ic=0" % (ref, node(ref, 1), node(ref, 2), value(p["value"])))
    elif re.match(r"L", fp) and value(p.get("value")) and not fp.startswith("LED"): deck.append("L%s %s %s %g ic=0" % (ref, node(ref, 1), node(ref, 2), value(p["value"])))
    elif fp.startswith("LED"): deck.append("D%s %s %s DLED" % (ref, node(ref, 2), node(ref, 1)))
    elif fp.startswith("SOD"): deck.append("D%s %s %s DSW" % (ref, node(ref, 2), node(ref, 1)))
    elif val.startswith("BSC"):
        s, g, d = node(ref, 1), node(ref, 4), node(ref, 5)
        for pin in (2, 3):
            if node(ref, pin) != s: deck.append("R%s_%d %s %s 1" % (ref, pin, node(ref, pin), s))
        deck += ["S%s %s %s %s %s SWFET" % (ref, d, s, g, s), "D%s_body %s %s DSW" % (ref, s, d), "R%s_g %s %s 1e6" % (ref, g, s), "C%s_g %s %s 3n ic=0" % (ref, g, s), "C%s_ds %s %s 1n ic=0" % (ref, d, s), "R%s_ds %s %s 1e5" % (ref, d, s)]
    elif val.startswith("IR2104"): drivers.append(ref)
    elif val.startswith("LM358"): amps.append(ref)
    elif val.startswith("ATMEGA"): mcu = ref
    elif val.startswith("MP1584"): buck = ref
    elif val.startswith("AMS1117"): reg = ref

# The chips: what each datasheet promises on the pins the design used.
for ref in drivers:
    vcc, ins, sd, com, lo, vs, ho, vb = [node(ref, k) for k in range(1, 9)]
    a = "x" + ref
    deck += [
        # Dead time: each output waits for the delayed input, so the two are never on together.
        "B%s_d %s_d 0 V=V(%s)-V(%s)" % (ref, a, ins, com), "R%s_d %s_d %s_e 1k" % (ref, a, a), "C%s_d %s_e 0 500p ic=0" % (ref, a),
        "B%s_on %s_on 0 V=(V(%s)-V(%s)>1.6 && V(%s)-V(%s)>9.1) ? 1 : 0" % (ref, a, sd, com, vcc, com),
        # The logic edges are softened a little, as real ones are, or the solver stalls on them.
        "B%s_hl %s_hl 0 V=(V(%s_on)>0.5 && V(%s_d)>1.6 && V(%s_e)>1.6) ? 1 : 0" % (ref, a, a, a, a), "R%s_hl %s_hl %s_hs 1k" % (ref, a, a), "C%s_hl %s_hs 0 20p ic=0" % (ref, a),
        "B%s_ho %s_h %s V=V(%s_hs)*max(V(%s)-V(%s),0)" % (ref, a, vs, a, vb, vs), "R%s_ho %s_h %s 15" % (ref, a, ho),
        "B%s_ll %s_ll 0 V=(V(%s_on)>0.5 && V(%s_d)<1.6 && V(%s_e)<1.6) ? 1 : 0" % (ref, a, a, a, a), "R%s_ll %s_ll %s_ls 1k" % (ref, a, a), "C%s_ll %s_ls 0 20p ic=0" % (ref, a),
        "B%s_lo %s_l %s V=V(%s_ls)*max(V(%s)-V(%s),0)" % (ref, a, com, a, vcc, com), "R%s_lo %s_l %s 15" % (ref, a, lo),
        "R%s_q %s %s 12k" % (ref, vcc, com), "R%s_b %s %s 40k" % (ref, vb, vs),
    ]
if buck:
    # Averaged over its 1 MHz switching: the error amplifier sets SW so that FB sits at 0.8 V.
    sw, en, comp, fb, gnd, freq, vin, bst = [node(buck, k) for k in range(1, 9)]
    deck += [
        "B%s_on x%s_on 0 V=(V(%s)>1.2 && V(%s)>4.5) ? 1 : 0" % (buck, buck, en, vin),
        "B%s_ea 0 x%s_c I=2e-4*clip(0.8-V(%s),-1,1)" % (buck, buck, fb), "C%s_c x%s_c 0 22n ic=0" % (buck, buck), "R%s_c x%s_c 0 1e6" % (buck, buck),
        "B%s_sw x%s_s 0 V=V(x%s_on)*clip(5*V(x%s_c),0,V(%s))" % (buck, buck, buck, buck, vin), "V%s_i x%s_s x%s_t 0" % (buck, buck, buck), "R%s_sw x%s_t %s 0.15" % (buck, buck, sw),
        # What it hands on it draws from VIN, so a VIN that is not really connected collapses.
        "B%s_in %s 0 I=V(x%s_s)*max(i(V%s_i),0)/max(V(%s),1)" % (buck, vin, buck, buck, vin),
        "R%s_i %s %s 100k" % (buck, vin, gnd if gnd != "0" else "0"), "R%s_f %s 0 1e7" % (buck, fb),
    ]
if reg:
    gnd, vout, vin = [node(reg, k) for k in (1, 2, 3)]
    deck += ["B%s_o x%s_o 0 V=clip(V(%s)-1.2,0,3.3)" % (reg, reg, vin), "R%s_o x%s_o %s 0.2" % (reg, reg, vout)]
for ref in amps:
    o1, m1, p1, g, p2, m2, o2, v = [node(ref, k) for k in range(1, 9)]
    for ch, (o, m, q) in enumerate(((o1, m1, p1), (o2, m2, p2))):
        # Gain 1000 with a pole at 1 kHz: about the 1 MHz of the real part, and stable in its loop.
        deck += ["B%s_%d x%s_%d 0 V=clip(1000*(V(%s)-V(%s)),0,max(V(%s)-1.5,0))" % (ref, ch, ref, ch, q, m, v), "R%s_%da x%s_%d x%s_%db 1k" % (ref, ch, ref, ch, ref, ch), "C%s_%d x%s_%db 0 160n ic=0" % (ref, ch, ref, ch), "E%s_%d x%s_%dc 0 x%s_%db 0 1" % (ref, ch, ref, ch, ref, ch), "R%s_%d x%s_%dc %s 100" % (ref, ch, ref, ch, o)]

# The rotor: position, speed, three phases in star with their back-EMF and the hall sensors.
R, L_, KE, J, LOAD = 0.4, 200e-6, 0.018, 4e-6, 0.01     # per phase; V*s/rad, kg*m2, N*m; two pole pairs
POLES = 2
for k, ph in enumerate("ABC"):
    deck += ["R_m%s n_PH_%s m%s_a %g" % (ph, ph, ph, R), "L_m%s m%s_a m%s_b %g ic=0" % (ph, ph, ph, L_),
             "B_m%s m%s_b star V=%g*V(speed)*clip(1.5*cos(%d*V(theta)-%g),-1,1)" % (ph, ph, KE, POLES, k * 2.0943951)]
deck += ["R_star star 0 1e6",
         # Torque from the three currents; speed and angle as voltages across capacitors.
         "B_torque 0 speed I=(%g*(i(L_mA)*clip(1.5*cos(%d*V(theta)),-1,1)+i(L_mB)*clip(1.5*cos(%d*V(theta)-2.0943951),-1,1)+i(L_mC)*clip(1.5*cos(%d*V(theta)-4.1887902),-1,1))-%g*(V(speed)>0.5?1:0)-1e-6*V(speed))" % (KE, POLES, POLES, POLES, LOAD),
         "C_speed speed 0 %g ic=0" % J, "R_speed speed 0 1e7",
         "B_theta 0 theta I=V(speed)", "C_theta theta 0 1 ic=0", "R_theta theta 0 1e9"]

# The controller: firmware with a fixed pin map, so a signal on the wrong pin is a motor that does not
# run. Hall sensors sit on the motor connector; everything else goes by the microcontroller's own pins.
FIRMWARE = {"A": {"pwm": 43, "sd": 42, "hall": 34}, "B": {"pwm": 44, "sd": 41, "hall": 33}, "C": {"pwm": 16, "sd": 40, "hall": 32}}
if mcu:
    # Open-collector sensors with the chip's own pull-up, one per phase, 120 degrees apart.
    for k, ph in enumerate("ABC"):
        deck.append("B_hall_%s %s 0 V=sin(%d*V(theta)-%g+1.0472)>0 ? 3.3 : 0" % (ph, node("J1", k + 1), POLES, k * 2.0943951))
    def hall(ph): return "(V(%s)>1.65)" % node(mcu, FIRMWARE[ph]["hall"])
    A, B, C = hall("A"), hall("B"), hall("C")
    # Which phase is high and which low for each hall state, as a table a controller would hold.
    state = {"A": ("(%s && !%s)" % (A, B), "(!%s && %s)" % (A, B)), "B": ("(%s && !%s)" % (B, C), "(!%s && %s)" % (B, C)), "C": ("(%s && !%s)" % (C, A), "(!%s && %s)" % (C, A))}
    deck += ["V_pwm pwm 0 PULSE(0 1 0 100n 100n %g %g)" % (DUTY / PWM_HZ, 1 / PWM_HZ), "R_pwm pwm 0 1e6"]
    for ph in "ABC":
        hi, lo = state[ph]
        deck.append("B_mcu_in%s %s 0 V=(V(time_ok)>0.5 && %s && V(pwm)>0.5) ? 3.3 : 0" % (ph, node(mcu, FIRMWARE[ph]["pwm"]), hi))
        deck.append("B_mcu_sd%s %s 0 V=(V(charge)>0.5 || (V(time_ok)>0.5 && (%s || %s))) ? 3.3 : 0" % (ph, node(mcu, FIRMWARE[ph]["sd"]), hi, lo))
    # First the rails come up, then every low side is on for a moment to charge the bootstraps, as firmware would do.
    deck += ["V_charge charge 0 PULSE(0 1 8m 1u 1u 4m 1)", "V_time time_ok 0 PULSE(0 1 12m 1u 1u 1 2)"]

saves = ["speed", "n_ph_a", "n_12v", "n_3v3", "n_isa", "n_vb_a", "n_gh_a", "n_gl_a", "n_sh_a"] + ["l_ma#branch", "l_mb#branch", "l_mc#branch", "vsupply#branch"]
deck.append(".tran 1u %g 0 0.5u uic" % STOP)
deck.append(".end")
open(out + "/motor_sim.cir", "w").write("\n".join(deck) + "\n")

lib = next(iter(glob.glob("/usr/lib/x86_64-linux-gnu/libngspice.so*") + glob.glob("/usr/lib*/libngspice.so*") + glob.glob("/usr/lib/kicad*/libngspice*")), None)
if not lib: raise SystemExit("KiCad's ngspice library is not on this computer.")
ng = ctypes.CDLL(lib)
said = []
P_ = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p)
S_ = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p)
X_ = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int, ctypes.c_bool, ctypes.c_bool, ctypes.c_int, ctypes.c_void_p)
def on_print(text, i, u):
    said.append(text.decode("utf8", "replace")); return 0
def on_stat(text, i, u): return 0
def on_exit(status, immediate, quitting, i, u): return 0
cbs = (P_(on_print), S_(on_stat), X_(on_exit))
ng.ngSpice_Init(cbs[0], cbs[1], cbs[2], None, None, None, None)
ng.ngSpice_Command.argtypes = [ctypes.c_char_p]
def cmd(text): return ng.ngSpice_Command(text.encode())
cmd("source %s/motor_sim.cir" % out)
cmd("save " + " ".join(saves))
cmd("run")
cmd("wrdata %s/motor_sim.dat " % out + " ".join(saves))
open(out + "/motor_sim.log", "w").write("\n".join(said))

rows = []
for line in open(out + "/motor_sim.dat"):
    f = line.split()
    # wrdata writes the time before each column.
    try: rows.append([float(f[0])] + [float(x) for x in f[1::2]])
    except (ValueError, IndexError): pass
if len(rows) < 100 or rows[-1][0] < STOP * 0.99:
    # The solver gave up partway. That is said as it is; it proves nothing about the board.
    json.dump({"passed": False, "gave_up_at_ms": round(rows[-1][0] * 1000, 1) if rows else 0, "rpm": 0, "peak_current_a": 0, "rail_12v": 0, "rail_3v3": 0, "bootstrap_min_v": 0, "checks": [{"rule": "the solver finishes", "passed": False, "value": " ".join(said[-3:])[:300]}]}, open(out + "/motor_simulation.json", "w"), indent=1)
    raise SystemExit("The simulation stopped early: " + " ".join(said[-3:])[:300])
T = [r[0] for r in rows]; col = {name: [r[i + 1] for r in rows] for i, name in enumerate(saves)}
tail = [i for i, t in enumerate(T) if t >= STOP * 0.8]
mean = lambda xs: sum(xs) / max(1, len(xs))
rpm = mean([col["speed"][i] for i in tail]) * 60 / (2 * math.pi)
ipk = max(abs(x) for k in "ABC" for x in col["l_m%s#branch" % k.lower()])
irms = math.sqrt(mean([col["l_ma#branch"][i] ** 2 for i in tail]))
isup = max(-x for x in col["vsupply#branch"])
v12, v33 = mean([col["n_12v"][i] for i in tail]), mean([col["n_3v3"][i] for i in tail])
boot = min(col["n_vb_a"][i] - col["n_ph_a"][i] for i in tail)
adc = max(col["n_isa"][i] for i in tail)
both = sum(1 for i in range(len(T)) if col["n_gh_a"][i] - col["n_ph_a"][i] > 3 and col["n_gl_a"][i] - col["n_sh_a"][i] > 3)
ideal = DUTY * 24.0 / (2 * KE * 1.0) * 60 / (2 * math.pi)
checks = [
    ("the motor turns the right way and reaches at least half of what the duty allows", rpm > 0.5 * ideal, "%.0f rpm (ideal without losses %.0f)" % (rpm, ideal)),
    ("12 V rail within 5%", abs(v12 - 12) < 0.6, "%.2f V" % v12),
    ("3.3 V rail within 5%", abs(v33 - 3.3) < 0.165, "%.2f V" % v33),
    ("bootstrap keeps the high side above the driver's 8 V minimum", boot > 8, "lowest %.1f V" % boot),
    ("high and low side of a phase are never on together", both == 0, "%d of %d steps with both gates on, peak supply %.1f A" % (both, len(T), isup)),
    ("the current signal reaches the ADC", 0.02 < adc <= 3.3, "up to %.2f V" % adc),
]
failed = [c for c in checks if not c[1]]
# A picture of it: speed and one phase current over time, hand-made so nothing has to be installed.
step = max(1, len(T) // 700)
def line(xs, top, colour, h=150, y0=0):
    pts = " ".join("%.1f,%.1f" % (40 + 660 * T[i] / STOP, y0 + h - h * max(0.0, min(1.0, xs[i] / top))) for i in range(0, len(T), step))
    return '<polyline fill="none" stroke="%s" stroke-width="1.2" points="%s"/>' % (colour, pts)
speed_rpm = [x * 60 / (2 * math.pi) for x in col["speed"]]
top_rpm, top_i = max(max(speed_rpm), 1) * 1.1, max(ipk, 0.1) * 1.1
shifted = [x + top_i for x in col["l_ma#branch"]]
svg = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 390" font-family="sans-serif" font-size="12"><rect width="720" height="390" fill="#fff"/>',
       '<text x="40" y="18">Speed, up to %.0f rpm</text>' % top_rpm, '<g transform="translate(0,24)">', line(speed_rpm, top_rpm, "#2a6"), '</g>',
       '<text x="40" y="200">Phase A current, +/- %.1f A</text>' % top_i, '<g transform="translate(0,206)">', line(shifted, 2 * top_i, "#c52"), '</g>',
       '<text x="40" y="382">0 to %.0f ms. SPICE, chips as behavioural models: not a bench test.</text>' % (STOP * 1000), '</svg>']
open(out + "/motor_simulation.svg", "w").write("\n".join(svg))
result = {"passed": not failed, "rpm": round(rpm), "peak_current_a": round(ipk, 1), "rms_current_a": round(irms, 1), "rail_12v": round(v12, 2), "rail_3v3": round(v33, 2), "bootstrap_min_v": round(boot, 1), "adc_max_v": round(adc, 2), "steps": len(T),
          "checks": [{"rule": c[0], "passed": bool(c[1]), "value": c[2]} for c in checks]}
json.dump(result, open(out + "/motor_simulation.json", "w"), indent=1)
print(json.dumps(result))
`;

/** One line for the chat from what the simulation wrote; what is wrong comes first. */
export function describeMotorSim(raw: string): string {
  const r = JSON.parse(raw) as {
    passed: boolean;
    rpm: number;
    peak_current_a: number;
    rail_12v: number;
    rail_3v3: number;
    bootstrap_min_v: number;
    checks: { rule: string; passed: boolean; value: string }[];
  };
  const wrong = r.checks.filter((c) => !c.passed);
  const head = r.passed
    ? `SPICE simulation of this board's own netlist: a modelled 24 V motor reaches ${r.rpm} rpm, peak ${r.peak_current_a} A, rails ${r.rail_12v} V and ${r.rail_3v3} V, bootstrap at least ${r.bootstrap_min_v} V.`
    : `SPICE simulation of this board's own netlist FAILED: ${wrong.map((c) => `${c.rule} (${c.value})`).join('; ')}.`;
  return `${head} Chips are behavioural models: this is not a bench test. Files: motor_simulation.json and .svg in the project folder.`;
}
