import { z } from 'zod';
import { CAD_EPILOGUE, CAD_HELPERS, TURBOFAN } from './cad.ts';
import { DESIGN_ENGINE } from './design.ts';
import { PCB_ENGINE, PCB_RECHECK_ENGINE } from './pcb.ts';
import { ROCKET_ENGINES } from './rocket.ts';

/**
 * The lab: simulation engines for deep-tech questions, run in the sandbox like analysis
 * recipes. Each engine writes its main result to /output/result.csv and its claims to
 * /output/summary.json; an independent check (lab/checks.ts) recomputes the claims with a
 * different method. Engines say what model they use and what its numbers are worth.
 */

export type LabDomain =
  'photonics' | 'quantum' | 'chemistry' | 'materials' | 'cad' | 'aerospace' | 'electronics';

export interface LabEngine {
  name: string;
  domain: LabDomain;
  title: string;
  description: string;
  params: z.ZodType<Record<string, unknown>>;
  /** Capability ids that must be enabled (mounted); acquired at runtime when missing. */
  requires: readonly string[];
  /** Capability need (catalog) to acquire when `requires` is not met. */
  need?: string;
  /** The independent check that verifies this engine's claims. */
  check: string;
  checkDescription: string;
  /** Further independent checks that run on the same step. */
  alsoChecks?: { name: string; description: string }[];
  body: string;
  /** Sandbox limits beyond the defaults (CAD needs more time, memory and output). */
  limits?: {
    timeoutMs?: number;
    memoryMb?: number;
    maxOutputBytes?: number;
    maxOutputFiles?: number;
    tmpMb?: number;
  };
}

export const MATERIALS: Record<string, number> = {
  air: 1,
  vacuum: 1,
  glass: 1.52,
  sio2: 1.45,
  mgf2: 1.38,
  al2o3: 1.76,
  si3n4: 2.0,
  ta2o5: 2.1,
  tio2: 2.4,
  si: 3.48,
};

const refIndex = z.union([
  z.number().min(1).max(6),
  z.enum(Object.keys(MATERIALS) as [string, ...string[]]),
]);
const layer = z
  .object({ material: refIndex, thickness_nm: z.number().positive().max(100_000) })
  .strict();
const stack = {
  layers: z.array(layer).max(200).optional(),
  bragg: z
    .object({
      high: refIndex.default('tio2'),
      low: refIndex.default('sio2'),
      pairs: z.number().int().min(1).max(50).default(8),
      center_nm: z.number().min(200).max(20_000).default(1550),
    })
    .strict()
    .optional(),
  incident: refIndex.default('air'),
  substrate: refIndex.default('glass'),
  start_nm: z.number().min(100).max(20_000).default(1000),
  stop_nm: z.number().min(100).max(20_000).default(2200),
  points: z.number().int().min(11).max(4001).default(601),
};

