import { z } from 'zod';
import { CAD_EPILOGUE, CAD_HELPERS } from './cad.ts';
import type { LabEngine } from './engines.ts';

/**
 * The rocket lab: a liquid rocket engine from chemical equilibrium (Cantera with the NASA
 * thermo database), launch-vehicle staging, a flown ascent to orbit, propellant tanks with
 * pressure and buckling sizing, and the whole vehicle as a CAD assembly. Each engine's
 * claims are recomputed by an independent check (lab/rocket-checks.ts). Together they take
 * a bot from "a rocket that puts 15 t in orbit" to numbers it can defend.
 */

export const PROPELLANTS = ['lox_lh2', 'lox_ch4', 'lox_rp1', 'n2o4_mmh'] as const;
export const TANK_MATERIALS = ['al2219', 'al2195', 'ss304l', 'ss301', 'ti6al4v', 'cfrp'] as const;

const PROPULSION = `import cantera as ct
G0 = 9.80665
PA_SL = 101325.0
AW = {"C": 12.0107, "H": 1.00794, "O": 15.9994, "N": 14.0067}
# Propellants as stored liquids: element formula, enthalpy of formation at storage
# temperature (J/mol, NASA CEA thermo data), density (kg/m3), usual O/F and L*.
PROPS = {
    "lox_lh2": {"name": "LOX / liquid hydrogen", "fuel": {"H": 2}, "fuel_h": -9012.0, "ox": {"O": 2}, "ox_h": -12979.0, "of": 6.0, "fuel_rho": 70.8, "ox_rho": 1141.0, "lstar": 0.76},
    "lox_ch4": {"name": "LOX / liquid methane", "fuel": {"C": 1, "H": 4}, "fuel_h": -89233.0, "ox": {"O": 2}, "ox_h": -12979.0, "of": 3.6, "fuel_rho": 422.6, "ox_rho": 1141.0, "lstar": 0.9},
    "lox_rp1": {"name": "LOX / RP-1 kerosene", "fuel": {"C": 1, "H": 1.9532}, "fuel_h": -24717.7, "ox": {"O": 2}, "ox_h": -12979.0, "of": 2.56, "fuel_rho": 810.0, "ox_rho": 1141.0, "lstar": 1.02},
    "n2o4_mmh": {"name": "N2O4 / MMH (storable)", "fuel": {"C": 1, "H": 6, "N": 2}, "fuel_h": 54200.0, "ox": {"N": 2, "O": 4}, "ox_h": -19564.0, "of": 2.0, "fuel_rho": 875.0, "ox_rho": 1440.0, "lstar": 0.8},
}
pr = PROPS[P["propellant"]]
molar = lambda f: sum(AW[e] * n for e, n in f.items())
import warnings
warnings.filterwarnings("ignore")
# Products: every C/H/O/N gas species of the NASA thermo database (9-coefficient fits,
# 200-6000 K), the set NASA CEA uses for these propellants.
gas = ct.Solution(thermo="ideal-gas", species=[s for s in ct.Species.list_from_file("nasa_gas.yaml")
                  if set(s.composition) <= {"C", "H", "O", "N"} and sum(s.composition.values()) <= 6])
tr = ct.Solution("gri30.yaml")   # transport properties for the heat-flux estimate
pc = float(P["chamber_pressure_bar"]) * 1e5

def mixture(of):
    wf, wo = 1 / (1 + of), of / (1 + of)
    atoms = {}
    for f, w in ((pr["fuel"], wf), (pr["ox"], wo)):
        for e, n in f.items(): atoms[e] = atoms.get(e, 0.0) + w / molar(f) * n
    h = 1000 * (wf * pr["fuel_h"] / molar(pr["fuel"]) + wo * pr["ox_h"] / molar(pr["ox"]))
    return atoms, h

def chamber(of):
    atoms, h = mixture(of)
    gas.TPX = 3000.0, pc, atoms
    gas.equilibrate("TP")
    gas.HP = h, pc
    gas.equilibrate("HP")
    return gas.T, gas.h, gas.s, gas.X.copy()

class Flow:
    """Shifting-equilibrium isentropic expansion from the chamber (infinite-area combustor)."""
    def __init__(self, of):
        self.of = of
        self.Tc, self.h0, self.s0, self.Xc = chamber(of)
        self.Mc = gas.mean_molecular_weight
        self.gamma_frozen = gas.cp / gas.cv
        self.cp = gas.cp_mass
        known = {n: x for n, x in zip(gas.species_names, gas.X) if n in tr.species_names and x > 0}
        tr.TPX = gas.T, pc, known
        self.mu, self.k = tr.viscosity, tr.thermal_conductivity
        self.gamma_s = self.isentropic_exponent(pc)
        self.throat()
    def at(self, p):
        gas.SP = self.s0, p
        gas.equilibrate("SP")
        v = math.sqrt(max(2 * (self.h0 - gas.h), 0.0))
        return {"p": p, "T": gas.T, "rho": gas.density, "h": gas.h, "v": v, "G": gas.density * v}
    def isentropic_exponent(self, p):
        a, b = self.at(p * 1.002), self.at(p / 1.002)
        return math.log(a["p"] / b["p"]) / math.log(a["rho"] / b["rho"])
    def sound(self, s):
        a, b = self.at(s["p"] * 1.002), self.at(s["p"] / 1.002)
        return math.sqrt((a["p"] - b["p"]) / (a["rho"] - b["rho"]))
    def throat(self):
        lo, hi = 0.35 * pc, 0.80 * pc
        g = (math.sqrt(5) - 1) / 2
        for _ in range(60):
            c, d = hi - g * (hi - lo), lo + g * (hi - lo)
            if self.at(c)["G"] > self.at(d)["G"]: hi = d
            else: lo = c
        self.t = self.at((lo + hi) / 2)
        self.Gt = self.t["G"]
        self.cstar = pc / self.Gt
    def eps(self, s): return self.Gt / s["G"]
    def exit_for_ratio(self, eps):
        lo, hi = math.log(pc * 1e-7), math.log(self.t["p"])
        for _ in range(70):
            m = (lo + hi) / 2
            if self.eps(self.at(math.exp(m))) > eps: lo = m
            else: hi = m
        return self.at(math.exp((lo + hi) / 2))
    def perf(self, e):
        eps = self.eps(e)
        isp_vac = (e["v"] + e["p"] * eps / self.Gt) / G0
        return eps, isp_vac, isp_vac - PA_SL * eps / (self.Gt * G0)

def flow_with_exit(of):
    f = Flow(of)
    e = f.at(float(P["exit_pressure_bar"]) * 1e5) if P.get("exit_pressure_bar") else f.exit_for_ratio(float(P["expansion_ratio"]))
    return f, e

# O/F sweep around the propellant's usual mixture ratio; optionally pick the best.
base_of = float(P.get("of_ratio") or pr["of"])
sweep = []
for k in np.linspace(0.6, 1.4, int(P.get("sweep_points", 9))):
    f, e = flow_with_exit(base_of * k)
    eps, iv, isl = f.perf(e)
    sweep.append([round(base_of * k, 4), round(f.Tc, 2), round(f.cstar, 2), round(iv, 3), round(isl, 3), round(eps, 3)])
write_csv("of_sweep.csv", ["of_ratio", "chamber_temperature_K", "cstar_m_s", "isp_vac_s", "isp_sl_s", "expansion_ratio"], sweep)
best = max(sweep, key=lambda r: r[3])
of = best[0] if P.get("optimize_of") else base_of

f, e = flow_with_exit(of)
eps, isp_vac, isp_sl = f.perf(e)
eta_c, eta_f = float(P["cstar_efficiency"]), float(P["nozzle_efficiency"])
d_vac, d_sl = isp_vac * eta_c * eta_f, (isp_vac * eta_c * eta_f - PA_SL * eps / (f.Gt * G0))
# Size the engine for the requested thrust (delivered performance).
F = float(P["thrust_kN"]) * 1e3
isp_size = d_sl if P["thrust_at"] == "sea_level" else d_vac
if isp_size <= 0: raise SystemExit("The nozzle does not produce thrust at sea level; size it in vacuum.")
mdot = F / (isp_size * G0)
At = mdot * f.cstar * eta_c / pc
Ae = At * eps
Dt, De = math.sqrt(4 * At / math.pi), math.sqrt(4 * Ae / math.pi)
Rt = Dt / 2
F_vac, F_sl = mdot * d_vac * G0, mdot * d_sl * G0

# Station table through the nozzle: converging side down to the throat, then the bell.
cr = float(P["contraction_ratio"])
rows = []
lo, hi = math.log(f.t["p"]), math.log(pc * 0.99999)
for _ in range(60):
    m = (lo + hi) / 2
    if f.eps(f.at(math.exp(m))) < cr: lo = m
    else: hi = m
p_inj = math.exp(lo)
for region, ps in (("converging", np.exp(np.linspace(math.log(p_inj), math.log(f.t["p"]), 14))[:-1]),
                   ("throat", [f.t["p"]]),
                   ("diverging", np.exp(np.linspace(math.log(f.t["p"]), math.log(e["p"]), 40))[1:])):
    for p in ps:
        s = f.at(float(p))
        rows.append([region, round(s["p"] / 1e5, 6), round(s["T"], 3), s["rho"], round(s["v"], 4), round(s["v"] / f.sound(s), 5), round(f.eps(s), 6), round(s["h"], 3)])
write_csv("result.csv", ["region", "pressure_bar", "temperature_K", "density_kg_m3", "velocity_m_s", "mach", "area_ratio", "enthalpy_J_kg"], rows)

# Chamber composition with element counts (in the summary), so a check can redo the mass balance.
gas.TPX = f.Tc, pc, f.Xc
spec = []
for i, name in enumerate(gas.species_names):
    if f.Xc[i] > 1e-7:
        sp = gas.species(i)
        spec.append([name, f.Xc[i]] + [sp.composition.get(el, 0) for el in ("C", "H", "O", "N")])
spec.sort(key=lambda r: -r[1])

# Rao-style 80 % bell contour (parabolic approximation) with the chamber, for CAD.
def interp(x, xs, ys): return float(np.interp(math.log(x), np.log(xs), ys))
EPS_T = [4, 10, 20, 30, 40, 50, 100, 200]
tn = math.radians(interp(eps, EPS_T, [21, 30, 32.5, 33.5, 34.5, 35, 37, 38.5]))
te = math.radians(interp(eps, EPS_T, [14, 8.5, 7.5, 7, 6.5, 6.25, 5.5, 4.5]))
Rc = Rt * math.sqrt(cr)
Lstar = float(P.get("l_star_m") or pr["lstar"])
conv = math.radians(30)
r1, r2 = 1.5 * Rt, 0.382 * Rt
pts = []
# converging: straight 30° line from the chamber radius down to the upstream throat arc
xa = -r1 * math.sin(conv); ra = Rt + r1 * (1 - math.cos(conv))
Lconv = (Rc - ra) / math.tan(conv)
Vconv = math.pi / 3 * Lconv * (Rc ** 2 + Rc * ra + ra ** 2)
Lcyl = max((Lstar * At - Vconv) / (math.pi * Rc ** 2), 0.3 * Rc)
x0 = xa - Lconv - Lcyl
pts += [(x0, Rc), (xa - Lconv, Rc), (xa, ra)]
for a in np.linspace(-conv, 0, 8)[1:]:
    pts.append((r1 * math.sin(a), Rt + r1 * (1 - math.cos(a))))
for a in np.linspace(0, tn, 8)[1:]:
    pts.append((r2 * math.sin(a), Rt + r2 * (1 - math.cos(a))))
Nx, Ny = pts[-1]
Ln = 0.8 * (math.sqrt(eps) - 1) * Rt / math.tan(math.radians(15))
Ex, Ey = Ln, De / 2
m1, m2 = math.tan(tn), math.tan(te)
Qx = (Ey - m2 * Ex - Ny + m1 * Nx) / (m1 - m2); Qy = Ny + m1 * (Qx - Nx)
for t in np.linspace(0, 1, 30)[1:]:
    pts.append(((1 - t) ** 2 * Nx + 2 * (1 - t) * t * Qx + t * t * Ex, (1 - t) ** 2 * Ny + 2 * (1 - t) * t * Qy + t * t * Ey))
write_csv("contour.csv", ["x_mm", "r_mm"], [[round(x * 1000, 3), round(r * 1000, 3)] for x, r in pts])

# Throat heat flux, Bartz correlation with chamber transport properties (an estimate).
Tw = float(P["wall_temperature_K"])
Pr_ = f.cp * f.mu / f.k
g = f.gamma_frozen
rc = (r1 + r2) / 2
sigma = 1 / ((0.5 * Tw / f.Tc * (1 + (g - 1) / 2) + 0.5) ** 0.68 * (1 + (g - 1) / 2) ** 0.12)
hg = 0.026 / Dt ** 0.2 * (f.mu ** 0.2 * f.cp / Pr_ ** 0.6) * (pc / f.cstar) ** 0.8 * (Dt / rc) ** 0.1 * sigma
Taw = f.Tc * (1 + Pr_ ** (1 / 3) * (g - 1) / 2) / (1 + (g - 1) / 2)
q = hg * (Taw - Tw)

pe = e["p"]
summary({
    "model": "chemical equilibrium (Gibbs minimisation over 72 C/H/O/N species, NASA 9-coefficient thermo to 6000 K, CEA propellant enthalpies), shifting-equilibrium isentropic nozzle flow, infinite-area combustor; Rao 80% bell approximation; Bartz throat heat flux",
    "propellant": P["propellant"], "propellant_name": pr["name"],
    "of_ratio": of, "best_of_vac": best[0],
    "chamber_pressure_bar": pc / 1e5, "chamber_temperature_K": f.Tc,
    "molar_mass": f.Mc, "gamma_frozen": f.gamma_frozen, "gamma_s": f.gamma_s,
    "cstar_m_s": f.cstar, "throat_pressure_bar": f.t["p"] / 1e5, "throat_temperature_K": f.t["T"],
    "expansion_ratio": eps, "exit_pressure_bar": pe / 1e5, "exit_temperature_K": e["T"], "exit_velocity_m_s": e["v"],
    "isp_vac_s": isp_vac, "isp_sl_s": isp_sl, "cf_vac": isp_vac * G0 / f.cstar,
    "cstar_efficiency": eta_c, "nozzle_efficiency": eta_f,
    "delivered_isp_vac_s": d_vac, "delivered_isp_sl_s": d_sl,
    "thrust_at": P["thrust_at"], "thrust_sl_kN": F_sl / 1e3, "thrust_vac_kN": F_vac / 1e3,
    "mass_flow_kg_s": mdot, "fuel_flow_kg_s": mdot / (1 + of), "oxidizer_flow_kg_s": mdot * of / (1 + of),
    "throat_diameter_mm": Dt * 1000, "exit_diameter_mm": De * 1000, "chamber_diameter_mm": 2 * Rc * 1000,
    "engine_length_mm": (Ln - x0) * 1000, "nozzle_length_mm": Ln * 1000,
    "separation_at_sea_level": bool(pe < 0.4 * PA_SL),
    "throat_heat_flux_MW_m2": q / 1e6, "wall_temperature_K": Tw,
    "chamber_species": {r[0]: r[1] for r in spec[:8]},
    "composition": spec,
})
print("%s at O/F %.2f, %.0f bar: Tc %.0f K, c* %.0f m/s, ideal Isp %.1f s in vacuum%s (expansion ratio %.1f); thrust %.1f kN in vacuum, throat %.0f mm, exit %.0f mm." % (
    pr["name"], of, pc / 1e5, f.Tc, f.cstar, isp_vac, (", %.1f s at sea level" % isp_sl) if isp_sl > 0 else ", vacuum only", eps, F_vac / 1e3, Dt * 1000, De * 1000))
`;
const VEHICLE = `G0 = 9.80665
MU, RE, OMEGA = 3.986004418e14, 6378137.0, 7.2921159e-5
stages = P["stages"]
n = len(stages)
mpl = float(P["payload_kg"]) + float(P.get("fairing_mass_kg", 0))

# Required ideal delta-v: circular orbit speed, minus Earth's rotation along the launch
# azimuth, plus the gravity, drag and steering losses of the ascent (an estimate the
# ascent simulation can confirm).
h = float(P["orbit_altitude_km"]) * 1e3
lat = math.radians(float(P["launch_latitude_deg"]))
inc = math.radians(float(P.get("inclination_deg") or P["launch_latitude_deg"]))
if math.cos(inc) > math.cos(lat) + 1e-12: raise SystemExit("An inclination below the launch latitude needs a plane change; pick at least %.1f deg." % math.degrees(lat))
az = math.asin(min(1.0, math.cos(inc) / math.cos(lat)))
v_orbit = math.sqrt(MU / (RE + h))
v_rot = OMEGA * RE * math.cos(lat) * math.sin(az)
losses = float(P["losses_m_s"])
dv_req = float(P["delta_v_m_s"]) if P.get("delta_v_m_s") else v_orbit - v_rot + losses

def ve(i):
    s = stages[i]
    vac = float(s["isp_vac_s"])
    # The first stage flies through the atmosphere: a weighted mean of sea-level and vacuum Isp.
    isp = 0.35 * float(s["isp_sl_s"]) + 0.65 * vac if i == 0 and s.get("isp_sl_s") else vac
    return isp * G0
def ve_reserve(i):
    s = stages[i]
    return float(s.get("isp_sl_s") or s["isp_vac_s"]) * G0
def k(i):
    f = float(stages[i]["structural_fraction"]); return f / (1 - f)
def reserve_factor(i):
    return math.exp(float(stages[i].get("reserve_delta_v_m_s", 0)) / ve_reserve(i)) - 1

def stage_from_dv(i, dv, m_up):
    """Propellant for a stage to give dv to everything above it, keeping its recovery reserve."""
    R = math.exp(dv / ve(i))
    den = 1 + k(i) - R * k(i) * (1 + reserve_factor(i))
    if den <= 1e-9: return None
    mp = m_up * (R - 1) / den
    return mp
def build(split):
    """Stage masses from the top down for a delta-v split; None if a stage cannot do it."""
    m_up = mpl; out = [None] * n
    for i in range(n - 1, -1, -1):
        mp = stage_from_dv(i, split[i], m_up)
        if mp is None or mp < 0: return None
        dry = k(i) * mp
        res = dry * reserve_factor(i)
        out[i] = {"prop": mp, "dry": dry, "reserve": res, "m0": m_up + dry + mp, "m_up": m_up}
        m_up = m_up + dry + mp
    return out
def liftoff(split):
    b = build(split); return b[0]["m0"] if b else float("inf")

given = all(s.get("propellant_mass_kg") for s in stages)
mode = P.get("mode") or ("evaluate" if given else "optimize")
if mode == "evaluate":
    if not given: raise SystemExit("Evaluate needs propellant_mass_kg for every stage.")
    m_up = mpl; built = [None] * n; split = [0.0] * n
    for i in range(n - 1, -1, -1):
        mp = float(stages[i]["propellant_mass_kg"])
        dry = float(stages[i].get("dry_mass_kg") or k(i) * mp)
        res = dry * reserve_factor(i)
        if res >= mp: raise SystemExit("Stage %d: the recovery reserve needs more propellant than it carries." % (i + 1))
        m0 = m_up + dry + mp
        split[i] = ve(i) * math.log(m0 / (m0 - (mp - res)))
        built[i] = {"prop": mp, "dry": dry, "reserve": res, "m0": m0, "m_up": m_up}
        m_up = m0
else:
    # Liftoff mass is minimised over how the required delta-v is split between stages:
    # repeated golden-section moves of delta-v between every pair of stages.
    split = [dv_req / n] * n
    if n > 1:
        for sweep in range(40):
            before = liftoff(split)
            for i in range(n):
                for j in range(i + 1, n):
                    lo, hi = -(split[i] - 50), split[j] - 50
                    def f(x):
                        s = list(split); s[i] += x; s[j] -= x; return liftoff(s)
                    g = (math.sqrt(5) - 1) / 2
                    a, b = lo, hi
                    for _ in range(60):
                        c, d = b - g * (b - a), a + g * (b - a)
                        if f(c) < f(d): b = d
                        else: a = c
                    x = (a + b) / 2
                    if f(x) < liftoff(split): split[i] += x; split[j] -= x
            if abs(before - liftoff(split)) < 1e-9 * before: break
    built = build(split)
    if built is None:
        raise SystemExit("No staging reaches %.0f m/s with these Isp and structural fractions; add a stage, raise Isp or lower the structural fraction." % dv_req)

rows = []
twrs = []
for i, s in enumerate(stages):
    b = built[i]
    burn = b["prop"] - b["reserve"]
    mf = b["m0"] - burn
    F = float(s["thrust_kN"]) * 1e3 if s.get("thrust_kN") else None
    isp_f = float(s["isp_sl_s"]) if i == 0 and s.get("isp_sl_s") else float(s["isp_vac_s"])
    tw0 = F / (b["m0"] * G0) if F else None
    tw1 = F / (mf * G0) if F else None
    tb = burn / (F / (isp_f * G0)) if F else None
    target = 1.35 if i == 0 else 0.8
    twrs.append(tw0)
    rows.append([i + 1, s.get("name") or "Stage %d" % (i + 1), round(split[i], 4), round(ve(i) / G0, 4), round(b["prop"], 3), round(burn, 3), round(b["reserve"], 3),
                 round(b["dry"], 3), round(b["m0"], 3), round(mf, 3), round(b["m0"] / mf, 6), float(s["structural_fraction"]),
                 round(F / 1e3, 3) if F else "", round(tw0, 4) if F else "", round(tw1, 4) if F else "", round(tb, 2) if F else "",
                 round(target * b["m0"] * G0 / 1e3, 1)])
write_csv("result.csv", ["stage", "name", "delta_v_m_s", "isp_effective_s", "propellant_kg", "ascent_propellant_kg", "reserve_kg", "dry_kg",
                         "ignition_mass_kg", "burnout_mass_kg", "mass_ratio", "structural_fraction", "thrust_kN", "twr_ignition", "twr_burnout",
                         "burn_time_s", "suggested_thrust_kN"], rows)
m0 = built[0]["m0"]
dv_total = sum(split)
problems = []
if twrs[0] is not None and twrs[0] < 1.15: problems.append("liftoff thrust-to-weight %.2f is below 1.15" % twrs[0])
for i, t in enumerate(twrs[1:], 2):
    if t is not None and t < 0.5: problems.append("stage %d thrust-to-weight %.2f is low (gravity losses grow)" % (i, t))
summary({
    "model": "Tsiolkovsky rocket equation per stage with structural fractions and recovery reserves; first-stage Isp weighted 35 % sea level / 65 % vacuum; delta-v split optimised for the lowest liftoff mass",
    "mode": mode, "stages": n,
    "payload_kg": float(P["payload_kg"]), "fairing_mass_kg": float(P.get("fairing_mass_kg", 0)),
    "orbit_altitude_km": h / 1e3, "orbital_velocity_m_s": v_orbit, "earth_rotation_m_s": v_rot, "launch_azimuth_deg": math.degrees(az),
    "losses_m_s": losses, "delta_v_required_m_s": dv_req, "delta_v_total_m_s": dv_total, "delta_v_margin_m_s": dv_total - dv_req,
    "reaches_orbit": bool(dv_total >= dv_req - 1e-6),
    "liftoff_mass_kg": m0, "payload_fraction": float(P["payload_kg"]) / m0,
    "propellant_total_kg": sum(b["prop"] for b in built), "dry_total_kg": sum(b["dry"] for b in built),
    "liftoff_twr": twrs[0], "delta_v_split_m_s": [round(x, 2) for x in split],
    "problems": problems,
})
print("%d-stage vehicle for %.0f kg to %.0f km: liftoff %.0f t, payload fraction %.2f %%, delta-v %.0f of %.0f m/s (%s)." % (
    n, float(P["payload_kg"]), h / 1e3, m0 / 1e3, 100 * float(P["payload_kg"]) / m0, dv_total, dv_req, "split " + " / ".join("%.0f" % x for x in split)))
`;
const ASCENT = `G0 = 9.80665
MU, RE, OMEGA = 3.986004418e14, 6378137.0, 7.2921159e-5
# US Standard Atmosphere 1976 below 86 km (geopotential layers), exponential tail above.
HB = [0.0, 11000.0, 20000.0, 32000.0, 47000.0, 51000.0, 71000.0, 84852.0]
LB = [-0.0065, 0.0, 0.001, 0.0028, 0.0, -0.0028, -0.002]
TB, PB = [288.15], [101325.0]
for i in range(7):
    T1 = TB[i] + LB[i] * (HB[i + 1] - HB[i])
    PB.append(PB[i] * (TB[i] / T1) ** (G0 * 0.0289644 / (8.3144598 * LB[i])) if LB[i] else PB[i] * math.exp(-G0 * 0.0289644 * (HB[i + 1] - HB[i]) / (8.3144598 * TB[i])))
    TB.append(T1)
def atmosphere(z):
    """Temperature (K), pressure (Pa) and density (kg/m3) at geometric altitude z (m)."""
    if z < 0: z = 0.0
    hg = RE * z / (RE + z)
    if hg >= HB[-1]:
        T = TB[-1]; p = PB[-1] * math.exp(-(hg - HB[-1]) / 7000.0)
        return T, p, p / (287.053 * T)
    i = 0
    while i < 6 and hg >= HB[i + 1]: i += 1
    T = TB[i] + LB[i] * (hg - HB[i])
    if LB[i]: p = PB[i] * (TB[i] / T) ** (G0 * 0.0289644 / (8.3144598 * LB[i]))
    else: p = PB[i] * math.exp(-G0 * 0.0289644 * (hg - HB[i]) / (8.3144598 * TB[i]))
    return T, p, p / (287.053 * T)
MACH = [0, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0, 3.0, 5.0, 10.0]
CD = [0.30, 0.30, 0.35, 0.50, 0.55, 0.48, 0.40, 0.32, 0.28, 0.25]
def cd(m):
    if m >= MACH[-1]: return CD[-1]
    i = 0
    while MACH[i + 1] < m: i += 1
    return CD[i] + (CD[i + 1] - CD[i]) * (m - MACH[i]) / (MACH[i + 1] - MACH[i])

stages = P["stages"]
n = len(stages)
payload = float(P["payload_kg"]); fairing = float(P.get("fairing_mass_kg", 0))
area = math.pi * float(P["diameter_m"]) ** 2 / 4 * float(P.get("cd_scale", 1.0))
target = float(P["orbit_altitude_km"]) * 1e3
lat = math.radians(float(P["launch_latitude_deg"]))
inc = math.radians(float(P.get("inclination_deg") or P["launch_latitude_deg"]))
if math.cos(inc) > math.cos(lat) + 1e-12: raise SystemExit("Inclination below the launch latitude.")
az = math.asin(min(1.0, math.cos(inc) / math.cos(lat)))
w_eff = OMEGA * math.cos(lat) * math.sin(az)          # in-plane rotation rate of the ground
amax = float(P["max_accel_g"]) * G0
tmin = float(P["min_throttle"])
fair_alt = float(P["fairing_altitude_km"]) * 1e3
coast = float(P["stage_coast_s"])
ST = []
for s in stages:
    Fv = float(s["thrust_vac_kN"]) * 1e3
    isp_v = float(s["isp_vac_s"]); isp_s = float(s.get("isp_sl_s") or 0)
    Ae = (Fv - Fv * isp_s / isp_v) / 101325.0 if isp_s else float(s.get("exit_area_m2", 0))
    ST.append({"Fv": Fv, "mdot": Fv / (isp_v * G0), "Ae": Ae, "prop": float(s["propellant_mass_kg"]),
               "dry": float(s["dry_mass_kg"]), "reserve": float(s.get("reserve_kg", 0)), "name": s.get("name") or "Stage"})

def orbit(x, y, vx, vy):
    r = math.hypot(x, y); v2 = vx * vx + vy * vy
    eps = v2 / 2 - MU / r
    hz = x * vy - y * vx
    if eps >= 0: return float("inf"), -RE
    a = -MU / (2 * eps)
    e = math.sqrt(max(0.0, 1 + 2 * eps * hz * hz / (MU * MU)))
    return a * (1 + e) - RE, a * (1 - e) - RE

def fly(kick, pa, pb, record=False):
    """One ascent. Stage 1 flies a gravity turn after a pitch kick; upper stages steer
    linearly in pitch from pa to pb (degrees above the local horizon) over their burn and
    cut off when the apoapsis reaches the target; the last stage then circularises there."""
    x, y, vx, vy = 0.0, RE, w_eff * RE, 0.0
    t = 0.0; k = 0; dropped = False
    fuel = [s["prop"] for s in ST]
    m = payload + fairing + sum(s["prop"] + s["dry"] for s in ST)
    out = []; stats = {"maxq": (0, 0, 0), "maxg": 0.0, "ideal": 0.0, "grav": 0.0, "drag": 0.0, "steer": 0.0, "back": 0.0, "upper_q": 0.0, "upper_maxz": 0.0, "events": []}
    upper_t0 = None; upper_T = 1.0
    def state(x, y, vx, vy, m, k, t, ctl):
        r = math.hypot(x, y); z = r - RE
        ux, uy = x / r, y / r; hx, hy = uy, -ux
        T_, p, rho = atmosphere(z)
        rvx, rvy = vx - w_eff * y, vy + w_eff * x
        vrel = math.hypot(rvx, rvy)
        mach = vrel / math.sqrt(1.4 * 287.053 * T_)
        q = 0.5 * rho * vrel * vrel
        D = q * cd(mach) * area
        if ctl is None or k >= n or fuel[k] <= ST[k]["reserve"] + 1e-9: F = 0.0; thr = 0.0; mdot = 0.0; ph = 0.0
        else:
            s = ST[k]
            Favail = max(s["Fv"] - p * s["Ae"], 0.0)
            thr = max(tmin, min(1.0, amax * m / Favail)) if Favail > 0 else 0.0
            F = thr * Favail; mdot = thr * s["mdot"]
            ph = ctl(t, rvx, rvy, hx, hy, ux, uy, vrel)
        cph, sph = math.cos(ph), math.sin(ph)
        dx, dy = cph * hx + sph * ux, cph * hy + sph * uy
        g = MU / (r * r)
        ax = (F * dx - (D * rvx / vrel if vrel > 0 else 0)) / m - g * ux
        ay = (F * dy - (D * rvy / vrel if vrel > 0 else 0)) / m - g * uy
        return ax, ay, mdot, {"z": z, "q": q, "mach": mach, "F": F, "D": D, "thr": thr, "ph": ph, "p": p, "g": g, "ux": ux, "uy": uy, "dx": dx, "dy": dy}
    def ctl_for(k):
        if k == 0:
            def c(t, rvx, rvy, hx, hy, ux, uy, vrel):
                if tk is None or (vrel < 40 and t < 20): return math.pi / 2
                if t < tk + 10: return math.pi / 2 - math.radians(kick) * min(1.0, (t - tk) / 10)
                return min(math.atan2(rvx * ux + rvy * uy, rvx * hx + rvy * hy), math.pi / 2 - math.radians(kick))
            return c
        def c(t, *a):
            f = min(1.0, max(0.0, (t - upper_t0) / upper_T))
            return math.radians(pa + (pb - pa) * f)
        return c
    tk = None
    dt = float(P.get("time_step_s", 0.5))
    nxt = 0.0
    phase = "burn"
    coast_until = None
    while t < 3000:
        if k < n and phase == "burn":
            ctl = ctl_for(k)
            if k == 0 and tk is None:
                rvx, rvy = vx - w_eff * y, vy + w_eff * x
                if math.hypot(rvx, rvy) >= 40 or t >= 20: tk = t
        else: ctl = None
        h = dt
        if ctl is not None:
            s = ST[k]; left = fuel[k] - s["reserve"]
            if left <= 1e-9: h = 0
            else: h = min(dt, left / s["mdot"] * 1.000001) if left < s["mdot"] * dt else dt
        if record and t >= nxt - 1e-9:
            ax, ay, mdot, info = state(x, y, vx, vy, m, k, t, ctl)
            out.append(row(t, k, x, y, vx, vy, m, info, ax, ay)); nxt += 1.0
        if h > 0:
            def deriv(X):
                ax, ay, md, info = state(X[0], X[1], X[2], X[3], X[4], k, X[5], ctl)
                return (X[2], X[3], ax, ay, -md, 1.0), info
            X0 = (x, y, vx, vy, m, t)
            def rk(X0, h):
                k1, i1 = deriv(X0)
                k2, _ = deriv(tuple(X0[j] + h / 2 * k1[j] for j in range(6)))
                k3, _ = deriv(tuple(X0[j] + h / 2 * k2[j] for j in range(6)))
                k4, _ = deriv(tuple(X0[j] + h * k3[j] for j in range(6)))
                return tuple(X0[j] + h / 6 * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]) for j in range(6)), i1
            X1, info = rk(X0, h)
            # Upper stage: cut off exactly when the apoapsis reaches the target (bisection).
            if k > 0 and ctl is not None and orbit(*X1[:4])[0] >= target:
                lo, hi = 0.0, h
                for _ in range(30):
                    mid = (lo + hi) / 2
                    if orbit(*rk(X0, mid)[0][:4])[0] >= target: hi = mid
                    else: lo = mid
                h = hi; X1, info = rk(X0, h)
                phase = "cutoff"
            burned = X0[4] - X1[4]
            if ctl is not None:
                fuel[k] -= burned
                a_th = info["F"] / X0[4]
                vr = math.hypot(X0[2], X0[3]); vrx, vry = X0[2] / vr, X0[3] / vr
                sin_g = vrx * info["ux"] + vry * info["uy"]
                stats["ideal"] += h * (info["F"] + info["p"] * ST[k]["Ae"] * info["thr"]) / X0[4]
                stats["back"] += h * info["p"] * ST[k]["Ae"] * info["thr"] / X0[4]
                stats["grav"] += h * info["g"] * sin_g
                stats["drag"] += h * info["D"] / X0[4]
                stats["steer"] += h * a_th * (1 - (info["dx"] * vrx + info["dy"] * vry))
                stats["maxg"] = max(stats["maxg"], a_th + info["D"] / X0[4] * 0)
            if info["q"] > stats["maxq"][0]: stats["maxq"] = (info["q"], t, info["z"])
            # An upper stage a minute into its burn should be out of the air, not diving back.
            if k > 0 and upper_t0 is not None and t > upper_t0 + 60:
                stats["upper_q"] = max(stats["upper_q"], info["q"])
            if k > 0: stats["upper_maxz"] = max(stats["upper_maxz"], info["z"])
            x, y, vx, vy, m, t = X1
            if math.hypot(x, y) < RE - 1: return None, out, stats
        else:
            # Engine out of usable propellant: staging (a coast, then the next stage) or end.
            if record:
                ax, ay, mdot, info = state(x, y, vx, vy, m, k, t, None)
                out.append(row(t, k, x, y, vx, vy, m, info, ax, ay))
            stats["events"].append(("%s cutoff" % ST[k]["name"], t, math.hypot(x, y) - RE))
            if k == n - 1: phase = "depleted"; break
            m -= ST[k]["dry"] + fuel[k]
            k += 1
            stats["events"].append(("%s separation" % ST[k - 1]["name"], t, math.hypot(x, y) - RE))
            # coast before ignition
            tc = t + coast
            while t < tc - 1e-9:
                hh = min(dt, tc - t)
                X0 = (x, y, vx, vy, m, t)
                def dc(X):
                    ax, ay, md, info = state(X[0], X[1], X[2], X[3], X[4], k, X[5], None)
                    return (X[2], X[3], ax, ay, 0.0, 1.0)
                k1 = dc(X0); k2 = dc(tuple(X0[j] + hh / 2 * k1[j] for j in range(6)))
                k3 = dc(tuple(X0[j] + hh / 2 * k2[j] for j in range(6))); k4 = dc(tuple(X0[j] + hh * k3[j] for j in range(6)))
                x, y, vx, vy, m, t = tuple(X0[j] + hh / 6 * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]) for j in range(6))
                if record and t >= nxt - 1e-9:
                    ax, ay, mdot, info = state(x, y, vx, vy, m, k, t, None)
                    out.append(row(t, k, x, y, vx, vy, m, info, ax, ay)); nxt += 1.0
            upper_t0 = t
            upper_T = (ST[k]["prop"] - ST[k]["reserve"]) / ST[k]["mdot"]
            stats["events"].append(("%s ignition" % ST[k]["name"], t, math.hypot(x, y) - RE))
            continue
        if not dropped and fairing and math.hypot(x, y) - RE >= fair_alt:
            m -= fairing; dropped = True
            stats["events"].append(("Fairing separation", t, math.hypot(x, y) - RE))
        if phase == "cutoff": break
    if record:
        ax, ay, mdot, info = state(x, y, vx, vy, m, k, t, None)
        out.append(row(t, k, x, y, vx, vy, m, info, ax, ay))
    apo, peri = orbit(x, y, vx, vy)
    # Circularise at apoapsis with what is left in the last stage (impulsive burn).
    s = ST[-1]
    left = max(0.0, fuel[-1] - s["reserve"]) if k == n - 1 else 0.0
    if apo == float("inf") or apo < 0: return {"apo": apo, "peri": peri, "margin": -1e9}, out, stats
    ra, rp = apo + RE, peri + RE
    a = (ra + rp) / 2
    v_apo = math.sqrt(MU * (2 / ra - 1 / a))
    dv_circ = math.sqrt(MU / ra) - v_apo
    ve = s["Fv"] / s["mdot"]
    need = m * (1 - math.exp(-dv_circ / ve))
    margin = left - need
    if margin >= 0: fin_peri = apo
    else:
        dv_have = ve * math.log(m / (m - left)) if left > 0 else 0.0
        v2 = v_apo + dv_have
        a2 = 1 / (2 / ra - v2 * v2 / MU)
        fin_peri = 2 * a2 - ra - RE
    return {"apo": apo, "peri": peri, "margin": margin, "dv_circ": dv_circ, "fin_peri": fin_peri, "t": t, "m": m, "left": left, "phase": phase, "k": k, "z": math.hypot(x, y) - RE}, out, stats

def row(t, k, x, y, vx, vy, m, info, ax, ay):
    r = math.hypot(x, y); ux, uy = x / r, y / r
    v = math.hypot(vx, vy)
    gam = math.degrees(math.asin(max(-1, min(1, (vx * ux + vy * uy) / v)))) if v else 90.0
    return [round(t, 4), k + 1, round((r - RE) / 1e3, 6), round(RE * math.atan2(x, y) / 1e3, 6), round(v, 4), round(gam, 5),
            round(math.degrees(info["ph"]), 6), round(info["thr"], 6), round(m, 4), round(info["F"] / 1e3, 4), round(info["D"] / 1e3, 5),
            round(info["q"] / 1e3, 5), round(info["mach"], 4), round(math.hypot(ax + info["g"] * ux, ay + info["g"] * uy) / G0, 5),
            repr(x), repr(y), repr(vx), repr(vy)]

def score(v):
    kick, pa, pb = v
    if not (0.2 <= kick <= 20 and -15 <= pa <= 70 and -40 <= pb <= 50): return 1e12
    res, _, st = fly(kick, pa, pb)
    if res is None: return 1e12
    if res.get("phase") == "depleted" or res["apo"] < target:
        # short of the target apoapsis: reward getting closer
        return 1e9 - max(res["apo"], -RE) - res["peri"] * 0.1 if res["apo"] != float("inf") else 1e10
    if res["peri"] < -RE + 1: return 1e10
    # Trajectories that dip back into the atmosphere are not flyable: rank them below all others.
    if st["upper_q"] > 300: return 1e8 + st["upper_q"]
    # ... nor do ones that climb and then dive: cut off near the highest point, above 100 km.
    dive = max(0.0, 0.92 * st["upper_maxz"] - res["z"]) + max(0.0, min(0.6 * target, 120e3) - res["z"])
    if dive > 0: return 1e8 + dive
    return -res["margin"]

# Nelder-Mead over (pitch kick, upper-stage start pitch, end pitch).
def nelder(f, x0, steps, iters):
    pts = [list(x0)] + [[x0[j] + (steps[j] if j == i else 0) for j in range(len(x0))] for i in range(len(x0))]
    vals = [f(p) for p in pts]
    for _ in range(iters):
        o = sorted(range(len(pts)), key=lambda i: vals[i]); pts = [pts[i] for i in o]; vals = [vals[i] for i in o]
        c = [sum(p[j] for p in pts[:-1]) / (len(pts) - 1) for j in range(len(x0))]
        xr = [c[j] + (c[j] - pts[-1][j]) for j in range(len(x0))]; fr = f(xr)
        if fr < vals[0]:
            xe = [c[j] + 2 * (c[j] - pts[-1][j]) for j in range(len(x0))]; fe = f(xe)
            pts[-1], vals[-1] = (xe, fe) if fe < fr else (xr, fr)
        elif fr < vals[-2]: pts[-1], vals[-1] = xr, fr
        else:
            xc = [c[j] + 0.5 * (pts[-1][j] - c[j]) for j in range(len(x0))]; fc = f(xc)
            if fc < vals[-1]: pts[-1], vals[-1] = xc, fc
            else:
                for i in range(1, len(pts)):
                    pts[i] = [pts[0][j] + 0.5 * (pts[i][j] - pts[0][j]) for j in range(len(x0))]; vals[i] = f(pts[i])
    i = min(range(len(pts)), key=lambda i: vals[i])
    return pts[i], vals[i]

if P.get("pitch_kick_deg") is not None and P.get("upper_pitch_start_deg") is not None and P.get("upper_pitch_end_deg") is not None:
    best = [float(P["pitch_kick_deg"]), float(P["upper_pitch_start_deg"]), float(P["upper_pitch_end_deg"])]
    searched = 0
else:
    cands = []
    for x0 in ([3.0, 20.0, -5.0], [6.0, 30.0, 0.0], [1.5, 10.0, -10.0]):
        cands.append(nelder(score, x0, [1.5, 10.0, 10.0], int(P.get("search_iterations", 45))))
    best = min(cands, key=lambda c: c[1])[0]
    searched = 1
res, traj, stats = fly(*best, record=True)
if res is None: raise SystemExit("The vehicle falls back; it does not have the thrust to climb.")
write_csv("result.csv", ["t_s", "stage", "altitude_km", "downrange_km", "velocity_m_s", "flight_path_deg", "pitch_deg", "throttle", "mass_kg",
                         "thrust_kN", "drag_kN", "q_kPa", "mach", "accel_g", "x_m", "y_m", "vx_m_s", "vy_m_s"], traj)
reached = res["margin"] >= 0 and res["apo"] >= target - 1
summary({
    "model": "planar point-mass ascent over a rotating spherical Earth: inverse-square gravity, US Standard Atmosphere 1976, Mach-dependent drag, back-pressure thrust loss, acceleration-limited throttling, staging and fairing jettison; RK4 at %.2f s; pitch program optimised (Nelder-Mead) for the most propellant left after circularising" % float(P.get("time_step_s", 0.5)),
    "orbit_reached": bool(reached), "target_altitude_km": target / 1e3,
    "apoapsis_km": res["apo"] / 1e3, "periapsis_at_cutoff_km": res["peri"] / 1e3,
    "final_periapsis_km": res.get("fin_peri", res["peri"]) / 1e3,
    "circularization_delta_v_m_s": res.get("dv_circ"), "propellant_margin_kg": res["margin"],
    "cutoff_time_s": res.get("t"), "mass_at_cutoff_kg": res.get("m"),
    "max_q_kPa": stats["maxq"][0] / 1e3, "max_q_time_s": stats["maxq"][1], "max_q_altitude_km": stats["maxq"][2] / 1e3,
    "max_accel_g": stats["maxg"] / G0, "upper_stage_max_q_kPa": stats["upper_q"] / 1e3,
    "ideal_delta_v_m_s": stats["ideal"], "gravity_loss_m_s": stats["grav"], "drag_loss_m_s": stats["drag"],
    "steering_loss_m_s": stats["steer"], "backpressure_loss_m_s": stats["back"],
    "earth_rotation_m_s": w_eff * RE, "launch_azimuth_deg": math.degrees(az),
    "pitch_kick_deg": best[0], "upper_pitch_start_deg": best[1], "upper_pitch_end_deg": best[2], "pitch_optimised": bool(searched),
    "events": [[e, round(t, 4), round(z / 1e3, 3)] for e, t, z in stats["events"]],
})
print("%s: apoapsis %.0f km, %s; max-Q %.1f kPa at %.0f s, max %.1f g; losses: gravity %.0f, drag %.0f, steering %.0f m/s; %.0f kg propellant %s." % (
    "Orbit reached" if reached else "Orbit NOT reached", res["apo"] / 1e3,
    ("circularised at %.0f km" % (res["apo"] / 1e3)) if reached else ("periapsis %.0f km" % (res.get("fin_peri", res["peri"]) / 1e3)),
    stats["maxq"][0] / 1e3, stats["maxq"][1], stats["maxg"] / G0, stats["grav"], stats["drag"], stats["steer"],
    abs(res["margin"]), "to spare" if res["margin"] >= 0 else "short"))
`;
const TANKS = `G0 = 9.80665
# Handbook values at room temperature (conservative for cryogenic tanks): density (kg/m3),
# yield and ultimate strength (MPa), Young's modulus (GPa).
MAT = {
    "al2219": {"name": "Al 2219-T87", "rho": 2840, "fy": 393, "fu": 476, "E": 73.1},
    "al2195": {"name": "Al-Li 2195-T8", "rho": 2700, "fy": 560, "fu": 600, "E": 76.0},
    "ss304l": {"name": "Stainless 304L", "rho": 7900, "fy": 210, "fu": 485, "E": 193.0},
    "ss301": {"name": "Stainless 301 full hard", "rho": 7880, "fy": 965, "fu": 1276, "E": 193.0},
    "ti6al4v": {"name": "Ti-6Al-4V", "rho": 4430, "fy": 880, "fu": 950, "E": 114.0},
    "cfrp": {"name": "Carbon fibre (quasi-isotropic)", "rho": 1550, "fy": 600, "fu": 600, "E": 70.0},
}
RHO = {"lox": 1141.0, "lh2": 70.8, "lch4": 422.6, "rp1": 810.0, "n2o4": 1440.0, "mmh": 875.0}
PAIR = {"lox_lh2": ("lox", "lh2"), "lox_ch4": ("lox", "lch4"), "lox_rp1": ("lox", "rp1"), "n2o4_mmh": ("n2o4", "mmh")}
K = 1 / math.sqrt(2)          # ellipsoidal dome height / radius
rows = []
out_stages = []
for si, s in enumerate(P["stages"]):
    mat = MAT[s.get("material", "al2195")]
    D = float(s["diameter_m"]); R = D / 2
    of = float(s["of_ratio"]); mp = float(s["propellant_mass_kg"])
    ox_n, fu_n = PAIR[s["propellant"]]
    p = float(s["tank_pressure_bar"]) * 1e5
    sf_y, sf_u = float(P["yield_factor"]), float(P["ultimate_factor"])
    allow = min(mat["fy"] / sf_y, mat["fu"] / sf_u) * 1e6
    tmin = float(P["min_gauge_mm"]) / 1e3
    ull = float(P["ullage"])
    accel = float(s.get("max_accel_g", 5.0))
    thrust = float(s.get("thrust_kN", 0)) * 1e3
    m_above = float(s.get("mass_above_kg", 0))
    stage_mass = 0.0
    tank_len = 0.0
    for name, kind, m in (("oxidizer", ox_n, mp * of / (1 + of)), ("fuel", fu_n, mp / (1 + of))):
        V = m / RHO[kind] * (1 + ull)
        Vdomes = 2 * (2 / 3) * math.pi * R ** 3 * K
        Lcyl = max((V - Vdomes) / (math.pi * R * R), 0.0)
        if Lcyl == 0.0: raise SystemExit("Stage %d %s tank: the domes alone hold more than needed; use a smaller diameter." % (si + 1, name))
        # Membrane wall: hoop stress p R / t, plus the hydrostatic head at peak acceleration.
        head = RHO[kind] * accel * G0 * (Lcyl + 2 * R * K)
        p_design = p + head
        t_wall = max(p_design * R / allow, tmin)
        # Ellipsoidal dome crown: sigma = p a^2 / (2 b t)
        t_dome = max(p_design * R * R / (2 * R * K) / allow, tmin)
        # Axial compression at the bottom of the lower tank: thrust load of everything above,
        # relieved by the pressure (end load p pi R^2), against classical buckling with the
        # NASA SP-8007 knockdown factor.
        N = max(thrust, (m_above + m) * accel * G0) if thrust else (m_above + m) * accel * G0
        def buckling(t):
            sig_ax = N / (2 * math.pi * R * t) - p * R / (2 * t)
            gamma = 1 - 0.901 * (1 - math.exp(-math.sqrt(R / t) / 16))
            sig_cr = gamma * 0.6052 * mat["E"] * 1e9 * t / R
            return sig_ax, sig_cr, (sig_cr / (sig_ax * sf_u) - 1) if sig_ax > 0 else float("inf")
        # Thicken the wall until it does not buckle (an unstiffened shell; stringers or
        # isogrid would make it lighter).
        sized_by = "pressure" if t_wall > tmin else "minimum gauge"
        while buckling(t_wall)[2] < 0:
            t_wall *= 1.01; sized_by = "buckling"
        sig_ax, sig_cr, buck_margin = buckling(t_wall)
        hoop = p_design * R / t_wall
        shell = 2 * math.pi * R * Lcyl * t_wall
        # oblate spheroid surface (two domes)
        e = math.sqrt(1 - K * K)
        dome_area = 2 * math.pi * R * R * (1 + (1 - e * e) / e * math.atanh(e))
        mass = (shell + dome_area * t_dome) * mat["rho"] * float(P["nonoptimum_factor"])
        L = Lcyl + 2 * R * K
        stage_mass += mass; tank_len += L
        rows.append([si + 1, s.get("name") or "Stage %d" % (si + 1), name, kind, round(m, 3), round(V, 5), round(Lcyl, 5), round(L, 5),
                     round(t_wall * 1e3, 4), round(t_dome * 1e3, 4), round(p_design / 1e5, 4), round(hoop / 1e6, 4), round(allow / 1e6, 4),
                     round(allow / hoop - 1, 5), round(sig_ax / 1e6, 5), round(sig_cr / 1e6, 5), round(buck_margin, 5) if buck_margin != float("inf") else "",
                     round(mass, 3), mat["name"], round(D, 4), sized_by])
        m_above += m
    out_stages.append({"stage": si + 1, "tank_mass_kg": stage_mass, "tank_length_m": tank_len})
write_csv("result.csv", ["stage", "name", "tank", "propellant", "propellant_kg", "volume_m3", "cylinder_m", "length_m", "wall_mm", "dome_mm",
                         "design_pressure_bar", "hoop_stress_MPa", "allowable_MPa", "pressure_margin", "axial_stress_MPa", "buckling_stress_MPa",
                         "buckling_margin", "mass_kg", "material", "diameter_m", "sized_by"], rows)
weak = [r for r in rows if (r[16] != "" and r[16] < 0)]
summary({
    "model": "thin-wall membrane tanks with ellipsoidal (sqrt 2) domes, hydrostatic head at peak acceleration, yield/ultimate factors, axial buckling with the NASA SP-8007 knockdown and pressure relief, non-optimum mass factor",
    "tanks": len(rows),
    "tank_mass_total_kg": sum(r[17] for r in rows),
    "stages": out_stages,
    "min_pressure_margin": min(r[13] for r in rows),
    "min_buckling_margin": min((r[16] for r in rows if r[16] != ""), default=None),
    "buckling_ok": not weak,
    "longest_tank_m": max(r[7] for r in rows),
})
print("%d tanks, %.1f t of tank structure; smallest margins: pressure %+.0f %%, buckling %s." % (
    len(rows), sum(r[17] for r in rows) / 1e3, 100 * min(r[13] for r in rows),
    ("%+.0f %%" % (100 * min(r[16] for r in rows if r[16] != ""))) if any(r[16] != "" for r in rows) else "n/a"))
`;
const ROCKET_CAD = `
MODEL = "Launch vehicle: stages with propellant tanks and domes, bell-nozzle engines, thrust sections, interstage, grid fins, landing legs, payload adapter and fairing (OpenCascade B-rep)"
from OCP.BRepPrimAPI import BRepPrimAPI_MakeRevol
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace

def revolve(profile):
    """A solid of revolution about the x axis from a closed (x, r) profile in mm."""
    poly = BRepBuilderAPI_MakePolygon()
    for x, r in profile: poly.Add(gp_Pnt(x, r, 0))
    poly.Close()
    return BRepPrimAPI_MakeRevol(BRepBuilderAPI_MakeFace(poly.Wire()).Face(), AXIS, 2 * math.pi).Shape()

def shell(curve, t):
    """A wall of thickness t inside an outer (x, r) curve."""
    return revolve(list(curve) + [(x, max(r - t, 1.0)) for x, r in reversed(curve)])

def dome(x0, R, t, up=True, k=1 / math.sqrt(2), n=16):
    """An ellipsoidal tank dome of height k R on the plane x0, bulging up or down."""
    s = 1 if up else -1
    outer = [(x0 + s * k * R * math.sin(a), max(R * math.cos(a), 1.0)) for a in [math.pi / 2 * i / n for i in range(n + 1)]]
    inner = [(x0 + s * (k * R - t) * math.sin(a), max((R - t) * math.cos(a), 1.0)) for a in [math.pi / 2 * i / n for i in range(n + 1)]]
    return revolve(outer + list(reversed(inner)))

def bell(Re, eps, wall):
    """Engine profile (x down from the injector at 0): chamber, throat, 80 % bell."""
    Rt = Re / math.sqrt(eps); Rc = 1.75 * Rt
    tn, te = math.radians(min(38, 24 + 3.2 * math.log(eps))), math.radians(max(5, 15 - 1.9 * math.log(eps)))
    Lc = 2.2 * Rc; Lconv = (Rc - Rt) / math.tan(math.radians(30))
    xt = Lc + Lconv
    Ln = 0.8 * (math.sqrt(eps) - 1) * Rt / math.tan(math.radians(15))
    pts = [(0, Rc), (Lc, Rc), (xt, Rt)]
    Nx, Ny, Ex, Ey = xt + 0.382 * Rt * math.sin(tn), Rt + 0.382 * Rt * (1 - math.cos(tn)), xt + Ln, Re
    m1, m2 = math.tan(tn), math.tan(te)
    Qx = (Ey - m2 * Ex - Ny + m1 * Nx) / (m1 - m2); Qy = Ny + m1 * (Qx - Nx)
    pts.append((Nx, Ny))
    for i in range(1, 25):
        u = i / 24
        pts.append(((1 - u) ** 2 * Nx + 2 * (1 - u) * u * Qx + u * u * Ex, (1 - u) ** 2 * Ny + 2 * (1 - u) * u * Qy + u * u * Ey))
    return pts, xt + Ln, Rc

def engine(prefix, group, x_mount, y, z, Re, eps, scale_len=None):
    pts, L, Rc = bell(Re, eps, 0)
    if scale_len: f = scale_len / L; pts = [(x * f, r) for x, r in pts]; L = scale_len
    wall = max(4.0, 0.012 * Re)
    # x down from the mount: flip the profile so the nozzle hangs below
    curve = [(x_mount - x, r + wall) for x, r in pts]
    nozzle = shell(curve, wall)
    part(f"{prefix}_Nozzle", group, moved(nozzle, 0, y, z))
    part(f"{prefix}_Injector_Dome", group, moved(cylinder(Rc + wall, x_mount, Rc * 0.5), 0, y, z))
    part(f"{prefix}_Gimbal", group, moved(cone(Rc * 0.55, Rc * 0.25, x_mount + Rc * 0.5, Rc * 0.9), 0, y, z))
    tp = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x_mount - Rc * 0.9, y, z + Rc + wall), gp_Dir(0, 0, 1)), Rc * 0.45, Rc * 1.1).Shape()
    part(f"{prefix}_Turbopump", group, tp)
    return L

def cluster(n, R, Re):
    """Engine positions: outer rings first, the rest towards the centre."""
    ring = lambda r, k: [(r * math.cos(2 * math.pi * (i + 0.5) / k), r * math.sin(2 * math.pi * (i + 0.5) / k)) for i in range(k)]
    if n == 1: return [(0.0, 0.0)]
    pos = []; left = n; r = R - 1.08 * Re
    while left > 0:
        if r < 1.1 * Re:
            pos += [(0.0, 0.0)] if left == 1 else ring(1.1 * Re / math.sin(math.pi / left), left)
            break
        take = min(max(1, int(2 * math.pi * r / (2.12 * Re))), left)
        pos += ring(r, take); left -= take; r -= 2.15 * Re
    return pos

stages = P["stages"]
x = 0.0
top_of_previous = None
for si, s in enumerate(stages):
    tag = "S%d" % (si + 1)
    D = s["diameter_m"] * 1000; R = D / 2; L = s["length_m"] * 1000
    t = max(6.0, D * 0.003)
    g = "stage_%d" % (si + 1)
    ne = int(s["engines"]); Re = s["engine_exit_diameter_m"] * 500; eps = s.get("expansion_ratio", 16 if si == 0 else 150)
    # Upper stages sit on the interstage; their engines hang inside it.
    base = x
    aft = 0.10 * D if si == 0 else 0.06 * D
    part(f"{tag}_Aft_Skirt", g, tube(R - t, R, base, aft))
    part(f"{tag}_Thrust_Plate", g, cylinder(R - t, base + aft * 0.35, max(20.0, 0.008 * D)))
    tank_len = L - aft - 0.05 * D
    k = 1 / math.sqrt(2)
    ox_share = s.get("oxidizer_fraction", 0.62)
    xs = base + aft
    for name, share in (("Fuel", 1 - ox_share), ("Oxidizer", ox_share)):
        h = tank_len * share
        cyl = max(h - 2 * k * R * 0.55, h * 0.3)
        x0 = xs + (h - cyl) / 2
        part(f"{tag}_{name}_Tank_Wall", g, tube(R - t, R, xs, h))
        part(f"{tag}_{name}_Tank_Lower_Dome", g, dome(x0, R - t - 1, t, up=False, k=k * 0.55))
        part(f"{tag}_{name}_Tank_Upper_Dome", g, dome(x0 + cyl, R - t - 1, t, up=True, k=k * 0.55))
        xs += h
    part(f"{tag}_Forward_Skirt", g, tube(R - t, R, xs, 0.05 * D))
    top = xs + 0.05 * D
    for i, (y, z) in enumerate(cluster(ne, R, Re)):
        engine(f"{tag}_Engine_{i + 1:02d}", f"engines_{si + 1}", base + aft * 0.35, y, z, Re, eps, s.get("engine_length_m", 0) * 1000 or None)
    if si == 0 and s.get("landing_legs", True):
        leg = box(0.22 * L, 0.08 * D, 0.035 * D, base - 0.02 * L, -0.04 * D, R + 15)
        polar(f"{tag}_Landing_Leg", "recovery", 4, leg, 45.0)
        polar(f"{tag}_Raceway", g, 1, box(L * 0.85, 160.0, 120.0, base + aft, -80.0, R - 10), 0.0)
    last = si == len(stages) - 1
    if not last:
        il = s.get("interstage_length_m", 6.5) * 1000
        D2 = stages[si + 1]["diameter_m"] * 1000
        part(f"{tag}_Interstage", "interstage", cone(R, max(D2 / 2, R * 0.6), top, il) if abs(D2 - D) > 1 else tube(R - t, R, top, il))
        if s.get("grid_fins", si == 0):
            fin = box(0.03 * D, 0.38 * D, 0.32 * D, top + il - 0.12 * D, -0.19 * D, R + 20)
            for a in range(3):
                for b in range(3):
                    fin = BRepAlgoAPI_Cut(fin, box(0.05 * D, 0.10 * D, 0.08 * D, top + il - 0.13 * D, -0.17 * D + a * 0.12 * D, R + 45 + b * 0.10 * D)).Shape()
            polar(f"{tag}_Grid_Fin", "recovery", 4, fin, 45.0)
        x = top + il
    else:
        # Payload adapter, payload and a two-piece ogive fairing
        f = P.get("fairing") or {}
        FD = f.get("diameter_m", s["diameter_m"] * 1.4) * 1000; FR = FD / 2; FL = f.get("length_m", FD / 400) * 1000
        part("Payload_Adapter", "payload", cone(R * 0.9, R * 0.45, top, 0.18 * D))
        pl = P.get("payload_length_m", FL / 2300) * 1000
        part("Payload", "payload", cylinder(min(FR * 0.72, R * 1.2), top + 0.18 * D, pl))
        boat = max(FR - R, 0) * 0.9 + 1
        curve = [(top - 50, R + 10), (top + boat, FR)]
        cyl_end = top + boat + FL * 0.45
        curve.append((cyl_end, FR))
        nose = FL - (cyl_end - top)
        for i in range(1, 15):
            u = i / 14
            # tangent ogive
            rho_ = (FR * FR + nose * nose) / (2 * FR)
            xx = u * nose
            yy = math.sqrt(max(rho_ * rho_ - xx * xx, 0)) + FR - rho_
            curve.append((cyl_end + xx, max(yy, 30.0)))
        fair = shell(curve, max(25.0, FD * 0.006))
        cut = box(FL + 4000, FD + 4000, FD + 4000, top - 2000, -FD - 2000, 0)
        part("Fairing_Half_1", "fairing", BRepAlgoAPI_Cut(fair, cut).Shape())
        part("Fairing_Half_2", "fairing", BRepAlgoAPI_Cut(fair, moved(cut, 0, 0, -(FD + 4000))).Shape())
`;

