import { z } from 'zod';
import type { Check } from '../verification/checks.ts';
import { MATERIALS } from './engines.ts';

/**
 * Independent checks for the lab engines. Each recomputes the engine's claims from its
 * reported output with a different method (recursive Fresnel instead of matrices, a full
 * unitary instead of tensor contraction, its own fit and its own atomic weights), so a bug
 * in an engine cannot verify itself.
 */

const params = z.object({ step: z.string() }).passthrough() as unknown as z.ZodType<
  Record<string, unknown>
>;

const STACK = `
MATERIALS = json.loads(${JSON.stringify(JSON.stringify(MATERIALS))})
def index_of(m):
    return float(MATERIALS[m]) if isinstance(m, str) else float(m)
def build_stack(P):
    if P.get("layers"):
        return [(index_of(l["material"]), float(l["thickness_nm"])) for l in P["layers"]]
    b = P.get("bragg") or {}
    hi, lo = index_of(b.get("high", "tio2")), index_of(b.get("low", "sio2"))
    c = float(b.get("center_nm", 1550)); pairs = int(b.get("pairs", 8))
    return [(hi, c / (4 * hi)), (lo, c / (4 * lo))] * pairs
import cmath
def rouard(layers, n0, ns, lam):
    media = [n0] + [n for n, _ in layers] + [ns]
    r = (media[-2] - media[-1]) / (media[-2] + media[-1])
    for j in range(len(layers) - 1, -1, -1):
        n, d = layers[j]
        rt = (media[j] - media[j + 1]) / (media[j] + media[j + 1])
        e = cmath.exp(-2j * 2 * math.pi * n * d / lam)
        r = (rt + r * e) / (1 + rt * r * e)
    return abs(r) ** 2
`;

