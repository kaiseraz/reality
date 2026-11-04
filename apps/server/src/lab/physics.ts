import { z } from 'zod';
import type { Check } from '../verification/checks.ts';
import type { LabEngine } from './engines.ts';

/**
 * Simulations in the fields an engineering team runs every day: structures (finite elements),
 * heat (conduction with convection), fluids (incompressible flow) and electromagnetics
 * (electrostatics of a transmission line). numpy only, so they run in the plain sandbox.
 * Each is checked against something it does not compute itself: beam theory, Heywood's
 * stress concentration, the fin equation, Ghia, Ghia & Shin's benchmark, Hammerstad-Jensen.
 */

/* ---------------------------------------------------------------- structures (FEM) ---- */

/*
 * Plane stress with quadratic triangles (6 nodes): bending is right without locking.
 * The mesh is a structured grid of quadratic nodes, mapped onto the shape, each cell split
 * into two triangles. Element rows carry their corners and centroid stresses; node rows
 * carry displacements. One file, a "kind" column tells them apart.
 */
const FEA = `
case = P["case"]
E = float(P["e_gpa"]) * 1e3            # N/mm^2
nu = float(P["poisson"])
t = float(P["thickness_mm"])
D = E / (1 - nu * nu) * np.array([[1, nu, 0], [nu, 1, 0], [0, 0, (1 - nu) / 2]])

if case == "cantilever":
    L, H = float(P["length_mm"]), float(P["height_mm"])
    nx, ny = int(P["cells_x"]), int(P["cells_y"])
    def place(s, r):          # s along the length, r through the height, both 0..1
        return (s * L, r * H)
else:
    W = float(P["width_mm"]); a = W / 2; R = float(P["hole_diameter_mm"]) / 2
    b = float(P["plate_length_mm"]) / 2      # half the length, along the load
    corner = math.atan2(a, b)
    nx, ny = int(P["cells_radial"]), int(P["cells_around"])
    # the corner of the quarter falls on a node: so many cells around it go to the loaded end
    loaded = max(1, min(ny - 1, round(ny * corner / (math.pi / 2))))
    split = loaded / ny
    def place(s, r):          # s from the hole outwards, r around the quarter
        th = r / split * corner if r <= split else corner + (r - split) / (1 - split) * (math.pi / 2 - corner)
        inner = (R * math.cos(th), R * math.sin(th))
        # the outer edge of the quarter: the loaded end (x = b) up to the corner, then the side (y = a)
        outer = (b, b * math.tan(th)) if th <= corner else (a / math.tan(th), a)
        g = s ** 1.6          # finer near the hole, where the stress peaks
        return (inner[0] + g * (outer[0] - inner[0]), inner[1] + g * (outer[1] - inner[1]))

GX, GY = 2 * nx + 1, 2 * ny + 1
nid = lambda i, j: i * GY + j
XY = np.zeros((GX * GY, 2))
for i in range(GX):
    for j in range(GY):
        XY[nid(i, j)] = place(i / (GX - 1), j / (GY - 1))
tris = []
for ci in range(nx):
    for cj in range(ny):
        i, j = 2 * ci, 2 * cj
        a0, b0, c0, d0 = nid(i, j), nid(i + 2, j), nid(i + 2, j + 2), nid(i, j + 2)
        tris.append([a0, b0, c0, nid(i + 1, j), nid(i + 2, j + 1), nid(i + 1, j + 1)])
        tris.append([a0, c0, d0, nid(i + 1, j + 1), nid(i + 1, j + 2), nid(i, j + 1)])
tris = np.array(tris)

# Quadratic triangle: shape function derivatives at a point (L1, L2), L3 = 1 - L1 - L2
def dN(l1, l2):
    l3 = 1 - l1 - l2
    dl1 = [4 * l1 - 1, 0, -(4 * l3 - 1), 4 * l2, -4 * l2, 4 * (l3 - l1)]
    dl2 = [0, 4 * l2 - 1, -(4 * l3 - 1), 4 * l1, 4 * (l3 - l2), -4 * l1]
    return np.array([dl1, dl2])
GAUSS = [(1 / 6, 1 / 6, 1 / 6), (2 / 3, 1 / 6, 1 / 6), (1 / 6, 2 / 3, 1 / 6)]
# corner order of the shape functions: 1 = L1, 2 = L2, 3 = L3; mid nodes 12, 23, 31
ORDER = [0, 1, 2, 3, 4, 5]
def bmat(xy, l1, l2):
    d = dN(l1, l2)
    J = d @ xy
    det = np.linalg.det(J)
    dxy = np.linalg.solve(J, d)
    B = np.zeros((3, 12))
    B[0, 0::2] = dxy[0]; B[1, 1::2] = dxy[1]; B[2, 0::2] = dxy[1]; B[2, 1::2] = dxy[0]
    return B, det

ndof = 2 * len(XY)
K = np.zeros((ndof, ndof))
for tri in tris:
    xy = XY[tri]
    ke = np.zeros((12, 12))
    for l1, l2, w in GAUSS:
        B, det = bmat(xy, l1, l2)
        ke += B.T @ D @ B * det * w * t
    dofs = np.ravel([[2 * n, 2 * n + 1] for n in tri])
    K[np.ix_(dofs, dofs)] += ke

F = np.zeros(ndof)
fixed = []
def edge_load(nodes, tx, ty):
    # consistent loads of a uniform traction on a quadratic edge: 1/6, 4/6, 1/6 of its length
    p0, pm, p1 = XY[nodes[0]], XY[nodes[1]], XY[nodes[2]]
    length = math.dist(p0, pm) + math.dist(pm, p1)
    for n, share in zip(nodes, (1 / 6, 4 / 6, 1 / 6)):
        F[2 * n] += tx * length * t * share; F[2 * n + 1] += ty * length * t * share

if case == "cantilever":
    P_load = float(P["load_n"])
    for j in range(GY):
        fixed += [2 * nid(0, j), 2 * nid(0, j) + 1]
    for k in range(ny):
        edge_load([nid(GX - 1, 2 * k), nid(GX - 1, 2 * k + 1), nid(GX - 1, 2 * k + 2)], 0, -P_load / (H * t))
else:
    S = float(P["stress_mpa"])
    for i in range(GX):
        fixed.append(2 * nid(i, 0) + 1)          # y = 0: symmetric, no vertical movement
        fixed.append(2 * nid(i, GY - 1))         # x = 0: symmetric, no horizontal movement
    for k in range(ny):
        e = [nid(GX - 1, 2 * k), nid(GX - 1, 2 * k + 1), nid(GX - 1, 2 * k + 2)]
        if all(abs(XY[n][0] - b) < 1e-9 for n in e):
            edge_load(e, S, 0)

free = np.setdiff1d(np.arange(ndof), np.array(sorted(set(fixed))))
U = np.zeros(ndof)
U[free] = np.linalg.solve(K[np.ix_(free, free)], F[free])

def stress_at(tri, l1, l2):
    B, _ = bmat(XY[tri], l1, l2)
    dofs = np.ravel([[2 * n, 2 * n + 1] for n in tri])
    return D @ (B @ U[dofs])
vm = lambda s: math.sqrt(s[0] ** 2 - s[0] * s[1] + s[1] ** 2 + 3 * s[2] ** 2)

rows = []
for tri in tris:
    s = stress_at(tri, 1 / 3, 1 / 3)
    c = XY[tri[:3]]
    rows.append(["element", *[round(float(v), 5) for v in c.ravel()], round(vm(s), 5), round(float(s[0]), 5), round(float(s[1]), 5), round(float(s[2]), 5)])
for n, (x, y) in enumerate(XY):
    rows.append(["node", round(float(x), 5), round(float(y), 5), "", "", "", "", round(float(U[2 * n]), 8), round(float(U[2 * n + 1]), 8), "", ""])
write_csv("result.csv", ["kind", "x1", "y1", "x2", "y2", "x3", "y3", "v1", "v2", "v3", "v4"], rows)

# Stress at a node: each element's value there, averaged (quadratic triangles are linear in stress)
CORNER = {0: (1, 0), 1: (0, 1), 2: (0, 0)}
def nodal_stress(n):
    found = []
    for tri in tris:
        for k in range(3):
            if tri[k] == n:
                found.append(stress_at(tri, *CORNER[k]))
    return np.mean(found, axis=0)

vms = [r[7] for r in rows if r[0] == "element"]
out = {"model": "plane stress, quadratic triangles (6 nodes), %d elements, %d nodes" % (len(tris), len(XY)),
       "case": case, "elements": len(tris), "nodes": len(XY),
       "max_von_mises_mpa": float(max(vms))}
if case == "cantilever":
    I = t * H ** 3 / 12; G = E / (2 * (1 + nu)); A = t * H
    tip = U[2 * nid(GX - 1, ny) + 1]
    out.update({"tip_deflection_mm": float(-tip),
                "beam_theory_mm": P_load * L ** 3 / (3 * E * I) + P_load * L / (5 / 6 * G * A),
                "root_stress_beam_mpa": P_load * L * (H / 2) / I})
else:
    peak = nodal_stress(nid(0, GY - 1))       # top of the hole, (0, R)
    net = S * a / (a - R)
    out.update({"peak_stress_mpa": float(peak[0]), "net_stress_mpa": net,
                "kt_net": float(peak[0] / net), "kt_gross": float(peak[0] / S)})
summary(out)
print("%s: %d elements, max von Mises %.1f MPa" % (case, len(tris), max(vms)))
`;