const isp = z.number().min(50).max(500);
const vehicleStage = z
  .object({
    name: z.string().max(40).optional(),
    isp_vac_s: isp,
    isp_sl_s: isp.optional(),
    structural_fraction: z.number().min(0.01).max(0.5),
    thrust_kN: z.number().positive().max(200_000).optional(),
    propellant_mass_kg: z.number().positive().max(1e8).optional(),
    dry_mass_kg: z.number().positive().max(1e7).optional(),
    reserve_delta_v_m_s: z.number().min(0).max(5000).default(0),
  })
  .strict();
const flownStage = z
  .object({
    name: z.string().max(40).optional(),
    propellant_mass_kg: z.number().positive().max(1e8),
    dry_mass_kg: z.number().positive().max(1e7),
    thrust_vac_kN: z.number().positive().max(200_000),
    isp_vac_s: isp,
    isp_sl_s: isp.optional(),
    exit_area_m2: z.number().min(0).max(500).optional(),
    reserve_kg: z.number().min(0).max(1e7).default(0),
  })
  .strict();
const tankStage = z
  .object({
    name: z.string().max(40).optional(),
    propellant: z.enum(PROPELLANTS),
    of_ratio: z.number().min(0.5).max(12),
    propellant_mass_kg: z.number().positive().max(1e8),
    diameter_m: z.number().min(0.2).max(20),
    tank_pressure_bar: z.number().min(0.5).max(30).default(3),
    material: z.enum(TANK_MATERIALS).default('al2195'),
    thrust_kN: z.number().positive().max(200_000).optional(),
    mass_above_kg: z.number().min(0).max(1e8).default(0),
    max_accel_g: z.number().min(1).max(15).default(5),
  })
  .strict();
