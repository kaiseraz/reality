import { z } from 'zod';
import { CAD_EPILOGUE, CAD_HELPERS } from './cad.ts';
import type { LabEngine } from './engines.ts';
import type { Check } from '../verification/checks.ts';

/**
 * Design by hierarchy: a bot (or a model) does not write CAD code but a spec: assemblies
 * with placements, parts built from primitives with cut/add features and patterns, and the
 * constraints and requirements the design has to meet. A deterministic builder turns the
 * spec into B-rep solids on the OpenCascade kernel, part by part and in the order given,
 * and the lab measures what was built: masses, extents, centre of mass, interferences,
 * distances. A separate check re-derives what it can from the part table.
 */

const DESIGN = `
MODEL = "Assembly designed part by part from a hierarchical spec: assemblies, parts with features and patterns, constraints and requirements (OpenCascade B-rep)"
import time as _time
from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism, BRepPrimAPI_MakeRevol
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
from OCP.BRepExtrema import BRepExtrema_DistShapeShape

DENSITY = {"steel": 7850, "stainless": 8000, "aluminium": 2700, "aluminum": 2700, "titanium": 4430, "copper": 8960, "brass": 8500,
           "abs": 1040, "pla": 1240, "nylon": 1150, "carbon": 1550, "glass": 2500, "rubber": 1100, "wood": 700, "concrete": 2400, "plastic": 1200}
Zdir = gp_Dir(0, 0, 1)

def _fail(msg): raise SystemExit(msg)
def _get(d, key, what):
    if key not in d: _fail("%s needs dims.%s" % (what, key))
    return d[key]

def _cyl(r, h): return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, -h / 2), Zdir), r, h).Shape()
def _poly_face(pts, z):
    poly = BRepBuilderAPI_MakePolygon()
    for x, y in pts: poly.Add(gp_Pnt(x, y, z))
    poly.Close()
    return BRepBuilderAPI_MakeFace(poly.Wire()).Face()

def prim(kind, d, what="part"):
    """A solid in its own frame: centred on the origin, axis +z."""
    w = "%s (%s)" % (what, kind)
    if kind == "box":
        dx, dy, dz = float(_get(d, "dx", w)), float(_get(d, "dy", w)), float(_get(d, "dz", w))
        return BRepPrimAPI_MakeBox(gp_Pnt(-dx / 2, -dy / 2, -dz / 2), dx, dy, dz).Shape()
    if kind == "cylinder": return _cyl(float(_get(d, "r", w)), float(_get(d, "h", w)))
    if kind == "tube":
        ri, ro, h = float(_get(d, "r_in", w)), float(_get(d, "r_out", w)), float(_get(d, "h", w))
        if ri >= ro: _fail("%s: r_in must be smaller than r_out" % w)
        return BRepAlgoAPI_Cut(_cyl(ro, h), _cyl(ri, h + 2)).Shape()
    if kind == "cone":
        h = float(_get(d, "h", w))
        return BRepPrimAPI_MakeCone(gp_Ax2(gp_Pnt(0, 0, -h / 2), Zdir), float(_get(d, "r0", w)), float(_get(d, "r1", w)), h).Shape()
    if kind == "sphere": return BRepPrimAPI_MakeSphere(gp_Pnt(0, 0, 0), float(_get(d, "r", w))).Shape()
    if kind == "torus": return BRepPrimAPI_MakeTorus(gp_Ax2(gp_Pnt(0, 0, 0), Zdir), float(_get(d, "R", w)), float(_get(d, "r", w))).Shape()
    if kind == "extrude":
        pts, h = _get(d, "points", w), float(_get(d, "h", w))
        if len(pts) < 3: _fail("%s needs at least 3 points" % w)
        return BRepPrimAPI_MakePrism(_poly_face(pts, -h / 2), gp_Vec(0, 0, h)).Shape()
    if kind == "revolve":
        pts = _get(d, "points", w)                      # (radius, z) pairs, closed automatically
        if len(pts) < 3: _fail("%s needs at least 3 points" % w)
        poly = BRepBuilderAPI_MakePolygon()
        for r, z in pts: poly.Add(gp_Pnt(float(r), 0, float(z)))
        poly.Close()
        return BRepPrimAPI_MakeRevol(BRepBuilderAPI_MakeFace(poly.Wire()).Face(), gp_Ax1(gp_Pnt(0, 0, 0), Zdir), 2 * math.pi).Shape()
    if kind == "plate":
        dx, dy, t = float(_get(d, "dx", w)), float(_get(d, "dy", w)), float(_get(d, "t", w))
        shape = BRepPrimAPI_MakeBox(gp_Pnt(-dx / 2, -dy / 2, -t / 2), dx, dy, t).Shape()
        for hole in d.get("holes", []):
            c = moved(_cyl(float(hole["d"]) / 2, t + 2), float(hole["x"]), float(hole["y"]), 0)
            shape = BRepAlgoAPI_Cut(shape, c).Shape()
        return shape
    if kind == "flange":
        ro, ri, t = float(_get(d, "r_out", w)), float(d.get("r_in", 0)), float(_get(d, "t", w))
        shape = _cyl(ro, t)
        if ri > 0: shape = BRepAlgoAPI_Cut(shape, _cyl(ri, t + 2)).Shape()
        n, bc, bd = int(d.get("bolts", 0)), float(d.get("bolt_circle_r", 0)), float(d.get("bolt_d", 0))
        for i in range(n):
            a = 2 * math.pi * i / n
            shape = BRepAlgoAPI_Cut(shape, moved(_cyl(bd / 2, t + 2), bc * math.cos(a), bc * math.sin(a), 0)).Shape()
        return shape
    if kind == "bracket":                                # L bracket: leg a along x, leg b up z, thickness t, width y
        a, b, t, wd = float(_get(d, "a", w)), float(_get(d, "b", w)), float(_get(d, "t", w)), float(_get(d, "w", w))
        base = BRepPrimAPI_MakeBox(gp_Pnt(0, -wd / 2, 0), a, wd, t).Shape()
        up = BRepPrimAPI_MakeBox(gp_Pnt(0, -wd / 2, 0), t, wd, b).Shape()
        return BRepAlgoAPI_Fuse(base, up).Shape()
    if kind == "bolt":                                   # head underside at the origin, shaft towards -z
        dd, l = float(_get(d, "d", w)), float(_get(d, "l", w))
        hd, hh = float(d.get("head_d", 1.6 * dd)), float(d.get("head_h", 0.7 * dd))
        head = moved(_cyl(hd / 2, hh), 0, 0, hh / 2)
        shaft = moved(_cyl(dd / 2, l), 0, 0, -l / 2)
        return BRepAlgoAPI_Fuse(head, shaft).Shape()
    if kind == "gear":                                   # spur gear, trapezoid teeth
        m, n, wd = float(_get(d, "module", w)), int(_get(d, "teeth", w)), float(_get(d, "width", w))
        rp = m * n / 2; ra = rp + m; rf = rp - 1.25 * m; pitch = 2 * math.pi / n
        pts = []
        for i in range(n):
            c = i * pitch
            for r, da in ((rf, -0.30), (ra, -0.12), (ra, 0.12), (rf, 0.30)):
                pts.append((r * math.cos(c + da * pitch), r * math.sin(c + da * pitch)))
        shape = BRepPrimAPI_MakePrism(_poly_face(pts, -wd / 2), gp_Vec(0, 0, wd)).Shape()
        bore = float(d.get("bore", 0))
        if bore > 0: shape = BRepAlgoAPI_Cut(shape, _cyl(bore / 2, wd + 2)).Shape()
        return shape
    _fail("Unknown part kind \\"%s\\" (box, cylinder, tube, cone, sphere, torus, extrude, revolve, plate, flange, bracket, bolt, gear)" % kind)

def trsf_of(at=None, rot=None):
    at = [float(v) for v in (at or [0, 0, 0])]; rot = [float(v) for v in (rot or [0, 0, 0])]
    R = gp_Trsf()
    for ang, ax in ((rot[2], gp_Dir(0, 0, 1)), (rot[1], gp_Dir(0, 1, 0)), (rot[0], gp_Dir(1, 0, 0))):
        r = gp_Trsf(); r.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), ax), math.radians(ang)); R.Multiply(r)
    T = gp_Trsf(); T.SetTranslation(gp_Vec(*at))
    out = gp_Trsf(); out.Multiply(T); out.Multiply(R)
    return out

def compose(*ts):
    out = gp_Trsf()
    for t in ts: out.Multiply(t)
    return out

def pattern_trsfs(p):
    if not p: return [gp_Trsf()]
    out = []
    kind = p["type"]
    if kind == "linear":
        s = p["step"]
        for i in range(int(p["count"])):
            t = gp_Trsf(); t.SetTranslation(gp_Vec(i * s[0], i * s[1], i * s[2])); out.append(t)
    elif kind == "grid":
        for j in range(int(p["ny"])):
            for i in range(int(p["nx"])):
                t = gp_Trsf(); t.SetTranslation(gp_Vec(i * p["dx"], j * p["dy"], 0)); out.append(t)
    elif kind == "polar":
        ax = {"x": gp_Dir(1, 0, 0), "y": gp_Dir(0, 1, 0), "z": gp_Dir(0, 0, 1)}[p.get("axis", "z")]
        c = p.get("center", [0, 0, 0]); n = int(p["count"]); span = float(p.get("span_deg", 360.0)); start = float(p.get("start_deg", 0.0))
        for i in range(n):
            t = gp_Trsf(); t.SetRotation(gp_Ax1(gp_Pnt(*[float(v) for v in c]), ax), math.radians(start + span * i / (n if span >= 360 else max(n - 1, 1)))); out.append(t)
    return out

ASM = {a["name"]: a for a in P.get("assemblies", [])}
def asm_chain(name, seen=()):
    if not name: return []
    if name not in ASM: _fail("Unknown assembly \\"%s\\"" % name)
    if name in seen: _fail("Assembly \\"%s\\" is its own ancestor" % name)
    a = ASM[name]
    return asm_chain(a.get("parent"), seen + (name,)) + [trsf_of(a.get("at"), a.get("rot"))]
def asm_path(name):
    out = []
    while name:
        out.append(name); name = ASM[name].get("parent")
    return "/".join(reversed(out))

def bbox_of(shape):
    b = Bnd_Box(); BRepBndLib.Add_s(shape, b, True)
    lo, hi = b.CornerMin(), b.CornerMax()
    return (lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z())
def vol_of(shape):
    p = GProp_GProps(); BRepGProp.VolumeProperties_s(shape, p); return p.Mass()
def com_of(shape):
    p = GProp_GProps(); BRepGProp.VolumeProperties_s(shape, p); c = p.CentreOfMass(); return (c.X(), c.Y(), c.Z())

# ---- build, part by part, in the order given --------------------------------------------
BUILT = []                                             # name, assembly path, top assembly, material, density
STEPS = []
for si, spec in enumerate(P["parts"]):
    nm = spec["name"]
    shape = prim(spec["kind"], spec.get("dims", {}), "part " + nm)
    for fi, f in enumerate(spec.get("features", [])):
        tool = prim(f["kind"], f.get("dims", {}), "feature %d of %s" % (fi + 1, nm))
        place = trsf_of(f.get("at"), f.get("rot"))
        for ft in pattern_trsfs(f.get("pattern")):
            ftool = tool.Moved(TopLoc_Location(compose(ft, place)))
            shape = (BRepAlgoAPI_Fuse if f.get("op") == "add" else BRepAlgoAPI_Cut)(shape, ftool).Shape()
    mat = spec.get("material", "steel")
    rho = float(mat) if isinstance(mat, (int, float)) else float(DENSITY.get(str(mat).lower(), 0))
    if rho <= 0: _fail("Part %s: unknown material \\"%s\\" (%s) or give a density in kg/m3" % (nm, mat, ", ".join(sorted(DENSITY))))
    chain = asm_chain(spec.get("assembly"))
    place = trsf_of(spec.get("at"), spec.get("rot"))
    copies = pattern_trsfs(spec.get("pattern"))
    width = len(str(len(copies)))
    top = (asm_path(spec.get("assembly")).split("/")[0]) if spec.get("assembly") else "parts"
    for k, pt in enumerate(copies):
        name = nm if len(copies) == 1 else "%s_%0*d" % (nm, width, k + 1)
        placed = shape.Moved(TopLoc_Location(compose(*chain, pt, place)))
        part(name, top, placed)
        BUILT.append((name, asm_path(spec.get("assembly")) if spec.get("assembly") else "", top, str(mat), rho))
    STEPS.append([si + 1, nm, asm_path(spec.get("assembly")) if spec.get("assembly") else "", len(copies)])
if len({b[0] for b in BUILT}) != len(BUILT): _fail("Part names must be unique (patterns add _01, _02 …).")

# ---- measure ----------------------------------------------------------------------------
BOX = [bbox_of(s) for _, _, s in PARTS]
VOL = [vol_of(s) for _, _, s in PARTS]
COM = [com_of(s) for _, _, s in PARTS]
MASS = [v * 1e-9 * b[4] for v, b in zip(VOL, BUILT)]
total_mass = sum(MASS)
com = tuple(sum(m * c[i] for m, c in zip(MASS, COM)) / total_mass for i in range(3)) if total_mass > 0 else (0, 0, 0)
lo = [min(b[i] for b in BOX) for i in range(3)]; hi = [max(b[i + 3] for b in BOX) for i in range(3)]
ext = [hi[i] - lo[i] for i in range(3)]
index = {n: i for i, (n, _, _) in enumerate(PARTS)}
def find(name):
    if name in index: return index[name]
    for n in index:
        if n.startswith(name + "_"): return index[n]
    _fail("Constraint refers to unknown part \\"%s\\"" % name)

# ---- interference: every pair whose boxes meet is intersected by the kernel -----------------
tol_v = float(P.get("interference_tol_mm3", 1.0))
allowed = [(a, b) for a, b in P.get("allow_overlap", [])]
def is_allowed(a, b):
    return any((a.startswith(x) and b.startswith(y)) or (a.startswith(y) and b.startswith(x)) for x, y in allowed)
interferences = []; pairs = 0; complete = True; t0 = _time.time()
if P.get("check_interference", True):
    n = len(PARTS)
    for i in range(n):
        bi = BOX[i]
        for j in range(i + 1, n):
            bj = BOX[j]
            if bi[0] > bj[3] or bj[0] > bi[3] or bi[1] > bj[4] or bj[1] > bi[4] or bi[2] > bj[5] or bj[2] > bi[5]: continue
            pairs += 1
            if _time.time() - t0 > 120: complete = False; break
            try:
                c = BRepAlgoAPI_Common(PARTS[i][2], PARTS[j][2])
                v = vol_of(c.Shape()) if c.IsDone() else 0.0
            except Exception: v = 0.0
            if v > tol_v and not is_allowed(PARTS[i][0], PARTS[j][0]):
                interferences.append([PARTS[i][0], PARTS[j][0], round(v, 3)])
        if not complete: break

# ---- constraints and requirements ---------------------------------------------------------
cons = []
for c in P.get("constraints", []):
    a, b = find(c["a"]), find(c["b"])
    d = BRepExtrema_DistShapeShape(PARTS[a][2], PARTS[b][2])
    meas = d.Value() if d.IsDone() else float("nan")
    want = 0.0 if c["type"] == "touch" else float(c.get("value", 0.0)); tol = float(c.get("tol", 0.05))
    cons.append([c["type"], PARTS[a][0], PARTS[b][0], want, tol, round(meas, 5), bool(abs(meas - want) <= tol)])
req = P.get("requirements") or {}
reqs = []
def need(key, actual, ok): reqs.append([key, float(req[key]), round(actual, 5), bool(ok)])
if "max_mass_kg" in req: need("max_mass_kg", total_mass, total_mass <= req["max_mass_kg"])
if "min_mass_kg" in req: need("min_mass_kg", total_mass, total_mass >= req["min_mass_kg"])
for ax, i in (("x", 0), ("y", 1), ("z", 2)):
    if "max_%s_mm" % ax in req: need("max_%s_mm" % ax, ext[i], ext[i] <= req["max_%s_mm" % ax])
if "max_parts" in req: need("max_parts", len(PARTS), len(PARTS) <= req["max_parts"])
req_met = all(r[3] for r in reqs) and all(c[6] for c in cons) and not interferences

write_csv("interference.csv", ["part_a", "part_b", "overlap_mm3"], interferences or [["", "", 0]])
EXTRA = {
    "assemblies": len(ASM), "build_steps": len(STEPS), "build_order": STEPS[:60],
    "total_mass_kg": total_mass, "centre_of_mass_mm": [round(v, 4) for v in com],
    "bbox_min_mm": [round(v, 4) for v in lo], "bbox_max_mm": [round(v, 4) for v in hi],
    "extent_x_mm": ext[0], "extent_y_mm": ext[1], "extent_z_mm": ext[2],
    "interference_count": len(interferences), "interference_pairs_tested": pairs, "interference_complete": complete,
    "interferences": interferences[:20],
    "constraints_total": len(cons), "constraints_met": sum(1 for c in cons if c[6]), "constraints": cons,
    "requirements": reqs, "requirements_met": bool(req_met),
    "design_ok": bool(req_met and complete),
}
_summary_base = summary
def summary(d):
    d.update(EXTRA)
    _summary_base(d)
`;
const DESIGN_POST = `
# result.csv once more, with what a design review needs next to each part.
_names = [r[0] for r in rows]
write_csv("result.csv", ["name", "group", "solids", "valid", "volume_mm3", "size_x", "size_y", "size_z",
                         "material", "density_kg_m3", "mass_kg", "x_min", "y_min", "z_min", "x_max", "y_max", "z_max",
                         "com_x", "com_y", "com_z", "assembly"],
          [r + [BUILT[i][3], BUILT[i][4], round(MASS[i], 7)] + [round(v, 4) for v in BOX[i]] + [round(v, 4) for v in COM[i]] + [BUILT[i][1]]
           for i, r in enumerate(rows)])
print("%.2f kg, %.0f x %.0f x %.0f mm; %d interferences; %d of %d constraints met; requirements %s." % (
    total_mass, ext[0], ext[1], ext[2], len(interferences), sum(1 for c in cons if c[6]), len(cons), "met" if req_met else "NOT met"))
`;
const DESIGN_CHECK_BODY = `
# Re-derives what can be re-derived from the part table alone: masses from volume and
# density, totals, extents and centre of mass from the part boxes, and the logic of the
# interference, constraint and requirement verdicts. (The kernel's intersections and
# distances cannot be redone without it; boxes give necessary conditions for both.)
data = rows("/input/result.csv")
claim = CLAIM or {}
mismatches = []
def off(name, expected, claimed, tol):
    if claimed in (None, "") or abs(expected - num(claimed)) > tol * max(1.0, abs(expected)):
        mismatches.append({"problem": name, "expected": expected, "claimed": claimed})
by = {r["name"]: r for r in data}
total = 0.0; comx = [0.0, 0.0, 0.0]
lo = [1e30] * 3; hi = [-1e30] * 3
for r in data:
    m = num(r["volume_mm3"]) * 1e-9 * num(r["density_kg_m3"])
    if abs(m - num(r["mass_kg"])) > 1e-4 * max(m, 1e-9) + 1e-7: mismatches.append({"problem": "part mass", "part": r["name"], "expected": m, "reported": r["mass_kg"]})
    total += m
    for i, a in enumerate("xyz"):
        comx[i] += m * num(r["com_" + a])
        lo[i] = min(lo[i], num(r[a + "_min"])); hi[i] = max(hi[i], num(r[a + "_max"]))
        if not (num(r[a + "_min"]) - 1e-3 <= num(r["com_" + a]) <= num(r[a + "_max"]) + 1e-3):
            mismatches.append({"problem": "centre of mass outside the part", "part": r["name"], "axis": a})
    if r["valid"] != "yes": mismatches.append({"problem": "invalid solid", "part": r["name"]})
off("total mass", total, claim.get("total_mass_kg"), 1e-4)
for i, a in enumerate("xyz"):
    if abs((hi[i] - lo[i]) - num(claim.get("extent_%s_mm" % a))) > 0.05: mismatches.append({"problem": "extent " + a, "expected": hi[i] - lo[i], "claimed": claim.get("extent_%s_mm" % a)})
    if total > 0 and abs(comx[i] / total - num((claim.get("centre_of_mass_mm") or [0, 0, 0])[i])) > 0.01: mismatches.append({"problem": "centre of mass " + a, "expected": comx[i] / total})
def boxes_meet(a, b, gap=0.0):
    A, B = by[a], by[b]
    return all(num(A[c + "_min"]) <= num(B[c + "_max"]) + gap and num(B[c + "_min"]) <= num(A[c + "_max"]) + gap for c in "xyz")
def box_gap(a, b):
    A, B = by[a], by[b]
    return math.sqrt(sum(max(0.0, num(A[c + "_min"]) - num(B[c + "_max"]), num(B[c + "_min"]) - num(A[c + "_max"])) ** 2 for c in "xyz"))
# 1. an interference needs overlapping boxes and a volume no larger than the smaller part
for a, b, v in claim.get("interferences") or []:
    if a not in by or b not in by: mismatches.append({"problem": "interference names an unknown part", "pair": [a, b]}); continue
    if not boxes_meet(a, b, 1e-3): mismatches.append({"problem": "interference between parts whose boxes do not meet", "pair": [a, b]})
    if num(v) > min(num(by[a]["volume_mm3"]), num(by[b]["volume_mm3"])) * (1 + 1e-6): mismatches.append({"problem": "overlap larger than the smaller part", "pair": [a, b], "overlap_mm3": v})
if int(num(claim.get("interference_count"))) < len(claim.get("interferences") or []): mismatches.append({"problem": "interference count"})
# 2. constraints: verdict follows from the measurement, the measurement from the boxes
met = 0
for kind, a, b, want, tol, meas, ok in claim.get("constraints") or []:
    if a not in by or b not in by: mismatches.append({"problem": "constraint names an unknown part", "pair": [a, b]}); continue
    if bool(ok) != (abs(num(meas) - num(want)) <= num(tol)): mismatches.append({"problem": "constraint verdict", "pair": [a, b], "measured": meas, "wanted": want, "tol": tol})
    if num(meas) < box_gap(a, b) - 1e-3: mismatches.append({"problem": "distance smaller than the gap between the part boxes", "pair": [a, b], "measured": meas, "box_gap": box_gap(a, b)})
    met += 1 if ok else 0
if int(num(claim.get("constraints_met"))) != met: mismatches.append({"problem": "constraints met", "expected": met, "claimed": claim.get("constraints_met")})
# 3. requirements recomputed from the totals
req_ok = True
for key, limit, actual, ok in claim.get("requirements") or []:
    value = {"max_mass_kg": total, "min_mass_kg": total, "max_parts": float(len(data)),
             "max_x_mm": hi[0] - lo[0], "max_y_mm": hi[1] - lo[1], "max_z_mm": hi[2] - lo[2]}.get(key)
    if value is None: mismatches.append({"problem": "unknown requirement", "key": key}); continue
    verdict_ = value >= limit - 1e-9 if key.startswith("min_") else value <= limit + 1e-9
    if bool(ok) != verdict_: mismatches.append({"problem": "requirement verdict", "key": key, "actual": value, "limit": limit})
    req_ok = req_ok and verdict_
all_met = req_ok and met == len(claim.get("constraints") or []) and int(num(claim.get("interference_count"))) == 0
if bool(claim.get("requirements_met")) != all_met: mismatches.append({"problem": "overall verdict", "recomputed": all_met, "claimed": claim.get("requirements_met")})
verdict(not mismatches, len(data), 0.0, mismatches,
        "%d parts: masses (%.3f kg), extents and centre of mass recomputed; %d interferences, %d constraints and %d requirements re-judged" % (
            len(data), total, int(num(claim.get("interference_count"))), len(claim.get("constraints") or []), len(claim.get("requirements") or [])))
`;

