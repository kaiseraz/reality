import { z } from 'zod';
import type { LabEngine } from './engines.ts';
import type { Check } from '../verification/checks.ts';
import { BLDC_DRIVER } from './pcb-bldc.ts';
import { PCB_ERC } from './pcb-erc.ts';

/**
 * Printed circuit boards: a bot gives parts (footprints), nets and rules; the lab places the
 * parts (simulated annealing on wire length, edges respected), routes both copper layers
 * (A* on a grid, 45-degree tracks, vias, wide power nets that neck down at tight pads) and
 * writes a KiCad 8 board file, Gerber copper and outline layers and an Excellon drill file.
 * An independent check re-measures every clearance with signed distance functions, rebuilds
 * the connectivity and compares the exported board file with the verified table.
 */

const PCB = `
import heapq, random, re, time as _time, os as _os

# On a bot's computer this same program reports each step, for KiCad to carry out on the open board.
LIVE = _os.environ.get("REALITY_LIVE")
SLEPT = 0.0
def emit(kind, pause=0.0, **d):
    global SLEPT
    if not LIVE: return
    with open(LIVE, "a") as f: f.write(json.dumps(dict(d, kind=kind)) + "\\n")
    if pause:
        _time.sleep(pause); SLEPT += pause
json.dump(P, open("/output/design.json", "w"))

W, H = float(P["board"]["width_mm"]), float(P["board"]["height_mm"])
R = P["rules"]
CLR, TW, PW = float(R["clearance_mm"]), float(R["track_mm"]), float(R["power_track_mm"])
VIA_D, VIA_H, EDGE = float(R["via_dia_mm"]), float(R["via_drill_mm"]), float(R["edge_clearance_mm"])
G = float(R["grid_mm"])
emit("rules", via=VIA_D, drill=VIA_H)
if VIA_H >= VIA_D: raise SystemExit("The via drill must be smaller than the via diameter.")

# ---- footprints ------------------------------------------------------------------------------
# Pads in the footprint frame, mm, y down like KiCad: (number, shape, x, y, w, h, drill).
CHIP = {"0402": (0.51, 0.54, 0.51), "0603": (0.8, 0.95, 0.825), "0805": (1.025, 1.4, 0.9125), "1206": (1.15, 1.8, 1.4)}
def fp_pads(name, custom=None):
    n = name.upper()
    m = re.fullmatch(r"(R|C|L|LED|D)(0402|0603|0805|1206)", n)
    if m:
        pw, ph, px = CHIP[m.group(2)]
        return [("1", "roundrect", -px, 0, pw, ph, 0), ("2", "roundrect", px, 0, pw, ph, 0)]
    m = re.fullmatch(r"SOIC(8|14|16)", n)
    if m:
        k = int(m.group(1)); out = []
        for i in range(k // 2):
            y = (-(k // 2 - 1) / 2 + i) * 1.27
            out.append((str(i + 1), "roundrect", -2.475, y, 1.95, 0.6, 0))
            out.append((str(k - i), "roundrect", 2.475, y, 1.95, 0.6, 0))
        return sorted(out, key=lambda p: int(p[0]))
    m = re.fullmatch(r"TSSOP(14|16|20)", n)
    if m:
        k = int(m.group(1)); out = []
        for i in range(k // 2):
            y = (-(k // 2 - 1) / 2 + i) * 0.65
            out.append((str(i + 1), "roundrect", -2.85, y, 1.5, 0.4, 0))
            out.append((str(k - i), "roundrect", 2.85, y, 1.5, 0.4, 0))
        return sorted(out, key=lambda p: int(p[0]))
    if n == "SOT23":
        return [("1", "roundrect", -0.9375, -0.95, 1.475, 0.6, 0), ("2", "roundrect", -0.9375, 0.95, 1.475, 0.6, 0), ("3", "roundrect", 0.9375, 0, 1.475, 0.6, 0)]
    if n == "SOT23_5":
        return [("1", "roundrect", -1.1375, -0.95, 1.325, 0.6, 0), ("2", "roundrect", -1.1375, 0, 1.325, 0.6, 0), ("3", "roundrect", -1.1375, 0.95, 1.325, 0.6, 0),
                ("4", "roundrect", 1.1375, 0.95, 1.325, 0.6, 0), ("5", "roundrect", 1.1375, -0.95, 1.325, 0.6, 0)]
    m = re.fullmatch(r"DIP(8|14|16|20|28)", n)
    if m:
        k = int(m.group(1)); out = []
        for i in range(k // 2):
            y = (-(k // 2 - 1) / 2 + i) * 2.54
            out.append((str(i + 1), "circle", -3.81, y, 1.6, 1.6, 0.8))
            out.append((str(k - i), "circle", 3.81, y, 1.6, 1.6, 0.8))
        return sorted(out, key=lambda p: int(p[0]))
    m = re.fullmatch(r"HEADER(?:(\\d+)X)?(\\d+)", n)
    if m:
        rows, cols = int(m.group(1) or 1), int(m.group(2)); out = []
        for c in range(cols):
            for r in range(rows):
                out.append((str(c * rows + r + 1), "circle", (r - (rows - 1) / 2) * 2.54, (c - (cols - 1) / 2) * 2.54, 1.7, 1.7, 1.0))
        return out
    m = re.fullmatch(r"HOLE([0-9.]+)", n)
    if m: return [("", "npth", 0, 0, float(m.group(1)), float(m.group(1)), float(m.group(1)))]
    if n == "TESTPOINT": return [("1", "circle", 0, 0, 1.5, 1.5, 0)]
    m = re.fullmatch(r"TQFP(32|44|48|64)", n)
    if m:
        k = int(m.group(1)); side = k // 4; pitch = 0.8; span = (side - 1) * pitch; c = span / 2 + 1.5; out = []
        for i in range(side):
            at = -span / 2 + i * pitch
            out.append((str(i + 1), "roundrect", -c, at, 1.5, 0.5, 0))
            out.append((str(side + i + 1), "roundrect", at, c, 0.5, 1.5, 0))
            out.append((str(2 * side + i + 1), "roundrect", c, -at, 1.5, 0.5, 0))
            out.append((str(3 * side + i + 1), "roundrect", -at, -c, 0.5, 1.5, 0))
        return sorted(out, key=lambda p: int(p[0]))
    if n == "PQFN5X6":  # power MOSFET: source pins 1 to 3, gate 4, the drain as one big pad
        return [("1", "rect", -1.905, 3.0, 0.8, 1.2, 0), ("2", "rect", -0.635, 3.0, 0.8, 1.2, 0), ("3", "rect", 0.635, 3.0, 0.8, 1.2, 0), ("4", "rect", 1.905, 3.0, 0.8, 1.2, 0), ("5", "rect", 0, -0.9, 4.9, 4.2, 0)]
    if n == "SOT223":
        return [("1", "rect", -2.3, 3.15, 1.0, 1.5, 0), ("2", "rect", 0, 3.15, 1.0, 1.5, 0), ("3", "rect", 2.3, 3.15, 1.0, 1.5, 0), ("2b", "rect", 0, -3.15, 3.3, 1.5, 0)]
    if n == "SOD123": return [("1", "rect", -1.65, 0, 0.9, 1.2, 0), ("2", "rect", 1.65, 0, 0.9, 1.2, 0)]
    if n == "R2512": return [("1", "rect", -3.1, 0, 1.4, 3.3, 0), ("2", "rect", 3.1, 0, 1.4, 3.3, 0)]
    if n == "XTAL3225": return [("1", "rect", -1.1, 0.8, 1.4, 1.2, 0), ("2", "rect", 1.1, 0.8, 1.4, 1.2, 0), ("3", "rect", 1.1, -0.8, 1.4, 1.2, 0), ("4", "rect", -1.1, -0.8, 1.4, 1.2, 0)]
    m = re.fullmatch(r"CAPE(8|10)", n)
    if m:
        d = int(m.group(1)); return [("1", "rect", -d / 2 + 0.6, 0, 2.6, 1.8, 0), ("2", "rect", d / 2 - 0.6, 0, 2.6, 1.8, 0)]
    if n == "L_SMD6": return [("1", "rect", -2.4, 0, 1.8, 3.2, 0), ("2", "rect", 2.4, 0, 1.8, 3.2, 0)]
    if n == "SW_TACT": return [("1", "rect", -3.1, -2.25, 1.6, 1.0, 0), ("2", "rect", 3.1, -2.25, 1.6, 1.0, 0), ("3", "rect", -3.1, 2.25, 1.6, 1.0, 0), ("4", "rect", 3.1, 2.25, 1.6, 1.0, 0)]
    m = re.fullmatch(r"JST(\\d+)", n)
    if m:
        k = int(m.group(1)); span = (k - 1) * 1.25; out = [(str(i + 1), "rect", -span / 2 + i * 1.25, 1.9, 0.7, 1.5, 0) for i in range(k)]
        return out + [("MP1", "rect", -span / 2 - 1.8, -1.1, 1.2, 2.0, 0), ("MP2", "rect", span / 2 + 1.8, -1.1, 1.2, 2.0, 0)]
    m = re.fullmatch(r"PAD_TH(\\d)", n)
    if m:
        d = float(m.group(1)); return [("1", "circle", 0, 0, d + 2.2, d + 2.2, d)]
    if n == "CUSTOM" and custom:
        return [(str(p["num"]), p.get("shape", "rect"), float(p["x"]), float(p["y"]), float(p["w"]), float(p["h"]), float(p.get("drill", 0))) for p in custom]
    raise SystemExit("Unknown footprint \\"%s\\" (R/C/L/LED/D + 0402|0603|0805|1206, SOIC8|14|16, TSSOP14|16|20, TQFP32|44|48|64, PQFN5X6, SOT223, SOD123, R2512, XTAL3225, CAPE8|10, L_SMD6, SW_TACT, JST<n>, PAD_TH<d>, SOT23, SOT23_5, DIP8..28, HEADER<n> or HEADER<rows>x<n>, HOLE<d>, TESTPOINT, CUSTOM with pads)" % name)

def rot_xy(x, y, deg):
    d = int(deg) % 360
    return {0: (x, y), 90: (y, -x), 180: (-x, -y), 270: (-y, x)}[d]      # CCW on screen, y down

class Part:
    def __init__(self, spec):
        self.ref = spec["ref"]; self.fp = spec["footprint"]; self.value = spec.get("value", ""); self.spec = spec
        self.pads = fp_pads(self.fp, spec.get("pads"))
        self.rot = int(spec.get("rot", 0)) % 360
        self.x, self.y = (float(spec["at"][0]), float(spec["at"][1])) if spec.get("at") else (None, None)
        self.fixed = bool(spec.get("at"))
        xs = [abs(p[2]) + p[4] / 2 for p in self.pads]; ys = [abs(p[3]) + p[5] / 2 for p in self.pads]
        self.hw0, self.hh0 = max(xs) + 0.25, max(ys) + 0.25
        m = re.fullmatch(r"CAPE(8|10)", self.fp.upper())
        if m: self.hw0, self.hh0 = int(m.group(1)) / 2 + 0.6, int(m.group(1)) / 2 + 0.6
        if self.fp.upper() == "L_SMD6": self.hw0, self.hh0 = 3.6, 3.3
        if self.fp.upper() == "SW_TACT": self.hw0, self.hh0 = 4.1, 3.2
    def half(self, rot=None):
        r = self.rot if rot is None else rot
        return (self.hh0, self.hw0) if r % 180 else (self.hw0, self.hh0)
    def abs_pads(self):
        out = []
        for num, shape, px, py, pw, ph, dr in self.pads:
            rx, ry = rot_xy(px, py, self.rot)
            w, h = (ph, pw) if self.rot % 180 else (pw, ph)
            out.append({"num": num, "shape": shape, "x": self.x + rx, "y": self.y + ry, "w": w, "h": h, "drill": dr, "local": (px, py, pw, ph)})
        return out

parts = [Part(s) for s in P["parts"]]
refs = {p.ref: p for p in parts}
if len(refs) != len(parts): raise SystemExit("Part references must be unique.")
nets = P["nets"]
# A big board with a ground net and no word about planes gets them: ground over tracks does not route.
if not P.get("pours") and len(parts) >= 30:
    _ground = next((n["name"] for n in nets if n["name"].upper() == "GND" and len(n["pins"]) >= 8), None)
    if _ground: P["pours"] = [{"net": _ground, "layer": "B.Cu"}, {"net": _ground, "layer": "F.Cu"}]
if len({n["name"] for n in nets}) != len(nets): raise SystemExit("Net names must be unique.")
pin_net = {}
for ni, n in enumerate(nets):
    for pin in n["pins"]:
        if "." not in pin: raise SystemExit("Pin \\"%s\\" must look like REF.PIN" % pin)
        ref, num = pin.split(".", 1)
        if ref not in refs: raise SystemExit("Net %s refers to unknown part %s" % (n["name"], ref))
        if num not in [p[0] for p in refs[ref].pads]: raise SystemExit("Part %s (%s) has no pad %s" % (ref, refs[ref].fp, num))
        if pin in pin_net: raise SystemExit("Pad %s is in two nets (%s, %s)" % (pin, nets[pin_net[pin]]["name"], n["name"]))
        pin_net[pin] = ni

# ---- placement: simulated annealing on wire length, parts kept apart, edges respected --------
class Rng:
    # Plain arithmetic on the one stream every Python agrees on: the library functions behind
    # gauss and exp differ between systems in the last bit, and placement is chaotic enough to show
    # it. So the same seed gives the same board on any computer.
    def __init__(self, seed): self.r = random.Random(seed)
    def random(self): return self.r.random()
    def uniform(self, a, b): return a + (b - a) * self.r.random()
    def gauss(self, mu, sd):
        v = -6.0   # no sum(): since Python 3.12 it rounds differently
        for _ in range(12): v += self.r.random()
        return mu + sd * v
    @staticmethod
    def exp(x):
        v = 1 + x / 256
        if v <= 0: return 0.0
        for _ in range(8): v = v * v
        return v
    def choice(self, seq): return seq[int(self.r.random() * len(seq))]
    def shuffle(self, seq):
        for i in range(len(seq) - 1, 0, -1):
            j = int(self.r.random() * (i + 1)); seq[i], seq[j] = seq[j], seq[i]
rnd = Rng(int(P.get("seed", 1)))
GAP = 0.3
def pad_pos(part, num, x=None, y=None, rot=None):
    for n_, shape, px, py, pw, ph, dr in part.pads:
        if n_ == num:
            rx, ry = rot_xy(px, py, part.rot if rot is None else rot)
            return (part.x if x is None else x) + rx, (part.y if y is None else y) + ry
def wirelength():
    total = 0.0
    for n in nets:
        pts = [pad_pos(refs[p.split(".", 1)[0]], p.split(".", 1)[1]) for p in n["pins"]]
        if len(pts) > 1:
            xs = [q[0] for q in pts]; ys = [q[1] for q in pts]
            total += (max(xs) - min(xs)) + (max(ys) - min(ys))
    return total
def overlap_cost():
    c = 0.0
    for i, a in enumerate(parts):
        ax, ay = a.half()
        for b in parts[i + 1:]:
            bx, by = b.half()
            ox = ax + bx + GAP - abs(a.x - b.x); oy = ay + by + GAP - abs(a.y - b.y)
            if ox > 0 and oy > 0: c += min(ox, oy) * 40 + ox * oy
        hx, hy = a.half()
        m = EDGE + 0.2
        c += 80 * (max(0, hx + m - a.x) + max(0, a.x + hx + m - W) + max(0, hy + m - a.y) + max(0, a.y + hy + m - H))
    return c
SPREAD = float(P.get("spread", 6.0))
def spread_cost():
    # Wire length alone pulls everything into one corner; this keeps the parts' centre of mass near the middle.
    cx = cy = 0.0
    for p in parts: cx += p.x; cy += p.y
    cx /= len(parts); cy /= len(parts)
    return SPREAD * (abs(cx - W / 2) + abs(cy - H / 2))
free = [p for p in parts if not p.fixed]
def snap_edge(p):
    e = p.spec.get("edge"); hx, hy = p.half(); m = EDGE + 0.2
    if e == "left": p.x = hx + m
    elif e == "right": p.x = W - hx - m
    elif e == "top": p.y = hy + m
    elif e == "bottom": p.y = H - hy - m
def part_frame(): return [[p.ref, round(p.x, 3), round(p.y, 3), p.rot] for p in parts]
def place():
    global rnd
    rnd = Rng(int(P.get("seed", 1)) + int(W) * 1000 + int(H))
    for p in free:
        p.x = rnd.uniform(5, max(6, W - 5)); p.y = rnd.uniform(5, max(6, H - 5)); snap_edge(p)
    if free:
        cost = wirelength() + overlap_cost() + spread_cost(); temp = max(W, H) / 4; iters = int(P.get("placement_iterations", 30000))
        for it in range(iters):
            if LIVE and it % max(1, iters // 40) == 0: emit("parts", 0.3, parts=part_frame())
            t = temp * (1 - it / iters) * (1 - it / iters) + 0.01
            p = rnd.choice(free); old = (p.x, p.y, p.rot)
            r = rnd.random()
            if r < 0.7: p.x += rnd.gauss(0, t); p.y += rnd.gauss(0, t)
            elif r < 0.85 and not p.spec.get("rot_locked"): p.rot = (p.rot + 90) % 360
            elif len(free) > 1:
                q = rnd.choice(free)
                if q is not p and not p.spec.get("edge") and not q.spec.get("edge"):
                    p.x, q.x = q.x, p.x; p.y, q.y = q.y, p.y; old = None
            snap_edge(p)
            new = wirelength() + overlap_cost() + spread_cost()
            if new <= cost or rnd.random() < rnd.exp(-(new - cost) / max(t, 1e-3)):
                cost = new
            else:
                if old is None:
                    p.x, q.x = q.x, p.x; p.y, q.y = q.y, p.y
                else: p.x, p.y, p.rot = old
        for p in free:
            p.x = round(p.x * 2) / 2; p.y = round(p.y * 2) / 2; snap_edge(p); p.x = round(p.x * 2) / 2; p.y = round(p.y * 2) / 2
def placement_problem():
    for i, a in enumerate(parts):
        ax, ay = a.half()
        if a.x - ax < 0 or a.x + ax > W or a.y - ay < 0 or a.y + ay > H: return "Part %s does not fit on the board; make the board larger." % a.ref
        for b in parts[i + 1:]:
            bx, by = b.half()
            if abs(a.x - b.x) < ax + bx and abs(a.y - b.y) < ay + by: return "Parts %s and %s overlap; make the board larger or place them." % (a.ref, b.ref)
# Parts that do not fit are the board's problem, not a reason to stop: a size is a first guess
# unless the parts are pinned to it. The result says when it grew.
ASKED = (W, H)
for attempt in range(8):
    emit("board", w=W, h=H)
    place()
    if LIVE and not free:
        # A placement the design decides: part after part, the way a person lays out a board.
        shown = []
        for p in parts:
            shown.append([p.ref, round(p.x, 3), round(p.y, 3), p.rot])
            emit("parts", 0.12, parts=shown[-1:])
    emit("parts", 0.5, parts=part_frame())
    problem = placement_problem()
    if not problem: break
    if attempt == 7 or free != parts or max(W, H) >= 200: raise SystemExit(problem)
    W = min(200.0, math.ceil(W * 1.25 / 5) * 5.0); H = min(200.0, math.ceil(H * 1.25 / 5) * 5.0)

# ---- copper features -------------------------------------------------------------------------
net_id = {n["name"]: i + 1 for i, n in enumerate(nets)}
FEATS = []          # kind, layer(0 top,1 bottom,2 both), net, geometry...
PADS = []           # absolute pads with net names
def copper_of_parts():
    global NX, NY
    NX, NY = int(W / G) + 1, int(H / G) + 1
    FEATS.clear(); PADS.clear()
    extra = len(nets) + 1
    for part in parts:
        for ap in part.abs_pads():
            pin = "%s.%s" % (part.ref, ap["num"])
            if ap["shape"] == "npth":
                FEATS.append(("hole", 2, -1, ap["x"], ap["y"], ap["drill"] / 2 + 0.25)); PADS.append(dict(ap, ref=pin, net="", nid=-1, layer=2)); continue
            nid = pin_net.get(pin)
            nid = nid + 1 if nid is not None else extra
            if nid == extra: extra += 1
            layer = 2 if ap["drill"] > 0 else 0
            PADS.append(dict(ap, ref=pin, net=nets[nid - 1]["name"] if nid <= len(nets) else "", nid=nid, layer=layer))
            FEATS.append(("rect" if ap["shape"] != "circle" else "circle", layer, nid, ap["x"], ap["y"], ap["w"] / 2, ap["h"] / 2))
copper_of_parts()

def paint(occ, L, geom, rad, nid):
    kind = geom[0]
    if kind == "seg":
        _, x1, y1, x2, y2, hw = geom; r = hw + rad
        x0, xe = min(x1, x2) - r, max(x1, x2) + r; y0, ye = min(y1, y2) - r, max(y1, y2) + r
    elif kind == "circle":
        _, cx, cy, rr = geom; r = rr + rad; x0, xe, y0, ye = cx - r, cx + r, cy - r, cy + r
    else:
        _, cx, cy, hw, hh = geom; x0, xe, y0, ye = cx - hw - rad, cx + hw + rad, cy - hh - rad, cy + hh + rad
    i0, i1 = max(0, int(math.floor(x0 / G))), min(NX - 1, int(math.ceil(xe / G)))
    j0, j1 = max(0, int(math.floor(y0 / G))), min(NY - 1, int(math.ceil(ye / G)))
    if i1 < i0 or j1 < j0: return
    xs = np.arange(i0, i1 + 1) * G; ys = np.arange(j0, j1 + 1) * G
    X, Y = np.meshgrid(xs, ys)
    if kind == "seg":
        dx, dy = x2 - x1, y2 - y1; ll = dx * dx + dy * dy
        t = np.clip(((X - x1) * dx + (Y - y1) * dy) / ll, 0, 1) if ll > 0 else np.zeros_like(X)
        mask = np.hypot(X - (x1 + t * dx), Y - (y1 + t * dy)) <= hw + rad + 1e-9
    elif kind == "circle": mask = np.hypot(X - cx, Y - cy) <= rr + rad + 1e-9
    else: mask = (np.abs(X - cx) <= hw + rad + 1e-9) & (np.abs(Y - cy) <= hh + rad + 1e-9)
    sub = occ[L, j0:j1 + 1, i0:i1 + 1]
    if nid == -1: sub[mask] = -1
    else:
        sub[mask & (sub == 0)] = nid
        sub[mask & (sub != 0) & (sub != nid)] = -1

def build_occ(rad):
    occ = np.zeros((2, NY, NX), dtype=np.int32)
    for f in FEATS:
        kind, layer, nid = f[0], f[1], f[2]
        geom = ("circle", f[3], f[4], f[5]) if kind in ("circle", "hole") else ("rect", f[3], f[4], f[5], f[6]) if kind == "rect" else f[3:]
        if kind == "seg": geom = ("seg", f[3], f[4], f[5], f[6], f[7])
        if kind == "via": geom = ("circle", f[3], f[4], f[5])
        for L in ((0, 1) if layer == 2 else (layer,)): paint(occ, L, geom, rad, -1 if kind == "hole" else nid)
    e = EDGE + rad
    ix = int(math.ceil(e / G)); iy = int(math.ceil(e / G))
    occ[:, :, :ix] = -1; occ[:, :, NX - ix:] = -1; occ[:, :iy, :] = -1; occ[:, NY - iy:, :] = -1
    return occ

def net_width(n): return float(n.get("width_mm") or (PW if n.get("class") == "power" else TW))

# ---- routing: A* on two layers with 45-degree moves and vias ----------------------------------
NB = [(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0), (1, 1, 1.4142), (-1, 1, 1.4142), (1, -1, 1.4142), (-1, -1, 1.4142)]
VIA_COST = float(R.get("via_cost", 12))
TRACKS = []; VIAS = []; unrouted = []
def cells_of_pad(ap, layers):
    out = set()
    hx, hy = ap["w"] / 2, ap["h"] / 2
    i0, i1 = int(math.ceil((ap["x"] - hx) / G - 1e-9)), int(math.floor((ap["x"] + hx) / G + 1e-9))
    j0, j1 = int(math.ceil((ap["y"] - hy) / G - 1e-9)), int(math.floor((ap["y"] + hy) / G + 1e-9))
    for j in range(j0, j1 + 1):
        for i in range(i0, i1 + 1):
            if 0 <= i < NX and 0 <= j < NY:
                if ap["shape"] == "circle" and math.hypot(i * G - ap["x"], j * G - ap["y"]) > hx: continue
                for L in layers: out.add((L, j, i))
    if not out:
        i, j = int(round(ap["x"] / G)), int(round(ap["y"] / G))
        for L in layers: out.add((L, j, i))
    return out

def astar(starts, goals, gp, occ, occv, nid):
    def h(j, i):
        x, y = i * G, j * G
        return min(max(abs(x - a), abs(y - b)) + 0.4142 * min(abs(x - a), abs(y - b)) for a, b in gp) / G
    openh = []; best = {}; came = {}
    for c in starts:
        best[c] = 0.0; heapq.heappush(openh, (h(c[1], c[2]), 0.0, c))
    expanded = 0
    while openh:
        f, g, cur = heapq.heappop(openh)
        if g > best.get(cur, 1e18) + 1e-12: continue
        if cur in goals: return cur, came
        expanded += 1
        if expanded > 400000: break
        L, j, i = cur
        for di, dj, c in NB:
            ni_, nj = i + di, j + dj
            if not (0 <= ni_ < NX and 0 <= nj < NY): continue
            o = occ[L][nj][ni_]
            if o != 0 and o != nid: continue
            if di and dj:
                o1, o2 = occ[L][j][ni_], occ[L][nj][i]
                if (o1 != 0 and o1 != nid) or (o2 != 0 and o2 != nid): continue
            cost = c * ((1.0 if (L == 0) == (dj == 0) else 1.12) if not (di and dj) else 1.0)
            nxt = (L, nj, ni_); ng = g + cost
            if ng < best.get(nxt, 1e18) - 1e-12:
                best[nxt] = ng; came[nxt] = cur; heapq.heappush(openh, (ng + h(nj, ni_), ng, nxt))
        o = occ[1 - L][j][i]
        if (o == 0 or o == nid) and occv[0][j][i] in (0, nid) and occv[1][j][i] in (0, nid):
            nxt = (1 - L, j, i); ng = g + VIA_COST
            if ng < best.get(nxt, 1e18) - 1e-12:
                best[nxt] = ng; came[nxt] = cur; heapq.heappush(openh, (ng + h(j, i), ng, nxt))
    return None, came

# A net with a whole copper plane on the back needs no tracks of its own: each surface pad gets the
# shortest way to a via that reaches the plane. KiCad fills the plane and its rule check judges it.
POUR_NETS = [p["net"] for p in (P.get("pours") or []) if p["layer"] == "B.Cu" and not p.get("rect")]
def stitch_net(ni):
    nid = ni + 1; w = net_width(nets[ni]); ok = True
    for pad in [p for p in PADS if p["nid"] == nid and p["layer"] == 0]:
        occ = build_occ(CLR + w / 2).tolist(); occv_ = build_occ(CLR + VIA_D / 2)
        for p in PADS:
            for L in (0, 1):
                geom = ("circle", p["x"], p["y"], p["w"] / 2) if p["shape"] == "circle" else ("rect", p["x"], p["y"], p["w"] / 2, p["h"] / 2)
                paint(occv_, L, geom, VIA_D / 2 + 0.05, -1)
        occv = occv_.tolist()
        starts = sorted(cells_of_pad(pad, (0,)))
        came = {}; seen = set(starts); queue = list(starts); found = None; at = 0
        while at < len(queue) and at < 8000 and found is None:
            L, j, i = queue[at]; at += 1
            if occv[0][j][i] in (0, nid) and occv[1][j][i] in (0, nid): found = (L, j, i); break
            for di, dj, c in NB:
                i2, j2 = i + di, j + dj
                if not (0 <= i2 < NX and 0 <= j2 < NY) or (0, j2, i2) in seen: continue
                if occ[0][j2][i2] not in (0, nid): continue
                if di and dj and (occ[0][j][i2] not in (0, nid) or occ[0][j2][i] not in (0, nid)): continue
                seen.add((0, j2, i2)); came[(0, j2, i2)] = (L, j, i); queue.append((0, j2, i2))
        if found is None: ok = False; continue
        path = [found]
        while path[-1] in came: path.append(came[path[-1]])
        x, y = found[2] * G, found[1] * G
        VIAS.append({"x": x, "y": y, "nid": nid, "pad": pad["ref"]}); FEATS.append(("via", 2, nid, x, y, VIA_D / 2))
        pts = [(c[2] * G, c[1] * G) for c in path] + [(pad["x"], pad["y"])]
        for k in range(len(pts) - 1):
            (x1, y1), (x2, y2) = pts[k], pts[k + 1]
            if abs(x1 - x2) < 1e-9 and abs(y1 - y2) < 1e-9: continue
            TRACKS.append({"L": 0, "x1": x1, "y1": y1, "x2": x2, "y2": y2, "w": w, "nid": nid})
            FEATS.append(("seg", 0, nid, x1, y1, x2, y2, w / 2))
    return ok

def route_net(ni):
    n = nets[ni]; nid = ni + 1; w_net = net_width(n)
    if n["name"] in POUR_NETS: return stitch_net(ni)
    pads = [p for p in PADS if p["nid"] == nid]
    if len(pads) < 2: return True
    cache = {}
    def maps(w):
        # Per track width: where its centre line may run, and where a via may sit. Created on demand.
        if w not in cache:
            occ = build_occ(CLR + w / 2); occv = build_occ(CLR + VIA_D / 2)
            for p in PADS:                                         # no vias on pads
                for L in (0, 1):
                    geom = ("circle", p["x"], p["y"], p["w"] / 2) if p["shape"] == "circle" else ("rect", p["x"], p["y"], p["w"] / 2, p["h"] / 2)
                    paint(occv, L, geom, VIA_D / 2 + 0.05, -1)
            cache[w] = (occ.tolist(), occv.tolist())   # plain lists: a search reads them millions of times
        return cache[w]
    tree = set(); tree_pts = []
    first = pads[0]
    for c in cells_of_pad(first, (0, 1) if first["layer"] == 2 else (first["layer"],)): tree.add(c)
    tree_pts.append((first["x"], first["y"]))
    todo = pads[1:]; ok = True
    while todo:
        todo.sort(key=lambda p: min(abs(p["x"] - q[0]) + abs(p["y"] - q[1]) for q in tree_pts))
        tgt = todo.pop(0)
        layers = (0, 1) if tgt["layer"] == 2 else (tgt["layer"],)
        starts = list(cells_of_pad(tgt, layers))
        gp = tree_pts[:: max(1, len(tree_pts) // 10)][:12]
        found = None
        for w in ([w_net] + ([TW] if TW < w_net - 1e-9 else [])):    # a wide net necks down where pads are tight
            occ, occv = maps(w)
            found, came = astar(starts, tree, gp, occ, occv, nid)
            if found is not None: break
        if found is None: ok = False; continue
        path = [found]
        while path[-1] in came and path[-1] not in starts: path.append(came[path[-1]])
        for c in path: tree.add(c)
        pts = [(c[0], c[2] * G, c[1] * G) for c in path]
        segs = []; cur_seg = None
        for k in range(len(pts) - 1):
            (L1, x1, y1), (L2, x2, y2) = pts[k], pts[k + 1]
            if L1 != L2:
                VIAS.append({"x": x1, "y": y1, "nid": nid}); FEATS.append(("via", 2, nid, x1, y1, VIA_D / 2)); cur_seg = None; continue
            d = (round(x2 - x1, 6), round(y2 - y1, 6))
            if cur_seg and cur_seg["d"] == d and cur_seg["L"] == L1: cur_seg["x2"], cur_seg["y2"] = x2, y2
            else:
                cur_seg = {"L": L1, "x1": x1, "y1": y1, "x2": x2, "y2": y2, "d": d}; segs.append(cur_seg)
        endL, ex, ey = pts[-1]
        if (ex, ey) != (tgt["x"], tgt["y"]): segs.append({"L": endL, "x1": ex, "y1": ey, "x2": tgt["x"], "y2": tgt["y"], "d": None})
        for sg in segs:
            if abs(sg["x1"] - sg["x2"]) < 1e-9 and abs(sg["y1"] - sg["y2"]) < 1e-9: continue
            TRACKS.append({"L": sg["L"], "x1": sg["x1"], "y1": sg["y1"], "x2": sg["x2"], "y2": sg["y2"], "w": w, "nid": nid})
            FEATS.append(("seg", sg["L"], nid, sg["x1"], sg["y1"], sg["x2"], sg["y2"], w / 2))
        tree_pts.append((tgt["x"], tgt["y"]))
        tree_pts.extend((c[2] * G, c[1] * G) for c in path[:: max(1, len(path) // 6)])
    return ok

def span(i):
    pts = [pad_pos(refs[p.split(".", 1)[0]], p.split(".", 1)[1]) for p in nets[i]["pins"]]
    return (max(q[0] for q in pts) - min(q[0] for q in pts)) + (max(q[1] for q in pts) - min(q[1] for q in pts))
# ---- rip-up: a net that found no way takes one through the nets in its way, and those try again ---
def drop_net(ni):
    nid = ni + 1
    TRACKS[:] = [t for t in TRACKS if t["nid"] != nid]
    VIAS[:] = [v for v in VIAS if v["nid"] != nid]
    FEATS[:] = [f for f in FEATS if not (f[0] in ("seg", "via") and f[2] == nid)]
def blockers(ni):
    # Who stands between this net's pads: a search that may cross other nets' copper at a high price.
    nid = ni + 1; w = net_width(nets[ni]) if net_width(nets[ni]) <= TW else TW
    pads = [p for p in PADS if p["nid"] == nid]
    if nets[ni]["name"] in POUR_NETS: pads = pads[:1]
    if not pads: return []
    keep = FEATS[:]
    FEATS[:] = [f for f in FEATS if f[0] not in ("seg", "via") or f[2] == nid]
    hard = build_occ(CLR + w / 2).tolist()
    FEATS[:] = keep
    soft = build_occ(CLR + w / 2).tolist()
    found = set()
    for k in range(1, len(pads)):
        a, b = pads[0], pads[k]
        goal = cells_of_pad(b, (0, 1) if b["layer"] == 2 else (b["layer"],))
        starts = cells_of_pad(a, (0, 1) if a["layer"] == 2 else (a["layer"],))
        gi, gj = int(b["x"] / G), int(b["y"] / G)
        def est(j, i):
            dx, dy = abs(i - gi), abs(j - gj)
            return max(dx, dy) + 0.4142 * min(dx, dy)
        openh = [(est(c[1], c[2]), 0.0, c) for c in sorted(starts)]; best = {c: 0.0 for c in starts}; came = {}; end_ = None; n_ = 0
        heapq.heapify(openh)
        while openh and n_ < 400000:
            _, g, cur = heapq.heappop(openh); n_ += 1
            if cur in goal: end_ = cur; break
            if g > best.get(cur, 1e18): continue
            L, j, i = cur
            for di, dj, c in NB:
                i2, j2 = i + di, j + dj
                if not (0 <= i2 < NX and 0 <= j2 < NY): continue
                if hard[L][j2][i2] not in (0, nid): continue
                o = soft[L][j2][i2]
                ng = g + c + (0 if o in (0, nid) else 25)
                if ng < best.get((L, j2, i2), 1e18):
                    best[(L, j2, i2)] = ng; came[(L, j2, i2)] = cur; heapq.heappush(openh, (ng + est(j2, i2), ng, (L, j2, i2)))
            if hard[1 - L][j][i] in (0, nid):
                ng = g + VIA_COST
                if ng < best.get((1 - L, j, i), 1e18):
                    best[(1 - L, j, i)] = ng; came[(1 - L, j, i)] = cur; heapq.heappush(openh, (ng + est(j, i), ng, (1 - L, j, i)))
        if end_ is None: continue
        c = end_
        while c in came:
            L, j, i = c
            o = soft[L][j][i]
            if o > 0 and o != nid and o <= len(nets): found.add(o - 1)
            c = came[c]
    return sorted(found)
def blockers_to(pad, goals, nid):
    # Whose copper lies on the cheapest way from a pad to these cells.
    keep = FEATS[:]
    FEATS[:] = [f for f in FEATS if f[0] not in ("seg", "via") or f[2] == nid]
    hard = build_occ(CLR + TW / 2).tolist()
    FEATS[:] = keep
    soft = build_occ(CLR + TW / 2).tolist()
    starts = cells_of_pad(pad, (0, 1) if pad["layer"] == 2 else (0,))
    openh = [(0.0, c) for c in sorted(starts)]; best = {c: 0.0 for c in starts}; came = {}; end_ = None; n_ = 0
    heapq.heapify(openh)
    while openh and n_ < 200000:
        g, cur = heapq.heappop(openh); n_ += 1
        if cur in goals: end_ = cur; break
        if g > best.get(cur, 1e18): continue
        L, j, i = cur
        for di, dj, c in NB:
            i2, j2 = i + di, j + dj
            if not (0 <= i2 < NX and 0 <= j2 < NY) or hard[L][j2][i2] not in (0, nid): continue
            ng = g + c + (0 if soft[L][j2][i2] in (0, nid) else 25)
            if ng < best.get((L, j2, i2), 1e18):
                best[(L, j2, i2)] = ng; came[(L, j2, i2)] = cur; heapq.heappush(openh, (ng, (L, j2, i2)))
    found = set(); c = end_
    while c in came:
        o = soft[c[0]][c[1]][c[2]]
        if o > 0 and o != nid and o <= len(nets): found.add(o - 1)
        c = came[c]
    return sorted(found)
def rip_up(failed, status, pause):
    tried = 0
    while failed and tried < 12:
        ni = failed[0]; tried += 1
        who = blockers(ni)
        if not who: failed.pop(0); continue
        saved = (list(TRACKS), list(VIAS), list(FEATS))
        for b in who:
            drop_net(b); emit("unroute", net=nets[b]["name"])
        drop_net(ni); emit("unroute", net=nets[ni]["name"])
        a_, b_ = len(TRACKS), len(VIAS)
        status[ni] = route_net(ni)
        emit("route", pause, **net_copper(ni, a_, b_))
        lost = [] if status[ni] else [ni]
        for b in who:
            a_, b_ = len(TRACKS), len(VIAS)
            status[b] = route_net(b)
            emit("route", pause, **net_copper(b, a_, b_))
            if not status[b]: lost.append(b)
        rest = failed[1:]
        if ni in lost:
            # No better for this net: put everything back and leave it for a later attempt.
            for b in who + [ni]:
                emit("unroute", net=nets[b]["name"])
            TRACKS[:], VIAS[:], FEATS[:] = saved
            for b in who: status[b] = True
            status[ni] = False
            for b in who + [ni]:
                emit("route", net=nets[b]["name"], tracks=[[t["L"], t["x1"], t["y1"], t["x2"], t["y2"], t["w"]] for t in TRACKS if t["nid"] == b + 1], vias=[[v["x"], v["y"]] for v in VIAS if v["nid"] == b + 1])
            failed[:] = rest
            continue
        failed[:] = rest + [x for x in lost if x not in rest]
    return [ni for ni in range(len(nets)) if not status.get(ni, True)]

# ---- copper planes as KiCad will fill them --------------------------------------------------------
def plane_pieces(ni):
    # Where the plane's copper will be on each layer, and which pieces hang together through this
    # net's vias, through-hole pads and tracks. A cell counts only with room for KiCad's clearance and
    # its narrowest fill, so what this calls connected, KiCad connects as well.
    nid = ni + 1; name = nets[ni]["name"]
    occ = build_occ(ZONE_CLR + ZONE_MIN / 2)
    pieces = np.full((2, NY, NX), -1, dtype=np.int32); parent = []
    def find(a):
        while parent[a] != a: parent[a] = parent[parent[a]]; a = parent[a]
        return a
    for L, layer in ((0, "F.Cu"), (1, "B.Cu")):
        free = (occ[L] == 0) | (occ[L] == nid)
        mine = [p for p in (P.get("pours") or []) if p["net"] == name and p["layer"] == layer]
        if not mine: free &= (occ[L] == nid)
        for z in (P.get("pours") or []):
            if z["net"] != name and z["layer"] == layer and z.get("rect"):
                ax, ay, bx, by = z["rect"]; r = ZONE_CLR + ZONE_MIN / 2
                free[max(0, int((ay - r) / G)):int((by + r) / G) + 2, max(0, int((ax - r) / G)):int((bx + r) / G) + 2] = False
        rows = free.tolist(); seen = pieces[L].tolist()
        for j in range(NY):
            for i in range(NX):
                if rows[j][i] and seen[j][i] < 0:
                    k = len(parent); parent.append(k); seen[j][i] = k; stack = [(j, i)]
                    while stack:
                        a, b = stack.pop()
                        for a2, b2 in ((a + 1, b), (a - 1, b), (a, b + 1), (a, b - 1)):
                            if 0 <= a2 < NY and 0 <= b2 < NX and rows[a2][b2] and seen[a2][b2] < 0:
                                seen[a2][b2] = k; stack.append((a2, b2))
        pieces[L] = seen
    def touch(L, x, y):
        j, i = int(round(y / G)), int(round(x / G))
        for r in range(0, 4):
            for a in range(max(0, j - r), min(NY, j + r + 1)):
                for b in range(max(0, i - r), min(NX, i + r + 1)):
                    if pieces[L, a, b] >= 0: return int(pieces[L, a, b])
        return -1
    for v in VIAS:
        if v["nid"] != nid: continue
        a, b = touch(0, v["x"], v["y"]), touch(1, v["x"], v["y"])
        if a >= 0 and b >= 0: parent[find(a)] = find(b)
    for p in PADS:
        if p["nid"] == nid and p["layer"] == 2:
            a, b = touch(0, p["x"], p["y"]), touch(1, p["x"], p["y"])
            if a >= 0 and b >= 0: parent[find(a)] = find(b)
    roots = [find(k) for k in range(len(parent))]
    return pieces, roots, touch
def tie_planes(ni):
    # Stitching vias alone in a cut-off corner go away; a pad cut off from the main plane gets a track.
    nid = ni + 1; tied = set()
    for _ in range(60):
        pieces, roots, touch = plane_pieces(ni)
        size = {}
        for L in (0, 1):
            ids, counts = np.unique(pieces[L][pieces[L] >= 0], return_counts=True)
            for k, c in zip(ids.tolist(), counts.tolist()): size[roots[k]] = size.get(roots[k], 0) + c
        if not size: return []
        main = max(sorted(size), key=lambda k: size[k])
        def on_main(x, y, layers):
            for L in layers:
                t = touch(L, x, y)
                if t >= 0 and roots[t] == main: return True
            return False
        keep = [v for v in VIAS if v["nid"] != nid or v.get("pad") or on_main(v["x"], v["y"], (0, 1))]
        if len(keep) != len(VIAS):
            gone = {(v["x"], v["y"]) for v in VIAS if v["nid"] == nid and not v.get("pad") and not on_main(v["x"], v["y"], (0, 1))}
            VIAS[:] = keep
            FEATS[:] = [f for f in FEATS if not (f[0] == "via" and f[2] == nid and (f[3], f[4]) in gone)]
            continue
        cut = []
        for pad in [p for p in PADS if p["nid"] == nid and p["ref"] not in tied]:
            layers = (0, 1) if pad["layer"] == 2 else (0,)
            if not on_main(pad["x"], pad["y"], layers):
                # Its own stitch via may reach the plane already.
                near = any(v["nid"] == nid and v.get("pad") == pad["ref"] and on_main(v["x"], v["y"], (0, 1)) for v in VIAS)
                if not near: cut.append(pad)
        if not cut: return []
        pad = cut[0]
        goals = set()
        for L in (0, 1):
            rows = np.argwhere(pieces[L] >= 0)
            for j, i in rows.tolist():
                if roots[int(pieces[L, j, i])] == main: goals.add((L, j, i))
        occ = build_occ(CLR + TW / 2).tolist(); occv = build_occ(CLR + VIA_D / 2).tolist()
        start = sorted(cells_of_pad(pad, (0, 1) if pad["layer"] == 2 else (0,)))
        gp = [(c[2] * G, c[1] * G) for c in sorted(goals)[:: max(1, len(goals) // 40)]][:40]
        found, came = astar(start, goals, gp, occ, occv, nid)
        if found is None:
            # Fenced in by other nets: they make way, the pad gets out, and they route again around it.
            who = blockers_to(pad, goals, nid)
            if not who: return [pad["ref"]]
            for b in who:
                drop_net(b); emit("unroute", net=nets[b]["name"])
            occ = build_occ(CLR + TW / 2).tolist(); occv = build_occ(CLR + VIA_D / 2).tolist()
            found, came = astar(start, goals, gp, occ, occv, nid)
            if found is None: return [pad["ref"]]
            moved = who
        else: moved = []
        tied.add(pad["ref"])
        path = [found]
        while path[-1] in came and path[-1] not in start: path.append(came[path[-1]])
        pts = [(c[0], c[2] * G, c[1] * G) for c in path] + [(path[-1][0], pad["x"], pad["y"])]
        for k in range(len(pts) - 1):
            (L1, x1, y1), (L2, x2, y2) = pts[k], pts[k + 1]
            if L1 != L2:
                VIAS.append({"x": x1, "y": y1, "nid": nid, "pad": pad["ref"]}); FEATS.append(("via", 2, nid, x1, y1, VIA_D / 2)); continue
            if abs(x1 - x2) < 1e-9 and abs(y1 - y2) < 1e-9: continue
            TRACKS.append({"L": L1, "x1": x1, "y1": y1, "x2": x2, "y2": y2, "w": TW, "nid": nid})
            FEATS.append(("seg", L1, nid, x1, y1, x2, y2, TW / 2))
        for b in moved:
            a_, b_ = len(TRACKS), len(VIAS)
            status[b] = route_net(b)
            emit("route", 0.2, **net_copper(b, a_, b_))
    return ["plane"]

def span(i):
    pts = [pad_pos(refs[p.split(".", 1)[0]], p.split(".", 1)[1]) for p in nets[i]["pins"]]
    return (max(q[0] for q in pts) - min(q[0] for q in pts)) + (max(q[1] for q in pts) - min(q[1] for q in pts))
ZONE_CLR, ZONE_MIN = 0.25, 0.2
def net_copper(i, a, b):
    return {"net": nets[i]["name"], "tracks": [[t["L"], t["x1"], t["y1"], t["x2"], t["y2"], t["w"]] for t in TRACKS[a:]], "vias": [[v["x"], v["y"]] for v in VIAS[b:]]}
def all_copper(ni):
    return {"net": nets[ni]["name"], "tracks": [[t["L"], t["x1"], t["y1"], t["x2"], t["y2"], t["w"]] for t in TRACKS if t["nid"] == ni + 1], "vias": [[v["x"], v["y"]] for v in VIAS if v["nid"] == ni + 1]}
# How often to try is the one thing here that depends on the clock, so a machine told how many tries
# the checked board took arrives at the same board however busy it is.
ATTEMPTS = int(_os.environ.get("REALITY_ATTEMPTS") or 0)
budget = float(P.get("routing_seconds", 240))
GROWS = not ATTEMPTS and free == parts
SIZES = 3 if GROWS else 1
t_all = _time.time()
for size in range(SIZES):
    order = sorted(range(len(nets)), key=lambda i: (nets[i]["name"] not in POUR_NETS, net_width(nets[i]) <= TW, span(i)))
    # A design may say which nets go first, from an earlier run that found an order that works.
    if P.get("route_first"):
        rank = {name: k for k, name in enumerate(P["route_first"])}
        order.sort(key=lambda i: (nets[i]["name"] not in POUR_NETS, rank.get(nets[i]["name"], len(rank))))
    BASE_FEATS = list(FEATS)
    def reset_routes():
        TRACKS.clear(); VIAS.clear(); FEATS[:] = BASE_FEATS
    emit("placed", 1.0, w=W, h=H)
    t0 = _time.time()
    best_state = None
    attempts_made = 0
    for attempt in range(ATTEMPTS or 12):
        attempts_made = attempt + 1
        reset_routes()
        emit("clear")
        status = {}
        for ni in order:
            a_, b_ = len(TRACKS), len(VIAS)
            status[ni] = route_net(ni)
            emit("route", 1.2 if attempt == 0 else 0.2, **net_copper(ni, a_, b_))
        failed = rip_up([ni for ni in order if not status[ni]], status, 0.2)
        if best_state is None or len(failed) < len(best_state[0]):
            best_state = (failed, list(TRACKS), list(VIAS), list(FEATS), dict(status))
            best_order = [nets[i]["name"] for i in order]
        if not failed or (not ATTEMPTS and _time.time() - t0 > budget / SIZES): break
        # whatever failed goes first next time: it gets the free board, the others route around it
        rest = [ni for ni in order if ni not in failed]
        if attempt >= 1: rnd.shuffle(rest)
        order = failed + rest
        order.sort(key=lambda i: nets[i]["name"] not in POUR_NETS)
    failed, tr_, vi_, fe_, status = best_state
    if not failed or size == SIZES - 1 or max(W, H) >= 200: break
    # Every part may move and it still does not route: more room, and a new placement.
    W = min(200.0, math.ceil(W * 1.2 / 5) * 5.0); H = min(200.0, math.ceil(H * 1.2 / 5) * 5.0)
    emit("board", w=W, h=H)
    place()
    emit("parts", 0.5, parts=part_frame())
    if placement_problem(): break
    TRACKS.clear(); VIAS.clear()
    copper_of_parts()
if LIVE and tr_ != TRACKS:
    emit("clear")
    for ni in range(len(nets)):
        emit("route", net=nets[ni]["name"], tracks=[[t["L"], t["x1"], t["y1"], t["x2"], t["y2"], t["w"]] for t in tr_ if t["nid"] == ni + 1], vias=[[v["x"], v["y"]] for v in vi_ if v["nid"] == ni + 1])
TRACKS[:] = tr_; VIAS[:] = vi_; FEATS[:] = fe_
# Stitching vias tie the planes on both sides together; whatever the plane cannot reach gets a track.
PLANE_CUT = {}
for name in POUR_NETS:
    ni = next(i for i, n in enumerate(nets) if n["name"] == name)
    occv = build_occ(CLR + VIA_D / 2)
    for p in PADS:
        for L in (0, 1):
            geom = ("circle", p["x"], p["y"], p["w"] / 2) if p["shape"] == "circle" else ("rect", p["x"], p["y"], p["w"] / 2, p["h"] / 2)
            paint(occv, L, geom, VIA_D / 2 + 0.05, -1)
    step = int(round(3.5 / G))
    for j in range(step, NY - step // 2, step):
        for i in range(step, NX - step // 2, step):
            if occv[0, j, i] == 0 and occv[1, j, i] == 0:
                x, y = i * G, j * G
                VIAS.append({"x": x, "y": y, "nid": ni + 1}); FEATS.append(("via", 2, ni + 1, x, y, VIA_D / 2))
    cut = tie_planes(ni)
    if cut: PLANE_CUT[name] = cut; status[ni] = False
    emit("unroute", net=name)
    emit("route", 0.5, **all_copper(ni))
# Where a track ends in the middle of another, that one is cut in two: a real junction for KiCad,
# which otherwise may call the joining end loose.
def split_at_junctions():
    changed = set()
    for _ in range(4):
        again = False
        for t in list(TRACKS):
            for x, y in ((t["x1"], t["y1"]), (t["x2"], t["y2"])):
                for o in TRACKS:
                    if o is t or o["nid"] != t["nid"] or o["L"] != t["L"]: continue
                    dx, dy = o["x2"] - o["x1"], o["y2"] - o["y1"]; ll = dx * dx + dy * dy
                    if ll < 1e-9: continue
                    u = ((x - o["x1"]) * dx + (y - o["y1"]) * dy) / ll
                    if u < 1e-6 or u > 1 - 1e-6: continue
                    if math.hypot(o["x1"] + u * dx - x, o["y1"] + u * dy - y) > 1e-6: continue
                    TRACKS.append(dict(o, x1=x, y1=y)); o["x2"], o["y2"] = x, y
                    FEATS.append(("seg", o["L"], o["nid"], x, y, TRACKS[-1]["x2"], TRACKS[-1]["y2"], o["w"] / 2))
                    changed.add(o["nid"] - 1); again = True
                    break
        if not again: break
    return sorted(changed)
for ni in split_at_junctions():
    emit("unroute", net=nets[ni]["name"])
    emit("route", **all_copper(ni))
emit("routed")
# For a run on another machine, which is to reach this same board.
json.dump(dict(P, board={"width_mm": W, "height_mm": H}, route_attempts=attempts_made, route_order=best_order), open("/output/design.json", "w"))
unrouted = [nets[i]["name"] for i in range(len(nets)) if not status[i]]
`;
const PCB_OUT = `
# ---- own design-rule check (analytic distances between copper items) -------------------------
def geom_of(f):
    kind = f[0]
    if kind == "seg": return ("seg", f[3], f[4], f[5], f[6], f[7])
    if kind in ("circle", "via", "hole"): return ("circle", f[3], f[4], f[5])
    return ("rect", f[3], f[4], f[5], f[6])
def self_drc():
    items = []
    for f in FEATS:
        g = geom_of(f)
        for L in ((0, 1) if f[1] == 2 else (f[1],)): items.append((L, f[2], g, bbox(g), f[0]))
    bad = 0
    for i in range(len(items)):
        Li, ni_, gi, bi, ki = items[i]
        for j in range(i + 1, len(items)):
            Lj, nj_, gj, bj, kj = items[j]
            if Li != Lj or ni_ == nj_ and ni_ != -1: continue
            if ki == "hole" and kj == "hole": continue
            if bi[0] - CLR > bj[2] or bj[0] - CLR > bi[2] or bi[1] - CLR > bj[3] or bj[1] - CLR > bi[3]: continue
            need = CLR - 0.002 if "hole" not in (ki, kj) else 0.25 - 0.002
            if distance(gi, gj) < need: bad += 1
    for f in FEATS:                                         # copper and the board edge
        if f[0] == "hole": continue
        bx = bbox(geom_of(f))
        if bx[0] < EDGE - 0.002 or bx[1] < EDGE - 0.002 or bx[2] > W - EDGE + 0.002 or bx[3] > H - EDGE + 0.002: bad += 1
    return bad
drc_violations = self_drc()

# ---- results ---------------------------------------------------------------------------------
LN = {0: "top", 1: "bottom", 2: "both"}
NETNAME = {i + 1: n["name"] for i, n in enumerate(nets)}
rows_out = []
for p in parts:
    rows_out.append(["part", p.ref, "", "top", round(p.x, 4), round(p.y, 4), p.rot, 0, round(2 * p.half()[0], 4), round(2 * p.half()[1], 4), 0, p.fp])
for ap in PADS:
    rows_out.append(["pad" if ap["shape"] != "npth" else "hole", ap["ref"], ap["net"], LN[ap["layer"]], round(ap["x"], 4), round(ap["y"], 4), "", "", round(ap["w"], 4), round(ap["h"], 4), ap["drill"], ap["shape"]])
for t in TRACKS:
    rows_out.append(["track", "", NETNAME[t["nid"]], LN[t["L"]], round(t["x1"], 4), round(t["y1"], 4), round(t["x2"], 4), round(t["y2"], 4), round(t["w"], 4), "", 0, "line"])
for v in VIAS:
    rows_out.append(["via", "", NETNAME[v["nid"]], "both", round(v["x"], 4), round(v["y"], 4), "", "", VIA_D, VIA_D, VIA_H, "circle"])
for x1, y1, x2, y2 in ((0, 0, W, 0), (W, 0, W, H), (W, H, 0, H), (0, H, 0, 0)):
    rows_out.append(["edge", "", "", "edge", x1, y1, x2, y2, 0.1, "", 0, "line"])
write_csv("result.csv", ["kind", "ref", "net", "layer", "x1", "y1", "x2", "y2", "w", "h", "drill", "shape"], rows_out)
write_csv("bom.csv", ["ref", "value", "footprint", "pads"], [[p.ref, p.value, p.fp, len(p.pads)] for p in parts])

# ---- KiCad board -----------------------------------------------------------------------------
def f6(v): return ("%.6f" % v).rstrip("0").rstrip(".") if v else "0"
def q(s): return '"' + str(s).replace('"', "'") + '"'
kid = {n["name"]: i + 1 for i, n in enumerate(nets)}
out = ['(kicad_pcb', '  (version 20240108)', '  (generator "reality")', '  (generator_version "1.0")', '  (general (thickness 1.6) (legacy_teardrops no))', '  (paper "A4")',
       '  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (32 "B.Adhes" user "B.Adhesive") (33 "F.Adhes" user "F.Adhesive") (34 "B.Paste" user) (35 "F.Paste" user) '
       '(36 "B.SilkS" user "B.Silkscreen") (37 "F.SilkS" user "F.Silkscreen") (38 "B.Mask" user) (39 "F.Mask" user) (40 "Dwgs.User" user "User.Drawings") '
       '(41 "Cmts.User" user "User.Comments") (42 "Eco1.User" user "User.Eco1") (43 "Eco2.User" user "User.Eco2") (44 "Edge.Cuts" user) (45 "Margin" user) '
       '(46 "B.CrtYd" user "B.Courtyard") (47 "F.CrtYd" user "F.Courtyard") (48 "B.Fab" user) (49 "F.Fab" user))',
       '  (setup (pad_to_mask_clearance 0))', '  (net 0 "")']
for n in nets: out.append('  (net %d %s)' % (kid[n["name"]], q(n["name"])))
for p in parts:
    out.append('  (footprint %s (layer "F.Cu") (at %s %s%s)' % (q(p.fp), f6(p.x), f6(p.y), (" " + str(p.rot)) if p.rot else ""))
    out.append('    (property "Reference" %s (at 0 %s 0) (layer "F.SilkS") (effects (font (size 0.8 0.8) (thickness 0.12))))' % (q(p.ref), f6(-p.hh0 - 0.5)))
    out.append('    (property "Value" %s (at 0 %s 0) (layer "F.Fab") (hide yes) (effects (font (size 1 1) (thickness 0.15))))' % (q(p.value or p.fp), f6(p.hh0 + 0.8)))
    out.append('    (attr %s)' % ("through_hole" if any(pd[6] > 0 for pd in p.pads) else "smd"))
    if p.ref in MODEL_FILE:
        out.append('    (model "\${KIPRJMOD}/%s" (offset (xyz 0 0 0)) (scale (xyz 0.3937008 0.3937008 0.3937008)) (rotate (xyz 0 0 0)))' % MODEL_FILE[p.ref])
    out.append('    (fp_rect (start %s %s) (end %s %s) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd"))' % (f6(-p.hw0), f6(-p.hh0), f6(p.hw0), f6(p.hh0)))
    for num, shape, px, py, pw, ph, dr in p.pads:
        at = "(at %s %s%s)" % (f6(px), f6(py), (" " + str(p.rot)) if p.rot else "")
        pin = "%s.%s" % (p.ref, num); nm = nets[pin_net[pin]]["name"] if pin in pin_net else None
        net = (" (net %d %s)" % (kid[nm], q(nm))) if nm else ""
        if shape == "npth":
            out.append('    (pad "" np_thru_hole circle %s (size %s %s) (drill %s) (layers "*.Cu" "*.Mask"))' % (at, f6(pw), f6(pw), f6(dr)))
        elif dr > 0:
            out.append('    (pad %s thru_hole %s %s (size %s %s) (drill %s) (layers "*.Cu" "*.Mask")%s)' % (q(num), "circle" if shape == "circle" else "rect", at, f6(pw), f6(ph), f6(dr), net))
        else:
            ex = " (roundrect_rratio 0.25)" if shape == "roundrect" else ""
            out.append('    (pad %s smd %s %s (size %s %s) (layers "F.Cu" "F.Paste" "F.Mask")%s%s)' % (q(num), "roundrect" if shape == "roundrect" else "rect", at, f6(pw), f6(ph), ex, net))
    out.append('  )')
for t in TRACKS:
    out.append('  (segment (start %s %s) (end %s %s) (width %s) (layer %s) (net %d))' % (f6(t["x1"]), f6(t["y1"]), f6(t["x2"]), f6(t["y2"]), f6(t["w"]), q("F.Cu" if t["L"] == 0 else "B.Cu"), kid[NETNAME[t["nid"]]]))
for v in VIAS:
    out.append('  (via (at %s %s) (size %s) (drill %s) (layers "F.Cu" "B.Cu") (net %d))' % (f6(v["x"]), f6(v["y"]), f6(VIA_D), f6(VIA_H), kid[NETNAME[v["nid"]]]))
for x1, y1, x2, y2 in ((0, 0, W, 0), (W, 0, W, H), (W, H, 0, H), (0, H, 0, 0)):
    out.append('  (gr_line (start %s %s) (end %s %s) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))' % (f6(x1), f6(y1), f6(x2), f6(y2)))
out.append(')')
open("/output/board.kicad_pcb", "w").write("\\n".join(out) + "\\n")
# The board as it stood after placement, before any track: KiCad shows the ratsnest of what is
# still to connect, which is how the work went.
_placed = [l for l in out if not (l.startswith("  (segment ") or l.startswith("  (via "))]
open("/output/stage_1_placed.kicad_pcb", "w").write("\\n".join(_placed) + "\\n")

# ---- Gerber (RS-274X) and Excellon ----------------------------------------------------------
def gcoord(x, y): return "X%dY%d" % (round(x * 1e6), round((H - y) * 1e6))
def gerber(name, layer):
    ap = {}; body = []
    def aperture(shape, w, h=None):
        key = (shape, round(w, 4), round(h or w, 4))
        if key not in ap: ap[key] = 10 + len(ap)
        return ap[key]
    cur = None
    def select(d):
        nonlocal cur
        if cur != d: body.append("D%d*" % d); cur = d
    if layer == "edge":
        d = aperture("C", 0.1); select(d)
        for x1, y1, x2, y2 in ((0, 0, W, 0), (W, 0, W, H), (W, H, 0, H), (0, H, 0, 0)): body.append(gcoord(x1, y1) + "D02*"); body.append(gcoord(x2, y2) + "D01*")
    else:
        L = 0 if layer == "top" else 1
        for t in TRACKS:
            if t["L"] != L: continue
            select(aperture("C", t["w"])); body.append(gcoord(t["x1"], t["y1"]) + "D02*"); body.append(gcoord(t["x2"], t["y2"]) + "D01*")
        for a in PADS:
            if a["shape"] == "npth" or (a["layer"] != 2 and a["layer"] != L): continue
            if a["shape"] == "circle": select(aperture("C", a["w"]))
            elif a["shape"] == "roundrect" or a["shape"] == "rect": select(aperture("R", a["w"], a["h"]))
            else: select(aperture("O", a["w"], a["h"]))
            body.append(gcoord(a["x"], a["y"]) + "D03*")
        for v in VIAS: select(aperture("C", VIA_D)); body.append(gcoord(v["x"], v["y"]) + "D03*")
    head = ["G04 Reality PCB %s*" % name, "%MOMM*%", "%FSLAX46Y46*%", "G01*"]
    for (shape, w, h), d in ap.items(): head.append("%%ADD%d%s,%s*%%" % (d, shape, ("%.4f" % w) if shape == "C" else "%.4fX%.4f" % (w, h)))
    return "\\n".join(head + body + ["M02*"]) + "\\n"
open("/output/copper_top.gtl", "w").write(gerber("top copper", "top"))
open("/output/copper_bottom.gbl", "w").write(gerber("bottom copper", "bottom"))
open("/output/outline.gko", "w").write(gerber("outline", "edge"))
holes = {}
for a in PADS:
    if a["drill"] > 0: holes.setdefault(round(a["drill"], 3), []).append((a["x"], a["y"]))
for v in VIAS: holes.setdefault(round(VIA_H, 3), []).append((v["x"], v["y"]))
dr_lines = ["M48", "; Reality PCB", "METRIC,TZ"]
for i, d in enumerate(sorted(holes)): dr_lines.append("T%dC%.3f" % (i + 1, d))
dr_lines += ["%", "G90", "G05"]
for i, d in enumerate(sorted(holes)):
    dr_lines.append("T%d" % (i + 1))
    for x, y in holes[d]: dr_lines.append("X%.3fY%.3f" % (x, H - y))
dr_lines.append("M30")
open("/output/drill.drl", "w").write("\\n".join(dr_lines) + "\\n")

# ---- summary ---------------------------------------------------------------------------------
tlen = sum(math.hypot(t["x2"] - t["x1"], t["y2"] - t["y1"]) for t in TRACKS)
summary({
    "model": "Auto-placed (simulated annealing on half-perimeter wire length) and routed (A* on a %.2f mm grid, two layers, 45-degree tracks, vias) board; KiCad 8 board file, Gerber RS-274X and Excellon drill; clearances by construction and a second analytic design-rule check" % G,
    "board_width_mm": W, "board_height_mm": H, "parts": len(parts), "nets": len(nets), "pads": sum(1 for a in PADS if a["shape"] != "npth"),
    "nets_routed": len(nets) - len(unrouted), "unrouted": unrouted, "tracks": len(TRACKS), "vias": len(VIAS), "track_length_mm": tlen,
    "wirelength_hpwl_mm": wirelength(), "drc_violations": drc_violations, "clearance_mm": CLR, "track_mm": TW, "power_track_mm": PW,
    "via_dia_mm": VIA_D, "via_drill_mm": VIA_H, "edge_clearance_mm": EDGE, "grid_mm": G,
    "design_ok": bool(not unrouted and drc_violations == 0 and not ERC_FAILED),
    "pour_nets": POUR_NETS,
    "electrical": ELECTRICAL,
    "plane_cut_off": PLANE_CUT,
    "placement": {p.ref: [round(p.x, 3), round(p.y, 3), p.rot] for p in parts},
})
print("%d parts, %d nets: %d of %d routed, %.1f mm of track, %d vias, %d design-rule violations on a %.0f x %.0f mm board%s." % (
    len(parts), len(nets), len(nets) - len(unrouted), len(nets), tlen, len(VIAS), drc_violations, W, H,
    "" if (W, H) == ASKED else " (enlarged from %.0f x %.0f, where the parts did not fit)" % ASKED))
# Copper pours are KiCad's to fill and KiCad's rule check judges them; the table above stays the
# routed board, which connects without them.
emit("pours", pours=P.get("pours") or [])
emit("done")
`;
const PCB_SCENE = `
# ---- 3D scene: every part as a few bodies (size, colour, material), so a viewer can draw it ----
# Bodies are in absolute board coordinates: x right, y down (like KiCad), z up from the board
# surface. "c" is the centre of the footprint of the body in x and y, z0 the height of its
# underside; "d" is its size (box: dx, dy, dz; cyl: diameter, diameter, dz).
import json as _json

CHIP_BODY = {"0402": (1.0, 0.5, 0.35), "0603": (1.6, 0.8, 0.45), "0805": (2.0, 1.25, 0.5), "1206": (3.2, 1.6, 0.55)}
LED_COLOURS = {"red": "#ff3b30", "green": "#2ee06a", "blue": "#3b82ff", "yellow": "#ffd23b", "white": "#f4f1e8", "orange": "#ff8a1f"}
BLACK, GREY, SILVER, GOLD, TAN = "#141417", "#3a3b40", "#c9ccd2", "#d9b24c", "#b8935f"

def _part_bodies(p):
    """Bodies of one part in its own frame (rot 0), then moved and turned onto the board."""
    n = p.fp.upper(); out = []
    def box(cx, cy, z0, dx, dy, dz, col, metal=0.0, rough=0.5, glow=0.0):
        out.append({"s": "box", "c": [cx, cy, z0], "d": [dx, dy, dz], "col": col, "m": metal, "r": rough, "g": glow})
    def cyl(cx, cy, z0, dia, dz, col, metal=0.0, rough=0.5):
        out.append({"s": "cyl", "c": [cx, cy, z0], "d": [dia, dia, dz], "col": col, "m": metal, "r": rough, "g": 0.0})
    import re as _re
    m = _re.fullmatch(r"(R|C|L|LED|D)(0402|0603|0805|1206)", n)
    if m:
        kind, size = m.group(1), m.group(2); L, Wd, Ht = CHIP_BODY[size]; cap = 0.3 if size != "1206" else 0.45
        val = (p.value or "").lower()
        body = {"R": BLACK, "C": TAN, "L": GREY, "D": BLACK, "LED": "#e9e4d6"}[kind]
        if kind == "LED":
            col = next((c for k, c in LED_COLOURS.items() if k in val), LED_COLOURS["red"])
            box(0, 0, 0.0, L, Wd, Ht * 0.7, "#e9e4d6", 0.0, 0.4)
            box(0, 0, Ht * 0.7, L - 2 * cap, Wd * 0.8, Ht * 0.45, col, 0.0, 0.15, glow=0.55)
        else:
            box(0, 0, 0.0, L - 2 * cap, Wd, Ht, body, 0.0, 0.55 if kind == "R" else 0.7)
            for s in (-1, 1): box(s * (L / 2 - cap / 2), 0, 0.0, cap, Wd * 1.02, Ht * 1.04, SILVER, 1.0, 0.3)
        if kind == "R" and val: pass
        return out
    m = _re.fullmatch(r"(SOIC|TSSOP)(\\d+)", n)
    if m:
        fam, k = m.group(1), int(m.group(2)); pitch = 1.27 if fam == "SOIC" else 0.65
        bw = 3.9 if fam == "SOIC" else 4.4
        bl = k // 2 * pitch - 0.18 if fam == "SOIC" else {14: 5.0, 16: 5.0, 20: 6.5}[k]
        ht = 1.5 if fam == "SOIC" else 1.0
        box(0, 0, 0.12, bw - 0.6, bl, ht - 0.12, BLACK, 0.0, 0.32)
        box(0, 0, 0.12, bw, bl, 0.05, BLACK, 0.0, 0.32)
        cyl(-bw / 2 + 0.7, -bl / 2 + 0.7, ht + 0.0, 0.7, 0.01, GREY, 0.0, 0.6)
        for num, shape, px, py, pw, ph, dr in p.pads:
            s = 1 if px > 0 else -1
            box(s * (bw / 2 - 0.1 + (abs(px) + pw / 2 - bw / 2 + 0.1) / 2), py, 0.0, abs(px) + pw / 2 - bw / 2 + 0.1 + 0.2, ph * 0.7, 0.2, SILVER, 1.0, 0.28)
        return out
    if n in ("SOT23", "SOT23_5"):
        bl = 2.9; bw = 1.3
        box(0, 0, 0.1, bw, bl, 1.0, BLACK, 0.0, 0.32)
        for num, shape, px, py, pw, ph, dr in p.pads:
            s = 1 if px > 0 else -1
            box(s * (bw / 2 + (abs(px) + pw / 2 - bw / 2) / 2), py, 0.0, abs(px) + pw / 2 - bw / 2, ph * 0.7, 0.2, SILVER, 1.0, 0.28)
        return out
    m = _re.fullmatch(r"DIP(\\d+)", n)
    if m:
        k = int(m.group(1)); bl = k // 2 * 2.54 - 0.4
        box(0, 0, 0.5, 6.35, bl, 3.6, BLACK, 0.0, 0.34)
        cyl(0, -bl / 2, 4.1, 2.0, 0.01, GREY, 0.0, 0.6)
        for num, shape, px, py, pw, ph, dr in p.pads:
            box(px, py, -3.0, 0.5, 0.5, 3.9, SILVER, 1.0, 0.25)
            box(px * 0.9, py, 0.0, 1.2, 0.5, 0.5, SILVER, 1.0, 0.25)
        return out
    m = _re.fullmatch(r"HEADER(?:(\\d+)X)?(\\d+)", n)
    if m:
        rows, cols = int(m.group(1) or 1), int(m.group(2))
        box(0, 0, 0.0, 2.54 * rows, 2.54 * cols, 2.5, BLACK, 0.0, 0.4)
        for num, shape, px, py, pw, ph, dr in p.pads:
            box(px, py, -3.0, 0.64, 0.64, 11.0, GOLD, 1.0, 0.28)
        return out
    if n.startswith("HOLE"): return out
    if n == "TESTPOINT": return out
    if n.startswith("PAD_TH"): return out
    m = _re.fullmatch(r"TQFP(\\d+)", n)
    if m:
        k = int(m.group(1)); span = (k // 4 - 1) * 0.8; bs = span + 1.8
        box(0, 0, 0.15, bs, bs, 1.1, BLACK, 0.0, 0.32)
        cyl(-bs / 2 + 1.0, -bs / 2 + 1.0, 1.25, 0.7, 0.01, GREY, 0.0, 0.6)
        for num, shape, px, py, pw, ph, dr in p.pads:
            if pw > ph: box(px * 0.92, py, 0.0, pw + 0.6, 0.3, 0.2, SILVER, 1.0, 0.28)
            else: box(px, py * 0.92, 0.0, 0.3, ph + 0.6, 0.2, SILVER, 1.0, 0.28)
        return out
    if n == "PQFN5X6":
        box(0, -0.2, 0.05, 5.0, 5.9, 1.0, BLACK, 0.0, 0.32)
        cyl(-1.8, -2.4, 1.05, 0.5, 0.01, GREY, 0.0, 0.6)
        for num, shape, px, py, pw, ph, dr in p.pads:
            if num != "5": box(px, py, 0.0, pw * 0.7, ph, 0.15, SILVER, 1.0, 0.3)
        return out
    if n == "SOT223":
        box(0, 0, 0.1, 6.5, 3.5, 1.6, BLACK, 0.0, 0.32)
        box(0, -2.6, 0.0, 3.0, 2.0, 0.25, SILVER, 1.0, 0.3)
        for num, shape, px, py, pw, ph, dr in p.pads:
            if num != "2b": box(px, py - 0.3, 0.0, 0.7, 2.0, 0.2, SILVER, 1.0, 0.3)
        return out
    if n == "SOD123":
        box(0, 0, 0.05, 2.7, 1.6, 1.0, BLACK, 0.0, 0.32)
        box(-1.0, 0, 1.05, 0.3, 1.6, 0.01, SILVER, 0.0, 0.5)
        for s in (-1, 1): box(s * 1.65, 0, 0.0, 0.8, 0.6, 0.15, SILVER, 1.0, 0.3)
        return out
    if n == "R2512":
        box(0, 0, 0.0, 4.6, 3.2, 0.6, BLACK, 0.0, 0.5)
        for s in (-1, 1): box(s * 2.9, 0, 0.0, 1.2, 3.25, 0.65, SILVER, 1.0, 0.3)
        return out
    if n == "XTAL3225":
        box(0, 0, 0.05, 3.2, 2.5, 0.75, SILVER, 1.0, 0.22)
        return out
    m = _re.fullmatch(r"CAPE(\\d+)", n)
    if m:
        d = float(m.group(1))
        box(0, 0, 0.0, d + 0.6, d + 0.6, 1.0, BLACK, 0.0, 0.5)
        cyl(0, 0, 1.0, d, d * 1.1, "#e8e9eb", 0.6, 0.35)
        cyl(0, 0, 1.0 + d * 1.1, d * 0.72, 0.03, "#c9ccd2", 1.0, 0.3)
        box(-d * 0.26, 0, 1.0 + d * 1.1 + 0.02, d * 0.2, d * 0.72, 0.03, BLACK, 0.0, 0.5)
        return out
    if n == "L_SMD6":
        box(0, 0, 0.0, 6.4, 6.2, 3.0, "#26272b", 0.0, 0.55)
        cyl(0, 0, 3.0, 4.2, 0.02, GREY, 0.2, 0.4)
        return out
    if n == "SW_TACT":
        box(0, 0, 0.0, 6.2, 6.2, 2.2, "#b9bcc2", 1.0, 0.4)
        box(0, 0, 2.2, 5.2, 5.2, 0.4, BLACK, 0.0, 0.5)
        cyl(0, 0, 2.6, 3.5, 1.8, BLACK, 0.0, 0.35)
        for num, shape, px, py, pw, ph, dr in p.pads: box(px, py, 0.0, pw, 0.6, 0.15, SILVER, 1.0, 0.3)
        return out
    m = _re.fullmatch(r"JST(\\d+)", n)
    if m:
        k = int(m.group(1)); span = (k - 1) * 1.25; ivory = "#efe9d8"
        box(0, -1.0, 0.0, span + 3.4, 4.6, 3.0, ivory, 0.0, 0.5)
        box(0, -1.4, 2.2, span + 2.2, 3.4, 0.9, "#d8d1bd", 0.0, 0.5)
        for num, shape, px, py, pw, ph, dr in p.pads:
            if num.startswith("MP"): box(px, py, 0.0, pw * 0.8, ph, 2.2, SILVER, 1.0, 0.3)
            else: box(px, py - 0.2, 0.0, 0.4, ph + 0.6, 0.2, SILVER, 1.0, 0.3)
        return out
    # A part of the bot's own (CUSTOM, with pads): a moulded body over its pads, gold pins through
    # the through-hole pads, silver leads on the surface pads and a pin-1 mark.
    pads = p.pads or []
    th = [pd for pd in pads if pd[6] > 0]
    smd = [pd for pd in pads if pd[6] <= 0]
    if smd:
        reach = max(max(pd[4], pd[5]) for pd in smd)
        hw, hh = max(0.4, p.hw0 - 0.25 - reach * 0.55), max(0.4, p.hh0 - 0.25 - reach * 0.55)
    else:
        hw, hh = max(0.4, p.hw0 - 0.25), max(0.4, p.hh0 - 0.25)
    ht = min(6.0, 0.9 + 0.35 * min(hw, hh))
    z0 = 0.5 if th else 0.1
    box(0, 0, z0, 2 * hw, 2 * hh, ht, BLACK, 0.0, 0.34)
    box(0, 0, z0 + ht, 2 * hw * 0.92, 2 * hh * 0.92, 0.02, GREY, 0.0, 0.6)
    for num, shape, px, py, pw, ph, dr in th:
        d = min(0.9, max(0.4, dr * 0.75))
        box(px, py, -3.0, d, d, 3.0 + z0 + ht + 1.5, GOLD, 1.0, 0.28)
    for num, shape, px, py, pw, ph, dr in smd:
        box(px, py, 0.0, pw * 0.8, ph * 0.8, z0 + 0.12, SILVER, 1.0, 0.28)
    if pads:
        cyl(-hw * 0.7, -hh * 0.7, z0 + ht, min(0.6, min(hw, hh) * 0.5), 0.03, SILVER, 0.0, 0.5)
    return out

def _place(p, b):
    cx, cy = rot_xy(b["c"][0], b["c"][1], p.rot)
    dx, dy, dz = b["d"]
    if p.rot % 180: dx, dy = dy, dx
    return {"s": b["s"], "c": [round(p.x + cx, 4), round(p.y + cy, 4), round(b["c"][2], 4)], "d": [round(dx, 4), round(dy, 4), round(dz, 4)],
            "col": b["col"], "m": b["m"], "r": b["r"], "g": b.get("g", 0.0)}

_scene = {
    "board": {"w": W, "h": H, "t": 1.6},
    "parts": [{"ref": p.ref, "fp": p.fp, "value": p.value, "x": round(p.x, 4), "y": round(p.y, 4), "rot": p.rot,
               "hw": round(p.hw0 - 0.25, 3), "hh": round(p.hh0 - 0.25, 3),
               "bodies": [_place(p, b) for b in _part_bodies(p)]} for p in parts],
}
open("/output/scene.json", "w").write(_json.dumps(_scene, separators=(",", ":")))

# ---- the same parts as VRML models for KiCad's own 3D viewer ----------------------------------
# One file per distinct part (footprint and look), in millimetres with z up; KiCad reads VRML in
# units of 2.54 mm, so the footprint's (model ...) scales by 1/2.54. Its y axis points up where
# the footprint's points down, hence -y.
import hashlib as _hashlib

def _rgb(hexcol):
    return tuple(int(hexcol[i:i + 2], 16) / 255 for i in (1, 3, 5))

def _wrl(bodies):
    out = ["#VRML V2.0 utf8"]
    for b in bodies:
        dx, dy, dz = b["d"]; cx, cy, z0 = b["c"]
        r, g, bl = _rgb(b["col"])
        spec = 0.9 if b["m"] > 0.5 else 0.3
        emi = b.get("g", 0.0)
        material = ("Material { diffuseColor %.3f %.3f %.3f specularColor %.2f %.2f %.2f emissiveColor %.3f %.3f %.3f ambientIntensity 0.35 shininess %.2f }"
                    % (r, g, bl, spec, spec, spec, r * emi, g * emi, bl * emi, 0.85 if b["m"] > 0.5 else 0.4))
        pos = "translation %.4f %.4f %.4f" % (cx, -cy, z0 + dz / 2)
        if b["s"] == "box":
            out.append("Transform { %s children [ Shape { appearance Appearance { material %s } geometry Box { size %.4f %.4f %.4f } } ] }" % (pos, material, dx, dy, dz))
        else:
            # KiCad's reader shows no Cylinder node, so a round body is a twenty-four sided prism.
            r0, n_ = dx / 2, 24
            pts = []
            for z_ in (-dz / 2, dz / 2):
                for k in range(n_):
                    pts.append("%.4f %.4f %.4f" % (r0 * math.cos(2 * math.pi * k / n_), r0 * math.sin(2 * math.pi * k / n_), z_))
            faces = [" ".join(str(k) for k in range(n_ - 1, -1, -1)) + " -1", " ".join(str(n_ + k) for k in range(n_)) + " -1"]
            for k in range(n_):
                faces.append("%d %d %d %d -1" % (k, (k + 1) % n_, n_ + (k + 1) % n_, n_ + k))
            out.append("Transform { %s children [ Shape { appearance Appearance { material %s } geometry IndexedFaceSet { creaseAngle 0.6 coord Coordinate { point [ %s ] } coordIndex [ %s ] } } ] }" % (pos, material, ", ".join(pts), " ".join(faces)))
    return "\\n".join(out) + "\\n"

MODEL_FILE = {}
for _p in parts:
    _local = _part_bodies(_p)
    if not _local: continue
    _key = _hashlib.md5(_json.dumps(_local, sort_keys=True).encode()).hexdigest()[:6]
    _name = "model_%s_%s.wrl" % (_p.fp.lower(), _key)
    if _name not in MODEL_FILE.values():
        open("/output/" + _name, "w").write(_wrl(_local))
    MODEL_FILE[_p.ref] = _name
`;
const PCB_CHECK = `
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
# A net joined by a copper plane has no complete track path to find; KiCad's rule check judges it.
for net, ps in nets_pins.items():
    if len(ps) < 2 or net in (claim.get("pour_nets") or []): continue
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
        if ch == '"' and prev != "\\\\": quoted = not quoted
        if not quoted:
            depth += (ch == "(") - (ch == ")")
            if depth < 0: break
        prev = ch
    if depth != 0: mismatches.append({"problem": "board file brackets do not balance"})
    # \\s, not a space: KiCad puts a line break there when it saves the file itself.
    k_seg = len(re.findall(r"\\(segment\\s", kicad)); k_via = len(re.findall(r"\\(via\\s", kicad)); k_fp = len(re.findall(r"\\(footprint\\s", kicad))
    k_pad = len(re.findall(r"\\(pad\\s", kicad))
    t_seg = sum(1 for r in data if r["kind"] == "track"); t_pad = sum(1 for r in data if r["kind"] in ("pad", "hole"))
    if k_seg != t_seg: mismatches.append({"problem": "segments in the board file", "file": k_seg, "table": t_seg})
    if k_via != nvias: mismatches.append({"problem": "vias in the board file", "file": k_via, "table": nvias})
    if k_fp != len(parts_): mismatches.append({"problem": "footprints in the board file", "file": k_fp, "table": len(parts_)})
    if k_pad != t_pad: mismatches.append({"problem": "pads in the board file", "file": k_pad, "table": t_pad})
    ksum = 0.0
    for m in re.finditer(r"\\(segment\\s+(?:\\(locked\\s+\\w+\\)\\s+)?\\(start\\s+([-\\d.]+)\\s+([-\\d.]+)\\)\\s+\\(end\\s+([-\\d.]+)\\s+([-\\d.]+)\\)", kicad):
        ksum += math.hypot(float(m.group(3)) - float(m.group(1)), float(m.group(4)) - float(m.group(2)))
    if abs(ksum - tl) > 1e-3 * max(1, tl): mismatches.append({"problem": "track length in the board file", "file": ksum, "table": tl})
    # Copper this table does not describe must not pass unseen.
    for word in ("arc", "zone"):
        found = len(re.findall(r"\\(%s\\s" % word, kicad))
        if found: mismatches.append({"problem": "%s items in the board file are not checked" % word, "count": found})
    # After a hand edit: every pad still sits on the net the lab gave it (the two files, read here).
    def _pad_nets(text):
        out = {}
        for block in re.split(r"\\(footprint\\s", text)[1:]:
            ref = re.search(r'"Reference"\\s+"([^"]*)"', block)
            # By pad number, since KiCad sorts the pads when it saves.
            seen = {}
            for chunk in re.split(r"\\(pad\\s", block)[1:]:
                num_ = re.match(r'\\s*"([^"]*)"', chunk)
                key = "%s.%s" % (ref.group(1) if ref else "?", num_.group(1) if num_ else "")
                seen[key] = seen.get(key, 0) + 1
                net = re.search(r'\\(net\\s+\\d+\\s+"([^"]*)"', chunk)
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
_el = claim.get("electrical") or {}
for f_ in (_el.get("failed") or [])[:6]: mismatches.append({"problem": "electrical: " + str(f_.get("detail"))})
_measured = "%d copper items re-measured (%d close pairs, tightest gap %s mm, rule %.2f mm), connectivity rebuilt for %d nets (%d unrouted)" % (
    len(items), tested, "n/a" if worst > 1e8 else "%.3f" % worst, CLR, len(nets_pins), len(unrouted_check))
# A failed check says what failed, first: a bot or a person reads this to fix the board.
_what = "; ".join(dict.fromkeys(str(m.get("problem")) + (" (%s - %s)" % (m["a"], m["b"]) if "a" in m and "b" in m else "") for m in mismatches[:6]))
verdict(not mismatches, len(items), 0.0 if worst > 1e8 else worst, mismatches,
        ("Problems: " + _what + ". " + _measured) if mismatches else _measured + ", board file consistent" + ((", %d electrical rules from the parts' datasheets hold" % _el["rules_passed"]) if _el.get("covered") else "") + ((" (no rules for %s)" % ", ".join(_el["not_covered"][:6])) if _el.get("not_covered") else ""))
`;
const PCB_DRC = `
# ---- analytic distances between copper items -------------------------------------------------
def _pt_seg(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1; ll = dx * dx + dy * dy
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / ll)) if ll else 0.0
    return math.hypot(px - x1 - t * dx, py - y1 - t * dy)
def _cross(ax, ay, bx, by, cx, cy): return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
def _seg_seg(a, b):
    (x1, y1, x2, y2), (x3, y3, x4, y4) = a, b
    d1, d2 = _cross(x1, y1, x2, y2, x3, y3), _cross(x1, y1, x2, y2, x4, y4)
    d3, d4 = _cross(x3, y3, x4, y4, x1, y1), _cross(x3, y3, x4, y4, x2, y2)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)) and d1 != 0 and d2 != 0 and d3 != 0 and d4 != 0: return 0.0
    return min(_pt_seg(x1, y1, x3, y3, x4, y4), _pt_seg(x2, y2, x3, y3, x4, y4), _pt_seg(x3, y3, x1, y1, x2, y2), _pt_seg(x4, y4, x1, y1, x2, y2))
def _rect_pt(cx, cy, hw, hh, px, py): return math.hypot(max(0.0, abs(px - cx) - hw), max(0.0, abs(py - cy) - hh))
def _rect_edges(cx, cy, hw, hh):
    c = [(cx - hw, cy - hh), (cx + hw, cy - hh), (cx + hw, cy + hh), (cx - hw, cy + hh)]
    return [(c[i][0], c[i][1], c[(i + 1) % 4][0], c[(i + 1) % 4][1]) for i in range(4)]
def distance(a, b):
    ka, kb = a[0], b[0]
    if ka > kb: a, b, ka, kb = b, a, kb, ka                    # order: circle < rect < seg
    order_ = {"circle": 0, "rect": 1, "seg": 2}
    if order_[ka] > order_[kb]: a, b, ka, kb = b, a, kb, ka
    if ka == "circle" and kb == "circle": return math.hypot(a[1] - b[1], a[2] - b[2]) - a[3] - b[3]
    if ka == "circle" and kb == "rect": return _rect_pt(b[1], b[2], b[3], b[4], a[1], a[2]) - a[3]
    if ka == "circle" and kb == "seg": return _pt_seg(a[1], a[2], b[1], b[2], b[3], b[4]) - a[3] - b[5]
    if ka == "rect" and kb == "rect": return math.hypot(max(0.0, abs(a[1] - b[1]) - a[3] - b[3]), max(0.0, abs(a[2] - b[2]) - a[4] - b[4]))
    if ka == "rect" and kb == "seg":
        for x, y in ((b[1], b[2]), (b[3], b[4])):
            if abs(x - a[1]) <= a[3] and abs(y - a[2]) <= a[4]: return -b[5]
        return min(_seg_seg(e, b[1:5]) for e in _rect_edges(a[1], a[2], a[3], a[4])) - b[5]
    return _seg_seg(a[1:5], b[1:5]) - a[5] - b[5]
def bbox(g):
    if g[0] == "seg": return (min(g[1], g[3]) - g[5], min(g[2], g[4]) - g[5], max(g[1], g[3]) + g[5], max(g[2], g[4]) + g[5])
    if g[0] == "circle": return (g[1] - g[3], g[2] - g[3], g[1] + g[3], g[2] + g[3])
    return (g[1] - g[3], g[2] - g[4], g[1] + g[3], g[2] + g[4])
`;
const PCB_RECHECK = `
# ---- a board after a hand edit ---------------------------------------------------------------
# Reads the KiCad file as KiCad saved it (a real S-expression parser, since KiCad reformats the
# file), turns it into the same table the design engine writes and measures it again.
R = P["rules"]
CLR, TW = float(R["clearance_mm"]), float(R["track_mm"])
VIA_D, VIA_H, EDGE = float(R["via_dia_mm"]), float(R["via_drill_mm"]), float(R["edge_clearance_mm"])

def parse(text):
    root = []; stack = [root]; i = 0; n = len(text)
    while i < n:
        c = text[i]
        if c == "(":
            node = []; stack[-1].append(node); stack.append(node); i += 1
        elif c == ")":
            if len(stack) == 1: raise SystemExit("The board file has a closing bracket too many.")
            stack.pop(); i += 1
        elif c == '"':
            j = i + 1; buf = []
            while j < n and text[j] != '"':
                if text[j] == "\\\\" and j + 1 < n: j += 1
                buf.append(text[j]); j += 1
            stack[-1].append("".join(buf)); i = j + 1
        elif c.isspace():
            i += 1
        else:
            j = i
            while j < n and not text[j].isspace() and text[j] not in '()"': j += 1
            stack[-1].append(text[i:j]); i = j
    if len(stack) != 1: raise SystemExit("The board file has an opening bracket too many.")
    if not root or not isinstance(root[0], list) or root[0][:1] != ["kicad_pcb"]: raise SystemExit("This is not a KiCad board file.")
    return root[0]
def kids(node, name): return [k for k in node if isinstance(k, list) and k[:1] == [name]]
def one(node, name):
    f = kids(node, name)
    return f[0] if f else None
def xy(node, name):
    f = one(node, name)
    return (float(f[1]), float(f[2])) if f else None
def turn(x, y, deg):                                     # counter-clockwise on screen, y down
    a = math.radians(deg); c, s = math.cos(a), math.sin(a)
    return x * c + y * s, -x * s + y * c
def layer_of(names):
    top = any(l in ("F.Cu", "*.Cu", "F&B.Cu") for l in names); bottom = any(l in ("B.Cu", "*.Cu", "F&B.Cu") for l in names)
    return "both" if top and bottom else "top" if top else "bottom"

def read_board(text):
    b = parse(text)
    out = {"parts": [], "pads": [], "tracks": [], "vias": [], "edges": [], "unsupported": [], "pins": {}}
    netname = {int(k[1]): k[2] for k in kids(b, "net") if len(k) > 2}
    for fp in kids(b, "footprint"):
        at = one(fp, "at"); fx, fy = float(at[1]), float(at[2]); frot = float(at[3]) if len(at) > 3 else 0.0
        ref = next((k[2] for k in kids(fp, "property") if len(k) > 2 and k[1] == "Reference"), "")
        name = fp[1].split(":")[-1] if len(fp) > 1 and isinstance(fp[1], str) else ""
        hw = hh = 0.0
        for r in kids(fp, "fp_rect"):
            if one(r, "layer") and one(r, "layer")[1] in ("F.CrtYd", "B.CrtYd"):
                s, e = xy(r, "start"), xy(r, "end"); hw, hh = abs(e[0] - s[0]) / 2, abs(e[1] - s[1]) / 2
        if round(frot) % 180 == 90: hw, hh = hh, hw
        out["parts"].append(["part", ref, "", "top", round(fx, 4), round(fy, 4), frot, 0, round(2 * hw, 4), round(2 * hh, 4), 0, name])
        for pd in kids(fp, "pad"):
            kind, shape = pd[2], pd[3]
            pa = one(pd, "at"); px, py = float(pa[1]), float(pa[2]); ang = float(pa[3]) if len(pa) > 3 else 0.0
            dx, dy = turn(px, py, frot)
            size = one(pd, "size"); w, h = float(size[1]), float(size[2])
            if ang % 90: w = h = math.hypot(w, h)            # turned by hand: its bounding square, on the safe side
            elif round(ang) % 180 == 90: w, h = h, w
            dr = one(pd, "drill"); drill = 0.0
            if dr:
                vals = [float(v) for v in dr[1:] if isinstance(v, str) and re.fullmatch(r"[-\\d.]+", v)]
                drill = vals[0] if vals else 0.0
            net = one(pd, "net"); nm = net[2] if net and len(net) > 2 else ""
            layers = one(pd, "layers"); lay = layer_of(layers[1:] if layers else [])
            if kind == "np_thru_hole":
                out["pads"].append(["hole", ref, "", "both", round(fx + dx, 4), round(fy + dy, 4), "", "", round(w, 4), round(h, 4), drill, "npth"])
            else:
                pin = "%s.%s" % (ref, pd[1]); k = 1
                while "%s#%d" % (pin, k) in out["pins"]: k += 1
                out["pins"]["%s#%d" % (pin, k)] = nm
                out["pads"].append(["pad", ref, nm, lay, round(fx + dx, 4), round(fy + dy, 4), "", "", round(w, 4), round(h, 4), drill, "circle" if shape == "circle" else "rect"])
    for s in kids(b, "segment"):
        (x1, y1), (x2, y2) = xy(s, "start"), xy(s, "end"); lay = one(s, "layer")[1]
        if lay not in ("F.Cu", "B.Cu"): out["unsupported"].append("track on layer " + lay); continue
        out["tracks"].append(["track", "", netname.get(int(one(s, "net")[1]), ""), "top" if lay == "F.Cu" else "bottom", x1, y1, x2, y2, float(one(s, "width")[1]), "", 0, "line"])
    for v in kids(b, "via"):
        x, y = xy(v, "at"); d = float(one(v, "size")[1])
        out["vias"].append(["via", "", netname.get(int(one(v, "net")[1]), ""), "both", x, y, "", "", d, d, float(one(v, "drill")[1]), "circle"])
    for name in ("arc", "zone", "image", "group"):
        if name in ("arc", "zone") and kids(b, name): out["unsupported"].append("%d %s item(s)" % (len(kids(b, name)), name))
    xs = []; ys = []
    for g in kids(b, "gr_line") + kids(b, "gr_rect"):
        if one(g, "layer") and one(g, "layer")[1] == "Edge.Cuts":
            for k in (xy(g, "start"), xy(g, "end")): xs.append(k[0]); ys.append(k[1])
    if not xs: raise SystemExit("The board file has no outline on Edge.Cuts.")
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    for e in ((x0, y0, x1, y0), (x1, y0, x1, y1), (x1, y1, x0, y1), (x0, y1, x0, y0)):
        out["edges"].append(["edge", "", "", "edge", e[0], e[1], e[2], e[3], 0.1, "", 0, "line"])
    out["box"] = (x0, y0, x1, y1)
    return out

BOARD = read_board(P["board_kicad"])
open("/output/board.kicad_pcb", "w").write(P["board_kicad"])
ORIGINAL = None
if P.get("original_kicad"):
    ORIGINAL = read_board(P["original_kicad"])
    open("/output/original.kicad_pcb", "w").write(P["original_kicad"])
write_csv("result.csv", ["kind", "ref", "net", "layer", "x1", "y1", "x2", "y2", "w", "h", "drill", "shape"],
          BOARD["parts"] + BOARD["pads"] + BOARD["tracks"] + BOARD["vias"] + BOARD["edges"])

# Analytic distances on the items of the file (the check measures them another way).
LAYERS = {"top": (0,), "bottom": (1,), "both": (0, 1)}
items = []
for r in BOARD["pads"]:
    if r[0] == "hole": g = ("circle", r[4], r[5], r[10] / 2)
    elif r[11] == "circle": g = ("circle", r[4], r[5], r[8] / 2)
    else: g = ("rect", r[4], r[5], r[8] / 2, r[9] / 2)
    items.append(("hole" if r[0] == "hole" else "pad", "#hole" if r[0] == "hole" else r[2], LAYERS[r[3]], g, bbox(g)))
for r in BOARD["tracks"]:
    g = ("seg", r[4], r[5], r[6], r[7], r[8] / 2); items.append(("track", r[2], LAYERS[r[3]], g, bbox(g)))
for r in BOARD["vias"]:
    g = ("circle", r[4], r[5], r[8] / 2); items.append(("via", r[2], (0, 1), g, bbox(g)))
violations = 0
parent = list(range(len(items)))
def find(x):
    while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
    return x
for i in range(len(items)):
    ki, ni, li, gi, bi = items[i]
    for j in range(i + 1, len(items)):
        kj, nj, lj, gj, bj = items[j]
        if not set(li) & set(lj): continue
        if ni == nj and ni != "":
            if ki == "hole" or bi[0] > bj[2] or bj[0] > bi[2] or bi[1] > bj[3] or bj[1] > bi[3]: continue
            if distance(gi, gj) <= 0.005: parent[find(i)] = find(j)
            continue
        if ki == "hole" and kj == "hole": continue
        if bi[0] - CLR > bj[2] or bj[0] - CLR > bi[2] or bi[1] - CLR > bj[3] or bj[1] - CLR > bi[3]: continue
        need = CLR if "hole" not in (ki, kj) else 0.25
        if distance(gi, gj) < need - 0.002: violations += 1
X0, Y0, X1, Y1 = BOARD["box"]
for k, n_, l_, g_, b_ in items:
    if k == "hole": continue
    if b_[0] < X0 + EDGE - 0.002 or b_[1] < Y0 + EDGE - 0.002 or b_[2] > X1 - EDGE + 0.002 or b_[3] > Y1 - EDGE + 0.002: violations += 1
pins = {}
for i, it in enumerate(items):
    if it[0] == "pad" and it[1]: pins.setdefault(it[1], []).append(i)
unrouted = sorted(n for n, ps in pins.items() if len(ps) > 1 and len({find(p) for p in ps}) > 1)

# What the hand changed, compared with the board the lab made.
changes = {}
nets_changed = []
if ORIGINAL:
    a, b = ORIGINAL["pins"], BOARD["pins"]
    nets_changed = sorted(k.split("#")[0] for k in set(a) | set(b) if a.get(k) != b.get(k))
    was = {(r[1], r[4], r[5]) for r in ORIGINAL["parts"]}; now = {(r[1], r[4], r[5]) for r in BOARD["parts"]}
    tkey = lambda r: (r[3], r[4], r[5], r[6], r[7], r[8])
    t0, t1 = {tkey(r) for r in ORIGINAL["tracks"]}, {tkey(r) for r in BOARD["tracks"]}
    changes = {"parts_moved": sorted({k[0] for k in now - was}), "tracks_added": len(t1 - t0), "tracks_removed": len(t0 - t1),
               "vias_before": len(ORIGINAL["vias"]), "vias_after": len(BOARD["vias"]), "tracks_before": len(ORIGINAL["tracks"]), "tracks_after": len(BOARD["tracks"])}

tlen = sum(math.hypot(r[6] - r[4], r[7] - r[5]) for r in BOARD["tracks"])
nets_total = len(pins)
ok = not unrouted and violations == 0 and not nets_changed and not BOARD["unsupported"]
summary({
    "model": "The board file as saved after a hand edit, read with an S-expression parser and measured again with analytic distances",
    "hand_edited": True, "board_width_mm": X1 - X0, "board_height_mm": Y1 - Y0, "parts": len(BOARD["parts"]), "nets": nets_total,
    "pads": sum(1 for r in BOARD["pads"] if r[0] == "pad"), "nets_routed": nets_total - len(unrouted), "unrouted": unrouted,
    "tracks": len(BOARD["tracks"]), "vias": len(BOARD["vias"]), "track_length_mm": tlen, "drc_violations": violations,
    "clearance_mm": CLR, "track_mm": TW, "via_dia_mm": VIA_D, "via_drill_mm": VIA_H, "edge_clearance_mm": EDGE,
    "changes": changes, "pads_with_changed_net": nets_changed, "unsupported_items": BOARD["unsupported"], "design_ok": bool(ok),
})
print("Board after the edit: %d of %d nets routed, %d design-rule violations, %d pads on another net, %s." % (
    nets_total - len(unrouted), nets_total, violations, len(nets_changed), "OK" if ok else "needs rework"))
`;

