
# Independent design-rule check. It never uses the router's grid or its distance functions:
# every copper item is turned into a signed-distance function, clearance is measured by
# sampling the boundary of one item against the other, and connectivity is rebuilt from
# touching copper with a union-find. The exported KiCad file is parsed and counted too.
import re
data = rows("/input/result.csv")
claim = CLAIM or {}
mismatches = []
RULE = {k: float(claim.get(k)) for k in ("clearance_mm", "track_mm", "via_dia_mm", "via_drill_mm", "edge_clearance_mm")}
TOL = 0.012                                    # sampling resolution of the distance measurement, mm

def sdf_seg(px, py, x1, y1, x2, y2, hw):
    dx, dy = x2 - x1, y2 - y1; ll = dx * dx + dy * dy
    t = 0.0 if ll == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / ll))
    return math.hypot(px - x1 - t * dx, py - y1 - t * dy) - hw
def sdf_rect(px, py, cx, cy, hw, hh):
    qx, qy = abs(px - cx) - hw, abs(py - cy) - hh
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0)
class Item:
    def __init__(self, kind, net, layers, geom, label):
        self.kind, self.net, self.layers, self.g, self.label = kind, net, layers, geom, label
        if kind == "seg": x1, y1, x2, y2, hw = geom; self.box = (min(x1, x2) - hw, min(y1, y2) - hw, max(x1, x2) + hw, max(y1, y2) + hw)
        elif kind == "circle": cx, cy, r = geom; self.box = (cx - r, cy - r, cx + r, cy + r)
        else: cx, cy, hw, hh = geom; self.box = (cx - hw, cy - hh, cx + hw, cy + hh)
    def sdf(self, x, y):
        g = self.g
        if self.kind == "seg": return sdf_seg(x, y, *g)
        if self.kind == "circle": return math.hypot(x - g[0], y - g[1]) - g[2]
        return sdf_rect(x, y, *g)
    def boundary(self, step=0.02):
        g = self.g; pts = []
        if self.kind == "circle":
            cx, cy, r = g; n = max(16, int(2 * math.pi * r / step))
            return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]
        if self.kind == "rect":
            cx, cy, hw, hh = g
            for k in range(int(2 * hw / step) + 1): pts += [(cx - hw + k * step, cy - hh), (cx - hw + k * step, cy + hh)]
            for k in range(int(2 * hh / step) + 1): pts += [(cx - hw, cy - hh + k * step), (cx + hw, cy - hh + k * step)]
            return pts + [(cx + hw, cy + hh), (cx - hw, cy + hh)]
        x1, y1, x2, y2, hw = g; L = math.hypot(x2 - x1, y2 - y1); n = max(1, int(L / step)); ux, uy = ((x2 - x1) / L, (y2 - y1) / L) if L else (1.0, 0.0)
        nx, ny = -uy, ux
        for i in range(n + 1):
            t = min(1.0, i / n); px, py = x1 + (x2 - x1) * t, y1 + (y2 - y1) * t
            pts += [(px + nx * hw, py + ny * hw), (px - nx * hw, py - ny * hw)]
        m = max(16, int(2 * math.pi * hw / step))
        for sx, sy in ((x1, y1), (x2, y2)):                    # the round end caps (interior points only ever lie farther away)
            pts += [(sx + hw * math.cos(2 * math.pi * k / m), sy + hw * math.sin(2 * math.pi * k / m)) for k in range(m)]
        return pts
    def gap(self, other):
        """Distance between copper edges: negative when they overlap."""
        best = 1e9
        for p in self.boundary(): best = min(best, other.sdf(*p))
        for p in other.boundary(): best = min(best, self.sdf(*p))
        return best
    def centre(self):
        b = self.box; return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)

items = []; pads = []; nets_pins = {}
_ex = [num(r[k]) for r in data if r["kind"] == "edge" for k in ("x1", "x2")] or [0]; _ey = [num(r[k]) for r in data if r["kind"] == "edge" for k in ("y1", "y2")] or [0]
X0, Y0, W, H = min(_ex), min(_ey), max(_ex), max(_ey)
EDITED = bool(claim.get("hand_edited"))
LAY = {"top": (0,), "bottom": (1,), "both": (0, 1)}
for r in data:
    k = r["kind"]
    if k == "pad":
        it = Item("circle" if r["shape"] == "circle" else "rect", r["net"], LAY[r["layer"]],
                  (num(r["x1"]), num(r["y1"]), num(r["w"]) / 2) if r["shape"] == "circle" else (num(r["x1"]), num(r["y1"]), num(r["w"]) / 2, num(r["h"]) / 2), r["ref"])
        items.append(it); pads.append(it)
        if r["net"]: nets_pins.setdefault(r["net"], []).append(it)
    elif k == "track":
        items.append(Item("seg", r["net"], LAY[r["layer"]], (num(r["x1"]), num(r["y1"]), num(r["x2"]), num(r["y2"]), num(r["w"]) / 2), "track"))
    elif k == "via":
        items.append(Item("circle", r["net"], (0, 1), (num(r["x1"]), num(r["y1"]), num(r["w"]) / 2), "via"))
    elif k == "hole":
        items.append(Item("circle", "#hole", (0, 1), (num(r["x1"]), num(r["y1"]), num(r["drill"]) / 2), "hole"))