/* ----------------------------------------------------------------------- heat (fin) ---- */

/*
 * A straight fin in two dimensions (length x thickness), finite differences: the base held at
 * a temperature, convection to the air on both faces and the tip, conduction inside. The
 * heat it sheds is what it is for.
 */
const FIN = `
L = float(P["length_mm"]) / 1e3; th = float(P["thickness_mm"]) / 1e3
k = float(P["conductivity_w_mk"]); h = float(P["h_w_m2k"])
Tb, Ta = float(P["base_c"]), float(P["air_c"])
nx, ny = int(P["cells_length"]), int(P["cells_thickness"])
dx, dy = L / nx, th / ny
NX, NY = nx + 1, ny + 1
idx = lambda i, j: i * NY + j
A = np.zeros((NX * NY, NX * NY)); b = np.zeros(NX * NY)
# Energy balance of each node's control volume (half or quarter cells on the faces).
for i in range(NX):
    for j in range(NY):
        n = idx(i, j)
        if i == 0:
            A[n, n] = 1; b[n] = Tb; continue
        wx = dy * (0.5 if j in (0, NY - 1) else 1.0)     # face through which heat flows in x
        wy = dx * (0.5 if i == NX - 1 else 1.0)          # face through which heat flows in y
        for di, dj, cond in ((-1, 0, k * wx / dx), (1, 0, k * wx / dx), (0, -1, k * wy / dy), (0, 1, k * wy / dy)):
            ii, jj = i + di, j + dj
            if 0 <= ii < NX and 0 <= jj < NY:
                A[n, idx(ii, jj)] -= cond; A[n, n] += cond
        conv = 0.0
        if j in (0, NY - 1): conv += h * wy             # top or bottom face to the air
        if i == NX - 1: conv += h * wx                  # the tip to the air
        A[n, n] += conv; b[n] += conv * Ta
T = np.linalg.solve(A, b).reshape(NX, NY)
# Heat leaving the fin = heat convected from all its faces (per metre of fin depth)
q_conv = 0.0
for i in range(1, NX):
    for j in (0, NY - 1):
        q_conv += h * dx * (0.5 if i == NX - 1 else 1.0) * (T[i, j] - Ta)
for j in range(NY):
    q_conv += h * dy * (0.5 if j in (0, NY - 1) else 1.0) * (T[NX - 1, j] - Ta)
# ... and the heat through the base (first column of cells), a second figure for the same thing
q_base = sum(k * dy * (0.5 if j in (0, NY - 1) else 1.0) * (T[0, j] - T[1, j]) / dx for j in range(NY))
q_ideal = h * (2 * L + th) * (Tb - Ta)
rows = [[round(i * dx * 1e3, 5), round(j * dy * 1e3, 5), round(float(T[i, j]), 6)] for i in range(NX) for j in range(NY)]
write_csv("result.csv", ["x_mm", "y_mm", "t_c"], rows)
summary({"model": "2D steady conduction with convection on the faces and the tip, finite volumes (%d x %d)" % (nx, ny),
         "heat_w_per_m": q_conv, "heat_through_base_w_per_m": q_base, "efficiency": q_conv / q_ideal,
         "tip_c": float(T[NX - 1, NY // 2]), "biot": h * th / (2 * k)})
print("fin sheds %.2f W per metre of depth, efficiency %.3f" % (q_conv, q_conv / q_ideal))
`;