/** Shared Python helpers: params, capability paths, the stack builder and the TMM. */
export function labPrelude(params: unknown, capabilityPaths: readonly string[] = []): string {
  return [
    'import json, sys, math, csv',
    `sys.path[:0] = json.loads(${JSON.stringify(JSON.stringify(capabilityPaths))})`,
    'import numpy as np',
    `P = json.loads(${JSON.stringify(JSON.stringify(params))})`,
    `MATERIALS = json.loads(${JSON.stringify(JSON.stringify(MATERIALS))})`,
    'def write_csv(name, header, rows):',
    '    with open("/output/" + name, "w", newline="") as f:',
    '        w = csv.writer(f); w.writerow(header); w.writerows(rows)',
    'def summary(d):',
    '    with open("/output/summary.json", "w") as f: json.dump(d, f, default=float)',
    'def index_of(m):',
    '    return float(MATERIALS[m]) if isinstance(m, str) else float(m)',
    'def build_stack(P):',
    '    if P.get("layers"):',
    '        return [(index_of(l["material"]), float(l["thickness_nm"])) for l in P["layers"]]',
    '    b = P.get("bragg") or {}',
    '    hi, lo = index_of(b.get("high", "tio2")), index_of(b.get("low", "sio2"))',
    '    c = float(b.get("center_nm", 1550)); pairs = int(b.get("pairs", 8))',
    '    return [(hi, c / (4 * hi)), (lo, c / (4 * lo))] * pairs',
    'def tmm(layers, n0, ns, wl):',
    '    # Characteristic-matrix method at normal incidence; lossless real indices.',
    '    M = np.tile(np.eye(2, dtype=complex), (len(wl), 1, 1))',
    '    for n, d in layers:',
    '        delta = 2 * np.pi * n * d / wl',
    '        L = np.empty((len(wl), 2, 2), dtype=complex)',
    '        L[:, 0, 0] = np.cos(delta); L[:, 0, 1] = 1j * np.sin(delta) / n',
    '        L[:, 1, 0] = 1j * n * np.sin(delta); L[:, 1, 1] = np.cos(delta)',
    '        M = M @ L',
    '    B = M[:, 0, 0] + M[:, 0, 1] * ns',
    '    C = M[:, 1, 0] + M[:, 1, 1] * ns',
    '    r = (n0 * B - C) / (n0 * B + C)',
    '    R = np.abs(r) ** 2',
    '    T = 4 * n0 * ns / np.abs(n0 * B + C) ** 2',
    '    return R, T',
    '',
  ].join('\n');
}

const THIN_FILM = `
layers = build_stack(P)
n0, ns = index_of(P.get("incident", "air")), index_of(P.get("substrate", "glass"))
wl = np.linspace(float(P.get("start_nm", 1000)), float(P.get("stop_nm", 2200)), int(P.get("points", 601)))
R, T = tmm(layers, n0, ns, wl)
write_csv("result.csv", ["wavelength_nm", "R", "T"], [[round(float(w), 6), float(r), float(t)] for w, r, t in zip(wl, R, T)])
i = int(np.argmax(R))
above = R >= R[i] / 2
lo = i
while lo > 0 and above[lo - 1]: lo -= 1
hi = i
while hi < len(wl) - 1 and above[hi + 1]: hi += 1
summary({
    "model": "transfer matrix, normal incidence, lossless dielectrics",
    "layers": len(layers),
    "total_thickness_nm": round(sum(d for _, d in layers), 3),
    "peak_reflectance": float(R[i]),
    "peak_wavelength_nm": float(wl[i]),
    "bandwidth_nm": float(wl[hi] - wl[lo]),
    "mean_reflectance": float(np.mean(R)),
})
print("Peak reflectance %.4f at %.1f nm, band %.1f nm wide (%d layers)." % (R[i], wl[i], wl[hi] - wl[lo], len(layers)))
`;

