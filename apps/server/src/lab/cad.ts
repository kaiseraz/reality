/**
 * CAD for the lab: helpers on the OpenCascade kernel (OCP), acquired at runtime as the
 * "ocp" capability, and a parametric turbofan. Engines append named solids with `part()`;
 * the epilogue validates every solid, measures it, writes a STEP assembly with part names,
 * one binary STL per group for the viewer, parts.csv (result.csv) and a summary.
 */

export const CAD_HELPERS = `
import math, struct
from OCP.gp import gp_Pnt, gp_Dir, gp_Ax1, gp_Ax2, gp_Trsf, gp_Vec
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeCone, BRepPrimAPI_MakeTorus, BRepPrimAPI_MakeSphere
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform, BRepBuilderAPI_MakePolygon
from OCP.BRepOffsetAPI import BRepOffsetAPI_ThruSections
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRep import BRep_Tool, BRep_Builder
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID, TopAbs_REVERSED
from OCP.TopoDS import TopoDS, TopoDS_Compound
from OCP.TopLoc import TopLoc_Location

AXIS = gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(1, 0, 0))   # the engine axis is +x
PARTS = []                                         # (name, group, shape)

def part(name, group, shape):
    PARTS.append((str(name), str(group), shape))
    return shape

def cylinder(r, x0, length):
    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x0, 0, 0), gp_Dir(1, 0, 0)), r, length).Shape()

def tube(r_in, r_out, x0, length):
    return BRepAlgoAPI_Cut(cylinder(r_out, x0, length), cylinder(r_in, x0 - 1, length + 2)).Shape()

def cone(r0, r1, x0, length):
    return BRepPrimAPI_MakeCone(gp_Ax2(gp_Pnt(x0, 0, 0), gp_Dir(1, 0, 0)), r0, r1, length).Shape()

def box(dx, dy, dz, x, y, z):
    return BRepPrimAPI_MakeBox(gp_Pnt(x, y, z), dx, dy, dz).Shape()

def torus(r_major, r_minor, x):
    return BRepPrimAPI_MakeTorus(gp_Ax2(gp_Pnt(x, 0, 0), gp_Dir(1, 0, 0)), r_major, r_minor).Shape()

def moved(shape, dx=0.0, dy=0.0, dz=0.0):
    t = gp_Trsf(); t.SetTranslation(gp_Vec(dx, dy, dz))
    return BRepBuilderAPI_Transform(shape, t, True).Shape()

def rotated(shape, degrees, axis=AXIS):
    # A located instance: the geometry is shared, so rows of blades cost one blade each
    # in memory, meshing and the STEP file.
    t = gp_Trsf(); t.SetRotation(axis, math.radians(degrees))
    return shape.Moved(TopLoc_Location(t))

def cutaway(shape):
    """Removes the viewer-side quarter of a casing, Astra-style: the nacelle and the
    cases are sectioned along the whole engine, so fan, compressor rows, combustor
    and turbines stay visible instead of hiding inside closed tubes."""
    cutter = box(18000, 8000, 8000, -2000, 0, 0)
    return BRepAlgoAPI_Cut(shape, cutter).Shape()

def section(chord, thickness, stagger_deg, r, x):
    """A cambered airfoil-like section in the plane y = r, centred at axial position x."""
    pts = []
    n = 6
    for i in range(n + 1):                        # upper surface, leading to trailing edge
        s = i / n
        pts.append((chord * (s - 0.5), thickness * (0.5 * math.sin(math.pi * s) + 0.15 * math.sin(math.pi * s) ** 2)))
    for i in range(n - 1, 0, -1):                 # lower surface back
        s = i / n
        pts.append((chord * (s - 0.5), -thickness * 0.35 * math.sin(math.pi * s)))
    a = math.radians(stagger_deg)
    poly = BRepBuilderAPI_MakePolygon()
    for u, v in pts:
        poly.Add(gp_Pnt(x + u * math.cos(a) - v * math.sin(a), r, u * math.sin(a) + v * math.cos(a)))
    poly.Close()
    return poly.Wire()

def blade(r_hub, r_tip, x, chord_hub, chord_tip, stagger_hub, stagger_tip, thick=0.08):
    loft = BRepOffsetAPI_ThruSections(True, False)
    for k in range(3):
        f = k / 2
        r = r_hub + (r_tip - r_hub) * f
        c = chord_hub + (chord_tip - chord_hub) * f
        loft.AddWire(section(c, c * thick, stagger_hub + (stagger_tip - stagger_hub) * f, r, x))
    loft.Build()
    return loft.Shape()

def row(prefix, group, count, shape):
    """Copies a shape around the axis: count parts named prefix_01 … prefix_NN."""
    width = len(str(count))
    for i in range(count):
        part(f"{prefix}_{i + 1:0{width}d}", group, shape if i == 0 else rotated(shape, 360.0 * i / count))

def polar(prefix, group, count, shape, phase=0.0):
    width = len(str(count))
    for i in range(count):
        part(f"{prefix}_{i + 1:0{width}d}", group, rotated(shape, phase + 360.0 * i / count))
`;

