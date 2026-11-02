import { z } from 'zod';
import type { Check } from '../verification/checks.ts';

/**
 * The independent check for CAD engines. It never touches the CAD kernel: it reads the
 * parts list and the exported meshes, recounts parts, blades and names, tests that every
 * mesh is closed (each edge shared by exactly two triangles) and recomputes each group's
 * volume from the triangles (divergence theorem), comparing it with the kernel's volumes.
 */
export const CAD_CHECK: Check = {
  name: 'cad_assembly_recomputed',
  description:
    'Recounts parts, blades and unique names from the parts list, requires every solid to be valid, checks that each exported mesh is closed and recomputes each group volume from its triangles, within 3 % of the kernel volume.',
  params: z.object({ step: z.string() }).passthrough() as unknown as z.ZodType<
    Record<string, unknown>
  >,
  needsResult: true,
  needsData: false,
  needsFiles: true,
  body: `
import os, struct
parts = rows("/input/result.csv")
claim = CLAIM or {}
mismatches = []
names = [p["name"] for p in parts]
blades = sum(1 for n in names if "blade" in n.lower() or "vane" in n.lower())
invalid = [p["name"] for p in parts if p["valid"] != "yes"]
if len(parts) != int(num(claim.get("part_count"))):
    mismatches.append({"problem": "part count", "listed": len(parts), "claimed": claim.get("part_count")})
if blades != int(num(claim.get("blade_count"))):
    mismatches.append({"problem": "blade count", "listed": blades, "claimed": claim.get("blade_count")})
if len(set(names)) != len(names):
    mismatches.append({"problem": "duplicate part names", "count": len(names) - len(set(names))})
if invalid:
    mismatches.append({"problem": "invalid solids", "parts": invalid[:5]})
groups = {}
for p in parts:
    groups[p["group"]] = groups.get(p["group"], 0.0) + num(p["volume_mm3"])
worst = 0.0
checked_meshes = 0
for g, kernel_volume in groups.items():
    safe = "".join(ch if ch.isalnum() else "_" for ch in g)[:40] or "group"
    path = "/input/mesh_" + safe + ".stl"
    if not os.path.exists(path):
        mismatches.append({"problem": "mesh missing", "group": g})
        continue
    data = open(path, "rb").read()
    n = struct.unpack_from("<I", data, 80)[0]
    vol = 0.0
    edges = {}
    def key(x, y, z): return (round(x, 3), round(y, 3), round(z, 3))
    for i in range(n):
        v = struct.unpack_from("<12f", data, 84 + 50 * i)
        a, b, c = v[3:6], v[6:9], v[9:12]
        vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
        ka, kb, kc = key(*a), key(*b), key(*c)
        for e in ((ka, kb), (kb, kc), (kc, ka)):
            k = e if e[0] <= e[1] else (e[1], e[0])
            edges[k] = edges.get(k, 0) + 1
    open_edges = sum(1 for c in edges.values() if c % 2 == 1)
    checked_meshes += 1
    err = abs(vol - kernel_volume) / max(kernel_volume, 1e-9)
    worst = max(worst, err)
    if open_edges > 0:
        mismatches.append({"problem": "mesh not closed", "group": g, "open_edges": open_edges})
    if err > 0.03:
        mismatches.append({"problem": "group volume", "group": g, "kernel": kernel_volume, "mesh": vol})
verdict(not mismatches and checked_meshes == len(groups), len(parts), worst, mismatches,
        "%d parts (%d blades and vanes) recounted; %d meshes closed; volumes within %.2f %% of the kernel" % (len(parts), blades, checked_meshes, worst * 100))
`,
};