const RING = `
L = 2 * np.pi * float(P["radius_um"]) * 1e3          # circumference in nm
neff, ng = float(P["n_eff"]), float(P["n_g"])
lam0 = float(P["center_nm"])
a = 10 ** (-float(P["loss_db_per_cm"]) * (L * 1e-7) / 20)   # field round-trip transmission
r = math.sqrt(1 - float(P["power_coupling"]))               # self-coupling
span = float(P["span_nm"])
wl = np.linspace(lam0 - span / 2, lam0 + span / 2, int(P["points"]))
dT = float(P.get("delta_t_k", 0))
n_lin = neff - (ng - neff) * (wl - lam0) / lam0 + float(P["dn_dt"]) * dT   # first-order dispersion
phi = 2 * np.pi * n_lin * L / wl
Tr = (a * a - 2 * r * a * np.cos(phi) + r * r) / (1 - 2 * a * r * np.cos(phi) + (r * a) ** 2)
write_csv("result.csv", ["wavelength_nm", "T"], [[round(float(w), 6), float(t)] for w, t in zip(wl, Tr)])
fsr = lam0 * lam0 / (ng * L)
# Resonance nearest the centre and its full width at half depth, measured on the spectrum
mins = [i for i in range(1, len(wl) - 1) if Tr[i] <= Tr[i - 1] and Tr[i] <= Tr[i + 1]]
k = min(mins, key=lambda i: abs(wl[i] - lam0)) if mins else int(np.argmin(Tr))
half = (1 + Tr[k]) / 2
lo = k
while lo > 0 and Tr[lo] < half: lo -= 1
hi = k
while hi < len(wl) - 1 and Tr[hi] < half: hi += 1
fwhm = float(wl[hi] - wl[lo])
regime = "critical" if abs(r - a) < 1e-3 else ("under" if r > a else "over")
summary({
    "model": "all-pass ring, coupled-mode transmission with first-order dispersion",
    "fsr_nm": float(fsr),
    "resonance_nm": float(wl[k]),
    "extinction_db": float(-10 * math.log10(max(Tr[k], 1e-12))),
    "q_loaded": float(wl[k] / fwhm) if fwhm > 0 else None,
    "fwhm_nm": fwhm,
    "coupling": regime,
    "thermal_shift_pm_per_k": float(lam0 * float(P["dn_dt"]) / ng * 1000),
    "round_trip_loss_db": float(-20 * math.log10(a)),
})
print("FSR %.3f nm, resonance %.3f nm, Q %.0f, extinction %.1f dB (%s coupled)." % (fsr, wl[k], wl[k] / fwhm if fwhm else 0, -10 * math.log10(max(Tr[k], 1e-12)), regime))
`;

const TOLERANCE = `
base = build_stack(P)
n0, ns = index_of(P.get("incident", "air")), index_of(P.get("substrate", "glass"))
wl = np.linspace(float(P.get("start_nm", 1000)), float(P.get("stop_nm", 2200)), int(P.get("points", 601)))
rng = np.random.default_rng(int(P["seed"]))
sigma = float(P["sigma_nm"]); spec = float(P["min_reflectance"])
rows = []
for run in range(int(P["runs"])):
    layers = [(n, max(0.0, d + rng.normal(0, sigma))) for n, d in base]
    R, _ = tmm(layers, n0, ns, wl)
    i = int(np.argmax(R))
    rows.append([run + 1, float(R[i]), float(wl[i])])
write_csv("result.csv", ["run", "peak_reflectance", "peak_wavelength_nm"], rows)
peaks = np.array([r[1] for r in rows]); centres = np.array([r[2] for r in rows])
summary({
    "model": "Monte Carlo over layer thickness errors (normal, independent per layer), transfer matrix",
    "runs": len(rows),
    "sigma_nm": sigma,
    "mean_peak_reflectance": float(peaks.mean()),
    "std_peak_reflectance": float(peaks.std()),
    "worst_peak_reflectance": float(peaks.min()),
    "yield": float(np.mean(peaks >= spec)),
    "centre_std_nm": float(centres.std()),
})
print("Yield %.1f%% at R >= %.3f over %d runs; centre wavelength spread %.2f nm." % (100 * np.mean(peaks >= spec), spec, len(rows), centres.std()))
`;