/* --------------------------------------------------------------------- fluids (CFD) ---- */

/*
 * Lid-driven cavity: the classic test of an incompressible flow solver. Stream function and
 * vorticity on a uniform grid, explicit time stepping to steady state, the Poisson equation
 * solved exactly each step with a sine transform (via the FFT).
 */
const CAVITY = `
Re = float(P["reynolds"]); N = int(P["grid"])
h = 1.0 / (N - 1); n = N - 2
lam = (2 * np.cos(np.pi * np.arange(1, n + 1) / (n + 1)) - 2) / h ** 2
def dst(x, axis):
    # DST-I along an axis via the FFT of the odd extension
    x = np.moveaxis(x, axis, -1)
    z = np.zeros(x.shape[:-1] + (1,))
    ext = np.concatenate([z, x, z, -x[..., ::-1]], axis=-1)
    y = -np.fft.fft(ext, axis=-1).imag[..., 1:n + 1] / 2
    return np.moveaxis(y, -1, axis)
def poisson(rhs):          # solves lap(psi) = rhs inside, psi = 0 on the walls
    r = dst(dst(rhs, 0), 1)
    r = r / (lam[:, None] + lam[None, :])
    return dst(dst(r, 0), 1) * (2 / (n + 1)) ** 2
psi = np.zeros((N, N)); w = np.zeros((N, N))      # index [i, j] = (x, y)
dt = 0.8 * min(0.25 * h * h * Re, 0.5 * h)
steps = 0; change = 1.0
while steps < int(P["max_steps"]):
    # wall vorticity (Thom): lid at the top moves with u = 1
    w[:, -1] = -2 * psi[:, -2] / h ** 2 - 2 / h
    w[:, 0] = -2 * psi[:, 1] / h ** 2
    w[0, :] = -2 * psi[1, :] / h ** 2
    w[-1, :] = -2 * psi[-2, :] / h ** 2
    u = (psi[1:-1, 2:] - psi[1:-1, :-2]) / (2 * h)
    v = -(psi[2:, 1:-1] - psi[:-2, 1:-1]) / (2 * h)
    wx = (w[2:, 1:-1] - w[:-2, 1:-1]) / (2 * h)
    wy = (w[1:-1, 2:] - w[1:-1, :-2]) / (2 * h)
    lap = (w[2:, 1:-1] + w[:-2, 1:-1] + w[1:-1, 2:] + w[1:-1, :-2] - 4 * w[1:-1, 1:-1]) / h ** 2
    dw = dt * (-u * wx - v * wy + lap / Re)
    w[1:-1, 1:-1] += dw
    psi[1:-1, 1:-1] = poisson(-w[1:-1, 1:-1])
    steps += 1
    if steps % 200 == 0:
        change = float(np.abs(dw).max() / dt)
        if change < float(P["tolerance"]): break
U = np.zeros((N, N)); V = np.zeros((N, N))
U[:, -1] = 1.0
U[1:-1, 1:-1] = (psi[1:-1, 2:] - psi[1:-1, :-2]) / (2 * h)
V[1:-1, 1:-1] = -(psi[2:, 1:-1] - psi[:-2, 1:-1]) / (2 * h)
stride = 1 if N <= 70 else (N - 1) // 64
keep = list(range(0, N, stride))
if keep[-1] != N - 1: keep.append(N - 1)
rows = [[round(i * h, 6), round(j * h, 6), round(float(U[i, j]), 6), round(float(V[i, j]), 6), round(float(psi[i, j]), 8)] for i in keep for j in keep]
write_csv("result.csv", ["x", "y", "u", "v", "psi"], rows)
mid = N // 2
ys = [j * h for j in range(N)]
center = list(U[mid, :])
GHIA_Y = [0.0, 0.0547, 0.0625, 0.0703, 0.1016, 0.1719, 0.2813, 0.4531, 0.5, 0.6172, 0.7344, 0.8516, 0.9531, 0.9609, 0.9688, 0.9766, 1.0]
k = np.unravel_index(np.argmin(psi), psi.shape)
summary({"model": "stream function and vorticity, %d x %d grid, central differences, explicit to steady state" % (N, N),
         "reynolds": Re, "grid": N, "steps": steps, "residual": change, "converged": change < float(P["tolerance"]),
         "u_centerline": [[y, float(np.interp(y, ys, center))] for y in GHIA_Y],
         "psi_min": float(psi[k]), "vortex_x": float(k[0] * h), "vortex_y": float(k[1] * h)})
print("Re %.0f on %d x %d: steady after %d steps, primary vortex at (%.3f, %.3f), psi %.5f" % (Re, N, N, steps, k[0] * h, k[1] * h, psi[k]))
`;

