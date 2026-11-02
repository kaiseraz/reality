
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
    out.append('    (property "Reference" %s (at 0 %s 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))' % (q(p.ref), f6(-p.hh0 - 0.8)))
    out.append('    (property "Value" %s (at 0 %s 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))' % (q(p.value or p.fp), f6(p.hh0 + 0.8)))
    out.append('    (attr %s)' % ("through_hole" if any(pd[6] > 0 for pd in p.pads) else "smd"))
    if p.ref in MODEL_FILE:
        out.append('    (model "${KIPRJMOD}/%s" (offset (xyz 0 0 0)) (scale (xyz 0.3937008 0.3937008 0.3937008)) (rotate (xyz 0 0 0)))' % MODEL_FILE[p.ref])
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
open("/output/board.kicad_pcb", "w").write("\n".join(out) + "\n")
# The board as it stood after placement, before any track: KiCad shows the ratsnest of what is
# still to connect, which is how the work went.
_placed = [l for l in out if not (l.startswith("  (segment ") or l.startswith("  (via "))]
open("/output/stage_1_placed.kicad_pcb", "w").write("\n".join(_placed) + "\n")

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
    return "\n".join(head + body + ["M02*"]) + "\n"
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
open("/output/drill.drl", "w").write("\n".join(dr_lines) + "\n")

# ---- summary ---------------------------------------------------------------------------------
tlen = sum(math.hypot(t["x2"] - t["x1"], t["y2"] - t["y1"]) for t in TRACKS)
summary({
    "model": "Auto-placed (simulated annealing on half-perimeter wire length) and routed (A* on a %.2f mm grid, two layers, 45-degree tracks, vias) board; KiCad 8 board file, Gerber RS-274X and Excellon drill; clearances by construction and a second analytic design-rule check" % G,
    "board_width_mm": W, "board_height_mm": H, "parts": len(parts), "nets": len(nets), "pads": sum(1 for a in PADS if a["shape"] != "npth"),
    "nets_routed": len(nets) - len(unrouted), "unrouted": unrouted, "tracks": len(TRACKS), "vias": len(VIAS), "track_length_mm": tlen,
    "wirelength_hpwl_mm": wirelength(), "drc_violations": drc_violations, "clearance_mm": CLR, "track_mm": TW, "power_track_mm": PW,
    "via_dia_mm": VIA_D, "via_drill_mm": VIA_H, "edge_clearance_mm": EDGE, "grid_mm": G,
    "design_ok": bool(not unrouted and drc_violations == 0),
    "placement": {p.ref: [round(p.x, 3), round(p.y, 3), p.rot] for p in parts},
})
print("%d parts, %d nets: %d of %d routed, %.1f mm of track, %d vias, %d design-rule violations on a %.0f x %.0f mm board." % (
    len(parts), len(nets), len(nets) - len(unrouted), len(nets), tlen, len(VIAS), drc_violations, W, H))