const QUANTUM = `
PRESETS = {
    "bell": "H 0; CX 0 1",
    "ghz": "; ".join(["H 0"] + ["CX %d %d" % (i, i + 1) for i in range(int(P.get("qubits", 3)) - 1)]),
}
text = P.get("circuit") or PRESETS.get(P.get("preset", "bell"), PRESETS["bell"])
ops = []
for part in text.replace("\\n", ";").split(";"):
    t = part.strip().split()
    if not t: continue
    g = t[0].lower(); args = t[1:]
    theta = None
    if g in ("rx", "ry", "rz", "p"):
        theta = float(args[-1]); args = args[:-1]
    ops.append((g, [int(x) for x in args], theta))
n = max([int(P.get("qubits", 0))] + [q + 1 for _, qs, _ in ops for q in qs])
if n < 1 or n > 10: raise SystemExit("Between 1 and 10 qubits.")
s2 = 1 / math.sqrt(2)
ONE = {
    "h": np.array([[s2, s2], [s2, -s2]], dtype=complex), "x": np.array([[0, 1], [1, 0]], dtype=complex),
    "y": np.array([[0, -1j], [1j, 0]], dtype=complex), "z": np.array([[1, 0], [0, -1]], dtype=complex),
    "s": np.array([[1, 0], [0, 1j]], dtype=complex), "t": np.array([[1, 0], [0, np.exp(1j * math.pi / 4)]], dtype=complex),
}
def rot(g, th):
    c, s = math.cos(th / 2), math.sin(th / 2)
    if g == "rx": return np.array([[c, -1j * s], [-1j * s, c]], dtype=complex)
    if g == "ry": return np.array([[c, -s], [s, c]], dtype=complex)
    if g == "rz": return np.array([[np.exp(-1j * th / 2), 0], [0, np.exp(1j * th / 2)]], dtype=complex)
    return np.array([[1, 0], [0, np.exp(1j * th)]], dtype=complex)
# State as a tensor with one axis per qubit (qubit 0 = most significant bit).
psi = np.zeros([2] * n, dtype=complex); psi[(0,) * n] = 1
def apply1(psi, U, q):
    return np.moveaxis(np.tensordot(U, psi, axes=([1], [q])), 0, q)
for g, qs, th in ops:
    if g in ONE: psi = apply1(psi, ONE[g], qs[0])
    elif g in ("rx", "ry", "rz", "p"): psi = apply1(psi, rot(g, th), qs[0])
    elif g in ("cx", "cnot", "cz"):
        c, t = qs
        sub = [slice(None)] * n; sub[c] = 1
        part = psi[tuple(sub)]
        tt = t if t < c else t - 1
        part = apply1(part, ONE["x"] if g != "cz" else ONE["z"], tt)
        psi = psi.copy(); psi[tuple(sub)] = part
    elif g == "swap":
        psi = np.swapaxes(psi, qs[0], qs[1])
    else: raise SystemExit("Unknown gate " + g)
amp = psi.reshape(-1)
prob = np.abs(amp) ** 2
rows = [[format(i, "0%db" % n), float(prob[i]), float(amp[i].real), float(amp[i].imag)] for i in range(len(amp)) if prob[i] > 1e-12]
write_csv("result.csv", ["state", "probability", "amp_re", "amp_im"], rows)
top = max(rows, key=lambda r: r[1])
ent = -sum(p * math.log2(p) for _, p, _, _ in rows if p > 0)
purity = None
if n >= 2:
    m = amp.reshape(2, -1)
    rho = m @ m.conj().T
    purity = float(np.real(np.trace(rho @ rho)))
summary({
    "model": "state-vector simulation, ideal gates, no noise",
    "qubits": n, "gates": len(ops), "circuit": text,
    "top_state": top[0], "top_probability": top[1],
    "entropy_bits": float(ent),
    "purity_qubit0": purity,
    "entangled": bool(purity is not None and purity < 1 - 1e-9),
})
print("%d qubits, %d gates: most likely |%s> with p = %.4f; qubit 0 %s." % (n, len(ops), top[0], top[1], "entangled" if purity is not None and purity < 1 - 1e-9 else "not entangled"))
`;

/** Common molecules by name, so a question can say "caffeine" instead of SMILES. */
export const MOLECULES: Record<string, string> = {
  water: 'O',
  methane: 'C',
  ethanol: 'CCO',
  'acetic acid': 'CC(=O)O',
  benzene: 'c1ccccc1',
  caffeine: 'Cn1cnc2c1c(=O)n(C)c(=O)n2C',
  aspirin: 'CC(=O)Oc1ccccc1C(=O)O',
  paracetamol: 'CC(=O)Nc1ccc(O)cc1',
  ibuprofen: 'CC(C)Cc1ccc(cc1)C(C)C(=O)O',
  glucose: 'OC[C@H]1OC(O)[C@H](O)[C@@H](O)[C@@H]1O',
  nicotine: 'CN1CCC[C@H]1c1cccnc1',
};