/* -------------------------------------------------------- electromagnetics (microstrip) ---- */

/*
 * A microstrip line: a strip of copper over a ground plane, separated by a dielectric. The
 * 2D electrostatic field is solved twice, with and without the dielectric; the charge on the
 * strip gives the capacitances, and from them the impedance and effective permittivity.
 */
const MICROSTRIP = `
W, Hs, T = float(P["width_mm"]), float(P["substrate_mm"]), float(P["copper_mm"])
er = float(P["permittivity"])
cell = Hs / int(P["cells_per_substrate"])
# the walls far enough away that the field without the substrate, which spreads most, barely feels them
box_w, box_h = W + 20 * Hs, 16 * Hs
nx, ny = int(round(box_w / cell)), int(round(box_h / cell))
X = (np.arange(nx + 1) - nx / 2) * cell
Y = np.arange(ny + 1) * cell
xx, yy = np.meshgrid(X, Y, indexing="ij")
strip = (np.abs(xx) <= W / 2 + 1e-12) & (yy >= Hs - 1e-12) & (yy <= Hs + T + 1e-12)  # copper thinner than a cell is one row of nodes
def solve(eps_sub):
    # permittivity of each cell face, by where the face lies: a vertical face (between two
    # nodes of a row) on the substrate's top surface is half in it; a horizontal face lies
    # wholly in the substrate or the air
    row = np.where(Y < Hs - 1e-9, eps_sub, np.where(Y < Hs + 1e-9, (eps_sub + 1) / 2, 1.0))
    ex = np.tile(row, (nx, 1))
    mid = (Y[:-1] + Y[1:]) / 2
    ey = np.tile(np.where(mid < Hs, eps_sub, 1.0), (nx + 1, 1))
    phi = np.where(strip, 1.0, 0.0)
    fixed = strip.copy(); fixed[:, 0] = True; fixed[0, :] = True; fixed[-1, :] = True; fixed[:, -1] = True
    free = ~fixed
    omega = 1.9
    for it in range(int(P["max_iterations"])):
        old = phi.copy()
        for colour in (0, 1):
            m = free & (((np.arange(nx + 1)[:, None] + np.arange(ny + 1)[None, :]) % 2) == colour)
            num = np.zeros_like(phi); den = np.zeros_like(phi)
            num[1:, :] += ex * phi[:-1, :]; den[1:, :] += ex
            num[:-1, :] += ex * phi[1:, :]; den[:-1, :] += ex
            num[:, 1:] += ey * phi[:, :-1]; den[:, 1:] += ey
            num[:, :-1] += ey * phi[:, 1:]; den[:, :-1] += ey
            new = num / np.where(den == 0, 1, den)
            phi[m] = phi[m] + omega * (new[m] - phi[m])
        if it % 50 == 0 and np.abs(phi - old).max() < float(P["tolerance"]):
            break
    # charge on the strip = flux leaving it (per metre, eps0 = 8.854e-12, a 1 V strip)
    q = 0.0
    for (i, j) in zip(*np.where(strip)):
        for di, dj, e in ((1, 0, ex[i, j] if i < nx else 0), (-1, 0, ex[i - 1, j] if i > 0 else 0), (0, 1, ey[i, j] if j < ny else 0), (0, -1, ey[i, j - 1] if j > 0 else 0)):
            ii, jj = i + di, j + dj
            if 0 <= ii <= nx and 0 <= jj <= ny and not strip[ii, jj]:
                q += e * (phi[i, j] - phi[ii, jj])
    return q * 8.854187817e-12, phi, it
C, phi, it1 = solve(er)
C0, _, it2 = solve(1.0)
c = 299792458.0
z0 = 1 / (c * math.sqrt(C * C0)); eeff = C / C0
step = max(1, (nx + 1) // 120)
rows = [[round(float(X[i]), 5), round(float(Y[j]), 5), round(float(phi[i, j]), 6)] for i in range(0, nx + 1, step) for j in range(0, ny + 1, step)]
write_csv("result.csv", ["x_mm", "y_mm", "potential_v"], rows)
summary({"model": "2D electrostatics, finite differences on a %d x %d grid, with and without the dielectric" % (nx, ny),
         "impedance_ohm": z0, "effective_permittivity": eeff, "capacitance_pf_per_m": C * 1e12,
         "iterations": [it1, it2]})
print("microstrip %.2f mm on %.2f mm, er %.2f: Z0 %.2f ohm, eps_eff %.3f" % (W, Hs, er, z0, eeff))
`;