export const LAB_CHECKS: Check[] = [
  {
    name: 'thin_film_recomputed',
    description:
      'Recomputes every reflectance value of a thin-film result with recursive Fresnel coefficients (independent of the transfer matrix), checks R + T = 1, and the claimed peak.',
    params,
    needsResult: true,
    needsData: false,
    body: `${STACK}
layers = build_stack(P)
n0, ns = index_of(P.get("incident", "air")), index_of(P.get("substrate", "glass"))
data = rows("/input/result.csv")
mismatches = []; worst = 0.0
for r in data:
    lam = num(r["wavelength_nm"]); R = num(r["R"]); T = num(r["T"])
    ref = rouard(layers, n0, ns, lam)
    err = abs(ref - R); worst = max(worst, err)
    if err > 1e-6: mismatches.append({"wavelength_nm": lam, "reported": R, "recomputed": ref})
    if abs(R + T - 1) > 1e-6: mismatches.append({"wavelength_nm": lam, "problem": "R + T != 1", "sum": R + T})
claim = CLAIM or {}
peak = max(data, key=lambda r: num(r["R"])) if data else None
if peak and not close(num(peak["R"]), num(claim.get("peak_reflectance"))):
    mismatches.append({"problem": "peak reflectance", "expected": num(peak["R"]), "claimed": claim.get("peak_reflectance")})
if peak and abs(num(peak["wavelength_nm"]) - num(claim.get("peak_wavelength_nm"))) > 1e-6:
    mismatches.append({"problem": "peak wavelength", "expected": num(peak["wavelength_nm"]), "claimed": claim.get("peak_wavelength_nm")})
verdict(bool(data) and not mismatches, len(data), worst, mismatches,
        "%d wavelengths recomputed with recursive Fresnel coefficients; largest difference %.1e" % (len(data), worst))
`,
  },
  {
    name: 'ring_recomputed',
    description:
      'Re-measures free spectral range (resonance spacing and the formula λ²/(n_g·L)), extinction and linewidth on the reported ring spectrum and compares them with the claims.',
    params,
    needsResult: true,
    needsData: false,
    body: `
data = [(num(r["wavelength_nm"]), num(r["T"])) for r in rows("/input/result.csv")]
wl = [w for w, _ in data]; T = [t for _, t in data]
step = (wl[-1] - wl[0]) / (len(wl) - 1)
mins = [i for i in range(1, len(T) - 1) if T[i] <= T[i - 1] and T[i] <= T[i + 1] and T[i] < 0.999]
claim = CLAIM or {}
mismatches = []
L = 2 * math.pi * float(P.get("radius_um", 20)) * 1e3
lam0 = float(P.get("center_nm", 1550))
fsr_formula = lam0 * lam0 / (float(P.get("n_g", 4.2)) * L)
if abs(fsr_formula - num(claim.get("fsr_nm"))) > 1e-6 * fsr_formula:
    mismatches.append({"problem": "fsr formula", "expected": fsr_formula, "claimed": claim.get("fsr_nm")})
if len(mins) >= 2:
    spacing = (wl[mins[-1]] - wl[mins[0]]) / (len(mins) - 1)
    if abs(spacing - fsr_formula) > 0.02 * fsr_formula + 2 * step:
        mismatches.append({"problem": "resonance spacing", "measured": spacing, "formula": fsr_formula})
k = min(mins, key=lambda i: abs(wl[i] - lam0)) if mins else min(range(len(T)), key=lambda i: T[i])
ext = -10 * math.log10(max(T[k], 1e-12))
if abs(ext - num(claim.get("extinction_db"))) > 0.05:
    mismatches.append({"problem": "extinction", "expected": ext, "claimed": claim.get("extinction_db")})
half = (1 + T[k]) / 2
def cross(i, d):
    while 0 < i < len(T) - 1 and T[i] < half: i += d
    j = i - d
    # linear interpolation between the last point below and the first above half depth
    return wl[j] + (half - T[j]) * (wl[i] - wl[j]) / (T[i] - T[j]) if T[i] != T[j] else wl[i]
fwhm = cross(k, 1) - cross(k, -1)
if claim.get("fwhm_nm") is not None and abs(fwhm - num(claim.get("fwhm_nm"))) > 2.5 * step:
    mismatches.append({"problem": "linewidth", "expected": fwhm, "claimed": claim.get("fwhm_nm")})
verdict(not mismatches, len(data), 0.0, mismatches,
        "%d resonances, spacing vs FSR %.4f nm, extinction %.2f dB, linewidth %.4f nm re-measured" % (len(mins), fsr_formula, ext, fwhm))
`,
  },
  {
    name: 'tolerance_recomputed',
    description:
      'Recomputes yield, mean, spread and worst case of a Monte Carlo tolerance run from its per-run results.',
    params,
    needsResult: true,
    needsData: false,
    body: `
data = rows("/input/result.csv")
peaks = [num(r["peak_reflectance"]) for r in data]
centres = [num(r["peak_wavelength_nm"]) for r in data]
n = len(peaks)
mean = sum(peaks) / n
std = math.sqrt(sum((p - mean) ** 2 for p in peaks) / n)
cmean = sum(centres) / n
cstd = math.sqrt(sum((c - cmean) ** 2 for c in centres) / n)
spec = float(P.get("min_reflectance", 0.99))
yld = sum(1 for p in peaks if p >= spec) / n
claim = CLAIM or {}
mismatches = []
for key, val in (("mean_peak_reflectance", mean), ("std_peak_reflectance", std), ("worst_peak_reflectance", min(peaks)), ("yield", yld), ("centre_std_nm", cstd)):
    if abs(val - num(claim.get(key))) > 1e-9 * max(1.0, abs(val)):
        mismatches.append({"problem": key, "expected": val, "claimed": claim.get(key)})
if int(num(claim.get("runs"))) != n:
    mismatches.append({"problem": "runs", "expected": n, "claimed": claim.get("runs")})
verdict(not mismatches, n, 0.0, mismatches, "%d runs: yield %.1f%%, mean peak %.5f recomputed" % (n, 100 * yld, mean))
`,
  },
  {
    name: 'quantum_recomputed',
    description:
      'Rebuilds the circuit as one full unitary matrix (Kronecker products, a different method from the state-vector run) and compares every probability; they must sum to one.',
    params,
    needsResult: true,
    needsData: false,
    body: `
import numpy as np
claim = CLAIM or {}
text = str(claim.get("circuit", ""))
n = int(num(claim.get("qubits")))
ops = []
for part in text.replace("\\n", ";").split(";"):
    t = part.strip().split()
    if not t: continue
    g = t[0].lower(); args = t[1:]; th = None
    if g in ("rx", "ry", "rz", "p"): th = float(args[-1]); args = args[:-1]
    ops.append((g, [int(x) for x in args], th))
I = np.eye(2, dtype=complex)
s2 = 1 / math.sqrt(2)
G = {"h": np.array([[s2, s2], [s2, -s2]]), "x": np.array([[0, 1], [1, 0]]), "y": np.array([[0, -1j], [1j, 0]]),
     "z": np.array([[1, 0], [0, -1]]), "s": np.array([[1, 0], [0, 1j]]), "t": np.array([[1, 0], [0, np.exp(1j * math.pi / 4)]])}
def rot(g, th):
    c, s = math.cos(th / 2), math.sin(th / 2)
    return {"rx": np.array([[c, -1j * s], [-1j * s, c]]), "ry": np.array([[c, -s], [s, c]]),
            "rz": np.array([[np.exp(-1j * th / 2), 0], [0, np.exp(1j * th / 2)]]), "p": np.array([[1, 0], [0, np.exp(1j * th)]])}[g]
def full(U, q):
    m = np.array([[1]], dtype=complex)
    for k in range(n): m = np.kron(m, U if k == q else I)
    return m
P0 = np.array([[1, 0], [0, 0]], dtype=complex); P1 = np.array([[0, 0], [0, 1]], dtype=complex)
def controlled(c, t, U):
    a = np.array([[1]], dtype=complex); b = np.array([[1]], dtype=complex)
    for k in range(n):
        a = np.kron(a, P0 if k == c else I)
        b = np.kron(b, P1 if k == c else (U if k == t else I))
    return a + b
dim = 2 ** n
M = np.eye(dim, dtype=complex)
for g, qs, th in ops:
    if g in G: U = full(G[g], qs[0])
    elif g in ("rx", "ry", "rz", "p"): U = full(rot(g, th), qs[0])
    elif g in ("cx", "cnot"): U = controlled(qs[0], qs[1], G["x"])
    elif g == "cz": U = controlled(qs[0], qs[1], G["z"])
    elif g == "swap":
        a, b = qs
        U = controlled(a, b, G["x"]) @ controlled(b, a, G["x"]) @ controlled(a, b, G["x"])
    M = U @ M
psi = M[:, 0]
expected = {format(i, "0%db" % n): abs(psi[i]) ** 2 for i in range(dim)}
reported = {r["state"]: num(r["probability"]) for r in rows("/input/result.csv")}
mismatches = []; worst = 0.0
for state, p in expected.items():
    err = abs(p - reported.get(state, 0.0)); worst = max(worst, err)
    if err > 1e-9: mismatches.append({"state": state, "expected": p, "reported": reported.get(state, 0.0)})
total = sum(reported.values())
if abs(total - 1) > 1e-9: mismatches.append({"problem": "probabilities sum", "sum": total})
top = max(expected, key=expected.get)
if abs(expected[top] - num(claim.get("top_probability"))) > 1e-9:
    mismatches.append({"problem": "top probability", "expected": expected[top], "claimed": claim.get("top_probability")})
verdict(not mismatches, dim, worst, mismatches,
        "%d amplitudes recomputed from the full %dx%d unitary; largest difference %.1e" % (dim, dim, dim, worst))
`,
  },
  {
    name: 'molecule_mass_recomputed',
    description:
      'Recomputes the molecular weight and the element counts of the formula from the atoms of the reported 3D structure with its own table of standard atomic weights.',
    params,
    needsResult: true,
    needsData: false,
    body: `
import re
W = {"H": 1.008, "C": 12.011, "N": 14.007, "O": 15.999, "F": 18.998, "P": 30.974, "S": 32.06,
     "Cl": 35.45, "Br": 79.904, "I": 126.904, "B": 10.81, "Si": 28.085, "Na": 22.99, "K": 39.098}
atoms = rows("/input/result.csv")
counts = {}
for a in atoms: counts[a["element"]] = counts.get(a["element"], 0) + 1
claim = CLAIM or {}
mismatches = []
unknown = [e for e in counts if e not in W]
mass = sum(W.get(e, 0) * c for e, c in counts.items())
if unknown: mismatches.append({"problem": "no atomic weight for", "elements": unknown})
elif abs(mass - num(claim.get("mol_weight"))) > 0.05:
    mismatches.append({"problem": "molecular weight", "expected": mass, "claimed": claim.get("mol_weight")})
formula = {}
for el, k in re.findall(r"([A-Z][a-z]?)(\\d*)", re.sub(r"[+-]\\d*$", "", str(claim.get("formula", "")))):
    formula[el] = formula.get(el, 0) + (int(k) if k else 1)
if formula != counts:
    mismatches.append({"problem": "formula", "from_atoms": counts, "claimed": claim.get("formula")})
verdict(not mismatches, len(atoms), 0.0, mismatches,
        "%d atoms: M = %.3f g/mol from standard atomic weights" % (len(atoms), mass))
`,
  },
  {
    name: 'crystal_fit_recomputed',
    description:
      'Refits the energy minimum of the reported energy-volume curve with a least-squares parabola and recomputes lattice constant, bulk modulus and cohesive energy.',
    params,
    needsResult: true,
    needsData: false,
    body: `
pts = [(num(r["volume_A3"]), num(r["energy_eV"])) for r in rows("/input/result.csv")]
k = min(range(len(pts)), key=lambda i: pts[i][1])
sel = pts[max(0, k - 2): k + 3]
# least-squares parabola E = c0 + c1 V + c2 V^2 (normal equations, Cramer's rule)
S = [sum(v ** p for v, _ in sel) for p in range(5)]
Y = [sum(e * v ** p for v, e in sel) for p in range(3)]
def det(m): return (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))
A = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]]
D = det(A)
def solve(col):
    m = [row[:] for row in A]
    for i in range(3): m[i][col] = Y[i]
    return det(m) / D
c0, c1, c2 = solve(0), solve(1), solve(2)
v0 = -c1 / (2 * c2)
a0 = (4 * v0) ** (1 / 3)
B = v0 * 2 * c2 * 160.21766
ecoh = -(c0 + c1 * v0 + c2 * v0 * v0)
claim = CLAIM or {}
mismatches = []
if abs(a0 - num(claim.get("a0_angstrom"))) > 0.003 * a0:
    mismatches.append({"problem": "lattice constant", "expected": a0, "claimed": claim.get("a0_angstrom")})
if abs(B - num(claim.get("bulk_modulus_GPa"))) > 0.05 * B:
    mismatches.append({"problem": "bulk modulus", "expected": B, "claimed": claim.get("bulk_modulus_GPa")})
if abs(ecoh - num(claim.get("cohesive_energy_eV"))) > 0.01 * ecoh:
    mismatches.append({"problem": "cohesive energy", "expected": ecoh, "claimed": claim.get("cohesive_energy_eV")})
verdict(not mismatches, len(pts), 0.0, mismatches,
        "Refitted from %d points: a0 = %.4f A, B = %.0f GPa, cohesive energy %.3f eV" % (len(pts), a0, B, ecoh))
`,
  },
];