const MOLECULE = `
from rdkit import Chem
from rdkit.Chem import AllChem, Descriptors, Crippen, rdMolDescriptors
smiles = P.get("smiles") or json.loads(${JSON.stringify(JSON.stringify(MOLECULES))}).get(str(P.get("name", "")).lower())
if not smiles: raise SystemExit("Unknown molecule; give a SMILES string.")
mol = Chem.MolFromSmiles(smiles)
if mol is None: raise SystemExit("Invalid SMILES: " + smiles)
mh = Chem.AddHs(mol)
energy = None
if AllChem.EmbedMolecule(mh, randomSeed=int(P.get("seed", 42))) == 0:
    if AllChem.MMFFHasAllMoleculeParams(mh):
        props = AllChem.MMFFGetMoleculeProperties(mh)
        ff = AllChem.MMFFGetMoleculeForceField(mh, props)
        ff.Minimize(maxIts=2000)
        energy = float(ff.CalcEnergy())
    conf = mh.GetConformer()
    pos = [conf.GetAtomPosition(i) for i in range(mh.GetNumAtoms())]
else:
    pos = [None] * mh.GetNumAtoms()
rows = []
for a in mh.GetAtoms():
    p = pos[a.GetIdx()]
    rows.append([a.GetIdx(), a.GetSymbol(), round(p.x, 4) if p else "", round(p.y, 4) if p else "", round(p.z, 4) if p else "", a.GetFormalCharge()])
write_csv("result.csv", ["index", "element", "x", "y", "z", "charge"], rows)
write_csv("bonds.csv", ["a", "b", "order"], [[b.GetBeginAtomIdx(), b.GetEndAtomIdx(), b.GetBondTypeAsDouble()] for b in mh.GetBonds()])
mw = float(Descriptors.MolWt(mh))
summary({
    "model": "RDKit descriptors; 3D conformer by ETKDG, MMFF94 minimised",
    "smiles": Chem.MolToSmiles(mol), "formula": rdMolDescriptors.CalcMolFormula(mol),
    "mol_weight": mw, "logp": float(Crippen.MolLogP(mol)), "tpsa": float(rdMolDescriptors.CalcTPSA(mol)),
    "h_donors": int(rdMolDescriptors.CalcNumHBD(mol)), "h_acceptors": int(rdMolDescriptors.CalcNumHBA(mol)),
    "rotatable_bonds": int(rdMolDescriptors.CalcNumRotatableBonds(mol)),
    "heavy_atoms": mol.GetNumHeavyAtoms(), "mmff_energy_kcal_mol": energy,
})
print("%s (%s): M = %.2f g/mol, logP %.2f, TPSA %.1f." % (rdMolDescriptors.CalcMolFormula(mol), Chem.MolToSmiles(mol), mw, Crippen.MolLogP(mol), rdMolDescriptors.CalcTPSA(mol)))
`;

/**
 * Morse pair-potential parameters for fcc metals: alpha (1/Å), r0 (Å), D (eV), from
 * Girifalco & Weizer, Phys. Rev. 114, 687 (1959); experimental lattice constants (Å).
 */
export const MORSE: Record<
  string,
  { alpha: number; r0: number; d: number; aExp: number; name: string }
> = {
  Cu: { alpha: 1.3588, r0: 2.866, d: 0.3429, aExp: 3.615, name: 'copper' },
  Ag: { alpha: 1.369, r0: 3.115, d: 0.3323, aExp: 4.086, name: 'silver' },
  Ni: { alpha: 1.4199, r0: 2.78, d: 0.4205, aExp: 3.524, name: 'nickel' },
  Al: { alpha: 1.1646, r0: 3.253, d: 0.2703, aExp: 4.05, name: 'aluminium' },
  Pb: { alpha: 1.1836, r0: 3.733, d: 0.2348, aExp: 4.95, name: 'lead' },
  Ca: { alpha: 0.80535, r0: 4.569, d: 0.1623, aExp: 5.58, name: 'calcium' },
  Sr: { alpha: 0.73776, r0: 4.988, d: 0.1513, aExp: 6.08, name: 'strontium' },
};