const num = z.number().min(-1e6).max(1e6);
const vec3 = z.array(num).length(3);
const dimValue = z.union([
  num,
  z
    .array(
      z.union([
        num,
        z.array(num).length(2),
        z.object({ x: num, y: num, d: z.number().positive() }).strict(),
      ]),
    )
    .max(400),
]);
const dims = z.record(z.string().max(30), dimValue);
const kind = z.enum([
  'box',
  'cylinder',
  'tube',
  'cone',
  'sphere',
  'torus',
  'extrude',
  'revolve',
  'plate',
  'flange',
  'bracket',
  'bolt',
  'gear',
]);
const pattern = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('linear'), count: z.number().int().min(2).max(500), step: vec3 })
    .strict(),
  z
    .object({
      type: z.literal('grid'),
      nx: z.number().int().min(1).max(100),
      ny: z.number().int().min(1).max(100),
      dx: num,
      dy: num,
    })
    .strict(),
  z
    .object({
      type: z.literal('polar'),
      count: z.number().int().min(2).max(500),
      axis: z.enum(['x', 'y', 'z']).default('z'),
      center: vec3.default([0, 0, 0]),
      span_deg: z.number().min(1).max(360).default(360),
      start_deg: z.number().min(-360).max(360).default(0),
    })
    .strict(),
]);
const feature = z
  .object({
    op: z.enum(['cut', 'add']).default('cut'),
    kind,
    dims,
    at: vec3.optional(),
    rot: vec3.optional(),
    pattern: pattern.optional(),
  })
  .strict();
