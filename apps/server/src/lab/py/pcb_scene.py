
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
    m = _re.fullmatch(r"(SOIC|TSSOP)(\d+)", n)
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
    m = _re.fullmatch(r"DIP(\d+)", n)
    if m:
        k = int(m.group(1)); bl = k // 2 * 2.54 - 0.4
        box(0, 0, 0.5, 6.35, bl, 3.6, BLACK, 0.0, 0.34)
        cyl(0, -bl / 2, 4.1, 2.0, 0.01, GREY, 0.0, 0.6)
        for num, shape, px, py, pw, ph, dr in p.pads:
            box(px, py, -3.0, 0.5, 0.5, 3.9, SILVER, 1.0, 0.25)
            box(px * 0.9, py, 0.0, 1.2, 0.5, 0.5, SILVER, 1.0, 0.25)
        return out
    m = _re.fullmatch(r"HEADER(?:(\d+)X)?(\d+)", n)
    if m:
        rows, cols = int(m.group(1) or 1), int(m.group(2))
        box(0, 0, 0.0, 2.54 * rows, 2.54 * cols, 2.5, BLACK, 0.0, 0.4)
        for num, shape, px, py, pw, ph, dr in p.pads:
            box(px, py, -3.0, 0.64, 0.64, 11.0, GOLD, 1.0, 0.28)
        return out
    if n.startswith("HOLE"): return out
    if n == "TESTPOINT": return out
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
            out.append("Transform { %s rotation 1 0 0 1.5708 children [ Shape { appearance Appearance { material %s } geometry Cylinder { radius %.4f height %.4f } } ] }" % (pos, material, dx / 2, dz))
    return "\n".join(out) + "\n"

MODEL_FILE = {}
for _p in parts:
    _local = _part_bodies(_p)
    if not _local: continue
    _key = _hashlib.md5(_json.dumps(_local, sort_keys=True).encode()).hexdigest()[:6]
    _name = "model_%s_%s.wrl" % (_p.fp.lower(), _key)
    if _name not in MODEL_FILE.values():
        open("/output/" + _name, "w").write(_wrl(_local))
    MODEL_FILE[_p.ref] = _name
