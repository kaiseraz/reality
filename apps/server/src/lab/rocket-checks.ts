import { z } from 'zod';
import type { Check } from '../verification/checks.ts';

/**
 * Independent checks for the rocket lab. None of them uses the engines' libraries or
 * code: a mass balance and an ideal-rocket model for the engine, numerical integration for
 * staging, a separately written force model re-flying the ascent, and slice integration of
 * the tank profiles.
 */

const params = z.object({ step: z.string() }).passthrough() as unknown as z.ZodType<
  Record<string, unknown>
>;

export const ROCKET_CHECKS: Check[] = [
  {
    name: 'rocket_engine_recomputed',
    description:
      'Recomputes a rocket engine: O/F from the chamber composition, energy and mass flow at every nozzle station, a sonic throat, c* and Isp from the stations, an ideal-rocket model as a second opinion, and the sizing from the mass flow.',
    params,
    needsResult: true,
    needsData: false,
    body: `
# Propellant formulas restated here (not imported from the engine): the oxidisers carry all
# the oxygen, so the oxidiser mass follows from the oxygen in the products alone.
G0 = 9.80665
AW = {"C": 12.0107, "H": 1.00794, "O": 15.9994, "N": 14.0067}
FORM = {"lox_lh2": ({"H": 2}, {"O": 2}), "lox_ch4": ({"C": 1, "H": 4}, {"O": 2}),
        "lox_rp1": ({"C": 1, "H": 1.9532}, {"O": 2}), "n2o4_mmh": ({"C": 1, "H": 6, "N": 2}, {"N": 2, "O": 4})}
claim = CLAIM or {}
mismatches = []
def off(name, expected, claimed, tol):
    if claimed is None or abs(expected - num(claimed)) > tol * max(1.0, abs(expected)):
        mismatches.append({"problem": name, "expected": expected, "claimed": claimed})
fuel, ox = FORM[str(claim.get("propellant"))]
mass = lambda f: sum(AW[e] * n for e, n in f.items())
# 1. Mass balance: the O/F ratio from the chamber composition
el = {e: 0.0 for e in AW}
for sp in claim.get("composition") or []:
    for j, e in enumerate(("C", "H", "O", "N")): el[e] += num(sp[1]) * num(sp[2 + j]) * AW[e]
total = sum(el.values())
ox_mass = el["O"] / (AW["O"] * ox["O"] / mass(ox))
of = ox_mass / (total - ox_mass)
off("O/F from the chamber composition", of, claim.get("of_ratio"), 2e-3)
if "C" in fuel:
    ratio = (el["H"] / AW["H"]) / (el["C"] / AW["C"])
    off("H/C ratio of the fuel", fuel["H"] / fuel["C"], ratio, 2e-3)
# 2. Energy and mass flow along the nozzle: h + v^2/2 constant, rho v A constant
st = rows("/input/result.csv")
h0 = num(st[0]["enthalpy_J_kg"]) + num(st[0]["velocity_m_s"]) ** 2 / 2
worst = 0.0
throat = [r for r in st if r["region"] == "throat"][0]
Gt = num(throat["density_kg_m3"]) * num(throat["velocity_m_s"])
for r in st:
    e = abs(num(r["enthalpy_J_kg"]) + num(r["velocity_m_s"]) ** 2 / 2 - h0)
    worst = max(worst, e / abs(h0) if h0 else e)
    if e > 1e-5 * max(abs(h0), 1e5): mismatches.append({"problem": "energy not conserved", "pressure_bar": r["pressure_bar"], "error_J_kg": e})
    g = num(r["density_kg_m3"]) * num(r["velocity_m_s"]) * num(r["area_ratio"])
    if abs(g - Gt) > 1e-4 * Gt: mismatches.append({"problem": "mass flow not conserved", "pressure_bar": r["pressure_bar"]})
# 3. The throat is where the flow turns sonic
if abs(num(throat["mach"]) - 1) > 0.02: mismatches.append({"problem": "throat Mach", "mach": throat["mach"]})
# 4. Performance from the station table
pc = num(claim.get("chamber_pressure_bar")) * 1e5
ex = st[-1]
eps = num(ex["area_ratio"])
off("c*", pc / Gt, claim.get("cstar_m_s"), 1e-4)
isp_vac = (num(ex["velocity_m_s"]) + num(ex["pressure_bar"]) * 1e5 * eps / Gt) / G0
off("vacuum Isp", isp_vac, claim.get("isp_vac_s"), 1e-4)
off("sea-level Isp", isp_vac - 101325 * eps / (Gt * G0), claim.get("isp_sl_s"), 1e-4)
# 5. A different model: ideal rocket with a constant isentropic exponent
gm = num(claim.get("gamma_s")); M = num(claim.get("molar_mass")); Tc = num(claim.get("chamber_temperature_K"))
Gam = math.sqrt(gm) * (2 / (gm + 1)) ** ((gm + 1) / (2 * (gm - 1)))
cstar_ideal = math.sqrt(8314.462618 / M * Tc) / Gam
def area(m): return 1 / m * ((2 / (gm + 1)) * (1 + (gm - 1) / 2 * m * m)) ** ((gm + 1) / (2 * (gm - 1)))
lo, hi = 1.0, 50.0
for _ in range(200):
    mid = (lo + hi) / 2
    if area(mid) < eps: lo = mid
    else: hi = mid
pr_ = (1 + (gm - 1) / 2 * lo * lo) ** (-gm / (gm - 1))
cf = Gam * math.sqrt(2 * gm / (gm - 1) * (1 - pr_ ** ((gm - 1) / gm))) + eps * pr_
isp_ideal = cstar_ideal * cf / G0
if abs(cstar_ideal - pc / Gt) > 0.03 * cstar_ideal: mismatches.append({"problem": "c* far from the ideal-rocket value", "ideal": cstar_ideal, "claimed": pc / Gt})
if abs(isp_ideal - isp_vac) > 0.06 * isp_ideal: mismatches.append({"problem": "vacuum Isp far from the ideal-rocket value", "ideal": isp_ideal, "claimed": isp_vac})
# 6. Sizing: thrust, throat and exit from the mass flow
md = num(claim.get("mass_flow_kg_s"))
off("vacuum thrust", md * num(claim.get("delivered_isp_vac_s")) * G0 / 1e3, claim.get("thrust_vac_kN"), 1e-6)
At = md * num(claim.get("cstar_m_s")) * num(claim.get("cstar_efficiency")) / pc
off("throat diameter", math.sqrt(4 * At / math.pi) * 1000, claim.get("throat_diameter_mm"), 1e-6)
off("exit diameter", math.sqrt(4 * At * eps / math.pi) * 1000, claim.get("exit_diameter_mm"), 1e-4)
verdict(not mismatches, len(st), worst, mismatches,
        "O/F %.3f from the mass balance; energy and mass flow conserved at %d stations; ideal-rocket model gives c* %.0f m/s and %.1f s (reported %.0f m/s, %.1f s)" % (of, len(st), cstar_ideal, isp_ideal, pc / Gt, isp_vac))
`,
  },
  {
    name: 'launch_vehicle_recomputed',
    description:
      'Adds up the stage masses from the payload, integrates each stage delta-v numerically, recomputes the orbital speed and tests that the delta-v split is optimal.',
    params,
    needsResult: true,
    needsData: false,
    body: `
G0 = 9.80665
claim = CLAIM or {}
st = rows("/input/result.csv")
mismatches = []
def off(name, expected, claimed, tol):
    if claimed in (None, "") or abs(expected - num(claimed)) > tol * max(1.0, abs(expected)):
        mismatches.append({"problem": name, "expected": expected, "claimed": claimed})
# 1. Mass bookkeeping from the payload up
m_up = num(claim.get("payload_kg")) + num(claim.get("fairing_mass_kg"))
for r in reversed(st):
    off("stage %s ignition mass" % r["stage"], m_up + num(r["dry_kg"]) + num(r["propellant_kg"]), r["ignition_mass_kg"], 1e-6)
    off("stage %s burnout mass" % r["stage"], num(r["ignition_mass_kg"]) - num(r["ascent_propellant_kg"]), r["burnout_mass_kg"], 1e-6)
    off("stage %s reserve" % r["stage"], num(r["propellant_kg"]) - num(r["ascent_propellant_kg"]), r["reserve_kg"], 1e-5)
    m_up = num(r["ignition_mass_kg"])
off("liftoff mass", m_up, claim.get("liftoff_mass_kg"), 1e-6)
# 2. Delta-v by integrating m dv = -ve dm numerically (not the logarithm)
total = 0.0; worst = 0.0
for r in st:
    ve = num(r["isp_effective_s"]) * G0
    m0, m1 = num(r["ignition_mass_kg"]), num(r["burnout_mass_kg"])
    N = 20000; dm = (m0 - m1) / N; dv = 0.0
    for j in range(N):
        a, b = m0 - j * dm, m0 - (j + 1) * dm
        dv += ve * dm * (1 / a + 4 / ((a + b) / 2) + 1 / b) / 6      # Simpson on 1/m
    total += dv
    err = abs(dv - num(r["delta_v_m_s"])); worst = max(worst, err)
    if err > 0.01 + 1e-6 * dv: mismatches.append({"problem": "stage %s delta-v" % r["stage"], "integrated": dv, "claimed": r["delta_v_m_s"]})
off("total delta-v", total, claim.get("delta_v_total_m_s"), 1e-5)
# 3. The orbit's delta-v requirement from first principles
MU, RE, OMEGA = 3.986004418e14, 6378137.0, 7.2921159e-5
v = math.sqrt(MU / (RE + num(claim.get("orbit_altitude_km")) * 1e3))
off("orbital velocity", v, claim.get("orbital_velocity_m_s"), 1e-9)
# 4. The split is optimal: moving delta-v between any two stages does not lower liftoff mass
if claim.get("mode") == "optimize" and len(st) > 1:
    P0 = {int(r["stage"]): r for r in st}
    def liftoff(split):
        m = num(claim.get("payload_kg")) + num(claim.get("fairing_mass_kg"))
        for r in reversed(st):
            i = int(r["stage"]); ve = num(r["isp_effective_s"]) * G0
            f = num(r["structural_fraction"]); k = f / (1 - f)
            prop0, dry0, res0 = num(r["propellant_kg"]), num(r["dry_kg"]), num(r["reserve_kg"])
            c = res0 / dry0 if dry0 else 0.0                  # reserve per kg of dry mass
            R = math.exp(split[i - 1] / ve)
            den = 1 + k - R * k * (1 + c)
            if den <= 0: return float("inf")
            mp = m * (R - 1) / den
            m = m + mp * (1 + k)
        return m
    base = [num(r["delta_v_m_s"]) for r in st]
    m_base = liftoff(base)
    off("liftoff mass from the split", m_base, claim.get("liftoff_mass_kg"), 1e-6)
    for i in range(len(base)):
        for j in range(len(base)):
            if i == j: continue
            s = list(base); s[i] += 10; s[j] -= 10
            if liftoff(s) < m_base * (1 - 1e-6):
                mismatches.append({"problem": "split not optimal", "move_10_m_s_from_stage": j + 1, "to_stage": i + 1, "liftoff": liftoff(s), "claimed": m_base})
verdict(not mismatches, len(st), worst, mismatches,
        "%d stages: masses add up from the payload; delta-v integrated numerically %.1f m/s (claimed %.1f)%s" % (
            len(st), total, num(claim.get("delta_v_total_m_s")), "; split optimal against 10 m/s moves" if claim.get("mode") == "optimize" else ""))
`,
  },
  {
    name: 'ascent_recomputed',
    description:
      'Re-flies each interval of an ascent from its reported state with an independent force model and integrator, recomputes dynamic pressure, the orbit at cutoff, the circularisation and max-Q.',
    params,
    needsResult: true,
    needsData: false,
    body: `
# Re-flies every interval of the reported trajectory from its reported state with a force
# model and integrator written separately from the engine (substeps of 0.05 s, controls
# interpolated between rows), then recomputes the orbit and the circularisation.
G0 = 9.80665
MU, RE, OMEGA = 3.986004418e14, 6378137.0, 7.2921159e-5
R_AIR, M_AIR, R_U = 287.053, 0.0289644, 8.3144598
LAYERS = [(0.0, -6.5e-3), (11e3, 0.0), (20e3, 1e-3), (32e3, 2.8e-3), (47e3, 0.0), (51e3, -2.8e-3), (71e3, -2e-3), (84852.0, None)]
base = []
T, p = 288.15, 101325.0
for i, (hb, lapse) in enumerate(LAYERS):
    base.append((hb, lapse, T, p))
    if lapse is None: break
    dh = LAYERS[i + 1][0] - hb
    if lapse == 0.0: p = p * math.exp(-G0 * M_AIR * dh / (R_U * T))
    else:
        T2 = T + lapse * dh
        p = p * (T2 / T) ** (-G0 * M_AIR / (R_U * lapse)); T = T2
def air(z):
    hgeo = RE * max(z, 0.0) / (RE + max(z, 0.0))
    for hb, lapse, Tb, pb in reversed(base):
        if hgeo >= hb: break
    if lapse is None: pr = pb * math.exp(-(hgeo - hb) / 7000.0); return Tb, pr, pr / (R_AIR * Tb)
    if lapse == 0.0: pr = pb * math.exp(-G0 * M_AIR * (hgeo - hb) / (R_U * Tb)); return Tb, pr, pr / (R_AIR * Tb)
    Tz = Tb + lapse * (hgeo - hb)
    pr = pb * (Tz / Tb) ** (-G0 * M_AIR / (R_U * lapse))
    return Tz, pr, pr / (R_AIR * Tz)
CDT = [(0, 0.30), (0.6, 0.30), (0.8, 0.35), (1.0, 0.50), (1.2, 0.55), (1.5, 0.48), (2.0, 0.40), (3.0, 0.32), (5.0, 0.28), (10.0, 0.25)]
def drag_coeff(mach):
    for (m0, c0), (m1, c1) in zip(CDT, CDT[1:]):
        if mach <= m1: return c0 + (c1 - c0) * (max(mach, m0) - m0) / (m1 - m0)
    return CDT[-1][1]

lat = math.radians(float(P.get("launch_latitude_deg", 28.5)))
inc = math.radians(float(P.get("inclination_deg") or P.get("launch_latitude_deg", 28.5)))
w = OMEGA * math.cos(lat) * math.sin(math.asin(min(1.0, math.cos(inc) / math.cos(lat))))
A = math.pi * float(P["diameter_m"]) ** 2 / 4 * float(P.get("cd_scale", 1.0))
eng = []
for s in P["stages"]:
    Fv = float(s["thrust_vac_kN"]) * 1e3; iv = float(s["isp_vac_s"]); isl = float(s.get("isp_sl_s") or 0)
    eng.append((Fv, iv, (Fv * (1 - isl / iv)) / 101325.0 if isl else float(s.get("exit_area_m2", 0))))

def accel(x, y, vx, vy, m, stage, pitch, thr):
    r = math.sqrt(x * x + y * y)
    ux, uy = x / r, y / r
    Tz, pz, rho = air(r - RE)
    ax_, ay_ = vx - w * y, vy + w * x
    va = math.sqrt(ax_ * ax_ + ay_ * ay_)
    D = 0.5 * rho * va * va * drag_coeff(va / math.sqrt(1.4 * R_AIR * Tz)) * A
    Fv, iv, Ae = eng[stage - 1]
    F = thr * max(Fv - pz * Ae, 0.0)
    md = thr * Fv / (iv * G0)
    c, s_ = math.cos(pitch), math.sin(pitch)
    tx, ty = c * uy + s_ * ux, -c * ux + s_ * uy
    gx, gy = -MU * x / r ** 3, -MU * y / r ** 3
    dx = -D * ax_ / va if va > 0 else 0.0
    dy = -D * ay_ / va if va > 0 else 0.0
    return gx + (F * tx + dx) / m, gy + (F * ty + dy) / m, -md

tr = rows("/input/result.csv")
claim = CLAIM or {}
jumps = [num(e[1]) for e in claim.get("events") or [] if "separation" in str(e[0])]   # mass drops
claim = CLAIM or {}
mismatches = []
checked = 0; worst_v = 0.0; worst_r = 0.0
for a, b in zip(tr, tr[1:]):
    ta, tb = num(a["t_s"]), num(b["t_s"])
    if tb - ta < 1e-6 or a["stage"] != b["stage"] or any(ta - 1e-3 <= t <= tb + 1e-2 for t in jumps): continue
    x, y, vx, vy, m = num(a["x_m"]), num(a["y_m"]), num(a["vx_m_s"]), num(a["vy_m_s"]), num(a["mass_kg"])
    st = int(a["stage"])
    burning = num(a["thrust_kN"]) > 0 or num(b["thrust_kN"]) > 0
    N = max(1, int(round((tb - ta) / 0.05))); h = (tb - ta) / N
    # A row at an ignition or cutoff reports the engine off; the burn uses the other row's controls.
    ca = (num(a["pitch_deg"]), num(a["throttle"])) if num(a["thrust_kN"]) > 0 else None
    cb = (num(b["pitch_deg"]), num(b["throttle"])) if num(b["thrust_kN"]) > 0 else None
    ca, cb = ca or cb, cb or ca
    def ctl(t):
        if not burning: return 0.0, 0.0
        f = (t - ta) / (tb - ta)
        return math.radians(ca[0] + (cb[0] - ca[0]) * f), ca[1] + (cb[1] - ca[1]) * f
    for j in range(N):
        t0 = ta + j * h
        # Heun's method (2nd order) on tiny substeps: a different integrator from the engine's RK4.
        p1, th1 = ctl(t0); k1 = accel(x, y, vx, vy, m, st, p1, th1)
        x1, y1, vx1, vy1, m1 = x + h * vx, y + h * vy, vx + h * k1[0], vy + h * k1[1], m + h * k1[2]
        p2, th2 = ctl(t0 + h); k2 = accel(x1, y1, vx1, vy1, m1, st, p2, th2)
        x, y = x + h / 2 * (vx + vx1), y + h / 2 * (vy + vy1)
        vx, vy, m = vx + h / 2 * (k1[0] + k2[0]), vy + h / 2 * (k1[1] + k2[1]), m + h / 2 * (k1[2] + k2[2])
    dr = math.hypot(x - num(b["x_m"]), y - num(b["y_m"])); dv = math.hypot(vx - num(b["vx_m_s"]), vy - num(b["vy_m_s"]))
    worst_r, worst_v = max(worst_r, dr), max(worst_v, dv)
    checked += 1
    # Throttle kinks (reaching the g limit) within a second: allow 1 % of the propellant burned.
    if dr > 25 or dv > 0.25 or abs(m - num(b["mass_kg"])) > 1 + 0.01 * abs(num(a["mass_kg"]) - num(b["mass_kg"])):
        mismatches.append({"problem": "trajectory does not follow from the forces", "t_s": tb, "position_error_m": dr, "velocity_error_m_s": dv, "mass_error_kg": m - num(b["mass_kg"])})
    # dynamic pressure from the independent atmosphere
    rr = math.hypot(num(b["x_m"]), num(b["y_m"]))
    Tz, pz, rho = air(rr - RE)
    vxa, vya = num(b["vx_m_s"]) - w * num(b["y_m"]), num(b["vy_m_s"]) + w * num(b["x_m"])
    q = 0.5 * rho * (vxa * vxa + vya * vya) / 1e3
    if abs(q - num(b["q_kPa"])) > 1e-3 + 1e-4 * q: mismatches.append({"problem": "dynamic pressure", "t_s": tb, "recomputed_kPa": q, "reported_kPa": b["q_kPa"]})
# Orbit at cutoff from the last state (vis-viva and angular momentum)
L = tr[-1]
x, y, vx, vy = num(L["x_m"]), num(L["y_m"]), num(L["vx_m_s"]), num(L["vy_m_s"])
r = math.hypot(x, y); v2 = vx * vx + vy * vy
a_ = 1 / (2 / r - v2 / MU)
hz = x * vy - y * vx
e = math.sqrt(max(0.0, 1 - hz * hz / (MU * a_)))
apo, peri = a_ * (1 + e) - RE, a_ * (1 - e) - RE
def off(name, expected, claimed, tol):
    if claimed is None or abs(expected - num(claimed)) > tol: mismatches.append({"problem": name, "expected": expected, "claimed": claimed})
off("apoapsis (km)", apo / 1e3, claim.get("apoapsis_km"), 0.05)
off("periapsis at cutoff (km)", peri / 1e3, claim.get("periapsis_at_cutoff_km"), 0.05)
# Circularisation: speed at apoapsis, burn and what is left
ra = apo + RE
dvc = math.sqrt(MU / ra) - math.sqrt(MU * (2 / ra - 1 / a_))
off("circularisation delta-v", dvc, claim.get("circularization_delta_v_m_s"), 0.05)
last = P["stages"][-1]
need = num(L["mass_kg"]) * (1 - math.exp(-dvc / (float(last["isp_vac_s"]) * G0)))
qmax = max(num(rw["q_kPa"]) for rw in tr)
if num(claim.get("max_q_kPa")) < qmax - 1e-4 or num(claim.get("max_q_kPa")) > qmax * 1.03 + 0.05:
    mismatches.append({"problem": "max-Q", "from_rows": qmax, "claimed": claim.get("max_q_kPa")})
reached = bool(claim.get("orbit_reached"))
if reached and (apo < num(claim.get("target_altitude_km")) * 1e3 - 1000 or num(claim.get("propellant_margin_kg")) < 0):
    mismatches.append({"problem": "orbit claimed but not reached"})
verdict(not mismatches and checked > 10, checked, worst_v, mismatches,
        "%d intervals re-flown with an independent force model (worst %.2f m, %.3f m/s); orbit at cutoff %.1f x %.1f km; circularisation %.1f m/s needs %.0f kg" % (
            checked, worst_r, worst_v, apo / 1e3, peri / 1e3, dvc, need))
`,
  },
  {
    name: 'rocket_tanks_recomputed',
    description:
      'Rebuilds each tank as a profile of revolution, integrates volume and wall area in slices, and recomputes hoop stress, buckling and mass.',
    params,
    needsResult: true,
    needsData: false,
    body: `
# Rebuilds each tank as a profile of revolution and integrates its volume and wall area in
# slices (instead of closed formulas), then recomputes stresses and buckling from the walls.
RHO = {"lox": 1141.0, "lh2": 70.8, "lch4": 422.6, "rp1": 810.0, "n2o4": 1440.0, "mmh": 875.0}
MATS = {"Al 2219-T87": (2840, 73.1), "Al-Li 2195-T8": (2700, 76.0), "Stainless 304L": (7900, 193.0),
        "Stainless 301 full hard": (7880, 193.0), "Ti-6Al-4V": (4430, 114.0), "Carbon fibre (quasi-isotropic)": (1550, 70.0)}
claim = CLAIM or {}
mismatches = []
ull = float(P.get("ullage", 0.03)); fac = float(P.get("nonoptimum_factor", 1.3)); sfu = float(P.get("ultimate_factor", 1.4))
worst = 0.0
for r in rows("/input/result.csv"):
    R = num(r["diameter_m"]) / 2; Lc = num(r["cylinder_m"]); b = num(r["length_m"]) - Lc
    hdome = b / 2
    N = 4000
    vol = 0.0; area = 0.0
    # dome: x from 0 to hdome, radius r(x) = R sqrt(1 - ((hdome - x)/hdome)^2), two of them
    prev = None
    for i in range(N + 1):
        x = hdome * i / N
        rr = R * math.sqrt(max(0.0, 1 - ((hdome - x) / hdome) ** 2))
        if prev is not None:
            dx = x - prev[0]
            vol += math.pi * dx * (rr * rr + rr * prev[1] + prev[1] ** 2) / 3          # frustum slices
            area += math.pi * (rr + prev[1]) * math.hypot(dx, rr - prev[1])
        prev = (x, rr)
    vol, area = 2 * vol, 2 * area
    vol += math.pi * R * R * Lc
    expected = num(r["propellant_kg"]) / RHO[r["propellant"]] * (1 + ull)
    err = abs(vol - expected) / expected; worst = max(worst, err)
    if err > 1e-3: mismatches.append({"problem": "tank volume", "tank": r["name"] + " " + r["tank"], "integrated_m3": vol, "needed_m3": expected})
    if abs(vol - num(r["volume_m3"])) > 1e-3 * vol: mismatches.append({"problem": "reported volume", "tank": r["tank"], "integrated_m3": vol, "reported": r["volume_m3"]})
    t = num(r["wall_mm"]) / 1e3; td = num(r["dome_mm"]) / 1e3
    p = num(r["design_pressure_bar"]) * 1e5
    hoop = p * R / t / 1e6
    if abs(hoop - num(r["hoop_stress_MPa"])) > 1e-3 * hoop: mismatches.append({"problem": "hoop stress", "tank": r["tank"], "expected": hoop, "reported": r["hoop_stress_MPa"]})
    if hoop > num(r["allowable_MPa"]) * (1 + 1e-6): mismatches.append({"problem": "wall overstressed", "tank": r["tank"], "hoop_MPa": hoop, "allowable_MPa": r["allowable_MPa"]})
    rho, E = MATS[r["material"]]
    gam = 1 - 0.901 * (1 - math.exp(-math.sqrt(R / t) / 16))
    scr = gam * 0.6052 * E * 1e3 * t / R
    if abs(scr - num(r["buckling_stress_MPa"])) > 2e-3 * scr: mismatches.append({"problem": "buckling stress", "tank": r["tank"], "expected": scr, "reported": r["buckling_stress_MPa"]})
    sax = num(r["axial_stress_MPa"])
    if sax > 0 and scr / (sax * sfu) < 1 - 2e-3: mismatches.append({"problem": "buckles under the axial load", "tank": r["tank"], "critical_MPa": scr, "applied_x_factor_MPa": sax * sfu})
    mass = (2 * math.pi * R * Lc * t + area * td) * rho * fac
    if abs(mass - num(r["mass_kg"])) > 2e-3 * mass: mismatches.append({"problem": "tank mass", "tank": r["tank"], "integrated_kg": mass, "reported": r["mass_kg"]})
n = len(rows("/input/result.csv"))
verdict(not mismatches, n, worst, mismatches,
        "%d tanks rebuilt in 4000 slices per dome: volumes within %.2g, stresses, buckling and masses recomputed" % (n, worst))
`,
  },
];