/** Validates, measures and exports PARTS (runs after the model code). */
export const CAD_EPILOGUE = `
def volume(shape):
    p = GProp_GProps(); BRepGProp.VolumeProperties_s(shape, p); return p.Mass()

def bounds(shape):
    b = Bnd_Box(); BRepBndLib.Add_s(shape, b, True)
    lo, hi = b.CornerMin(), b.CornerMax()
    return lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z()

names = [n for n, _, _ in PARTS]
if len(PARTS) == 0: raise SystemExit("The model defines no parts.")
if len(PARTS) > 6000: raise SystemExit("More than 6000 parts.")
rows = []
groups = {}
for name, group, shape in PARTS:
    solids = 0
    ex = TopExp_Explorer(shape, TopAbs_SOLID)
    while ex.More(): solids += 1; ex.Next()
    valid = BRepCheck_Analyzer(shape).IsValid() and solids >= 1
    v = volume(shape)
    x0, y0, z0, x1, y1, z1 = bounds(shape)
    rows.append([name, group, solids, "yes" if valid else "no", round(v, 4), round(x1 - x0, 3), round(y1 - y0, 3), round(z1 - z0, 3)])
    groups.setdefault(group, []).append(shape)
write_csv("result.csv", ["name", "group", "solids", "valid", "volume_mm3", "size_x", "size_y", "size_z"], rows)

# One binary STL per group for the viewer: tessellate, honour face orientation.
deflection = float(P.get("mesh_mm", 1.5))
def write_stl(fname, shapes):
    tris = []
    for shape in shapes:
        BRepMesh_IncrementalMesh(shape, deflection, False, 0.5, True)
        ex = TopExp_Explorer(shape, TopAbs_FACE)
        while ex.More():
            face = TopoDS.Face(ex.Current())
            loc = TopLoc_Location()
            tri = BRep_Tool.Triangulation_s(face, loc)
            if tri is not None:
                trsf = loc.Transformation()
                nodes = [tri.Node(i).Transformed(trsf) for i in range(1, tri.NbNodes() + 1)]
                flip = face.Orientation() == TopAbs_REVERSED
                for i in range(1, tri.NbTriangles() + 1):
                    a, b, c = tri.Triangle(i).Get()
                    if flip: b, c = c, b
                    tris.append((nodes[a - 1], nodes[b - 1], nodes[c - 1]))
            ex.Next()
    with open("/output/" + fname, "wb") as f:
        f.write(b"Reality CAD mesh".ljust(80, b" "))
        f.write(struct.pack("<I", len(tris)))
        for p1, p2, p3 in tris:
            f.write(struct.pack("<12fH", 0, 0, 0, p1.X(), p1.Y(), p1.Z(), p2.X(), p2.Y(), p2.Z(), p3.X(), p3.Y(), p3.Z(), 0))
    return len(tris)
triangles = {}
for g, shapes in groups.items():
    safe = "".join(ch if ch.isalnum() else "_" for ch in g)[:40] or "group"
    triangles[g] = write_stl("mesh_" + safe + ".stl", shapes)

# STEP assembly with one named product per part.
from OCP.TDocStd import TDocStd_Document
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
# Metallic colours per group, so the assembly reads like the real machine in
# FreeCAD instead of one grey blob: bright fan steel, blue-grey compressor,
# copper combustor, dark turbine, near-white nacelle.
from OCP.XCAFDoc import XCAFDoc_ColorGen
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
GROUP_COLORS = {
    "nacelle": (0.90, 0.93, 0.98), "casing": (0.62, 0.68, 0.76),
    "fan": (0.86, 0.88, 0.92), "compressor": (0.16, 0.48, 0.88),
    "combustor": (0.98, 0.42, 0.08), "turbine": (0.78, 0.18, 0.16),
    "shafts": (0.55, 0.57, 0.62), "exhaust": (0.78, 0.60, 0.30),
    "accessories": (0.95, 0.76, 0.15),
}
import os, sys

def write_step(path, subset):
    """A STEP file with one named, coloured product per part."""
    doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    XCAFApp_Application.GetApplication_s().InitDocument(doc)
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ctool = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    for name, group, shape in subset:
        label = tool.AddShape(shape, False)
        TDataStd_Name.Set_s(label, TCollection_ExtendedString(name))
        rgb = GROUP_COLORS.get(group)
        if rgb:
            try:
                ctool.SetColor(label, Quantity_Color(rgb[0], rgb[1], rgb[2], Quantity_TOC_RGB), XCAFDoc_ColorGen)
            except Exception:
                pass
    # The kernel prints its own progress banners to the C-level stdout; keep them out of
    # the step's output, which people read.
    sys.stdout.flush()
    saved_fd, null_fd = os.dup(1), os.open(os.devnull, os.O_WRONLY)
    os.dup2(null_fd, 1)
    try:
        writer = STEPCAFControl_Writer()
        writer.SetNameMode(True)
        writer.SetColorMode(True)
        writer.Transfer(doc, STEPControl_AsIs)
        writer.Write(path)
    finally:
        os.dup2(saved_fd, 1)
        os.close(null_fd)
        os.close(saved_fd)

write_step("/output/assembly.step", PARTS)
allx = [bounds(s) for _, _, s in PARTS]

# For watching the build: every part in one BREP file (the kernel's own format, read far faster
# than STEP) and a list of names and colours in the same order, so a program can put the parts on
# screen one at a time. Written last: the meshes on the shapes are not needed in the file.
if len(PARTS) > 1:
    from OCP.BRepTools import BRepTools
    import json as _json
    _palette = [(0.16, 0.48, 0.88), (0.98, 0.42, 0.08), (0.20, 0.72, 0.45), (0.78, 0.18, 0.16), (0.95, 0.76, 0.15), (0.55, 0.36, 0.80), (0.10, 0.70, 0.75), (0.86, 0.88, 0.92)]
    _colors = {}
    for g in dict.fromkeys(g for _, g, _ in PARTS):
        _colors[g] = GROUP_COLORS.get(g) or _palette[len(_colors) % len(_palette)]
    _whole = TopoDS_Compound(); _bb = BRep_Builder(); _bb.MakeCompound(_whole)
    for _, _, shape in PARTS:
        BRepTools.Clean_s(shape)
        _bb.Add(_whole, shape)
    BRepTools.Write_s(_whole, "/output/parts.brep")
    open("/output/build.json", "w").write(_json.dumps({"file": "parts.brep", "colors": _colors, "parts": [{"name": n, "group": g} for n, g, _ in PARTS]}))

summary({
    "model": MODEL,
    "part_count": len(PARTS),
    "blade_count": sum(1 for n in names if "blade" in n.lower() or "vane" in n.lower()),
    "group_count": len(groups),
    "unique_names": len(set(names)) == len(names),
    "invalid_parts": sum(1 for r in rows if r[3] != "yes"),
    "total_volume_mm3": round(sum(r[4] for r in rows), 2),
    "length_mm": round(max(b[3] for b in allx) - min(b[0] for b in allx), 2),
    "diameter_mm": round(max(max(abs(b[1]), abs(b[4]), abs(b[2]), abs(b[5])) for b in allx) * 2, 2),
    "triangles": sum(triangles.values()),
    "groups": ", ".join(sorted(groups)),
})
print("%d parts (%d blades and vanes) in %d groups, %d invalid; STEP assembly and meshes written." % (len(PARTS), sum(1 for n in names if "blade" in n.lower() or "vane" in n.lower()), len(groups), sum(1 for r in rows if r[3] != "yes")))
`;