const CRYSTAL = `
M = json.loads(${JSON.stringify(JSON.stringify(MORSE))})[P["element"]]
al, r0, D = M["alpha"], M["r0"], M["d"]
# fcc neighbour distances in units of a, from an explicit lattice sum
basis = [(0, 0, 0), (0.5, 0.5, 0), (0.5, 0, 0.5), (0, 0.5, 0.5)]
dists = []
N = 6
for i in range(-N, N + 1):
    for j in range(-N, N + 1):
        for k in range(-N, N + 1):
            for b in basis:
                d = math.sqrt((i + b[0]) ** 2 + (j + b[1]) ** 2 + (k + b[2]) ** 2)
                if 0 < d <= N - 0.5: dists.append(d)
dists = np.array(dists)
def energy(a):
    r = dists * a
    return 0.5 * float(np.sum(D * (np.exp(-2 * al * (r - r0)) - 2 * np.exp(-al * (r - r0)))))
lo, hi = 0.88 * M["aExp"], 1.12 * M["aExp"]
grid = np.linspace(lo, hi, int(P.get("points", 49)))
E = np.array([energy(a) for a in grid])
write_csv("result.csv", ["a_angstrom", "volume_A3", "energy_eV"], [[float(a), float(a ** 3 / 4), float(e)] for a, e in zip(grid, E)])
# Golden-section search for the minimum, then curvature by central differences
g = (math.sqrt(5) - 1) / 2
x1, x2 = lo, hi
for _ in range(200):
    c, d = x2 - g * (x2 - x1), x1 + g * (x2 - x1)
    if energy(c) < energy(d): x2 = d
    else: x1 = c
a0 = (x1 + x2) / 2
h = 1e-3
V = lambda a: a ** 3 / 4
EV = lambda v: energy((4 * v) ** (1 / 3))
v0 = V(a0)
d2 = (EV(v0 + h) - 2 * EV(v0) + EV(v0 - h)) / (h * h)
B = v0 * d2 * 160.21766
summary({
    "model": "Morse pair potential, Girifalco & Weizer (1959); qualitative for elastic properties",
    "element": P["element"],
    "a0_angstrom": float(a0), "a_exp_angstrom": M["aExp"],
    "deviation_percent": float(100 * (a0 - M["aExp"]) / M["aExp"]),
    "cohesive_energy_eV": float(-energy(a0)), "bulk_modulus_GPa": float(B),
})
print("%s: a0 = %.4f A (experiment %.3f A), cohesive energy %.3f eV, bulk modulus %.0f GPa." % (P["element"], a0, M["aExp"], -energy(a0), B))
`;