const mm = z.number().min(-1000).max(1000);
const ref = z
  .string()
  .min(1)
  .max(12)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const part = z
  .object({
    ref,
    footprint: z.string().min(2).max(24),
    value: z.string().max(40).optional(),
    at: z.tuple([mm, mm]).optional(),
    rot: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
    rot_locked: z.boolean().optional(),
    edge: z.enum(['left', 'right', 'top', 'bottom']).optional(),
    pads: z
      .array(
        z
          .object({
            num: z.union([z.string().max(8), z.number()]),
            shape: z.enum(['rect', 'roundrect', 'circle']).default('rect'),
            x: mm,
            y: mm,
            w: z.number().positive().max(50),
            h: z.number().positive().max(50),
            drill: z.number().min(0).max(10).optional(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
  })
  .strict();
const net = z
  .object({
    name: z
      .string()
      .min(1)
      .max(30)
      .regex(/^[A-Za-z0-9_+.-]+$/),
    pins: z.array(z.string().min(3).max(24)).min(1).max(300),
    class: z.enum(['signal', 'power']).optional(),
    width_mm: z.number().min(0.1).max(5).optional(),
  })
  .strict();
const EXAMPLE = {
  parts: [
    { ref: 'U1', footprint: 'SOIC8', value: 'NE555' },
    { ref: 'R1', footprint: 'R0603', value: '10k' },
    { ref: 'R2', footprint: 'R0603', value: '47k' },
    { ref: 'R3', footprint: 'R0603', value: '470' },
    { ref: 'C1', footprint: 'C0603', value: '10u' },
    { ref: 'C2', footprint: 'C0603', value: '100n' },
    { ref: 'D1', footprint: 'LED0603', value: 'red' },
    { ref: 'J1', footprint: 'HEADER1x2', value: 'power', edge: 'left' },
  ],
  nets: [
    { name: 'VCC', class: 'power', pins: ['J1.1', 'U1.8', 'U1.4', 'R1.1', 'C2.1'] },
    { name: 'GND', class: 'power', pins: ['J1.2', 'U1.1', 'C1.2', 'C2.2', 'D1.1'] },
    { name: 'DIS', pins: ['U1.7', 'R1.2', 'R2.1'] },
    { name: 'TRIG', pins: ['U1.2', 'U1.6', 'R2.2', 'C1.1'] },
    { name: 'OUT', pins: ['U1.3', 'R3.1'] },
    { name: 'LED', pins: ['R3.2', 'D1.2'] },
    { name: 'CV', pins: ['U1.5'] },
  ],
  board: { width_mm: 50, height_mm: 35 },
};

export const PCB_ENGINE: LabEngine = {
  name: 'pcb_design',
  domain: 'electronics',
  title: 'Printed circuit board',
  description:
    'Designs a two-layer printed circuit board: places the parts, routes the nets, and writes a KiCad 8 board file (board.kicad_pcb), Gerber copper and outline layers, an Excellon drill file and a bill of materials. Give board {width_mm, height_mm}, parts [{ref, footprint, value, at, rot, edge}] and nets [{name, pins:["U1.8","R1.1"], class:"power"|"signal", width_mm}]. Footprints: R/C/L/LED/D with 0402, 0603, 0805 or 1206 (e.g. R0603), SOIC8/14/16, TSSOP14/16/20, TQFP32/44/48/64, PQFN5X6, SOT223, SOD123, R2512, XTAL3225, CAPE8/10, L_SMD6, SW_TACT, JST<n>, PAD_TH<d>, SOT23, SOT23_5, DIP8/14/16/20/28, HEADER<n> or HEADER<rows>x<n> (2.54 mm), HOLE<diameter> (mounting hole), TESTPOINT, or CUSTOM with pads [{num, shape, x, y, w, h, drill}]. Pad numbers follow the usual datasheet order (DIP and SOIC: down the left side, up the right); pad 1 of a diode or LED is its cathode, pad 1 of CAPE is plus. Parts without "at" are placed automatically and a board that does not route grows by itself; "edge" pins a part to a board edge (connectors). Rules: clearance_mm, track_mm, power_track_mm, via_dia_mm, via_drill_mm, edge_clearance_mm, grid_mm. pours [{net, layer, rect, priority}] makes copper planes; a board of 30 or more parts with a GND net gets ground planes by itself. rails {net: volts} says what a supply carries, and electrical rules from datasheets judge the known chips (IR2104, MP1584, AMS1117, LM358, NE555, ATMEGA1284, BSC060N10), LEDs and electrolytics; a broken rule fails the board, other chips are named as not covered. Reports routed nets, track length, vias, design-rule violations and the electrical result. A ready motor controller: {"preset":"bldc_driver"}. Not covered: impedance control, parts on the bottom side, schematics, whether the circuit works on a bench.',
  params: z.preprocess(
    (raw) => ((raw as { preset?: string } | null)?.preset === 'bldc_driver' ? BLDC_DRIVER : raw),
    z
      .object({
        board: z
          .object({ width_mm: z.number().min(5).max(200), height_mm: z.number().min(5).max(200) })
          .strict()
          .default(EXAMPLE.board),
        rules: z
          .object({
            clearance_mm: z.number().min(0.05).max(2).default(0.2),
            track_mm: z.number().min(0.05).max(2).default(0.25),
            power_track_mm: z.number().min(0.05).max(5).default(0.4),
            via_dia_mm: z.number().min(0.2).max(3).default(0.6),
            via_drill_mm: z.number().min(0.1).max(2).default(0.3),
            edge_clearance_mm: z.number().min(0).max(5).default(0.3),
            grid_mm: z.number().min(0.05).max(1).default(0.2),
            via_cost: z.number().min(1).max(100).default(12),
          })
          .strict()
          .default({
            clearance_mm: 0.2,
            track_mm: 0.25,
            power_track_mm: 0.4,
            via_dia_mm: 0.6,
            via_drill_mm: 0.3,
            edge_clearance_mm: 0.3,
            grid_mm: 0.2,
            via_cost: 12,
          }),
        parts: z
          .array(part)
          .min(1)
          .max(150)
          .default(EXAMPLE.parts as never),
        nets: z
          .array(net)
          .min(1)
          .max(300)
          .default(EXAMPLE.nets as never),
        pours: z
          .array(
            z
              .object({
                net: z.string().min(1).max(40),
                layer: z.enum(['F.Cu', 'B.Cu']),
                rect: z.tuple([mm, mm, mm, mm]).optional(),
                priority: z.number().int().min(0).max(9).optional(),
              })
              .strict(),
          )
          .max(12)
          .optional(),
        route_first: z.array(z.string().max(40)).max(300).optional(),
        rails: z.record(z.string(), z.number().min(-100).max(1000)).optional(),
        bench: z.enum(['bldc_six_step']).optional(),
        seed: z.number().int().min(0).max(1e9).default(1),
        placement_iterations: z.number().int().min(1000).max(200_000).default(30_000),
        spread: z.number().min(0).max(20).default(6),
        routing_seconds: z.number().min(5).max(480).default(240),
      })
      .strict(),
  ),
  requires: [],
  check: 'pcb_recomputed',
  checkDescription:
    'Every clearance is re-measured with signed distance functions (not the router grid), connectivity is rebuilt per net from touching copper, widths, vias, annular rings, board edge and part overlaps are re-judged, and the exported KiCad board file is parsed and compared with the verified table',
  body: PCB + PCB_ERC + PCB_SCENE + PCB_DRC + PCB_OUT,
  limits: {
    timeoutMs: 600_000,
    memoryMb: 1536,
    maxOutputBytes: 60 * 1024 * 1024,
    maxOutputFiles: 40,
    tmpMb: 128,
  },
};

/** The board again after someone changed it by hand in KiCad: the same independent check. */
export const PCB_RECHECK_ENGINE: LabEngine = {
  name: 'pcb_recheck',
  domain: 'electronics',
  title: 'Board re-checked after a hand edit',
  description:
    'Reads a KiCad board file as it was saved after a hand edit and measures it again: clearances, board edge, connectivity per net, and against the original design whether any pad moved to another net. The tool recheck_board fills this in from the bot computer; use that tool. Not covered: copper zones and arcs (reported, and the board does not pass).',
  params: z
    .object({
      board_kicad: z.string().min(10).max(4_000_000),
      original_kicad: z.string().max(4_000_000).optional(),
      rules: z
        .object({
          clearance_mm: z.number().min(0.05).max(2).default(0.2),
          track_mm: z.number().min(0.05).max(2).default(0.25),
          via_dia_mm: z.number().min(0.2).max(3).default(0.6),
          via_drill_mm: z.number().min(0.1).max(2).default(0.3),
          edge_clearance_mm: z.number().min(0).max(5).default(0.3),
        })
        .strict()
        .default({
          clearance_mm: 0.2,
          track_mm: 0.25,
          via_dia_mm: 0.6,
          via_drill_mm: 0.3,
          edge_clearance_mm: 0.3,
        }),
    })
    .strict(),
  requires: [],
  check: 'pcb_recomputed',
  checkDescription:
    'Every clearance is re-measured with signed distance functions, connectivity is rebuilt per net from touching copper, widths, vias, annular rings and the board edge are re-judged, the saved KiCad file is compared with the table, and every pad is compared with the original design',
  body: 'import re\n' + PCB_DRC + PCB_RECHECK,
  limits: { timeoutMs: 300_000, memoryMb: 1024, maxOutputBytes: 30 * 1024 * 1024, tmpMb: 64 },
};

export const PCB_CHECK_DEF: Check = {
  name: 'pcb_recomputed',
  description:
    'Re-measures every copper clearance with signed distance functions, rebuilds connectivity from touching copper, re-judges widths, vias, annular rings and the board edge, and compares the exported KiCad board file with the verified table.',
  params: z.object({ step: z.string() }).passthrough() as unknown as z.ZodType<
    Record<string, unknown>
  >,
  needsResult: true,
  needsData: false,
  needsFiles: true,
  body: PCB_CHECK,
};