# 1. clearance between copper of different nets on a shared layer
CLR = RULE["clearance_mm"]
violations = []; worst = 1e9; tested = 0
for i in range(len(items)):
    a = items[i]
    for j in range(i + 1, len(items)):
        b = items[j]
        if a.net == b.net and a.net != "": continue
        if not set(a.layers) & set(b.layers): continue
        if a.box[0] - CLR > b.box[2] or b.box[0] - CLR > a.box[2] or a.box[1] - CLR > b.box[3] or b.box[1] - CLR > a.box[3]: continue
        if a.label == "hole" and b.label == "hole": continue
        need = CLR if "#hole" not in (a.net, b.net) else 0.25
        tested += 1
        gap = a.gap(b); worst = min(worst, gap)
        if gap < need - TOL: violations.append({"a": a.label, "b": b.label, "gap_mm": round(gap, 4), "needed_mm": need})
# 2. copper to the board edge, and everything on the board
E = RULE["edge_clearance_mm"]
for it in items:
    if it.label == "hole": continue
    b = it.box
    if b[0] < X0 + E - TOL or b[1] < Y0 + E - TOL or b[2] > W - E + TOL or b[3] > H - E + TOL: violations.append({"a": it.label, "problem": "closer to the edge than allowed"})
# 3. widths, vias, annular rings
for r in data:
    if r["kind"] == "track" and num(r["w"]) < RULE["track_mm"] - 1e-9: mismatches.append({"problem": "track narrower than the rule", "w": r["w"]})
    if r["kind"] == "via":
        ring = (num(r["w"]) - num(r["drill"])) / 2
        if ring < 0.13 - 1e-9: mismatches.append({"problem": "annular ring", "ring_mm": ring})
        # A via placed by hand may be bigger than the rule; one from the router must match it.
        if EDITED:
            if num(r["w"]) < RULE["via_dia_mm"] - 1e-9: mismatches.append({"problem": "via smaller than the rule", "dia_mm": r["w"]})
        elif abs(num(r["w"]) - RULE["via_dia_mm"]) > 1e-9 or abs(num(r["drill"]) - RULE["via_drill_mm"]) > 1e-9: mismatches.append({"problem": "via size differs from the rule"})
    if r["kind"] == "pad" and num(r["drill"]) > 0 and (num(r["w"]) - num(r["drill"])) / 2 < 0.13 - 1e-9: mismatches.append({"problem": "pad annular ring", "pad": r["ref"]})
# 4. connectivity: touching copper on a shared layer, per net
parent = list(range(len(items)))
def find(x):
    while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
    return x
for i in range(len(items)):
    a = items[i]
    for j in range(i + 1, len(items)):
        b = items[j]
        if a.net != b.net or a.net == "" or a.label == "hole": continue
        if not set(a.layers) & set(b.layers): continue
        if a.box[0] > b.box[2] or b.box[0] > a.box[2] or a.box[1] > b.box[3] or b.box[1] > a.box[3]: continue
        if a.gap(b) <= 0.005: parent[find(i)] = find(j)
idx = {id(it): i for i, it in enumerate(items)}
unrouted_check = []
for net, ps in nets_pins.items():
    if len(ps) < 2: continue
    if len({find(idx[id(p)]) for p in ps}) > 1: unrouted_check.append(net)
claimed_un = sorted(claim.get("unrouted") or [])
if sorted(unrouted_check) != claimed_un: mismatches.append({"problem": "unrouted nets", "recomputed": sorted(unrouted_check), "claimed": claimed_un})
# 5. totals
tl = sum(math.hypot(num(r["x2"]) - num(r["x1"]), num(r["y2"]) - num(r["y1"])) for r in data if r["kind"] == "track")
if abs(tl - num(claim.get("track_length_mm"))) > 1e-3 * max(1, tl): mismatches.append({"problem": "track length", "recomputed": tl, "claimed": claim.get("track_length_mm")})
nvias = sum(1 for r in data if r["kind"] == "via")
if nvias != int(num(claim.get("vias"))): mismatches.append({"problem": "vias", "recomputed": nvias, "claimed": claim.get("vias")})
if len(violations) != int(num(claim.get("drc_violations"))): mismatches.append({"problem": "design-rule violations", "recomputed": len(violations), "claimed": claim.get("drc_violations"), "first": violations[:3]})
# 6. parts do not overlap and the nets only use existing pads
parts_ = [r for r in data if r["kind"] == "part"]
for i, a in enumerate(parts_):
    for b in parts_[i + 1:]:
        if abs(num(a["x1"]) - num(b["x1"])) < (num(a["w"]) + num(b["w"])) / 2 - 1e-6 and abs(num(a["y1"]) - num(b["y1"])) < (num(a["h"]) + num(b["h"])) / 2 - 1e-6:
            mismatches.append({"problem": "parts overlap", "a": a["ref"], "b": b["ref"]})