export const PHYSICS_ENGINES: LabEngine[] = [
  {
    name: 'structural_fea',
    domain: 'mechanics',
    title: 'Structural FEA (plane stress)',
    description:
      'Finite-element stress analysis in plane stress with quadratic triangles: a cantilever under a tip load (deflection and bending stress) or a plate with a hole in tension (stress concentration). Gives the stress field, von Mises stress and displacements.',
    params: z
      .object({
        case: z.enum(['cantilever', 'plate_hole']).default('cantilever'),
        e_gpa: z.number().min(0.001).max(1500).default(210),
        poisson: z.number().min(0).max(0.49).default(0.3),
        thickness_mm: z.number().min(0.01).max(1e4).default(10),
        length_mm: z.number().min(1).max(1e5).default(1000),
        height_mm: z.number().min(0.1).max(1e4).default(100),
        load_n: z.number().min(0.001).max(1e9).default(1000),
        cells_x: z.number().int().min(4).max(60).default(40),
        cells_y: z.number().int().min(2).max(16).default(6),
        width_mm: z.number().min(1).max(1e5).default(200),
        hole_diameter_mm: z.number().min(0.1).max(1e5).default(40),
        plate_length_mm: z.number().min(1).max(1e5).default(400),
        stress_mpa: z.number().min(0.001).max(1e5).default(100),
        cells_radial: z.number().int().min(4).max(30).default(16),
        cells_around: z.number().int().min(4).max(40).default(20),
      })
      .strict()
      .refine(
        (p) => p.hole_diameter_mm < 0.8 * Math.min(p.width_mm, p.plate_length_mm),
        'The hole must be smaller than the plate',
      ),
    requires: [],
    check: 'fea_recomputed',
    checkDescription:
      'The stress field is compared with theory it was not computed from: beam bending stress along the cantilever and its deflection (Timoshenko), or equilibrium across the plate and the stress concentration of a hole (Heywood)',
    body: FEA,
    limits: { timeoutMs: 300_000, memoryMb: 1536 },
  },
  {
    name: 'heat_fin',
    domain: 'thermal',
    title: 'Heat transfer: cooling fin',
    description:
      'Steady 2D conduction in a straight fin with convection on its faces and tip (finite volumes): temperature field, heat shed per metre of depth, fin efficiency and tip temperature.',
    params: z
      .object({
        length_mm: z.number().min(0.5).max(5000).default(40),
        thickness_mm: z.number().min(0.05).max(500).default(2),
        conductivity_w_mk: z.number().min(0.01).max(5000).default(200),
        h_w_m2k: z.number().min(0.1).max(1e5).default(50),
        base_c: z.number().min(-200).max(3000).default(80),
        air_c: z.number().min(-200).max(3000).default(20),
        cells_length: z.number().int().min(10).max(300).default(160),
        cells_thickness: z.number().int().min(2).max(40).default(8),
      })
      .strict(),
    requires: [],
    check: 'fin_recomputed',
    checkDescription:
      'The heat shed is recomputed from the reported temperatures (convection over the surface and conduction through the base must agree) and compared with the fin equation with a corrected tip',
    body: FIN,
  },
  {
    name: 'cavity_flow',
    domain: 'fluids',
    title: 'CFD: lid-driven cavity',
    description:
      'Incompressible 2D flow in a square cavity whose lid moves (stream function and vorticity, solved to steady state): velocity field, stream function, the primary vortex and the velocity profile on the centre line. Reynolds number 10 to 1000.',
    params: z
      .object({
        reynolds: z.number().min(10).max(1000).default(100),
        grid: z.number().int().min(33).max(161).default(65),
        max_steps: z.number().int().min(100).max(200_000).default(60_000),
        tolerance: z.number().min(1e-8).max(1).default(1e-4),
      })
      .strict(),
    requires: [],
    check: 'cavity_recomputed',
    checkDescription:
      'The centre-line velocity is compared with the benchmark of Ghia, Ghia & Shin (1982), and mass conservation and the reported vortex are recomputed from the velocity field',
    body: CAVITY,
    limits: { timeoutMs: 600_000, memoryMb: 1024 },
  },
  {
    name: 'microstrip',
    domain: 'electronics',
    title: 'Electromagnetics: microstrip line',
    description:
      'Characteristic impedance and effective permittivity of a microstrip line from a 2D electrostatic field solution (finite differences, with and without the substrate), with the potential field.',
    params: z
      .object({
        width_mm: z.number().min(0.01).max(100).default(3),
        substrate_mm: z.number().min(0.01).max(50).default(1.6),
        copper_mm: z.number().min(0).max(1).default(0.035),
        permittivity: z.number().min(1).max(100).default(4.4),
        cells_per_substrate: z.number().int().min(4).max(40).default(16),
        max_iterations: z.number().int().min(100).max(100_000).default(20_000),
        tolerance: z.number().min(1e-9).max(1e-2).default(1e-5),
      })
      .strict(),
    requires: [],
    check: 'microstrip_recomputed',
    checkDescription:
      'Impedance and effective permittivity are compared with the closed-form Hammerstad-Jensen formulas, which the field solution does not use',
    body: MICROSTRIP,
    limits: { timeoutMs: 600_000 },
  },
];

