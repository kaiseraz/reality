
import heapq, random, re, time as _time

W, H = float(P["board"]["width_mm"]), float(P["board"]["height_mm"])
R = P["rules"]
CLR, TW, PW = float(R["clearance_mm"]), float(R["track_mm"]), float(R["power_track_mm"])
VIA_D, VIA_H, EDGE = float(R["via_dia_mm"]), float(R["via_drill_mm"]), float(R["edge_clearance_mm"])
G = float(R["grid_mm"])
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
    m = re.fullmatch(r"HEADER(?:(\d+)X)?(\d+)", n)
    if m:
        rows, cols = int(m.group(1) or 1), int(m.group(2)); out = []
        for c in range(cols):
            for r in range(rows):
                out.append((str(c * rows + r + 1), "circle", (r - (rows - 1) / 2) * 2.54, (c - (cols - 1) / 2) * 2.54, 1.7, 1.7, 1.0))
        return out
    m = re.fullmatch(r"HOLE([0-9.]+)", n)
    if m: return [("", "npth", 0, 0, float(m.group(1)), float(m.group(1)), float(m.group(1)))]
    if n == "TESTPOINT": return [("1", "circle", 0, 0, 1.5, 1.5, 0)]
    if n == "CUSTOM" and custom:
        return [(str(p["num"]), p.get("shape", "rect"), float(p["x"]), float(p["y"]), float(p["w"]), float(p["h"]), float(p.get("drill", 0))) for p in custom]
    raise SystemExit("Unknown footprint \"%s\" (R/C/L/LED/D + 0402|0603|0805|1206, SOIC8|14|16, TSSOP14|16|20, SOT23, SOT23_5, DIP8..28, HEADER<n> or HEADER<rows>x<n>, HOLE<d>, TESTPOINT, CUSTOM with pads)" % name)

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
if len({n["name"] for n in nets}) != len(nets): raise SystemExit("Net names must be unique.")
pin_net = {}
for ni, n in enumerate(nets):
    for pin in n["pins"]:
        if "." not in pin: raise SystemExit("Pin \"%s\" must look like REF.PIN" % pin)
        ref, num = pin.split(".", 1)
        if ref not in refs: raise SystemExit("Net %s refers to unknown part %s" % (n["name"], ref))
        if num not in [p[0] for p in refs[ref].pads]: raise SystemExit("Part %s (%s) has no pad %s" % (ref, refs[ref].fp, num))
        if pin in pin_net: raise SystemExit("Pad %s is in two nets (%s, %s)" % (pin, nets[pin_net[pin]]["name"], n["name"]))
        pin_net[pin] = ni

# ---- placement: simulated annealing on wire length, parts kept apart, edges respected --------
rnd = random.Random(int(P.get("seed", 1)))
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
    cx = sum(p.x for p in parts) / len(parts); cy = sum(p.y for p in parts) / len(parts)
    return SPREAD * (abs(cx - W / 2) + abs(cy - H / 2))
free = [p for p in parts if not p.fixed]
def snap_edge(p):
    e = p.spec.get("edge"); hx, hy = p.half(); m = EDGE + 0.2
    if e == "left": p.x = hx + m
    elif e == "right": p.x = W - hx - m
    elif e == "top": p.y = hy + m
    elif e == "bottom": p.y = H - hy - m
for p in free:
    p.x = rnd.uniform(5, max(6, W - 5)); p.y = rnd.uniform(5, max(6, H - 5)); snap_edge(p)
if free:
    cost = wirelength() + overlap_cost() + spread_cost(); temp = max(W, H) / 4; iters = int(P.get("placement_iterations", 30000))
    for it in range(iters):
        t = temp * (1 - it / iters) ** 2 + 0.01
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
        if new <= cost or rnd.random() < math.exp(-(new - cost) / max(t, 1e-3)):
            cost = new
        else:
            if old is None:
                p.x, q.x = q.x, p.x; p.y, q.y = q.y, p.y
            else: p.x, p.y, p.rot = old
    for p in free:
        p.x = round(p.x * 2) / 2; p.y = round(p.y * 2) / 2; snap_edge(p); p.x = round(p.x * 2) / 2; p.y = round(p.y * 2) / 2
for i, a in enumerate(parts):
    ax, ay = a.half()
    if a.x - ax < 0 or a.x + ax > W or a.y - ay < 0 or a.y + ay > H: raise SystemExit("Part %s does not fit on the board; make the board larger." % a.ref)
    for b in parts[i + 1:]:
        bx, by = b.half()
        if abs(a.x - b.x) < ax + bx and abs(a.y - b.y) < ay + by: raise SystemExit("Parts %s and %s overlap; make the board larger or place them." % (a.ref, b.ref))

# ---- copper features -------------------------------------------------------------------------
NX, NY = int(W / G) + 1, int(H / G) + 1
net_id = {n["name"]: i + 1 for i, n in enumerate(nets)}
FEATS = []          # kind, layer(0 top,1 bottom,2 both), net, geometry...
PADS = []           # absolute pads with net names
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
            o = occ[L, nj, ni_]
            if o != 0 and o != nid: continue
            if di and dj:
                o1, o2 = occ[L, j, ni_], occ[L, nj, i]
                if (o1 != 0 and o1 != nid) or (o2 != 0 and o2 != nid): continue
            cost = c * ((1.0 if (L == 0) == (dj == 0) else 1.12) if not (di and dj) else 1.0)
            nxt = (L, nj, ni_); ng = g + cost
            if ng < best.get(nxt, 1e18) - 1e-12:
                best[nxt] = ng; came[nxt] = cur; heapq.heappush(openh, (ng + h(nj, ni_), ng, nxt))
        o = occ[1 - L, j, i]
        if (o == 0 or o == nid) and occv[0, j, i] in (0, nid) and occv[1, j, i] in (0, nid):
            nxt = (1 - L, j, i); ng = g + VIA_COST
            if ng < best.get(nxt, 1e18) - 1e-12:
                best[nxt] = ng; came[nxt] = cur; heapq.heappush(openh, (ng + h(j, i), ng, nxt))
    return None, came

def route_net(ni):
    n = nets[ni]; nid = ni + 1; w_net = net_width(n)
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
            cache[w] = (occ, occv)
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
order = sorted(range(len(nets)), key=lambda i: (net_width(nets[i]) <= TW, span(i)))
BASE_FEATS = list(FEATS)
def reset_routes():
    TRACKS.clear(); VIAS.clear(); FEATS[:] = BASE_FEATS
t0 = _time.time(); budget = float(P.get("routing_seconds", 240))
best_state = None
for attempt in range(12):
    reset_routes()
    status = {}
    for ni in order: status[ni] = route_net(ni)
    failed = [ni for ni in order if not status[ni]]
    if best_state is None or len(failed) < len(best_state[0]):
        best_state = (failed, list(TRACKS), list(VIAS), list(FEATS), dict(status))
    if not failed or _time.time() - t0 > budget: break
    # whatever failed goes first next time: it gets the free board, the others route around it
    rest = [ni for ni in order if ni not in failed]
    if attempt >= 1: rnd.shuffle(rest)
    order = failed + rest
failed, tr_, vi_, fe_, status = best_state
TRACKS[:] = tr_; VIAS[:] = vi_; FEATS[:] = fe_
unrouted = [nets[i]["name"] for i in range(len(nets)) if not status[i]]