export const LAB_ENGINES: readonly LabEngine[] = [
  {
    name: 'thin_film',
    domain: 'photonics',
    title: 'Thin-film stack / Bragg mirror',
    description:
      'Reflectance and transmission spectrum of a dielectric layer stack (transfer matrix, normal incidence). Give explicit layers [{material, thickness_nm}] or a quarter-wave Bragg mirror {high, low, pairs, center_nm}. Materials: ' +
      Object.keys(MATERIALS).join(', ') +
      ' or a refractive index.',
    params: z.object(stack).strict(),
    requires: [],
    check: 'thin_film_recomputed',
    checkDescription:
      'Every reflectance value is recomputed with an independent method (recursive Fresnel coefficients) and R + T = 1 holds for the lossless stack',
    body: THIN_FILM,
  },
  {
    name: 'ring_resonator',
    domain: 'photonics',
    title: 'Ring resonator',
    description:
      'Transmission of an all-pass microring: free spectral range, loaded Q, extinction, coupling regime and thermo-optic shift.',
    params: z
      .object({
        radius_um: z.number().min(1).max(5000).default(20),
        n_eff: z.number().min(1).max(4).default(2.4),
        n_g: z.number().min(1).max(6).default(4.2),
        loss_db_per_cm: z.number().min(0).max(100).default(2),
        // Near critical coupling for the default loss: a deep, narrow resonance.
        power_coupling: z.number().min(0.0001).max(0.9).default(0.006),
        center_nm: z.number().min(300).max(5000).default(1550),
        span_nm: z.number().min(0.1).max(200).default(20),
        points: z.number().int().min(201).max(40_001).default(8001),
        dn_dt: z.number().min(-1e-3).max(1e-3).default(1.8e-4),
        delta_t_k: z.number().min(-200).max(500).default(0),
      })
      .strict(),
    requires: [],
    check: 'ring_recomputed',
    checkDescription:
      'Free spectral range, extinction and Q are re-measured on the reported spectrum and compared with the claims',
    body: RING,
  },
  {
    name: 'stack_tolerance',
    domain: 'photonics',
    title: 'Fabrication tolerance (Monte Carlo)',
    description:
      'Monte Carlo over random layer-thickness errors of a stack: yield above a reflectance spec, spread of peak and centre wavelength.',
    params: z
      .object({
        ...stack,
        points: z.number().int().min(11).max(1001).default(301),
        sigma_nm: z.number().min(0).max(100).default(3),
        runs: z.number().int().min(10).max(500).default(200),
        min_reflectance: z.number().min(0).max(1).default(0.99),
        seed: z.number().int().min(0).max(1e9).default(1),
      })
      .strict(),
    requires: [],
    check: 'tolerance_recomputed',
    checkDescription: 'Yield, mean and spread are recomputed from the per-run results',
    body: TOLERANCE,
  },
  {
    name: 'quantum_circuit',
    domain: 'quantum',
    title: 'Quantum circuit',
    description:
      'Ideal state-vector simulation of up to 10 qubits. Circuit as text, e.g. "H 0; CX 0 1; RZ 1 0.5" (gates H X Y Z S T RX RY RZ P CX CZ SWAP), or preset "bell"/"ghz".',
    params: z
      .object({
        circuit: z.string().max(4000).optional(),
        preset: z.enum(['bell', 'ghz']).optional(),
        qubits: z.number().int().min(1).max(10).optional(),
      })
      .strict(),
    requires: [],
    check: 'quantum_recomputed',
    checkDescription:
      'All probabilities are recomputed with the full unitary matrix (a different method) and sum to one',
    body: QUANTUM,
  },
  {
    name: 'molecule',
    domain: 'chemistry',
    title: 'Molecule (RDKit)',
    description:
      'Descriptors (molecular weight, logP, TPSA, H-bond donors and acceptors) and an MMFF-minimised 3D structure from SMILES or a common name (' +
      Object.keys(MOLECULES).join(', ') +
      '). Needs the RDKit capability.',
    params: z
      .object({
        smiles: z.string().min(1).max(500).optional(),
        name: z.string().min(1).max(60).optional(),
        seed: z.number().int().min(0).max(1e9).default(42),
      })
      .strict(),
    requires: ['rdkit'],
    need: 'cheminformatics',
    check: 'molecule_mass_recomputed',
    checkDescription:
      'The molecular weight is recomputed from the atoms of the 3D structure with a separate table of atomic weights',
    body: MOLECULE,
  },
  {
    name: 'fcc_crystal',
    domain: 'materials',
    title: 'Crystal (fcc metal)',
    description:
      'Lattice constant, cohesive energy and bulk modulus of an fcc metal from a Morse pair potential (Girifalco & Weizer 1959): ' +
      Object.entries(MORSE)
        .map(([k, v]) => `${k} (${v.name})`)
        .join(', ') +
      '. Lattice constants are close to experiment by construction; elastic numbers are qualitative.',
    params: z
      .object({
        element: z.enum(Object.keys(MORSE) as [string, ...string[]]),
        points: z.number().int().min(15).max(201).default(49),
      })
      .strict(),
    requires: [],
    check: 'crystal_fit_recomputed',
    checkDescription:
      'The energy minimum and curvature are refitted from the reported energy curve with a separate method',
    body: CRYSTAL,
  },
];

