
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
                if text[j] == "\\" and j + 1 < n: j += 1
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
                vals = [float(v) for v in dr[1:] if isinstance(v, str) and re.fullmatch(r"[-\d.]+", v)]
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