const cadStage = z
  .object({
    name: z.string().max(40).optional(),
    length_m: z.number().min(1).max(150),
    diameter_m: z.number().min(0.3).max(20),
    engines: z.number().int().min(1).max(60),
    engine_exit_diameter_m: z.number().min(0.05).max(6),
    expansion_ratio: z.number().min(2).max(400).optional(),
    engine_length_m: z.number().min(0.1).max(15).optional(),
    oxidizer_fraction: z.number().min(0.3).max(0.8).optional(),
    interstage_length_m: z.number().min(0).max(25).optional(),
    grid_fins: z.boolean().optional(),
    landing_legs: z.boolean().optional(),
  })
  .strict();
const orbit = {
  orbit_altitude_km: z.number().min(150).max(2000).default(400),
  launch_latitude_deg: z.number().min(0).max(70).default(28.5),
  inclination_deg: z.number().min(0).max(180).optional(),
};
// A Falcon-9-class two-stage vehicle (public figures, rounded) as the default example.
const F9_FLOWN = [
  {
    name: 'Booster',
    propellant_mass_kg: 411_000,
    dry_mass_kg: 25_600,
    thrust_vac_kN: 8227,
    isp_vac_s: 311,
    isp_sl_s: 282,
    reserve_kg: 11_000,
  },
  {
    name: 'Upper stage',
    propellant_mass_kg: 107_500,
    dry_mass_kg: 4000,
    thrust_vac_kN: 981,
    isp_vac_s: 348,
    reserve_kg: 0,
  },
];