const name = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9_.-]+$/);
const part = z
  .object({
    name,
    assembly: name.optional(),
    kind,
    dims,
    material: z.union([z.string().max(30), z.number().positive().max(30_000)]).default('steel'),
    at: vec3.optional(),
    rot: vec3.optional(),
    features: z.array(feature).max(40).optional(),
    pattern: pattern.optional(),
  })
  .strict();
const assembly = z
  .object({ name, parent: name.optional(), at: vec3.optional(), rot: vec3.optional() })
  .strict();
const constraint = z
  .object({
    type: z.enum(['touch', 'gap']),
    a: name,
    b: name,
    value: z.number().min(0).max(1e5).optional(),
    tol: z.number().min(0).max(1000).optional(),
  })
  .strict();
const requirements = z
  .object({
    max_mass_kg: z.number().positive().optional(),
    min_mass_kg: z.number().positive().optional(),
    max_x_mm: z.number().positive().optional(),
    max_y_mm: z.number().positive().optional(),
    max_z_mm: z.number().positive().optional(),
    max_parts: z.number().int().positive().optional(),
  })
  .strict();

const EXAMPLE = {
  assemblies: [{ name: 'Frame' }, { name: 'Rotor', at: [0, 0, 26] }, { name: 'Fasteners' }],
  parts: [
    {
      name: 'Base_Plate',
      assembly: 'Frame',
      kind: 'plate',
      dims: {
        dx: 120,
        dy: 60,
        t: 12,
        holes: [
          { x: -45, y: -20, d: 9 },
          { x: 45, y: -20, d: 9 },
          { x: -45, y: 20, d: 9 },
          { x: 45, y: 20, d: 9 },
        ],
      },
      material: 'steel',
    },
    {
      name: 'Housing',
      assembly: 'Frame',
      kind: 'box',
      dims: { dx: 60, dy: 40, dz: 40 },
      at: [0, 0, 26],
      material: 'aluminium',
      features: [{ op: 'cut', kind: 'cylinder', dims: { r: 14, h: 80 }, rot: [0, 90, 0] }],
    },
    {
      name: 'Shaft',
      assembly: 'Rotor',
      kind: 'cylinder',
      dims: { r: 10, h: 140 },
      rot: [0, 90, 0],
      material: 'steel',
    },
    {
      name: 'Bearing',
      assembly: 'Rotor',
      kind: 'tube',
      dims: { r_in: 10, r_out: 14, h: 12 },
      at: [-18, 0, 0],
      rot: [0, 90, 0],
      material: 'steel',
      pattern: { type: 'linear', count: 2, step: [36, 0, 0] },
    },
    {
      name: 'Bolt',
      assembly: 'Fasteners',
      kind: 'bolt',
      dims: { d: 8, l: 24 },
      at: [-45, -20, 6],
      material: 'steel',
      pattern: { type: 'grid', nx: 2, ny: 2, dx: 90, dy: 40 },
    },
  ],
  constraints: [
    { type: 'touch', a: 'Shaft', b: 'Bearing_1' },
    { type: 'touch', a: 'Housing', b: 'Base_Plate' },
  ],
  requirements: { max_mass_kg: 12, max_x_mm: 160 },
};