# 7. the KiCad file says the same as the table
kicad = None
try:
    kicad = open("/input/board.kicad_pcb").read()
except Exception: mismatches.append({"problem": "board.kicad_pcb is missing"})
if kicad is not None:
    depth = 0; quoted = False; prev = ""
    for ch in kicad:
        if ch == '"' and prev != "\\": quoted = not quoted
        if not quoted:
            depth += (ch == "(") - (ch == ")")
            if depth < 0: break
        prev = ch
    if depth != 0: mismatches.append({"problem": "board file brackets do not balance"})
    # \s, not a space: KiCad puts a line break there when it saves the file itself.
    k_seg = len(re.findall(r"\(segment\s", kicad)); k_via = len(re.findall(r"\(via\s", kicad)); k_fp = len(re.findall(r"\(footprint\s", kicad))
    k_pad = len(re.findall(r"\(pad\s", kicad))
    t_seg = sum(1 for r in data if r["kind"] == "track"); t_pad = sum(1 for r in data if r["kind"] in ("pad", "hole"))
    if k_seg != t_seg: mismatches.append({"problem": "segments in the board file", "file": k_seg, "table": t_seg})
    if k_via != nvias: mismatches.append({"problem": "vias in the board file", "file": k_via, "table": nvias})
    if k_fp != len(parts_): mismatches.append({"problem": "footprints in the board file", "file": k_fp, "table": len(parts_)})
    if k_pad != t_pad: mismatches.append({"problem": "pads in the board file", "file": k_pad, "table": t_pad})
    ksum = 0.0
    for m in re.finditer(r"\(segment\s+(?:\(locked\s+\w+\)\s+)?\(start\s+([-\d.]+)\s+([-\d.]+)\)\s+\(end\s+([-\d.]+)\s+([-\d.]+)\)", kicad):
        ksum += math.hypot(float(m.group(3)) - float(m.group(1)), float(m.group(4)) - float(m.group(2)))
    if abs(ksum - tl) > 1e-3 * max(1, tl): mismatches.append({"problem": "track length in the board file", "file": ksum, "table": tl})
    # Copper this table does not describe must not pass unseen.
    for word in ("arc", "zone"):
        found = len(re.findall(r"\(%s\s" % word, kicad))
        if found: mismatches.append({"problem": "%s items in the board file are not checked" % word, "count": found})
    # After a hand edit: every pad still sits on the net the lab gave it (the two files, read here).
    def _pad_nets(text):
        out = {}
        for block in re.split(r"\(footprint\s", text)[1:]:
            ref = re.search(r'"Reference"\s+"([^"]*)"', block)
            # By pad number, since KiCad sorts the pads when it saves.
            seen = {}
            for chunk in re.split(r"\(pad\s", block)[1:]:
                num_ = re.match(r'\s*"([^"]*)"', chunk)
                key = "%s.%s" % (ref.group(1) if ref else "?", num_.group(1) if num_ else "")
                seen[key] = seen.get(key, 0) + 1
                net = re.search(r'\(net\s+\d+\s+"([^"]*)"', chunk)
                out["%s#%d" % (key, seen[key])] = net.group(1) if net else ""
        return out
    try:
        original = open("/input/original.kicad_pcb").read()
    except Exception:
        original = None
    if original is not None:
        a_, b_ = _pad_nets(original), _pad_nets(kicad)
        changed = sorted(k for k in set(a_) | set(b_) if a_.get(k) != b_.get(k))
        if changed: mismatches.append({"problem": "pads on another net than in the design", "pads": changed[:8], "count": len(changed)})
for v in violations[:5]: mismatches.append(dict(v, problem=v.get("problem", "clearance violation")))
_measured = "%d copper items re-measured (%d close pairs, tightest gap %s mm, rule %.2f mm), connectivity rebuilt for %d nets (%d unrouted)" % (
    len(items), tested, "n/a" if worst > 1e8 else "%.3f" % worst, CLR, len(nets_pins), len(unrouted_check))
# A failed check says what failed, first: a bot or a person reads this to fix the board.
_what = "; ".join(dict.fromkeys(str(m.get("problem")) + (" (%s - %s)" % (m["a"], m["b"]) if "a" in m and "b" in m else "") for m in mismatches[:6]))
verdict(not mismatches, len(items), 0.0 if worst > 1e8 else worst, mismatches,
        ("Problems: " + _what + ". " + _measured) if mismatches else _measured + ", board file consistent")