/* ------------------------------------------------------------------------- checks ------ */

const params = z.object({ step: z.string() }).passthrough() as unknown as z.ZodType<
  Record<string, unknown>
>;

export const PHYSICS_CHECKS: Check[] = [
  {
    name: 'fea_recomputed',
    description:
      'Checks a plane-stress FEA against theory: for a cantilever the bending stress of every element in the middle of the span and the tip deflection (Euler-Bernoulli plus shear); for a plate with a hole, force equilibrium across the section through the hole and the stress concentration (Heywood).',
    params,
    needsResult: true,
    needsData: false,
    body: `
data = rows("/input/result.csv")
els = [r for r in data if r["kind"] == "element"]
nodes = [r for r in data if r["kind"] == "node"]
claim = CLAIM or {}
mismatches = []
E = num(P.get("e_gpa", 210)) * 1e3; nu = num(P.get("poisson", 0.3)); t = num(P.get("thickness_mm", 10))
case = P.get("case", "cantilever")
centroid = lambda r: ((num(r["x1"]) + num(r["x2"]) + num(r["x3"])) / 3, (num(r["y1"]) + num(r["y2"]) + num(r["y3"])) / 3)
if case == "cantilever":
    L, H, Pl = num(P.get("length_mm", 1000)), num(P.get("height_mm", 100)), num(P.get("load_n", 1000))
    I = t * H ** 3 / 12
    errs = []
    for r in els:
        x, y = centroid(r)
        if 0.3 * L <= x <= 0.7 * L and abs(y - H / 2) > 0.2 * H:
            beam = Pl * (L - x) * (y - H / 2) / I
            errs.append(abs(num(r["v2"]) - beam) / abs(beam))
    worst = max(errs) if errs else 1.0
    if not errs or sum(errs) / len(errs) > 0.03:
        mismatches.append({"problem": "bending stress", "mean_error": sum(errs) / max(1, len(errs)), "elements": len(errs)})
    G = E / (2 * (1 + nu)); A = t * H
    theory = Pl * L ** 3 / (3 * E * I) + Pl * L / (5 / 6 * G * A)
    tip = [r for r in nodes if abs(num(r["x1"]) - L) < 1e-6 * L and abs(num(r["y1"]) - H / 2) < 1e-6 * H]
    dtip = -num(tip[0]["v2"]) if tip else 0.0
    if abs(dtip - theory) > 0.03 * theory:
        mismatches.append({"problem": "tip deflection", "fea_mm": dtip, "beam_theory_mm": theory})
    if abs(num(claim.get("tip_deflection_mm")) - dtip) > 1e-6 * max(1, dtip):
        mismatches.append({"problem": "claimed deflection", "claimed": claim.get("tip_deflection_mm"), "field": dtip})
    note = "%d elements against beam theory (mean error %.2f %%), tip %.4f mm vs %.4f mm" % (len(errs), 100 * sum(errs) / max(1, len(errs)), dtip, theory)
    checked = len(errs) + 1
else:
    W, S, d = num(P.get("width_mm", 200)), num(P.get("stress_mpa", 100)), num(P.get("hole_diameter_mm", 40))
    a, R = W / 2, d / 2
    # Equilibrium: the elements in the first column above the hole carry the whole load across x = 0
    col = []
    for r in els:
        xs = [num(r["x1"]), num(r["x2"]), num(r["x3"])]
        if min(xs) < 1e-6 * a:
            ys = [num(r["y1"]), num(r["y2"]), num(r["y3"])]
            col.append((min(ys), max(ys), num(r["v2"])))
    force = 0.0
    seen = sorted(col)
    # one element per strip of height: the strips overlap in pairs, so integrate over unique heights
    cuts = sorted(set([R] + [c[0] for c in seen] + [c[1] for c in seen] + [a]))
    for lo, hi in zip(cuts[:-1], cuts[1:]):
        mid = (lo + hi) / 2
        inside = [c[2] for c in seen if c[0] <= mid <= c[1]]
        if inside: force += sum(inside) / len(inside) * (hi - lo)
    applied = S * a
    if abs(force - applied) > 0.04 * applied:
        mismatches.append({"problem": "equilibrium across the hole", "carried_n_per_mm": force, "applied": applied})
    kt = num(claim.get("kt_net"))
    heywood = 2 + (1 - d / W) ** 3
    if abs(kt - heywood) > 0.06 * heywood:
        mismatches.append({"problem": "stress concentration", "fea_kt_net": kt, "heywood": heywood})
    peak_el = max(num(r["v2"]) for r in els)
    if not (0.6 * num(claim.get("peak_stress_mpa")) <= peak_el <= 1.05 * num(claim.get("peak_stress_mpa"))):
        mismatches.append({"problem": "claimed peak against the field", "peak_element": peak_el, "claimed": claim.get("peak_stress_mpa")})
    note = "load across the section %.1f of %.1f N/mm, Kt (net) %.3f vs Heywood %.3f" % (force, applied, kt, heywood)
    checked = len(col) + 2
verdict(not mismatches, checked, 0.0, mismatches, note)
`,
  },
  {
    name: 'fin_recomputed',
    description:
      'Recomputes the heat a fin sheds from its reported temperature field (convection from every face, and conduction through the base, which must agree) and compares it with the fin equation with a corrected tip length.',
    params,
    needsResult: true,
    needsData: false,
    body: `
data = [(num(r["x_mm"]), num(r["y_mm"]), num(r["t_c"])) for r in rows("/input/result.csv")]
claim = CLAIM or {}
mismatches = []
L = num(P.get("length_mm", 40)) / 1e3; th = num(P.get("thickness_mm", 2)) / 1e3
k = num(P.get("conductivity_w_mk", 200)); h = num(P.get("h_w_m2k", 50))
Tb, Ta = num(P.get("base_c", 80)), num(P.get("air_c", 20))
xs = sorted(set(round(x, 5) for x, _, _ in data)); ys = sorted(set(round(y, 5) for _, y, _ in data))
T = {(round(x, 5), round(y, 5)): v for x, y, v in data}
# convection: trapezoid rule along both faces and across the tip, from the reported field
def face(y):
    pts = [(x / 1e3, T[(x, y)] - Ta) for x in xs]
    return sum((b[0] - a[0]) * (a[1] + b[1]) / 2 for a, b in zip(pts[:-1], pts[1:]))
tip = [(y / 1e3, T[(xs[-1], y)] - Ta) for y in ys]
q_conv = h * (face(ys[0]) + face(ys[-1]) + sum((b[0] - a[0]) * (a[1] + b[1]) / 2 for a, b in zip(tip[:-1], tip[1:])))
# conduction through the base from the first two columns
dx = (xs[1] - xs[0]) / 1e3
grad = [(y / 1e3, (T[(xs[0], y)] - T[(xs[1], y)]) / dx) for y in ys]
q_base = k * sum((b[0] - a[0]) * (a[1] + b[1]) / 2 for a, b in zip(grad[:-1], grad[1:]))
if abs(q_conv - q_base) > 0.03 * abs(q_conv):
    mismatches.append({"problem": "energy balance", "convected": q_conv, "through_base": q_base})
m = math.sqrt(2 * h / (k * th)); Lc = L + th / 2
q_fin = math.sqrt(2 * h * k * th) * (Tb - Ta) * math.tanh(m * Lc)
biot = h * th / (2 * k)
if biot < 0.1 and abs(q_conv - q_fin) > 0.03 * abs(q_fin):
    mismatches.append({"problem": "fin equation", "field": q_conv, "fin_equation": q_fin})
if abs(num(claim.get("heat_w_per_m")) - q_conv) > 0.03 * abs(q_conv):
    mismatches.append({"problem": "claimed heat", "claimed": claim.get("heat_w_per_m"), "from_field": q_conv})
verdict(not mismatches, len(data), 0.0, mismatches,
        "heat from the field %.2f W/m (base %.2f), fin equation %.2f W/m, Biot %.3f" % (q_conv, q_base, q_fin, biot))
`,
  },
  {
    name: 'cavity_recomputed',
    description:
      'Compares the centre-line velocity of a lid-driven cavity with the benchmark of Ghia, Ghia & Shin (1982, J. Comput. Phys. 48, Table I) and recomputes mass conservation and the primary vortex from the velocity field.',
    params,
    needsResult: true,
    needsData: false,
    body: `
# Ghia, Ghia & Shin (1982), Table I: u on the vertical centre line
GHIA_Y = [0.0, 0.0547, 0.0625, 0.0703, 0.1016, 0.1719, 0.2813, 0.4531, 0.5, 0.6172, 0.7344, 0.8516, 0.9531, 0.9609, 0.9688, 0.9766, 1.0]
GHIA_U = {
    100: [0.0, -0.03717, -0.04192, -0.04775, -0.06434, -0.10150, -0.15662, -0.21090, -0.20581, -0.13641, 0.00332, 0.23151, 0.68717, 0.73722, 0.78871, 0.84123, 1.0],
    400: [0.0, -0.08186, -0.09266, -0.10338, -0.14612, -0.24299, -0.32726, -0.17119, -0.11477, 0.02135, 0.16256, 0.29093, 0.55892, 0.61756, 0.68439, 0.75837, 1.0],
    1000: [0.0, -0.18109, -0.20196, -0.22220, -0.29730, -0.38289, -0.27805, -0.10648, -0.06080, 0.05702, 0.18719, 0.33304, 0.46604, 0.51117, 0.57492, 0.65928, 1.0],
}
data = [(num(r["x"]), num(r["y"]), num(r["u"]), num(r["v"]), num(r["psi"])) for r in rows("/input/result.csv")]
claim = CLAIM or {}
mismatches = []
Re = num(P.get("reynolds", 100))
xs = sorted(set(round(d[0], 6) for d in data))
grid = {(round(d[0], 6), round(d[1], 6)): d for d in data}
xmid = min(xs, key=lambda x: abs(x - 0.5))
line = sorted((d[1], d[2]) for d in data if round(d[0], 6) == xmid)
def interp(y):
    for (y0, u0), (y1, u1) in zip(line[:-1], line[1:]):
        if y0 <= y <= y1:
            return u0 + (u1 - u0) * (y - y0) / (y1 - y0) if y1 > y0 else u0
    return line[-1][1]
note = ""
ref = GHIA_U.get(int(round(Re)))
if ref:
    errs = [abs(interp(y) - u) for y, u in zip(GHIA_Y, ref)]
    tol = 0.03 if Re <= 100 else (0.05 if Re <= 400 else 0.08)
    if max(errs) > tol:
        mismatches.append({"problem": "centre-line velocity against Ghia et al.", "max_error": max(errs), "tolerance": tol})
    note = "centre line against Ghia et al. (Re %d): max error %.4f, mean %.4f; " % (int(Re), max(errs), sum(errs) / len(errs))
else:
    note = "no Ghia et al. table for Re %.0f (100, 400, 1000): benchmark not applied; " % Re
# mass conservation: the net flux through each horizontal cut of the cavity is zero
h = xs[1] - xs[0]
worst = 0.0
for y in sorted(set(round(d[1], 6) for d in data))[1:-1]:
    flux = sum(grid[(x, y)][3] for x in xs[1:-1]) * h
    worst = max(worst, abs(flux))
if worst > 0.01:
    mismatches.append({"problem": "mass conservation", "worst_net_flux": worst})
# the primary vortex: where the stream function is lowest
low = min(data, key=lambda d: d[4])
if abs(low[0] - num(claim.get("vortex_x"))) > 2.5 * h or abs(low[1] - num(claim.get("vortex_y"))) > 2.5 * h:
    mismatches.append({"problem": "vortex centre", "field": [low[0], low[1]], "claimed": [claim.get("vortex_x"), claim.get("vortex_y")]})
if not claim.get("converged"):
    mismatches.append({"problem": "not converged", "residual": claim.get("residual")})
verdict(not mismatches, len(data), 0.0, mismatches,
        note + "worst net flux %.2e, vortex at (%.3f, %.3f)" % (worst, low[0], low[1]))
`,
  },
  {
    name: 'microstrip_recomputed',
    description:
      'Compares the impedance and effective permittivity of a microstrip field solution with the Hammerstad-Jensen closed-form formulas (with the strip thickness correction), which the solution does not use.',
    params,
    needsResult: true,
    needsData: false,
    body: `
claim = CLAIM or {}
mismatches = []
W, H, T, er = num(P.get("width_mm", 3)), num(P.get("substrate_mm", 1.6)), num(P.get("copper_mm", 0.035)), num(P.get("permittivity", 4.4))
# Hammerstad & Jensen (1980), with the thickness correction of the strip width
if T > 0:
    dW1 = T / math.pi * math.log(1 + 4 * math.e / (T / H * (1 / math.tanh(math.sqrt(6.517 * W / H))) ** 2))
    dWr = (1 + 1 / math.cosh(math.sqrt(er - 1))) / 2 * dW1
else:
    dW1 = dWr = 0.0
def z01(u):
    f = 6 + (2 * math.pi - 6) * math.exp(-(30.666 / u) ** 0.7528)
    return 60 * math.log(f / u + math.sqrt(1 + (2 / u) ** 2))
def eeff_of(u):
    a = 1 + math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + math.log(1 + (u / 18.1) ** 3) / 18.7
    b = 0.564 * ((er - 0.9) / (er + 3)) ** 0.053
    return (er + 1) / 2 + (er - 1) / 2 * (1 + 10 / u) ** (-a * b)
u1, ur = (W + dW1) / H, (W + dWr) / H
z_hj = z01(ur) / math.sqrt(eeff_of(ur))
e_hj = eeff_of(ur) * (z01(u1) / z01(ur)) ** 2
z = num(claim.get("impedance_ohm")); e = num(claim.get("effective_permittivity"))
if abs(z - z_hj) > 0.05 * z_hj:
    mismatches.append({"problem": "impedance", "field_ohm": z, "hammerstad_jensen_ohm": z_hj})
if abs(e - e_hj) > 0.05 * e_hj:
    mismatches.append({"problem": "effective permittivity", "field": e, "hammerstad_jensen": e_hj})
verdict(not mismatches, 2, abs(z - z_hj), mismatches,
        "Z0 %.2f ohm vs Hammerstad-Jensen %.2f ohm, eps_eff %.3f vs %.3f" % (z, z_hj, e, e_hj))
`,
  },
];