const CAD_LIMITS = {
  timeoutMs: 600_000,
  memoryMb: 3072,
  maxOutputBytes: 400 * 1024 * 1024,
  maxOutputFiles: 40,
  tmpMb: 256,
};

(LAB_ENGINES as LabEngine[]).push(
  {
    name: 'turbofan',
    domain: 'cad',
    title: 'Jet engine (turbofan) CAD model',
    description:
      'Builds a complete two-spool turbofan as named B-rep solids: spinner, fan and outlet guide vanes, booster and high-pressure compressor (disks, rotor blades, stator vanes), annular combustor with fuel injectors, high- and low-pressure turbines, concentric shafts with bearings, casings, nacelle, exhaust and accessory gearbox. Exports a STEP assembly, meshes and a parts list. Needs the CAD kernel capability.',
    params: z
      .object({
        fan_diameter_mm: z.number().min(200).max(4000).default(1600),
        fan_blades: z.number().int().min(8).max(40).default(22),
        ogv_vanes: z.number().int().min(8).max(90).default(40),
        booster_stages: z.number().int().min(0).max(5).default(3),
        hpc_stages: z.number().int().min(1).max(14).default(9),
        hpt_stages: z.number().int().min(1).max(3).default(2),
        lpt_stages: z.number().int().min(1).max(7).default(4),
        injectors: z.number().int().min(6).max(40).default(20),
        mesh_mm: z.number().min(0.3).max(10).default(2),
      })
      .strict(),
    requires: ['ocp'],
    need: 'cad',
    check: 'cad_assembly_recomputed',
    checkDescription:
      'Parts, blades and unique names are recounted, every solid is valid, every mesh is closed, and each group volume is recomputed from its triangles within 3 % of the kernel',
    body: CAD_HELPERS + TURBOFAN + CAD_EPILOGUE,
    limits: CAD_LIMITS,
  },
  {
    name: 'cad_model',
    domain: 'cad',
    title: 'CAD model',
    description:
      'Runs Python CAD code on the OpenCascade kernel with helpers: cylinder(r, x0, length), tube(r_in, r_out, x0, length), cone(r0, r1, x0, length), box(dx, dy, dz, x, y, z), torus(R, r, x), blade(r_hub, r_tip, x, chord_hub, chord_tip, stagger_hub, stagger_tip), moved(shape, dx, dy, dz), rotated(shape, degrees), row(prefix, group, count, shape) for a full ring, polar(...), and part(name, group, shape) to add each named solid. The x axis is the main axis; units are mm. Set MODEL to a one-line description. Exports STEP, meshes and a parts list. Needs the CAD kernel capability.',
    params: z
      .object({
        code: z.string().min(1).max(60_000),
        mesh_mm: z.number().min(0.1).max(10).default(1),
      })
      .strict(),
    requires: ['ocp'],
    need: 'cad',
    check: 'cad_assembly_recomputed',
    checkDescription:
      'Parts and unique names are recounted, every solid is valid, every mesh is closed, and each group volume is recomputed from its triangles within 3 % of the kernel',
    body:
      CAD_HELPERS +
      'MODEL = "CAD model written by a bot"\nexec(compile(P["code"], "model.py", "exec"))\n' +
      CAD_EPILOGUE,
    limits: CAD_LIMITS,
  },
);

(LAB_ENGINES as LabEngine[]).push(...ROCKET_ENGINES, DESIGN_ENGINE, PCB_ENGINE, PCB_RECHECK_ENGINE);

export const getLabEngine = (name: string): LabEngine | undefined =>
  LAB_ENGINES.find((e) => e.name === name);

/** The program for an engine, or the validation error for its params. */
export function buildLabCode(
  engine: LabEngine,
  params: unknown,
  capabilityPaths: readonly string[] = [],
): { code: string; params: Record<string, unknown> } | { error: string } {
  const parsed = engine.params.safeParse(params ?? {});
  if (!parsed.success)
    return { error: `Invalid params for ${engine.name}: ${parsed.error.message}` };
  return { code: labPrelude(parsed.data, capabilityPaths) + engine.body, params: parsed.data };
}