/** A parametric two-spool turbofan: fan, booster, HP compressor, combustor, turbines, shafts. */
export const TURBOFAN = `
MODEL = "Parametric two-spool turbofan, OpenCascade B-rep solids (illustrative proportions)"
D = float(P["fan_diameter_mm"]); R = D / 2
s = D / 1600.0                                   # every proportion scales with the fan
nf = int(P["fan_blades"]); lpc = int(P["booster_stages"]); hpc = int(P["hpc_stages"])
hpt = int(P["hpt_stages"]); lpt = int(P["lpt_stages"]); inj = int(P["injectors"])
x = 0.0
# Nacelle, spinner and fan
part("Spinner", "fan", cone(2 * s, 170 * s, 30 * s, 230 * s))
part("Fan_Disk", "fan", cylinder(200 * s, 250 * s, 200 * s))
row("Fan_Blade", "fan", nf, blade(205 * s, R * 0.97, 350 * s, 260 * s, 360 * s, 58, 22, 0.06))
part("Fan_Case", "casing", cutaway(tube(R, R + 30 * s, 150 * s, 780 * s)))
part("Nacelle_Cowl", "nacelle", cutaway(tube(R + 45 * s, R + 95 * s, -60 * s, 1500 * s)))
part("Inlet_Lip", "nacelle", cutaway(torus(R + 45 * s, 32 * s, -60 * s)))
row("OGV_Vane", "fan", int(P["ogv_vanes"]), blade(470 * s, R * 0.98, 720 * s, 120 * s, 150 * s, -12, -12, 0.08))
row("Bypass_Strut", "casing", 12, blade(455 * s, R * 0.97, 830 * s, 95 * s, 115 * s, 4, 4, 0.14))
# Core: booster (LPC) and high-pressure compressor
xc = 860 * s
part("Splitter", "casing", tube(445 * s, 465 * s, xc - 40 * s, 120 * s))
for st in range(lpc):
    r_hub, r_tip = 290 * s, 430 * s - st * 18 * s
    part(f"LPC_S{st + 1}_Disk", "compressor", cylinder(r_hub, xc, 40 * s))
    row(f"LPC_S{st + 1}_Rotor_Blade", "compressor", 32 + 4 * st, blade(r_hub, r_tip, xc + 20 * s, 60 * s, 70 * s, 50, 30))
    row(f"LPC_S{st + 1}_Stator_Vane", "compressor", 36 + 4 * st, blade(r_hub + 5 * s, r_tip, xc + 70 * s, 55 * s, 60 * s, -35, -25))
    xc += 105 * s
part("LPC_Case", "casing", cutaway(tube(435 * s, 450 * s, 860 * s, xc - 860 * s)))
part("Core_Cowl", "casing", cutaway(tube(438 * s, 452 * s, 815 * s, 240 * s)))
xh = xc + 40 * s
for st in range(hpc):
    f = st / max(1, hpc - 1)
    r_hub, r_tip = (220 + 40 * f) * s, (330 - 40 * f) * s
    part(f"HPC_S{st + 1:02d}_Disk", "compressor", cylinder(r_hub, xh, 30 * s))
    row(f"HPC_S{st + 1:02d}_Rotor_Blade", "compressor", 30 + 3 * st, blade(r_hub, r_tip, xh + 15 * s, 40 * s, 36 * s, 48, 32))
    row(f"HPC_S{st + 1:02d}_Stator_Vane", "compressor", 34 + 3 * st, blade(r_hub + 4 * s, r_tip, xh + 52 * s, 36 * s, 32 * s, -32, -24))
    xh += 75 * s
part("HPC_Case", "casing", cutaway(tube(335 * s, 350 * s, xc + 40 * s, xh - xc - 40 * s)))
# Combustor: annular liners, dome and fuel injectors
xb = xh + 30 * s
part("Combustor_Outer_Liner", "combustor", cutaway(tube(328 * s, 334 * s, xb, 330 * s)))
part("Combustor_Inner_Liner", "combustor", cutaway(tube(236 * s, 242 * s, xb, 330 * s)))
part("Combustor_Dome", "combustor", cutaway(tube(242 * s, 328 * s, xb, 12 * s)))
for ring in range(3):
    part(f"Combustor_Cooling_Ring_{ring + 1}", "combustor", cutaway(torus(331 * s, 4 * s, xb + (70 + ring * 90) * s)))
polar("Fuel_Injector", "combustor", inj, moved(cylinder(9 * s, xb - 110 * s, 150 * s), 0, 285 * s, 0))
part("Fuel_Manifold", "combustor", torus(303 * s, 13 * s, xb - 45 * s))
polar("Fuel_Feed_Pipe", "combustor", inj, BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(xb - 45 * s, 250 * s, 0), gp_Dir(0, 1, 0)), 6 * s, 55 * s).Shape())
part("Combustor_Case", "casing", cutaway(tube(350 * s, 365 * s, xb - 20 * s, 380 * s)))
# Turbines
xt = xb + 360 * s
for st in range(hpt):
    part(f"HPT_S{st + 1}_Disk", "turbine", cylinder(225 * s, xt, 35 * s))
    row(f"HPT_S{st + 1}_Nozzle_Vane", "turbine", 44 + 4 * st, blade(232 * s, 338 * s, xt - 30 * s, 48 * s, 44 * s, -40, -30, 0.14))
    row(f"HPT_S{st + 1}_Rotor_Blade", "turbine", 48 + 4 * st, blade(230 * s, 336 * s, xt + 18 * s, 42 * s, 38 * s, 38, 52, 0.14))
    xt += 90 * s
for st in range(lpt):
    r_tip = (360 + 35 * st) * s
    part(f"LPT_S{st + 1}_Disk", "turbine", cylinder(235 * s, xt, 35 * s))
    row(f"LPT_S{st + 1}_Nozzle_Vane", "turbine", 52 + 4 * st, blade(242 * s, r_tip, xt - 30 * s, 52 * s, 56 * s, -38, -28, 0.12))
    row(f"LPT_S{st + 1}_Rotor_Blade", "turbine", 56 + 4 * st, blade(240 * s, r_tip - 4 * s, xt + 18 * s, 46 * s, 50 * s, 36, 50, 0.12))
    xt += 95 * s
part("Turbine_Case", "casing", cutaway(cone(345 * s, (365 + 35 * lpt) * s, xb + 340 * s, xt - xb - 340 * s)))
# Shafts and bearings: the LP shaft runs inside the hollow HP shaft
part("LP_Shaft", "shafts", cylinder(45 * s, 300 * s, xt - 260 * s))
part("HP_Shaft", "shafts", tube(70 * s, 95 * s, xc + 40 * s, xt - xc - 40 * s - (lpt * 95 + 40) * s))
for i, xb_ in enumerate([420 * s, xc + 20 * s, xb - 60 * s, xt - 60 * s]):
    part(f"Bearing_{i + 1}", "shafts", tube(96 * s if 0 < i < 3 else 46 * s, (130 if 0 < i < 3 else 80) * s, xb_, 40 * s))
row("Front_Bearing_Strut", "shafts", 8, blade(50 * s, 128 * s, 432 * s, 30 * s, 30 * s, 0, 0, 0.16))
row("Rear_Bearing_Strut", "shafts", 10, blade(84 * s, 205 * s, xt - 52 * s, 34 * s, 34 * s, 0, 0, 0.16))
# Exhaust
part("Exhaust_Plug", "exhaust", cone(200 * s, 30 * s, xt, 450 * s))
part("Exhaust_Nozzle", "exhaust", cutaway(tube((360 + 35 * lpt) * s, (375 + 35 * lpt) * s, xt, 380 * s)))
row("Exhaust_Petal", "exhaust", 12, blade((350 + 35 * lpt) * s, (394 + 35 * lpt) * s, xt + 330 * s, 62 * s, 44 * s, 16, 16, 0.1))
# Accessory gearbox under the fan case, with its pumps
gb_z = -(R + 140 * s)
part("Accessory_Gearbox", "accessories", box(420 * s, 160 * s, 110 * s, 420 * s, -80 * s, gb_z))
part("Towershaft", "accessories", BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(600 * s, 0, gb_z + 110 * s), gp_Dir(0, 0, 1)), 16 * s, R - 200 * s).Shape())
for i, name in enumerate(["Fuel_Pump", "Oil_Pump", "Hydraulic_Pump", "Generator", "Starter"]):
    part(f"Accessory_{name}", "accessories", BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(450 * s + i * 80 * s, -80 * s, gb_z + 40 * s), gp_Dir(0, -1, 0)), 30 * s, 90 * s).Shape())
`;