export const DESIGN_ENGINE: LabEngine = {
  name: 'design_assembly',
  domain: 'cad',
  title: 'Assembly design',
  description:
    'Designs a mechanical assembly from a hierarchical spec and builds it on the OpenCascade kernel part by part, then measures it. Spec: assemblies [{name, parent, at, rot}] (placements compose down the tree); parts [{name, assembly, kind, dims, material, at, rot, features, pattern}] built in the order given. Units mm, degrees; every primitive sits centred on its own origin with its axis along +z, then rot (about x, y, z) and at place it. Kinds and dims: box{dx,dy,dz}, cylinder{r,h}, tube{r_in,r_out,h}, cone{r0,r1,h}, sphere{r}, torus{R,r}, extrude{points:[[x,y]..],h}, revolve{points:[[r,z]..]}, plate{dx,dy,t,holes:[{x,y,d}]}, flange{r_out,r_in,t,bolts,bolt_circle_r,bolt_d}, bracket{a,b,t,w}, bolt{d,l} (head underside at the origin, shaft towards -z), gear{module,teeth,width,bore}. features: [{op:cut|add, kind, dims, at, rot, pattern}] edit a part (holes, pockets, bosses). pattern: linear{count,step}, grid{nx,ny,dx,dy}, polar{count,axis,center,span_deg}; copies are named name_01, name_02 …. materials: ' +
    'steel, stainless, aluminium, titanium, copper, brass, abs, pla, nylon, carbon, glass, rubber, wood, concrete, plastic or a density in kg/m3. constraints: [{type:touch|gap, a, b, value, tol}] on the distance between two parts; requirements: max_mass_kg, min_mass_kg, max_x_mm, max_y_mm, max_z_mm, max_parts. All pairs of parts are tested for interference (allow_overlap [[a,b]] by name prefix for press fits). Reports mass, centre of mass, extents, interferences, constraint and requirement verdicts, and exports STEP and meshes. Needs the CAD kernel capability.',
  params: z
    .object({
      parts: z
        .array(part)
        .min(1)
        .max(400)
        .default(EXAMPLE.parts as never),
      assemblies: z
        .array(assembly)
        .max(100)
        .default(EXAMPLE.assemblies as never),
      constraints: z
        .array(constraint)
        .max(200)
        .default(EXAMPLE.constraints as never),
      requirements: requirements.default(EXAMPLE.requirements as never),
      allow_overlap: z
        .array(z.tuple([z.string().max(60), z.string().max(60)]))
        .max(100)
        .default([]),
      check_interference: z.boolean().default(true),
      interference_tol_mm3: z.number().min(0).max(1e6).default(1),
      mesh_mm: z.number().min(0.2).max(20).default(2),
    })
    .strict(),
  requires: ['ocp'],
  need: 'cad',
  check: 'cad_assembly_recomputed',
  checkDescription:
    'Parts and unique names are recounted, every solid is valid, every mesh is closed, and each group volume is recomputed from its triangles within 3 % of the kernel',
  alsoChecks: [
    {
      name: 'assembly_design_recomputed',
      description:
        'Masses are recomputed from volume and density, total mass, extents and centre of mass from the part table, and the interference, constraint and requirement verdicts are re-judged against the part boxes',
    },
  ],
  body: CAD_HELPERS + DESIGN + CAD_EPILOGUE + DESIGN_POST,
  limits: {
    timeoutMs: 600_000,
    memoryMb: 3072,
    maxOutputBytes: 400 * 1024 * 1024,
    maxOutputFiles: 40,
    tmpMb: 256,
  },
};

export const DESIGN_CHECK: Check = {
  name: 'assembly_design_recomputed',
  description:
    'Recomputes part masses from volume and density, the total mass, extents and centre of mass from the part table, and re-judges interference, constraint and requirement verdicts against the part boxes.',
  params: z.object({ step: z.string() }).passthrough() as unknown as z.ZodType<
    Record<string, unknown>
  >,
  needsResult: true,
  needsData: false,
  body: DESIGN_CHECK_BODY,
};