export const ROCKET_ENGINES: LabEngine[] = [
  {
    name: 'rocket_engine',
    domain: 'aerospace',
    title: 'Liquid rocket engine',
    description:
      'Designs a liquid rocket engine from chemical equilibrium like NASA CEA (Cantera, 72 C/H/O/N species, NASA thermo to 6000 K): chamber temperature and composition, c*, shifting-equilibrium nozzle flow, Isp at sea level and in vacuum, an O/F sweep (optionally picking the best), throat/exit/chamber sizing for a thrust, an 80 % bell contour (contour.csv) and the Bartz throat heat flux. Propellants: lox_lh2, lox_ch4, lox_rp1, n2o4_mmh. Give expansion_ratio or exit_pressure_bar. Needs the thermochemistry capability (Cantera).',
    params: z
      .object({
        propellant: z.enum(PROPELLANTS).default('lox_ch4'),
        of_ratio: z.number().min(0.5).max(12).optional(),
        optimize_of: z.boolean().default(false),
        chamber_pressure_bar: z.number().min(2).max(400).default(100),
        expansion_ratio: z.number().min(1.5).max(400).default(40),
        exit_pressure_bar: z.number().min(0.0005).max(5).optional(),
        thrust_kN: z.number().min(0.001).max(50_000).default(1000),
        thrust_at: z.enum(['sea_level', 'vacuum']).default('sea_level'),
        cstar_efficiency: z.number().min(0.8).max(1).default(0.98),
        nozzle_efficiency: z.number().min(0.8).max(1).default(0.98),
        contraction_ratio: z.number().min(1.5).max(10).default(3),
        l_star_m: z.number().min(0.2).max(3).optional(),
        wall_temperature_K: z.number().min(300).max(1500).default(900),
        sweep_points: z.number().int().min(3).max(25).default(9),
      })
      .strict(),
    requires: ['cantera'],
    need: 'combustion',
    check: 'rocket_engine_recomputed',
    checkDescription:
      'The O/F ratio is recomputed from the chamber composition (mass balance), energy and mass flow are conserved at every nozzle station, the throat is sonic, Isp and c* follow from the station table, agree with an ideal-rocket model within 3–6 %, and thrust, throat and exit sizes follow from the mass flow',
    body: PROPULSION,
  },
  {
    name: 'launch_vehicle',
    domain: 'aerospace',
    title: 'Launch vehicle staging',
    description:
      'Sizes a 1–4 stage launch vehicle with the rocket equation: the delta-v needed for an orbit (orbital speed, Earth rotation along the launch azimuth, ascent losses), the delta-v split that gives the lowest liftoff mass, propellant and dry mass per stage, recovery reserves (e.g. a booster landing, reserve_delta_v_m_s), thrust-to-weight and burn times. Mode "evaluate" takes given propellant masses and reports the delta-v and margin instead.',
    params: z
      .object({
        payload_kg: z.number().min(1).max(1e6).default(15_000),
        fairing_mass_kg: z.number().min(0).max(50_000).default(0),
        ...orbit,
        losses_m_s: z.number().min(0).max(4000).default(1600),
        delta_v_m_s: z.number().min(500).max(30_000).optional(),
        mode: z.enum(['optimize', 'evaluate']).optional(),
        stages: z
          .array(vehicleStage)
          .min(1)
          .max(4)
          .default([
            {
              name: 'Booster',
              isp_sl_s: 327,
              isp_vac_s: 350,
              structural_fraction: 0.06,
              reserve_delta_v_m_s: 1200,
            },
            {
              name: 'Upper stage',
              isp_vac_s: 375,
              structural_fraction: 0.07,
              reserve_delta_v_m_s: 0,
            },
          ]),
      })
      .strict(),
    requires: [],
    check: 'launch_vehicle_recomputed',
    checkDescription:
      'Masses add up stage by stage from the payload, each stage delta-v is integrated numerically from its masses, the orbital speed is recomputed, and (when optimised) no 10 m/s move of delta-v between stages lowers the liftoff mass',
    body: VEHICLE,
  },
  {
    name: 'ascent_trajectory',
    domain: 'aerospace',
    title: 'Ascent to orbit',
    description:
      'Flies a launch vehicle to orbit: a planar point-mass ascent over a rotating Earth with the 1976 standard atmosphere, Mach-dependent drag, back-pressure thrust loss, acceleration-limited throttling, staging, coasts and fairing jettison. The pitch program (kick, upper-stage pitch) is optimised for the most propellant left after circularising. Reports max-Q, max g, gravity/drag/steering losses, the orbit and the propellant margin, with the whole trajectory. Stages need propellant_mass_kg, dry_mass_kg, thrust_vac_kN, isp_vac_s (isp_sl_s for the first), optional reserve_kg (kept for a landing).',
    params: z
      .object({
        payload_kg: z.number().min(1).max(1e6).default(15_000),
        fairing_mass_kg: z.number().min(0).max(50_000).default(1900),
        diameter_m: z.number().min(0.3).max(20).default(3.7),
        cd_scale: z.number().min(0.3).max(3).default(1),
        orbit_altitude_km: z.number().min(150).max(2000).default(300),
        launch_latitude_deg: orbit.launch_latitude_deg,
        inclination_deg: orbit.inclination_deg,
        max_accel_g: z.number().min(1).max(15).default(5),
        min_throttle: z.number().min(0.1).max(1).default(0.4),
        fairing_altitude_km: z.number().min(50).max(200).default(110),
        stage_coast_s: z.number().min(0).max(60).default(3),
        time_step_s: z.number().min(0.1).max(2).default(0.5),
        search_iterations: z.number().int().min(5).max(200).default(45),
        pitch_kick_deg: z.number().min(0.2).max(20).optional(),
        upper_pitch_start_deg: z.number().min(-15).max(70).optional(),
        upper_pitch_end_deg: z.number().min(-40).max(50).optional(),
        stages: z.array(flownStage).min(1).max(4).default(F9_FLOWN),
      })
      .strict(),
    requires: [],
    check: 'ascent_recomputed',
    checkDescription:
      'Every interval of the trajectory is re-flown from its reported state with an independently written force model and integrator, dynamic pressure is recomputed from the atmosphere, and the orbit, circularisation and max-Q are recomputed from the reported states',
    body: ASCENT,
    limits: { timeoutMs: 600_000 },
  },
  {
    name: 'rocket_tanks',
    domain: 'aerospace',
    title: 'Propellant tanks and structure',
    description:
      'Sizes the oxidiser and fuel tanks of each stage: volumes with ullage, cylinder and ellipsoidal dome lengths, wall and dome thickness from tank pressure plus hydrostatic head at peak acceleration (yield and ultimate factors), axial buckling with the NASA SP-8007 knockdown (walls thickened until they hold), and tank masses. Materials: Al 2219, Al-Li 2195, stainless 304L/301, Ti-6Al-4V, CFRP.',
    params: z
      .object({
        yield_factor: z.number().min(1).max(2).default(1.1),
        ultimate_factor: z.number().min(1).max(3).default(1.4),
        min_gauge_mm: z.number().min(0.3).max(10).default(1.5),
        ullage: z.number().min(0).max(0.2).default(0.03),
        nonoptimum_factor: z.number().min(1).max(2).default(1.3),
        stages: z
          .array(tankStage)
          .min(1)
          .max(4)
          .default([
            {
              name: 'Booster',
              propellant: 'lox_rp1',
              of_ratio: 2.36,
              propellant_mass_kg: 411_000,
              diameter_m: 3.66,
              tank_pressure_bar: 3.5,
              material: 'al2195',
              thrust_kN: 7607,
              mass_above_kg: 130_000,
              max_accel_g: 5,
            },
            {
              name: 'Upper stage',
              propellant: 'lox_rp1',
              of_ratio: 2.36,
              propellant_mass_kg: 107_500,
              diameter_m: 3.66,
              tank_pressure_bar: 3.5,
              material: 'al2195',
              thrust_kN: 981,
              mass_above_kg: 23_000,
              max_accel_g: 5,
            },
          ]),
      })
      .strict(),
    requires: [],
    check: 'rocket_tanks_recomputed',
    checkDescription:
      'Each tank is rebuilt as a profile of revolution and its volume and wall area integrated in slices; hoop stress, buckling stress and mass are recomputed from the walls and every wall must hold',
    body: TANKS,
  },
  {
    name: 'rocket_cad',
    domain: 'cad',
    title: 'Launch vehicle CAD model',
    description:
      'Builds the whole launch vehicle as named B-rep solids: per stage the aft skirt, thrust plate, fuel and oxidiser tanks with domes, forward skirt and a cluster of bell-nozzle engines (injector, gimbal, turbopump); interstage, grid fins and landing legs on the booster; payload adapter, payload and a two-piece ogive fairing. Exports a STEP assembly, meshes and a parts list. Needs the CAD kernel capability.',
    params: z
      .object({
        mesh_mm: z.number().min(1).max(100).default(15),
        payload_length_m: z.number().min(0.5).max(40).optional(),
        fairing: z
          .object({ length_m: z.number().min(1).max(60), diameter_m: z.number().min(0.3).max(20) })
          .strict()
          .optional(),
        stages: z
          .array(cadStage)
          .min(1)
          .max(4)
          .default([
            {
              name: 'Booster',
              length_m: 41.2,
              diameter_m: 3.66,
              engines: 9,
              engine_exit_diameter_m: 0.92,
              expansion_ratio: 16,
              interstage_length_m: 6.5,
            },
            {
              name: 'Upper stage',
              length_m: 9.5,
              diameter_m: 3.66,
              engines: 1,
              engine_exit_diameter_m: 3,
              expansion_ratio: 165,
            },
          ]),
      })
      .strict(),
    requires: ['ocp'],
    need: 'cad',
    check: 'cad_assembly_recomputed',
    checkDescription:
      'Parts and unique names are recounted, every solid is valid, every mesh is closed, and each group volume is recomputed from its triangles within 3 % of the kernel',
    body: CAD_HELPERS + ROCKET_CAD + CAD_EPILOGUE,
    limits: {
      timeoutMs: 600_000,
      memoryMb: 3072,
      maxOutputBytes: 400 * 1024 * 1024,
      maxOutputFiles: 40,
      tmpMb: 256,
    },
  },
];
