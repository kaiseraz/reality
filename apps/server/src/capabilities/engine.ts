import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapabilityResolver } from '../analysis/executor.ts';
import type { RunStore } from '../analysis/run-store.ts';
import type { SandboxService } from '../analysis/sandbox-service.ts';
import type { EventLog } from '../events/event-log.ts';
import type { CapabilityAgent, CapabilityProposal } from '../orchestrator/graph.ts';
import {
  assess,
  classifyLicense,
  fetchFacts,
  findCatalogEntry,
  type CandidateAssessment,
  type PackageFacts,
  findCandidate,
} from './catalog.ts';
import {
  DYNAMIC_ENTRY,
  launchFromScripts,
  scriptFromBin,
  withMcpSession,
  withRemoteSession,
  type McpBlob,
  type McpLaunch,
  type McpSession,
} from './mcp.ts';
import { scrubSecrets, type SecretStore } from './secrets.ts';
import { findReviewedServer, reviewedById, reviewedId, reviewedLaunch } from './servers.ts';
import {
  fetchNpmFacts,
  neededDomains,
  neededSecrets,
  normalizeName,
  searchCapabilities,
  wantsMcp,
  type SearchDeps,
} from './search.ts';
import type { CapabilityRecord, CapabilityStore, WheelInfo } from './store.ts';
import type { Mount, RunInput } from '../sandbox/docker-runner.ts';

/**
 * The test a library found by search gets, since nobody wrote one for it: its own modules must
 * load from the isolated read-only layer. That proves it is installed and loadable, not that it
 * does what is needed; that shows in use (and after enough uses it becomes trusted).
 */
export function genericLibraryTest(id: string, pkg: string) {
  return {
    name: 'loads-from-layer',
    description:
      'The library must install into its isolated layer and its own modules must import from that read-only layer with no network. It is not proven to do what you need: that shows in use.',
    code: `
import importlib, importlib.metadata as md, json, re, sys
ID, PKG = ${JSON.stringify(id)}, ${JSON.stringify(pkg)}
root = "/caps/" + ID
sys.path[:0] = [root]
norm = lambda n: re.sub(r"[-_.]+", "-", n or "").lower()
mods, version = [], None
for d in md.distributions(path=[root]):
    if norm(d.metadata["Name"]) != norm(PKG): continue
    version = d.version
    top = (d.read_text("top_level.txt") or "").split()
    if not top:
        files = d.files or []
        top = sorted({f.parts[0] for f in files if len(f.parts) > 1 and f.parts[0].isidentifier()} | {f.stem for f in files if len(f.parts) == 1 and f.suffix == ".py"})
    mods = [m for m in top if m.isidentifier() and not m.startswith("_")][:6]
loaded = []
for m in mods:
    try:
        mod = importlib.import_module(m)
        path = getattr(mod, "__file__", None) or (list(getattr(mod, "__path__", [])) or [""])[0]
        loaded.append({"module": m, "from_layer": str(path).startswith(root + "/")})
    except Exception as e:
        loaded.append({"module": m, "error": str(e)[:200]})
passed = bool(version) and any(x.get("from_layer") for x in loaded)
out = {"passed": passed, "version": version, "modules": [x["module"] for x in loaded if x.get("from_layer")], "loaded": loaded}
json.dump(out, open("/output/summary.json", "w"))
print(json.dumps(out))
`,
  };
}

export const GENERIC_MCP_TEST = {
  name: 'starts-and-lists-tools',
  description:
    'The server must start and offer at least one tool. Its tools are listed by the server after installation; only those can be called, and nothing else about it is vouched for.',
};

/** Requirement tests: each capability must prove it does what recipes rely on. */
export const REQUIREMENT_TESTS: Record<
  string,
  { name: string; description: string; code: string }
> = {
  ocp: {
    name: 'ocp-solid-step-roundtrip',
    description:
      'OpenCascade must build a 10 x 20 x 30 mm block with a 3 mm radius hole through it, give its volume within 0.01% of the formula (6000 - 90 pi mm3), validate the solid, write it as STEP, read it back with the same volume, mesh it, and load from the isolated layer.',
    code: `
import json, math, sys
sys.path[:0] = ["/caps/ocp"]
import OCP
from OCP.gp import gp_Pnt, gp_Dir, gp_Ax2
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.STEPControl import STEPControl_Writer, STEPControl_Reader, STEPControl_AsIs
from OCP.BRepMesh import BRepMesh_IncrementalMesh
def vol(s):
    p = GProp_GProps(); BRepGProp.VolumeProperties_s(s, p); return p.Mass()
block = BRepPrimAPI_MakeBox(10, 20, 30).Shape()
hole = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(5, 10, -1), gp_Dir(0, 0, 1)), 3, 32).Shape()
part = BRepAlgoAPI_Cut(block, hole).Shape()
expected = 6000 - math.pi * 9 * 30
v = vol(part)
valid = BRepCheck_Analyzer(part).IsValid()
w = STEPControl_Writer(); w.Transfer(part, STEPControl_AsIs); w.Write("/tmp/t.step")
r = STEPControl_Reader(); r.ReadFile("/tmp/t.step"); r.TransferRoots()
back = vol(r.OneShape())
mesh = BRepMesh_IncrementalMesh(part, 0.1, False, 0.5, True); mesh.Perform()
from_layer = OCP.__file__.startswith("/caps/ocp/")
passed = abs(v - expected) / expected < 1e-4 and abs(back - v) / v < 1e-6 and valid and mesh.IsDone() and from_layer
out = {"passed": passed, "volume": v, "expected": expected, "step_roundtrip_volume": back, "valid": valid,
       "meshed": mesh.IsDone(), "loaded_from_layer": from_layer}
json.dump(out, open("/output/summary.json", "w"))
print(json.dumps(out))
`,
  },
  cantera: {
    name: 'cantera-adiabatic-flames',
    description:
      'Cantera must reproduce two textbook adiabatic flame temperatures at 1 atm from chemical equilibrium within 15 K of NASA CEA (methane-air 2226 K, hydrogen-oxygen 3079 K), load the NASA thermo database with its C/H/O/N species, and load from the isolated layer.',
    code: `
import json, sys
sys.path[:0] = ["/caps/cantera"]
import cantera as ct
g = ct.Solution("gri30.yaml")
g.TPX = 298.15, ct.one_atm, "CH4:1, O2:2, N2:7.52"; g.equilibrate("HP"); t_ch4 = g.T
g.TPX = 298.15, ct.one_atm, "H2:2, O2:1"; g.equilibrate("HP"); t_h2 = g.T
nasa = [s for s in ct.Species.list_from_file("nasa_gas.yaml") if set(s.composition) <= {"C", "H", "O", "N"}]
from_layer = ct.__file__.startswith("/caps/cantera/")
passed = abs(t_ch4 - 2226) < 15 and abs(t_h2 - 3079) < 15 and len(nasa) > 50 and from_layer
out = {"passed": passed, "methane_air_K": t_ch4, "hydrogen_oxygen_K": t_h2, "nasa_chon_species": len(nasa),
       "loaded_from_layer": from_layer, "version": ct.__version__}
json.dump(out, open("/output/summary.json", "w"))
print(json.dumps(out))
`,
  },
  rdkit: {
    name: 'rdkit-ethanol-and-caffeine',
    description:
      'RDKit must parse ethanol and caffeine, give their molecular weights within 0.01 g/mol of the reference (46.069, 194.194), embed a 3D conformer of caffeine and minimise it with MMFF94, and load from the isolated layer.',
    code: `
import json, sys
sys.path[:0] = ["/caps/rdkit"]
import rdkit
from rdkit import Chem
from rdkit.Chem import AllChem, Descriptors
eth = Chem.MolFromSmiles("CCO")
caf = Chem.MolFromSmiles("Cn1cnc2c1c(=O)n(C)c(=O)n2C")
mw_eth, mw_caf = Descriptors.MolWt(eth), Descriptors.MolWt(caf)
h = Chem.AddHs(caf)
embedded = AllChem.EmbedMolecule(h, randomSeed=42) == 0
optimised = embedded and AllChem.MMFFOptimizeMolecule(h, maxIters=2000) in (0, 1)
from_layer = rdkit.__file__.startswith("/caps/rdkit/")
passed = abs(mw_eth - 46.069) < 0.01 and abs(mw_caf - 194.194) < 0.01 and embedded and optimised and from_layer
out = {"passed": passed, "mw_ethanol": mw_eth, "mw_caffeine": mw_caf, "embedded": embedded,
       "optimised": bool(optimised), "loaded_from_layer": from_layer, "version": rdkit.__version__}
json.dump(out, open("/output/summary.json", "w"))
print(json.dumps(out))
`,
  },
  statsmodels: {
    name: 'stl-recovers-known-seasonality',
    description:
      'STL on a synthetic 3-year weekly series with a known 52-week sine (amplitude 100, peak in week 13) must recover the amplitude within 15%, the peak within 2 weeks, and reconstruct the series exactly; Holt-Winters fitted on the first 130 weeks must forecast the last 26 with a mean absolute error below 25 (noise sd 10); the library must load from the isolated layer.',
    code: `
import json, sys
sys.path[:0] = ["/caps/statsmodels"]
import numpy as np, pandas as pd
import statsmodels
from statsmodels.tsa.seasonal import STL
rng = np.random.default_rng(7)
t = np.arange(156)
y = 1000 + 2 * t + 100 * np.sin(2 * np.pi * t / 52) + rng.normal(0, 10, len(t))
s = pd.Series(y, index=pd.date_range("2023-01-02", periods=len(t), freq="W-MON"))
res = STL(s, period=52, robust=True).fit()
amp = float((res.seasonal.max() - res.seasonal.min()) / 2)
peak = int(np.argmax(res.seasonal.values[52:104]))
recon = float(np.max(np.abs(res.trend + res.seasonal + res.resid - s)))
from statsmodels.tsa.holtwinters import ExponentialSmoothing
hw = ExponentialSmoothing(s.iloc[:130], trend="add", seasonal="add", seasonal_periods=52).fit()
forecast_mae = float(np.mean(np.abs(hw.forecast(26).values - s.iloc[130:].values)))
from_layer = statsmodels.__file__.startswith("/caps/statsmodels/")
passed = (abs(amp - 100) / 100 < 0.15 and abs(peak - 13) <= 2 and recon < 1e-6
          and forecast_mae < 25 and from_layer)
out = {"passed": passed, "amplitude": amp, "expected_amplitude": 100, "peak_week": peak,
       "expected_peak_week": 13, "reconstruction_error": recon, "forecast_mae": forecast_mae,
       "loaded_from_layer": from_layer, "version": statsmodels.__version__}
json.dump(out, open("/output/summary.json", "w"))
print(json.dumps(out))
`,
  },
};

const DOWNLOAD = `
import json, subprocess, sys, time
P = json.loads(__PARAMS__)
cmd = [sys.executable, "-m", "pip", "download", "--only-binary=:all:", "--no-cache-dir",
       "--disable-pip-version-check", "--retries", "8", "--timeout", "60",
       "--dest", "/wheels", P["requirement"]]
# The index occasionally answers "from versions: none" for wheels that exist (seen on
# real runs); a fresh attempt a little later succeeds. Same command, same wheels-only rules.
for attempt in range(3):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode == 0: break
    print(f"Attempt {attempt + 1} failed: {r.stderr.strip().splitlines()[-1:]}")
    time.sleep(5 * (attempt + 1))
print(r.stdout[-6000:])
print(r.stderr[-6000:], file=sys.stderr)
sys.exit(r.returncode)
`;

/** How much worse a fit an installed capability may be and still be reused instead of a new one. */
const REUSE_MARGIN = 0.05;
/** How many of a search's candidates are inspected, one after the other, until one passes. */
const MAX_INSPECTED = 3;
const FALLBACK_MARGIN = 0.1;
/** Marks a capability that is hosted elsewhere instead of a layer here. */
const REMOTE_PREFIX = 'remote:';
/** The sandbox image with Node added (sandbox/node). Same lockdown as the Python one. */
export const NODE_IMAGE = 'reality-sandbox-node:dev';

/** Downloads a Node package and what it depends on. Install scripts stay off: none of it runs. */
const NPM_STAGE = `
import json, os, shutil, subprocess, sys
P = json.loads(__PARAMS__)
if P.get("overrides"):
    shutil.rmtree("/layer/node_modules", ignore_errors=True)
    if os.path.exists("/layer/package-lock.json"): os.remove("/layer/package-lock.json")
    json.dump({"overrides": P["overrides"]}, open("/layer/package.json", "w"))
cmd = ["npm", "install", P["spec"], "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
       "--prefix", "/layer", "--cache", "/tmp/npm", "--loglevel", "error"]
r = subprocess.run(cmd, capture_output=True, text=True, env={"HOME": "/tmp", "PATH": "/usr/local/bin:/usr/bin:/bin"})
print(r.stdout[-4000:])
print(r.stderr[-4000:], file=sys.stderr)
sys.exit(r.returncode)
`;

const TREE_HASH = `
def tree_hash(root):
    h = hashlib.sha256()
    for d, dirs, files in sorted(os.walk(root)):
        dirs.sort()
        for f in sorted(files):
            p = os.path.join(d, f)
            if os.path.islink(p):
                h.update((os.path.relpath(p, root) + "->" + os.readlink(p)).encode()); continue
            h.update(os.path.relpath(p, root).encode())
            with open(p, "rb") as fh:
                h.update(hashlib.sha256(fh.read()).digest())
    return h.hexdigest()
`;

/** Hash of a staged Node layer: what was approved must be what is started. */
const NODE_TREE = `
import hashlib, json, os
${TREE_HASH}
json.dump({"tree": tree_hash("/layer")}, open("/output/summary.json", "w"))
`;

/** Reads a staged Node layer as data; nothing from it is imported or executed. */
const NPM_INSPECT = `
import hashlib, json, os
${TREE_HASH}
P = json.loads(__PARAMS__)
root = "/layer/node_modules"
wheels, scripts, seen = [], [], set()
for d, dirs, files in os.walk(root):
    if "package.json" not in files or os.path.basename(os.path.dirname(d)) not in ("node_modules",) and not os.path.basename(os.path.dirname(d)).startswith("@"):
        continue
    try:
        meta = json.load(open(os.path.join(d, "package.json"), encoding="utf-8"))
    except Exception:
        continue
    name, version = meta.get("name"), meta.get("version")
    if not name or not version or (name, version) in seen:
        continue
    seen.add((name, version))
    size, count, native = 0, 0, 0
    for dd, _, ff in os.walk(d):
        for f in ff:
            count += 1
            native += f.endswith(".node")
            try:
                size += os.path.getsize(os.path.join(dd, f))
            except OSError:
                pass
    lic = meta.get("license")
    s = meta.get("scripts") or {}
    if any(k in s for k in ("preinstall", "install", "postinstall")):
        scripts.append(name)
    wheels.append({"file": name + "@" + version, "name": name, "version": version,
                   "license": lic if isinstance(lic, str) else "unknown", "sha256": "", "size": size,
                   "pth_files": [], "console_scripts": 0, "native_libs": native, "files": count,
                   "in_base": False, "requires": len(meta.get("dependencies") or {})})
main = {}
try:
    main = json.load(open(os.path.join(root, *P["package"].split("/"), "package.json"), encoding="utf-8"))
except Exception:
    pass
json.dump({"wheels": wheels, "tree": tree_hash("/layer"), "bin": main.get("bin"), "scripts": scripts},
          open("/output/summary.json", "w"))
print(len(wheels), "packages inspected")
`;

/** Runs without network. Parses wheels as data; nothing from them is imported or executed. */
const INSPECT = `
import hashlib, json, os, re, zipfile, importlib.metadata as md
norm = lambda n: re.sub(r"[-_.]+", "-", n or "").lower()
base = sorted({norm(d.metadata["Name"]) for d in md.distributions()})
out = []
for f in sorted(os.listdir("/wheels")):
    p = os.path.join("/wheels", f)
    if not f.endswith(".whl"):
        out.append({"file": f, "error": "not a wheel (source distributions are not allowed)"}); continue
    h = hashlib.sha256(open(p, "rb").read()).hexdigest()
    try:
        z = zipfile.ZipFile(p)
    except zipfile.BadZipFile:
        out.append({"file": f, "error": "not a valid zip archive"}); continue
    names = z.namelist()
    meta_files = [n for n in names if n.endswith(".dist-info/METADATA")]
    headers, classifiers, requires = {}, [], 0
    if meta_files:
        meta = z.read(meta_files[0]).decode("utf-8", "replace")
        for line in meta.split("\\n\\n", 1)[0].splitlines():
            if ": " not in line: continue
            k, v = line.split(": ", 1)
            if k == "Classifier" and v.startswith("License ::"): classifiers.append(v.split("::")[-1].strip())
            elif k == "Requires-Dist" and "extra ==" not in v: requires += 1
            elif k in ("Name", "Version", "License", "License-Expression"): headers.setdefault(k, v)
    console = 0
    scripts = []
    for ep in [n for n in names if n.endswith(".dist-info/entry_points.txt")]:
        section = None
        for line in z.read(ep).decode("utf-8", "replace").splitlines():
            line = line.strip()
            if line.startswith("["): section = line
            elif line and section in ("[console_scripts]", "[gui_scripts]"):
                console += 1
                if section == "[console_scripts]": scripts.append(line[:200])
    lic = headers.get("License-Expression") or (headers.get("License", "") if len(headers.get("License", "")) < 200 else "") or ", ".join(classifiers)
    out.append({"file": f, "name": norm(headers.get("Name")), "version": headers.get("Version"),
                "license": lic or "unknown", "sha256": h, "size": os.path.getsize(p),
                "pth_files": [n for n in names if n.endswith(".pth")], "console_scripts": console, "scripts": scripts[:10],
                "native_libs": sum(1 for n in names if n.endswith((".so", ".pyd")) or ".so." in n),
                "files": len(names), "in_base": norm(headers.get("Name")) in base, "requires": requires,
                **({} if meta_files else {"error": "missing METADATA"})})
json.dump({"wheels": out}, open("/output/summary.json", "w"))
print(f"{len(out)} files inspected")
`;

const INSTALL = `
import json, subprocess, sys
P = json.loads(__PARAMS__)
files = ["/wheels/" + f for f in P["files"]]
cmd = [sys.executable, "-m", "pip", "install", "--no-index", "--no-deps", "--no-compile",
       "--disable-pip-version-check", "--target", "/layer", *files]
r = subprocess.run(cmd, capture_output=True, text=True)
print(r.stdout[-6000:])
print(r.stderr[-6000:], file=sys.stderr)
if r.returncode != 0:
    sys.exit(r.returncode)
# Precompile to bytecode: the layer is read-only at runtime, so otherwise every start
# recompiles every import. Compiling parses source; it does not execute package code.
import compileall, os
compileall.compile_dir("/layer", quiet=1, workers=1)
size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk("/layer") for f in fs)
json.dump({"layerBytes": size}, open("/output/summary.json", "w"))
`;

/**
 * Requirement tests for MCP servers: start the server from its layer inside the
 * sandbox, check that the approved tool exists, call it on known data, compare.
 */
export const MCP_REQUIREMENT_TESTS: Record<
  string,
  {
    name: string;
    description: string;
    csv: string;
    tool: string;
    args: Record<string, unknown>;
    check: (text: string) => { passed: boolean; detail: unknown };
  }
> = {
  'mcp-server-motherduck': {
    name: 'sql-group-by-on-known-data',
    description:
      'Started offline in the sandbox, the server must offer execute_query and return North = 30 and South = 4 for a GROUP BY over a 3-row CSV.',
    csv: 'week,region,revenue\n2025-01-06,North,10\n2025-01-06,South,4\n2025-01-13,North,20\n',
    tool: 'execute_query',
    args: { sql: 'SELECT region, SUM(revenue) AS total FROM data GROUP BY region ORDER BY region' },
    check: (text) => {
      try {
        const r = JSON.parse(text) as { success?: boolean; rows?: unknown[][] };
        const rows = (r.rows ?? []).map((row) => [String(row[0]), Number(row[1])]);
        const passed =
          r.success === true &&
          JSON.stringify(rows) ===
            JSON.stringify([
              ['North', 30],
              ['South', 4],
            ]);
        return { passed, detail: { rows } };
      } catch {
        return { passed: false, detail: { unparsable: text.slice(0, 500) } };
      }
    },
  },
};

/**
 * Capability layers live in Docker volumes (fast on Windows/macOS; inside Docker's VM).
 * Every installation gets its own volume: several Reality instances (or databases) can share
 * one Docker host, and a reinstall must never empty a layer another instance is using.
 */
const VOLUME_PREFIX = 'volume:';
const volumeName = (id: string, version: string | null) =>
  `reality-cap-${`${id}-${version ?? '0'}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')}-${randomBytes(4).toString('hex')}`;

const withParams = (template: string, params: unknown) =>
  template.replace('__PARAMS__', JSON.stringify(JSON.stringify(params)));

export interface Vulnerability {
  package: string;
  version: string | null;
  ids: string[];
}

export interface PolicyResult {
  blocking: string[];
  flags: string[];
}

/** Deterministic policy over an inspection. Blocking findings reject the capability. */
/** Inspection output describes untrusted files; entries may be partial (e.g. for non-wheels). */
function normalize(w: Partial<WheelInfo> & { file: string }): WheelInfo {
  return {
    name: '',
    version: null,
    license: 'unknown',
    sha256: '',
    size: 0,
    pth_files: [],
    console_scripts: 0,
    native_libs: 0,
    files: 0,
    in_base: false,
    requires: 0,
    ...w,
  };
}

export function evaluatePolicy(
  rawWheels: (Partial<WheelInfo> & { file: string })[],
  vulnerabilities: Vulnerability[] | null,
  maxBytes = 400 * 1024 * 1024,
  /** A tool server found by search: a known vulnerability is for the person to judge on the card. */
  vulnerabilitiesTo: 'reject' | 'card' = 'reject',
): PolicyResult {
  const wheels = rawWheels.map(normalize);
  const blocking: string[] = [];
  const flags: string[] = [];
  const fresh = wheels.filter((w) => !w.in_base);
  for (const w of wheels) {
    if (w.error) blocking.push(`${w.file}: ${w.error}`);
    if (w.pth_files.length > 0) {
      blocking.push(
        `${w.file} contains .pth files (${w.pth_files.join(', ')}), which execute code at interpreter start-up`,
      );
    }
  }
  for (const w of fresh) {
    const cls = classifyLicense(w.license);
    if (cls === 'copyleft')
      flags.push(`${w.name}: copyleft license (${w.license}) — review before redistribution`);
    if (cls === 'unknown') flags.push(`${w.name}: license not declared clearly (${w.license})`);
    if (w.console_scripts > 0)
      flags.push(`${w.name}: defines ${w.console_scripts} command-line scripts (not exposed)`);
    if (w.native_libs > 0)
      flags.push(
        `${w.name}: contains compiled native code (${w.native_libs} libraries); isolation relies on the sandbox`,
      );
  }
  if (vulnerabilities === null)
    flags.push('Vulnerability database (OSV) unreachable: known-vulnerability status unknown');
  for (const v of vulnerabilities ?? []) {
    if (v.ids.length > 0 && vulnerabilitiesTo === 'reject')
      blocking.push(`${v.package} ${v.version}: known vulnerabilities ${v.ids.join(', ')}`);
  }
  const total = fresh.reduce((n, w) => n + w.size, 0);
  if (total > maxBytes)
    blocking.push(`New packages total ${(total / 1e6).toFixed(0)} MB (limit ${maxBytes / 1e6} MB)`);
  return { blocking, flags };
}

export async function queryOsv(
  wheels: WheelInfo[],
  fetchImpl: typeof fetch = fetch,
  ecosystem: 'PyPI' | 'npm' = 'PyPI',
): Promise<Vulnerability[] | null> {
  const fresh = wheels.filter((w) => !w.in_base && w.name && w.version);
  if (fresh.length === 0) return [];
  try {
    const res = await fetchImpl('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        queries: fresh.map((w) => ({
          package: { name: w.name, ecosystem },
          version: w.version,
        })),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { results: { vulns?: { id: string }[] }[] };
    return fresh.map((w, i) => ({
      package: w.name,
      version: w.version,
      ids: (body.results[i]?.vulns ?? []).map((v) => v.id),
    }));
  } catch {
    return null;
  }
}

const majorOf = (v: string) => v.split('.')[0] ?? '';
function newer(a: string, b: string): boolean {
  const parts = (v: string) => v.split('-')[0]?.split('.').map(Number) ?? [];
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/**
 * The versions that fix a Node package's known vulnerabilities, where a fix exists in the same
 * major version: such an update is meant to change nothing else. What has none stays as it is,
 * and is reported. null when the database cannot say.
 */
export async function sameMajorFixes(
  vulnerabilities: readonly Vulnerability[],
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string> | null> {
  const fixes: Record<string, string> = {};
  for (const v of vulnerabilities) {
    if (v.ids.length === 0) continue;
    if (!v.version) return null;
    const current = v.version;
    for (const id of v.ids) {
      let body: {
        affected?: {
          package?: { name?: string; ecosystem?: string };
          ranges?: { events?: { fixed?: string }[] }[];
        }[];
      };
      try {
        const res = await fetchImpl(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return null;
        body = (await res.json()) as typeof body;
      } catch {
        return null;
      }
      const fixed = (body.affected ?? [])
        .filter((a) => a.package?.name === v.package && a.package?.ecosystem === 'npm')
        .flatMap((a) => a.ranges ?? [])
        .flatMap((r) => r.events ?? [])
        .flatMap((e) => (e.fixed ? [e.fixed] : []))
        .filter((f) => majorOf(f) === majorOf(current) && newer(f, current))
        .sort((a, b) => (newer(a, b) ? 1 : -1))[0];
      if (!fixed) continue;
      const before = fixes[v.package];
      if (before && majorOf(before) !== majorOf(fixed)) continue;
      if (!before || newer(fixed, before)) fixes[v.package] = fixed;
    }
  }
  return fixes;
}

/** What a person needs in order to judge the advisories: how bad, and what it is about. */
export async function describeAdvisories(
  vulnerabilities: readonly Vulnerability[],
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const out: string[] = [];
  for (const v of vulnerabilities) {
    for (const id of v.ids.slice(0, 6)) {
      let about: string;
      try {
        const res = await fetchImpl(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {
          signal: AbortSignal.timeout(15_000),
        });
        const body = (res.ok ? await res.json() : {}) as {
          summary?: string;
          database_specific?: { severity?: string };
        };
        const severity = body.database_specific?.severity;
        about = `${severity ? ` (${severity})` : ''}${body.summary ? `: ${body.summary.slice(0, 160)}` : ''}`;
      } catch {
        about = '';
      }
      out.push(`${v.package} ${v.version ?? ''} ${id}${about}`);
    }
  }
  return out;
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

const MAX_TOOL_FILES = 10;
const MAX_TOOL_FILE_BYTES = 25 * 1024 * 1024;

/** What a tool left in /output or sent as data. Names are the server's, so they are cleaned. */
export async function collectToolFiles(
  outputDir: string | undefined,
  blobs: readonly McpBlob[] | undefined,
  save: (file: { name: string; path: string }) => Promise<void>,
): Promise<string[]> {
  const saved: string[] = [];
  const clean = (n: string) =>
    n
      .split(/[\\/]/)
      .pop()
      ?.replace(/[^\w.() -]+/g, '_')
      .slice(0, 120) || 'file';
  if (outputDir) {
    for (const entry of await readdir(outputDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || saved.length >= MAX_TOOL_FILES) continue;
      const path = join(outputDir, entry.name);
      if ((await stat(path)).size > MAX_TOOL_FILE_BYTES) continue;
      await save({ name: clean(entry.name), path });
      saved.push(clean(entry.name));
    }
  }
  if (blobs?.length) {
    const tmp = await mkdtemp(join(tmpdir(), 'reality-tool-'));
    try {
      for (const b of blobs) {
        if (saved.length >= MAX_TOOL_FILES || b.data.length > MAX_TOOL_FILE_BYTES) continue;
        const path = join(tmp, 'blob');
        await writeFile(path, b.data);
        await save({ name: clean(b.name), path });
        saved.push(clean(b.name));
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  return saved;
}

export interface EngineDeps {
  store: CapabilityStore;
  sandbox: SandboxService;
  events: EventLog;
  runs: RunStore;
  /** Root for staging wheels and capability layers (outside any package directory). */
  dir: string;
  fetchFacts?: (pkg: string) => Promise<PackageFacts | null>;
  queryOsv?: (wheels: WheelInfo[]) => Promise<Vulnerability[] | null>;
  /** Successful uses after which an enabled capability becomes trusted. */
  trustAfterUses?: number;
  /** Where to look for what the reviewed catalog does not know (a model's suggestions, fetch). */
  search?: SearchDeps;
  /** Encrypted API keys for tool servers. */
  secrets?: SecretStore;
  /** The gateway's way out for tool servers that need the internet; absent without computers. */
  toolAccess?: () => ToolAccess | null;
  /** The sandbox image with Node, for servers from npm. */
  nodeImage?: string;
}

export interface ToolAccess {
  openToolAccess(
    container: string,
    domains: readonly string[],
  ): Promise<{ network: string; proxy: string; mark: number }>;
  closeToolAccess(container: string, mark: number): Promise<string[]>;
}

/**
 * The adaptive capability engine (M5): discover → inspect → (human approval) →
 * install into an isolated layer → requirement test → enable → trust through use.
 * Discovering a package never means trusting it; every step leaves a record.
 */
/** How long a card for a capability counts as open; after that it may be inspected again. */
const ASKED_FOR_MS = 30 * 60_000;

export class CapabilityEngine implements CapabilityAgent, CapabilityResolver {
  private readonly staging: string;
  /** Work on one capability at a time: two at once share its staging folder and its record. */
  private readonly busy = new Map<string, Promise<unknown>>();
  /**
   * Capabilities whose card a person has in front of them now, and since when. Kept here, not in
   * the record: an "inspected" record left by a stopped run has no card any more and is inspected
   * again; one asked for minutes ago is not inspected under the open card.
   */
  private readonly asked = new Map<string, number>();

  constructor(private readonly deps: EngineDeps) {
    this.staging = join(deps.dir, 'staging');
  }

  /**
   * Runs one job on a capability after the one before it finished. Seen: a bot retried a lab job
   * while its tool was still being inspected, and the second download deleted the first one's
   * files, twelve times in a row.
   */
  private async oneAtATime<T>(id: string, job: () => Promise<T>): Promise<T> {
    const before = this.busy.get(id) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(job);
    this.busy.set(id, run);
    try {
      return await run;
    } finally {
      if (this.busy.get(id) === run) this.busy.delete(id);
    }
  }

  private layerMount(c: CapabilityRecord): Mount | undefined {
    if (!c.layerPath || c.layerPath.startsWith(REMOTE_PREFIX)) return undefined;
    return c.layerPath.startsWith(VOLUME_PREFIX)
      ? { volume: c.layerPath.slice(VOLUME_PREFIX.length), containerPath: c.permissions.path }
      : { hostPath: c.layerPath, containerPath: c.permissions.path }; // pre-volume layers
  }

  private async usable(c: CapabilityRecord | undefined): Promise<Mount | undefined> {
    if (!c || (c.state !== 'enabled' && c.state !== 'trusted')) return undefined;
    // A hosted server has nothing here to check; it is reached and judged when it is called.
    if (c.layerPath?.startsWith(REMOTE_PREFIX)) {
      return { hostPath: c.layerPath, containerPath: c.permissions.path };
    }
    const mount = this.layerMount(c);
    if (!mount) return undefined;
    const exists =
      'volume' in mount
        ? await this.deps.sandbox.runner.volumeExists(mount.volume)
        : existsSync(mount.hostPath);
    return exists ? mount : undefined;
  }

  async enabledIds(): Promise<string[]> {
    const ids: string[] = [];
    for (const c of await this.deps.store.list()) {
      if (await this.usable(c)) ids.push(c.id);
    }
    return ids;
  }

  async mountsFor(ids: readonly string[]) {
    const mounts: Mount[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const c = await this.deps.store.get(id);
      const mount = c?.kind === 'mcp-server' ? undefined : await this.usable(c);
      if (!mount) {
        missing.push(id);
        continue;
      }
      mounts.push(mount);
    }
    if (missing.length > 0) return { ok: false as const, missing };
    return { ok: true as const, mounts, paths: mounts.map((m) => m.containerPath) };
  }

  /**
   * How to start an MCP capability: the reviewed launch of the catalog, or the one read from the
   * server's own files at inspection, with the tools the server itself listed when it was tested.
   */
  private launchOf(c: CapabilityRecord): McpLaunch | undefined {
    const reviewed = findCandidate(c.id)?.mcp;
    if (reviewed) return reviewed;
    const found = (c.inspection as { launch?: McpLaunch } | null)?.launch;
    if (!found) return undefined;
    const tools = (c.tests as { result?: { tools?: { name: string }[] } | null }[] | null)?.[0]
      ?.result?.tools;
    const only = reviewedById(c.id)?.onlyTools;
    const offered = (tools ?? []).map((t) => t.name);
    return { ...found, allowedTools: only ? offered.filter((t) => only.includes(t)) : offered };
  }

  async info(id: string) {
    const c = await this.deps.store.get(id);
    if (!c) return undefined;
    const tests = (c.tests ?? []) as { result?: { modules?: string[] } | null }[];
    return {
      id: c.id,
      package: c.package,
      version: c.version,
      state: c.state,
      kind: c.kind,
      modules: tests[0]?.result?.modules ?? [],
      tools: c.kind === 'mcp-server' ? (this.launchOf(c)?.allowedTools ?? []) : [],
    };
  }

  /** What an enabled MCP server offers, asked of the running server (descriptions are untrusted data). */
  async listTools(
    id: string,
    owner?: string | null,
  ): Promise<
    { ok: true; tools: { name: string; description: string }[] } | { ok: false; detail: string }
  > {
    const c = await this.deps.store.get(id);
    const launch = c ? this.launchOf(c) : undefined;
    if (!c || c.kind !== 'mcp-server' || !launch || !c.layerPath || !(await this.usable(c))) {
      return { ok: false, detail: `${id} is not an enabled MCP capability.` };
    }
    const holders = (await this.deps.secrets?.names(id)) ?? [];
    if (owner !== undefined && holders.some((h) => h.owner !== null && h.owner !== owner)) {
      return { ok: false, detail: `${id} holds another person's key.` };
    }
    try {
      const tools = await this.withServer(id, c.layerPath, launch, [], async (s) => s.tools);
      return { ok: true, tools: tools.filter((t) => launch.allowedTools.includes(t.name)) };
    } catch (err) {
      const values = holders.length
        ? Object.values((await this.deps.secrets?.reveal(id)) ?? {})
        : [];
      return { ok: false, detail: scrubSecrets((err as Error).message, values).slice(0, 1500) };
    }
  }

  async recordUse(ids: readonly string[]): Promise<void> {
    const threshold = this.deps.trustAfterUses ?? 3;
    for (const id of ids) {
      const uses = await this.deps.store.incrementUses(id);
      const c = await this.deps.store.get(id);
      if (c?.state === 'enabled' && uses >= threshold) {
        await this.deps.store.transition(
          id,
          'trusted',
          `Used successfully ${uses} times without failure`,
        );
      }
    }
  }

  /** A job with a server known to work: that one, with no search. */
  private async prepareReviewed(need: string, taskId: string) {
    const server = findReviewedServer(need);
    if (!server) return undefined;
    const id = reviewedId(server);
    const record = await this.deps.store.get(id);
    if (await this.usable(record)) {
      await this.deps.events.append(taskId, 'capability.reused', 'capability-agent', {
        capabilityId: id,
        version: record?.version,
        state: record?.state,
      });
      return {
        kind: 'reuse' as const,
        capabilityId: id,
        detail: `Reused ${server.package} ${record?.version ?? ''} (${record?.state}); it is the reviewed server for this, already installed and tested. Use it with mcp_call server "${id}".`,
      };
    }
    const facts =
      server.runtime === 'node'
        ? await fetchNpmFacts(server.package)
        : await (this.deps.fetchFacts ?? fetchFacts)(server.package);
    const assessed = assess(
      {
        package: server.package,
        provides: id,
        kind: 'mcp-server',
        fit: 1,
        fitNote: server.fitNote,
        mcp: reviewedLaunch(server),
      },
      facts,
    );
    if (!assessed.eligible) return undefined;
    const label = server.job;
    return this.discoverAndInspect(label, need, [assessed], taskId, { source: 'catalog' });
  }

  async prepare(need: string, taskId: string) {
    const reviewed = await this.prepareReviewed(need, taskId);
    if (reviewed) return reviewed;
    const entry = findCatalogEntry(need);
    if (!entry) return this.prepareFromSearch(need, taskId);
    // The catalog matches on words ("OSV database" is not a job for an SQL engine).
    if (wantsMcp(need) && this.deps.search?.ruleOut) {
      const unfit = await this.deps.search
        .ruleOut(
          need,
          entry.candidates.map((c) => ({ package: c.package, says: c.fitNote })),
        )
        .catch(() => [] as string[]);
      if (entry.candidates.every((c) => unfit.includes(c.package))) {
        return this.prepareFromSearch(need, taskId);
      }
    }
    const usable = new Set(await this.enabledIds());
    const reusable = entry.candidates.find((c) => usable.has(c.provides));
    if (reusable) {
      const record = await this.deps.store.get(reusable.provides);
      await this.deps.events.append(taskId, 'capability.reused', 'capability-agent', {
        capabilityId: reusable.provides,
        version: record?.version,
        state: record?.state,
      });
      return {
        kind: 'reuse' as const,
        capabilityId: reusable.provides,
        detail: `Reused ${reusable.package} ${record?.version ?? ''} (${record?.state}); already installed and tested, no new installation.`,
      };
    }
    const lookup = this.deps.fetchFacts ?? fetchFacts;
    const assessments: CandidateAssessment[] = await Promise.all(
      entry.candidates.map(async (c) => assess(c, await lookup(c.package))),
    );
    return this.discoverAndInspect(entry.label, need, assessments, taskId, { source: 'catalog' });
  }

  /**
   * What the reviewed catalog does not know: look for it. Names come from a model, keyword
   * listings and the MCP registry; code then verifies every one on PyPI and ranks them. The
   * one that is chosen goes through the same offline inspection and the same approval as any
   * library, and its proposal says plainly that it was found, not reviewed.
   */
  private async prepareFromSearch(need: string, taskId: string) {
    const label = need
      .replace(/\s*\[(package|domains|secrets):[^\]]*\]|\s*\[mcp\]/g, '')
      .trim()
      .slice(0, 100);
    const result = await searchCapabilities(need, this.deps.search ?? {});
    await this.deps.events.append(taskId, 'capability.searched', 'capability-agent', {
      need: label,
      considered: result.considered,
      bySource: result.bySource,
      notes: result.notes,
      top: result.ranked.slice(0, 8).map((a) => ({
        package: a.package,
        eligible: a.eligible,
        score: a.score,
        downloads: a.downloads,
        foundBy: a.foundBy,
        reasons: a.reasons,
      })),
    });
    const usable = new Set(await this.enabledIds());
    // Something installed is reused only if it is about as good a fit as the best one found:
    // merely turning up in a search for something else does not make it the right tool.
    const best = result.ranked.find((a) => a.eligible && a.facts);
    const reusable =
      best &&
      result.ranked.find(
        (a) => a.eligible && usable.has(a.provides) && a.score >= best.score - REUSE_MARGIN,
      );
    if (reusable) {
      const record = await this.deps.store.get(reusable.provides);
      await this.deps.events.append(taskId, 'capability.reused', 'capability-agent', {
        capabilityId: reusable.provides,
        version: record?.version,
        state: record?.state,
      });
      return {
        kind: 'reuse' as const,
        capabilityId: reusable.provides,
        detail: `Reused ${reusable.package} ${record?.version ?? ''} (${record?.state}); it fits "${label}", is already installed and tested, no new installation.`,
      };
    }
    if (!result.ranked.some((a) => a.eligible && a.facts)) {
      const why = result.ranked
        .slice(0, 5)
        .map((a) => `${a.package} (${a.reasons.join('; ') || 'ineligible'})`)
        .join(', ');
      return {
        kind: 'unavailable' as const,
        detail: `Nothing found for "${label}" that passes the checks (looked at ${result.considered} names)${why ? `: ${why}` : ''}.${result.notes.length ? ` ${result.notes.join(' ')}` : ''}`,
      };
    }
    return this.discoverAndInspect(label, need, result.ranked, taskId, {
      source: 'search',
      considered: result.considered,
      bySource: result.bySource,
      notes: result.notes,
    });
  }

  private async discoverAndInspect(
    label: string,
    need: string,
    assessments: CandidateAssessment[],
    taskId: string,
    origin: {
      source: 'catalog' | 'search';
      considered?: number;
      bySource?: Record<string, number>;
      notes?: string[];
    },
  ) {
    const ranked = [...assessments].sort(
      (a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score,
    );
    await this.deps.events.append(taskId, 'capability.discovered', 'capability-agent', {
      need: label,
      candidates: ranked.map((a) => ({
        package: a.package,
        eligible: a.eligible,
        score: a.score,
        reasons: a.reasons,
      })),
    });
    // A server of this version that would not even start is not put before a person again, unless
    // this time it gets the key it may have been missing.
    const bringsKeys = neededSecrets(need).length > 0;
    const seen = await Promise.all(ranked.map((a) => this.deps.store.get(a.provides)));
    const eligible = ranked.filter(
      (a, i) =>
        a.eligible &&
        a.facts &&
        (bringsKeys ||
          !(
            seen[i]?.state === 'rejected' &&
            seen[i]?.version === a.facts.version &&
            (seen[i]?.tests as unknown[] | null)?.length
          )),
    );
    if (eligible.length === 0) {
      return {
        kind: 'unavailable' as const,
        detail: `No eligible candidate for "${label}": ${ranked.map((a) => `${a.package} (${a.reasons.join('; ') || 'ineligible'})`).join(', ')}.`,
      };
    }
    // What a search found may fail inspection (say, a dependency with a known vulnerability); the
    // next one that passed the same checks gets its turn. The reviewed catalog is judged as it is.
    // Only one about as good: a server for something else is no substitute for the one asked for.
    const top = ranked.find((a) => a.eligible && a.facts)?.score ?? 0;
    const turns =
      origin.source === 'search'
        ? eligible.filter((a) => a.score >= top - FALLBACK_MARGIN).slice(0, MAX_INSPECTED)
        : eligible.slice(0, 1);
    const failed: string[] = [];
    let judged = ranked;
    // One with known vulnerabilities is held back: a clean one of about the same fit goes first.
    let held: { kind: 'proposal'; proposal: CapabilityProposal } | undefined;
    const dropStaged = async (p: CapabilityProposal) => {
      const c = await this.deps.store.get(p.capabilityId);
      const volume = (c?.inspection as { node?: { volume?: string } } | null)?.node?.volume;
      if (volume) await this.deps.sandbox.runner.removeVolume(volume).catch(() => undefined);
    };
    for (const chosen of turns) {
      const outcome = await this.inspectCandidate(label, need, chosen, judged, taskId, origin);
      // Another task installed it while this one waited its turn.
      if (outcome.kind === 'reuse') {
        if (held) await dropStaged(held.proposal);
        return outcome;
      }
      if (outcome.kind === 'proposal') {
        const warned = (outcome.proposal as unknown as { warnings?: string[] }).warnings?.length;
        if (!warned) {
          if (held) await dropStaged(held.proposal);
          return outcome;
        }
        if (held) await dropStaged(outcome.proposal);
        else held = outcome;
        continue;
      }
      failed.push(outcome.detail);
      judged = judged.map((a) =>
        a === chosen ? { ...a, eligible: false, reasons: [...a.reasons, outcome.detail] } : a,
      );
    }
    if (held) return held;
    return { kind: 'unavailable' as const, detail: failed.join(' Next: ') };
  }

  private async inspectCandidate(
    label: string,
    need: string,
    chosen: CandidateAssessment,
    ranked: CandidateAssessment[],
    taskId: string,
    origin: {
      source: 'catalog' | 'search';
      considered?: number;
      bySource?: Record<string, number>;
      notes?: string[];
    },
  ) {
    if (!chosen.facts) {
      return { kind: 'unavailable' as const, detail: `${chosen.package}: no facts.` };
    }
    const id = chosen.provides;
    const facts = chosen.facts;
    return this.oneAtATime(id, async () => {
      const now = await this.deps.store.get(id);
      if (now && (await this.usable(now))) {
        return {
          kind: 'reuse' as const,
          capabilityId: id,
          detail: `Reused ${now.package} ${now.version}; it was installed meanwhile.`,
        };
      }
      const askedAt = this.asked.get(id);
      if (
        now?.state === 'inspected' &&
        now.version === facts.version &&
        askedAt !== undefined &&
        Date.now() - askedAt < ASKED_FOR_MS
      ) {
        return {
          kind: 'unavailable' as const,
          detail: `${chosen.package} ${facts.version} is already inspected and waits for the person's approval on its card. Do not start it again: wait until it is approved, then run the job once more.`,
        };
      }
      const made = await this.inspectChosen(
        label,
        need,
        { ...chosen, facts },
        ranked,
        taskId,
        origin,
      );
      if (made.kind === 'proposal') this.asked.set(id, Date.now());
      return made;
    });
  }

  private async inspectChosen(
    label: string,
    need: string,
    chosen: CandidateAssessment & { facts: NonNullable<CandidateAssessment['facts']> },
    ranked: CandidateAssessment[],
    taskId: string,
    origin: {
      source: 'catalog' | 'search';
      considered?: number;
      bySource?: Record<string, number>;
      notes?: string[];
    },
  ) {
    const id = chosen.provides;
    const version = chosen.facts.version;
    await this.deps.store.discover({
      id,
      need: label,
      package: chosen.package,
      version,
      license: chosen.facts.license,
      reason:
        origin.source === 'search'
          ? `Found by search (${origin.considered} names considered), best of ${ranked.length} verified for "${label}" (score ${chosen.score})`
          : `Best of ${ranked.length} candidates for "${need}" (score ${chosen.score})`,
      kind: chosen.kind ?? 'python-package',
      registry:
        chosen.mcp?.runtime === 'remote'
          ? 'hosted'
          : chosen.mcp?.runtime === 'node'
            ? 'npm'
            : 'pypi',
    });

    const dynamicMcp = chosen.kind === 'mcp-server' && chosen.mcp?.entry === DYNAMIC_ENTRY;
    const runtime = chosen.mcp?.runtime ?? 'python';
    const asked = {
      domains: [...new Set([...(chosen.mcp?.domains ?? []), ...neededDomains(need)])],
      secrets: [
        ...(chosen.mcp?.secrets ?? []),
        ...neededSecrets(need)
          .filter((n) => !(chosen.mcp?.secrets ?? []).some((s) => s.name === n))
          .map((name) => ({ name })),
      ],
    };
    if (runtime === 'remote' || runtime === 'node') {
      const staged =
        runtime === 'remote'
          ? await this.inspectHosted(id, chosen.mcp as McpLaunch, asked, taskId)
          : await this.inspectNode(
              id,
              chosen.package,
              version,
              chosen.mcp as McpLaunch,
              asked,
              taskId,
            );
      if (!staged.ok) return { kind: 'unavailable' as const, detail: staged.detail };
      return {
        kind: 'proposal' as const,
        proposal: this.proposalFor(id, label, chosen, version, ranked, origin, staged),
      };
    }

    const stagingDir = join(this.staging, `${id}-${version}`);
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });
    await chmod(stagingDir, 0o777);

    const download = await this.deps.sandbox.execute({
      taskId,
      kind: 'capability-inspect',
      label: `download ${chosen.package}==${version} (wheels only)`,
      code: withParams(DOWNLOAD, { requirement: `${chosen.package}==${version}` }),
      network: 'egress',
      writableMounts: [{ hostPath: stagingDir, containerPath: '/wheels' }],
      limits: { timeoutMs: 600_000, memoryMb: 1024, tmpMb: 512, pids: 128 },
    });
    await download.result.cleanup();
    if (download.result.status !== 'succeeded') {
      await this.deps.store.transition(
        id,
        'rejected',
        'Wheel download failed (no compatible wheels?)',
      );
      return {
        kind: 'unavailable' as const,
        detail: `Could not obtain wheels for ${chosen.package}: ${download.result.stderr.slice(-400)}`,
      };
    }

    const inspected = await this.inspectStaging(
      id,
      stagingDir,
      taskId,
      dynamicMcp ? { package: chosen.package, args: chosen.mcp?.args ?? [], ...asked } : undefined,
    );
    if (!inspected.ok) {
      return { kind: 'unavailable' as const, detail: inspected.detail };
    }
    return {
      kind: 'proposal' as const,
      proposal: this.proposalFor(id, label, chosen, version, ranked, origin, inspected),
    };
  }

  /** What the person is asked to approve. */
  private proposalFor(
    id: string,
    label: string,
    chosen: CandidateAssessment,
    version: string,
    ranked: CandidateAssessment[],
    origin: {
      source: 'catalog' | 'search';
      considered?: number;
      bySource?: Record<string, number>;
      notes?: string[];
    },
    inspected: { report: Record<string, unknown>; launch?: McpLaunch },
  ): CapabilityProposal {
    const dynamicMcp = chosen.kind === 'mcp-server' && !findCandidate(id)?.mcp;
    const started = inspected.launch;
    const proposal: CapabilityProposal = {
      capabilityId: id,
      need: label,
      ...(started?.secrets?.length ? { secrets: started.secrets } : {}),
      ...(started?.domains?.length ? { domains: started.domains } : {}),
      ...(started?.url ? { hostedAt: new URL(started.url).hostname, hostedUrl: started.url } : {}),
      ...(started?.runtime ? { runtime: started.runtime } : {}),
      source: origin.source,
      ...(origin.source === 'search'
        ? {
            considered: origin.considered ?? 0,
            foundBy: (chosen as { foundBy?: string[] }).foundBy ?? [],
            searchNotes: origin.notes ?? [],
          }
        : {}),
      package: chosen.package,
      version,
      summary: chosen.facts?.summary ?? '',
      fitNote: chosen.fitNote,
      candidates: ranked.map((a) => ({
        package: a.package,
        version: a.facts?.version ?? null,
        license: a.facts?.license ?? null,
        released: a.facts?.released ?? null,
        score: a.score,
        eligible: a.eligible,
        reasons: a.reasons,
        fitNote: a.fitNote,
      })),
      ...inspected.report,
      kind: chosen.kind ?? 'python-package',
      permissions: { network: 'none', filesystem: 'read-only layer', mountedAt: `/caps/${id}` },
      ...(chosen.mcp
        ? {
            mcp: dynamicMcp
              ? {
                  allowedTools: [],
                  launch:
                    started?.url ??
                    `${started?.script ?? started?.entry ?? '?'} ${(started?.args ?? []).join(' ')}`.trim(),
                  note: 'Runs as its own sandboxed process (no network, read-only, nothing but its own tools). Its tools are listed by the server itself after installation; only those can be called, and what they return is treated as data, never as instructions.',
                }
              : {
                  allowedTools: chosen.mcp.allowedTools,
                  launch: `${chosen.mcp.entry} ${chosen.mcp.args.join(' ')}`,
                  note: 'Runs as its own sandboxed process (no network); Reality calls only the allowed tools.',
                },
          }
        : {}),
      test: (() => {
        const t =
          REQUIREMENT_TESTS[id] ??
          MCP_REQUIREMENT_TESTS[id] ??
          (chosen.kind === 'mcp-server'
            ? (() => {
                const reviewed = reviewedById(id)?.test;
                return reviewed
                  ? { name: 'real-call', description: reviewed.description }
                  : GENERIC_MCP_TEST;
              })()
            : genericLibraryTest(id, chosen.package));
        return t ? { name: t.name, description: t.description } : null;
      })(),
    };
    return proposal;
  }

  /** Inspection + policy, as a separately testable step (fixtures can be staged directly). */
  async inspectStaging(
    id: string,
    stagingDir: string,
    taskId: string | null,
    /** An MCP server nobody reviewed: how to start it is read from its own console scripts. */
    mcp?: {
      package: string;
      args: string[];
      domains?: string[];
      secrets?: NonNullable<McpLaunch['secrets']>;
    },
  ): Promise<
    | { ok: true; report: Record<string, unknown>; launch?: McpLaunch }
    | { ok: false; detail: string }
  > {
    const inspection = await this.deps.sandbox.execute({
      taskId,
      kind: 'capability-inspect',
      label: `inspect ${id} wheels (offline)`,
      code: INSPECT,
      readOnlyMounts: [{ hostPath: stagingDir, containerPath: '/wheels' }],
      limits: { timeoutMs: 120_000, memoryMb: 1024 },
    });
    await inspection.result.cleanup();
    const wheels = (inspection.summary as { wheels?: WheelInfo[] } | undefined)?.wheels;
    if (inspection.result.status !== 'succeeded' || !wheels) {
      await this.deps.store.transition(id, 'rejected', 'Inspection failed');
      return {
        ok: false,
        detail: `Inspection of ${id} failed: ${inspection.result.stderr.slice(-400)}`,
      };
    }
    // An MCP server nobody reviewed: how to start it comes from its own wheel's console scripts.
    let launch: McpLaunch | undefined;
    if (mcp) {
      const own = wheels.find((w) => normalizeName(w.name ?? '') === normalizeName(mcp.package));
      launch = launchFromScripts(mcp.package, own?.scripts ?? [], mcp.args) ?? undefined;
      if (launch) {
        launch = {
          ...launch,
          ...(mcp.domains?.length ? { domains: mcp.domains } : {}),
          ...(mcp.secrets?.length ? { secrets: mcp.secrets } : {}),
        };
      }
      if (!launch) {
        await this.deps.store.transition(id, 'rejected', 'No console script to start it with');
        await rm(stagingDir, { recursive: true, force: true });
        return {
          ok: false,
          detail: `${mcp.package} declares no console script, so Reality has no way to start it as an MCP server.`,
        };
      }
    }
    const vulnerabilities = await (this.deps.queryOsv ?? queryOsv)(wheels);
    const policy = evaluatePolicy(wheels, vulnerabilities, undefined, mcp ? 'card' : 'reject');
    const warnings = mcp ? await describeAdvisories(vulnerabilities ?? []) : [];
    const fresh = wheels.filter((w) => !w.in_base);
    const report = {
      wheels: fresh.map((w) => ({
        name: w.name,
        version: w.version,
        license: w.license,
        sizeBytes: w.size,
        sha256: w.sha256,
        nativeLibs: w.native_libs,
      })),
      alreadyInBase: wheels.filter((w) => w.in_base).map((w) => `${w.name} ${w.version}`),
      totalNewBytes: fresh.reduce((n, w) => n + w.size, 0),
      vulnerabilities: vulnerabilities ?? 'unknown',
      flags: policy.flags,
      blocking: policy.blocking,
      ...(warnings.length ? { warnings } : {}),
    };
    if (taskId) {
      await this.deps.events.append(taskId, 'capability.inspected', 'capability-agent', {
        capabilityId: id,
        newPackages: fresh.length,
        flags: policy.flags.length,
        blocking: policy.blocking,
      });
    }
    if (policy.blocking.length > 0) {
      await this.deps.store.transition(id, 'rejected', `Policy: ${policy.blocking.join('; ')}`, {
        inspection: { wheels, vulnerabilities, ...policy },
      });
      if (taskId) {
        await this.deps.events.append(taskId, 'capability.rejected', 'capability-agent', {
          capabilityId: id,
          reasons: policy.blocking,
        });
      }
      await rm(stagingDir, { recursive: true, force: true });
      return { ok: false, detail: `Rejected ${id} at inspection: ${policy.blocking.join('; ')}` };
    }
    await this.deps.store.transition(
      id,
      'inspected',
      `${fresh.length} new packages inspected; ${policy.flags.length} flags`,
      {
        inspection: {
          wheels,
          vulnerabilities,
          ...policy,
          stagingDir,
          ...(launch ? { launch } : {}),
        },
      },
    );
    return { ok: true, report, ...(launch ? { launch } : {}) };
  }

  async install(proposal: CapabilityProposal, taskId: string) {
    return this.oneAtATime(proposal.capabilityId, () => this.installNow(proposal, taskId));
  }

  private async installNow(proposal: CapabilityProposal, taskId: string) {
    const id = proposal.capabilityId;
    this.asked.delete(id);
    const record = await this.deps.store.get(id);
    // Approved twice (two tasks asked for the same tool): the first install serves both.
    if (record && (await this.usable(record))) {
      return {
        ok: true as const,
        capabilityId: id,
        detail: `${record.package} ${record.version} is installed and tested already; it is used as it is.`,
      };
    }
    if (!record || record.state !== 'inspected') {
      return {
        ok: false as const,
        detail: `${id} is not awaiting installation (state ${record?.state ?? 'unknown'}).`,
      };
    }
    const inspection = record.inspection as {
      wheels: WheelInfo[];
      stagingDir?: string;
      launch?: McpLaunch;
      node?: { volume: string; tree: string };
    };
    const fresh = inspection.wheels.filter((w) => !w.in_base);
    const hosted = inspection.launch?.runtime === 'remote';

    // The files must be exactly what was inspected and approved (no swap after approval).
    if (inspection.node) {
      const tree = await this.nodeTree(inspection.node.volume, taskId);
      if (tree !== inspection.node.tree) {
        await this.fail(id, taskId, 'The staged packages changed after inspection');
        return {
          ok: false as const,
          detail: `Integrity check failed for ${id}; it changed after inspection.`,
        };
      }
    }
    for (const w of inspection.node || hosted ? [] : inspection.wheels) {
      const path = join(inspection.stagingDir ?? '', w.file);
      if (!existsSync(path) || (await sha256(path)) !== w.sha256) {
        await this.fail(id, taskId, `Staged file ${w.file} changed after inspection`);
        return {
          ok: false as const,
          detail: `Integrity check failed for ${w.file}; ${id} rejected.`,
        };
      }
    }

    const volume = inspection.node?.volume ?? volumeName(id, record.version);
    const layer: Mount = { volume, containerPath: '/layer' };
    const previousLayer = record.layerPath;
    const dropLayer = () =>
      hosted ? Promise.resolve() : this.deps.sandbox.runner.removeVolume(volume);
    // A Node server's layer is the volume it was inspected in; a hosted one has none.
    if (!inspection.node && !hosted) {
      const install = await this.deps.sandbox.execute({
        taskId,
        kind: 'capability-install',
        label: `install ${fresh.length} wheels into isolated layer (offline)`,
        code: withParams(INSTALL, { files: fresh.map((w) => w.file) }),
        readOnlyMounts: [{ hostPath: inspection.stagingDir ?? '', containerPath: '/wheels' }],
        writableMounts: [layer],
        limits: { timeoutMs: 900_000, memoryMb: 1024, tmpMb: 512, pids: 128 },
      });
      await install.result.cleanup();
      if (install.result.status !== 'succeeded') {
        await dropLayer();
        await this.fail(id, taskId, 'Installation failed');
        return {
          ok: false as const,
          detail: `Installation of ${id} failed: ${install.result.stderr.slice(-400)}`,
        };
      }
      await this.deps.events.append(taskId, 'capability.installed', 'capability-agent', {
        capabilityId: id,
        packages: fresh.map((w) => `${w.name} ${w.version}`),
        layerBytes: (install.summary as { layerBytes?: number } | undefined)?.layerBytes ?? null,
      });
    }

    const outcome =
      record.kind === 'mcp-server'
        ? await this.testMcp(id, volume, taskId)
        : await this.testLibrary(
            id,
            record.package,
            { volume, containerPath: record.permissions.path },
            taskId,
          );
    if (!outcome) {
      await dropLayer();
      await this.fail(id, taskId, 'No requirement test defined');
      return {
        ok: false as const,
        detail: `${id} has no requirement test, so it cannot be enabled.`,
      };
    }
    const { passed, tests, name } = outcome;
    await this.deps.events.append(taskId, 'capability.tested', 'capability-agent', {
      capabilityId: id,
      passed,
      result: tests[0]?.result ?? null,
    });
    if (!passed) {
      await dropLayer();
      await this.deps.store.transition(id, 'rejected', `Requirement test ${name} failed`, {
        tests,
      });
      await this.deps.events.append(taskId, 'capability.rejected', 'capability-agent', {
        capabilityId: id,
        reasons: ['requirement test failed'],
      });
      return {
        ok: false as const,
        detail: `${id} failed its requirement test (${name}); not enabled.${(() => {
          const said = (
            tests[0]?.result as { detail?: { error?: string; returned?: string } } | null
          )?.detail;
          const why = said?.error ?? said?.returned;
          return why ? ` It said: ${why.slice(0, 600)}` : '';
        })()}`,
      };
    }
    await this.deps.store.transition(id, 'tested', `Requirement test ${name} passed`, {
      tests,
      layerPath: hosted ? `${REMOTE_PREFIX}${inspection.launch?.url}` : `${VOLUME_PREFIX}${volume}`,
    });
    await this.deps.store.transition(id, 'enabled', 'Approved by user; installed and tested', {
      limitations:
        record.kind === 'mcp-server'
          ? [
              hosted
                ? `Hosted by someone else: what a bot sends goes to ${inspection.launch?.url}`
                : inspection.launch?.domains?.length
                  ? `Runs as its own sandboxed process, may reach only ${inspection.launch.domains.join(', ')}`
                  : 'Runs as its own sandboxed process, no network access',
              `Only these tools may be called: ${(findCandidate(id)?.mcp?.allowedTools ?? ((tests[0]?.result as { tools?: { name: string }[] } | null)?.tools ?? []).map((t) => t.name)).join(', ')}`,
              'Tool descriptions from the server are treated as untrusted data',
            ]
          : ['Runs only inside the sandbox, mounted read-only', 'No network access at runtime'],
    });
    if (inspection.stagingDir) {
      await rm(inspection.stagingDir, { recursive: true, force: true });
    }
    // This instance's earlier layer for the same capability is no longer referenced.
    if (previousLayer?.startsWith(VOLUME_PREFIX) && previousLayer !== `${VOLUME_PREFIX}${volume}`) {
      await this.deps.sandbox.runner
        .removeVolume(previousLayer.slice(VOLUME_PREFIX.length))
        .catch(() => undefined);
    }
    await this.deps.events.append(taskId, 'capability.enabled', 'capability-agent', {
      capabilityId: id,
      version: record.version,
    });
    const modules = (tests[0]?.result as { modules?: string[] } | null)?.modules ?? [];
    const serverTools = (
      (tests[0]?.result as { tools?: { name: string }[] } | null)?.tools ?? []
    ).map((t) => t.name);
    const how =
      record.kind === 'mcp-server'
        ? ` Use it with mcp_call server "${id}"${serverTools.length ? `; tools: ${serverTools.join(', ')}` : ''}.`
        : ` Use it with run_python libraries ["${id}"]${modules.length ? `; import ${modules.join(', ')}` : ''}.`;
    return {
      ok: true as const,
      capabilityId: id,
      detail: `${hosted ? `Connected to ${record.package}, hosted by someone else` : `Installed ${record.package} ${record.version} with ${fresh.length} new packages in an isolated read-only layer`}; requirement test "${name}" passed.${how}`,
    };
  }

  private async testLibrary(id: string, pkg: string, mount: Mount, taskId: string) {
    const test = REQUIREMENT_TESTS[id] ?? genericLibraryTest(id, pkg);
    const run = await this.deps.sandbox.execute({
      taskId,
      kind: 'capability-test',
      label: `test ${id}: ${test.name}`,
      code: test.code,
      readOnlyMounts: [mount],
      limits: { timeoutMs: 180_000, memoryMb: 1024 },
    });
    await run.result.cleanup();
    const result = run.summary as { passed?: boolean } | undefined;
    const passed = run.result.status === 'succeeded' && result?.passed === true;
    return {
      name: test.name,
      passed,
      tests: [
        {
          name: test.name,
          description: test.description,
          passed,
          result: result ?? null,
          runId: run.record.id,
        },
      ],
    };
  }

  /** Starts the MCP server from its layer in the sandbox and calls the approved tool on known data. */
  private async testMcp(id: string, volume: string, taskId: string) {
    const test = MCP_REQUIREMENT_TESTS[id];
    const launch = findCandidate(id)?.mcp;
    if (!test || !launch) return this.testUnreviewedMcp(id, volume, taskId);
    const started = Date.now();
    const dir = join(this.staging, `mcp-test-${id}-${started}`);
    await mkdir(dir, { recursive: true });
    const csv = join(dir, 'data.csv');
    await writeFile(csv, test.csv);
    let result: {
      passed: boolean;
      detail: unknown;
      tools?: { name: string; description: string }[];
    };
    try {
      result = await this.withServer(
        id,
        `${VOLUME_PREFIX}${volume}`,
        launch,
        [{ name: 'data.csv', hostPath: csv }],
        async (s) => {
          const offered = s.tools.map((t) => t.name);
          const missing = launch.allowedTools.filter((t) => !offered.includes(t));
          if (missing.length > 0) {
            return { passed: false, detail: { missingTools: missing, offered }, tools: s.tools };
          }
          const call = await s.call(test.tool, test.args);
          const checked = call.isError
            ? { passed: false, detail: { error: call.text.slice(0, 500) } }
            : test.check(call.text);
          return { ...checked, tools: s.tools };
        },
      );
    } catch (err) {
      result = { passed: false, detail: { error: (err as Error).message.slice(0, 1500) } };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const record = await this.deps.runs.insert({
      id: randomUUID(),
      taskId,
      stepId: null,
      kind: 'capability-test',
      label: `test ${id}: ${test.name} (MCP)`,
      code: JSON.stringify({ tool: test.tool, arguments: test.args }, null, 2),
      image: this.deps.sandbox.runner.image,
      status: result.passed ? 'succeeded' : 'failed',
      exitCode: null,
      stdout: JSON.stringify(result.detail),
      stderr: '',
      durationMs: Date.now() - started,
      inputs: ['data.csv'],
      outputs: [],
      summary: result,
    });
    return {
      name: test.name,
      passed: result.passed,
      tests: [
        {
          name: test.name,
          description: test.description,
          passed: result.passed,
          result: { detail: result.detail, tools: result.tools ?? [] },
          runId: record.id,
        },
      ],
    };
  }

  /**
   * An MCP server found by search: nobody wrote a test for its tools. It must start in the
   * sandbox (no network) and list at least one tool; the tools it lists become the only ones that
   * can be called. What they do is not vouched for: that shows in use, and what they return is data.
   */
  private async testUnreviewedMcp(id: string, volume: string, taskId: string) {
    const record = await this.deps.store.get(id);
    const found = (record?.inspection as { launch?: McpLaunch } | null)?.launch;
    if (!record || !found) return undefined;
    const started = Date.now();
    let result: {
      passed: boolean;
      detail: unknown;
      tools?: { name: string; description: string }[];
    };
    try {
      const layerPath =
        found.runtime === 'remote' ? `${REMOTE_PREFIX}${found.url}` : `${VOLUME_PREFIX}${volume}`;
      const check = reviewedById(id)?.test;
      const allowed = check ? { ...found, allowedTools: [check.tool] } : found;
      result = await this.withServer(id, layerPath, allowed, [], async (s) => {
        const tools = s.tools.slice(0, 40).map((t) => ({
          name: t.name,
          description: t.description.slice(0, 300),
        }));
        if (!check) {
          return { passed: s.tools.length > 0, detail: { toolCount: s.tools.length }, tools };
        }
        // Known to work when it was reviewed; it must still, against the real service.
        const call = await s.call(check.tool, check.args);
        return {
          passed: !call.isError && check.expect.test(call.text),
          detail: { tool: check.tool, returned: call.text.slice(0, 600) },
          tools,
        };
      });
    } catch (err) {
      const values = Object.values((await this.deps.secrets?.reveal(id)) ?? {});
      result = {
        passed: false,
        detail: { error: scrubSecrets((err as Error).message, values).slice(0, 1500) },
      };
    }
    const run = await this.deps.runs.insert({
      id: randomUUID(),
      taskId,
      stepId: null,
      kind: 'capability-test',
      label: `test ${id}: ${GENERIC_MCP_TEST.name} (MCP)`,
      code: JSON.stringify({ start: found.entry, arguments: found.args }, null, 2),
      image: this.deps.sandbox.runner.image,
      status: result.passed ? 'succeeded' : 'failed',
      exitCode: null,
      stdout: JSON.stringify(result.detail),
      stderr: '',
      durationMs: Date.now() - started,
      inputs: [],
      outputs: [],
      summary: result,
    });
    return {
      name: GENERIC_MCP_TEST.name,
      passed: result.passed,
      tests: [
        {
          name: GENERIC_MCP_TEST.name,
          description: GENERIC_MCP_TEST.description,
          passed: result.passed,
          result: { detail: result.detail, tools: result.tools ?? [] },
          runId: run.id,
        },
      ],
    };
  }

  /**
   * Runs `fn` against a server, whichever way it runs: hosted, or in the sandbox, with the
   * gateway as its only way out when a person allowed it domains. Secrets are fetched here and go
   * no further than the server. `onRefused` hears which hosts the gateway turned away.
   */
  private async withServer<T>(
    id: string,
    layerPath: string,
    launch: McpLaunch,
    inputs: RunInput[],
    fn: (s: McpSession) => Promise<T>,
    onRefused?: (hosts: string[]) => void,
  ): Promise<T> {
    const wanted = launch.secrets ?? [];
    const stored = wanted.length > 0 ? ((await this.deps.secrets?.reveal(id)) ?? {}) : {};
    const missing = wanted.filter((s) => !stored[s.name]).map((s) => s.name);
    if (missing.length > 0) {
      throw new Error(`It needs ${missing.join(', ')}, and the person has not given that.`);
    }
    const secrets = Object.fromEntries(
      wanted.flatMap((s) => {
        const value = stored[s.name];
        return value ? [[s.name, value] as const] : [];
      }),
    );
    if (launch.runtime === 'remote') {
      return withRemoteSession({ capabilityId: id, launch, secrets }, fn);
    }
    const layer = layerPath.startsWith(VOLUME_PREFIX)
      ? { volume: layerPath.slice(VOLUME_PREFIX.length) }
      : { hostPath: layerPath };
    const image = launch.runtime === 'node' ? (this.deps.nodeImage ?? NODE_IMAGE) : undefined;
    const base = {
      capabilityId: id,
      layer,
      launch,
      inputs,
      secrets,
      ...(image ? { image } : {}),
    };
    if (!launch.domains?.length) {
      return withMcpSession(this.deps.sandbox.runner, base, fn);
    }
    const access = this.deps.toolAccess?.();
    if (!access) {
      throw new Error('It needs the internet, and the gateway is off here (COMPUTERS=off).');
    }
    const name = `reality-tool-${randomBytes(8).toString('hex')}`;
    const opened = await access.openToolAccess(name, launch.domains);
    try {
      return await withMcpSession(
        this.deps.sandbox.runner,
        { ...base, name, egress: { network: opened.network, proxy: opened.proxy } },
        fn,
      );
    } finally {
      const refused = await access.closeToolAccess(name, opened.mark);
      if (refused.length > 0) onRefused?.(refused);
    }
  }

  /** Stores what a person typed on the approval card: only the names that server declared. */
  async setSecrets(id: string, values: Record<string, string>, owner: string | null) {
    const c = await this.deps.store.get(id);
    const launch = c ? this.launchOf(c) : undefined;
    if (!c || !launch || !this.deps.secrets) throw new Error(`${id} takes no secrets.`);
    const declared = new Set((launch.secrets ?? []).map((s) => s.name));
    const stored: string[] = [];
    for (const [name, value] of Object.entries(values)) {
      if (!declared.has(name) || !value.trim()) continue;
      await this.deps.secrets.set(id, name, value.trim(), owner);
      stored.push(name);
    }
    return stored;
  }

  /** A person let a tool server reach one more domain. It is on the list from the next call. */
  async allowDomain(id: string, domain: string): Promise<string> {
    const c = await this.deps.store.get(id);
    const inspection = c?.inspection as { launch?: McpLaunch } | null;
    if (!c || !inspection?.launch) throw new Error(`${id} is not a tool server found by search.`);
    const d = domain.trim().toLowerCase();
    if (!/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(d)) {
      throw new Error(`"${domain}" is not a domain name.`);
    }
    const domains = [...new Set([...(inspection.launch.domains ?? []), d])];
    await this.deps.store.setInspection(id, {
      ...inspection,
      launch: { ...inspection.launch, domains },
    });
    return d;
  }

  /** A hosted server: nothing to download or run here. What matters goes on the card. */
  private async inspectHosted(
    id: string,
    launch: McpLaunch,
    asked: { domains: string[]; secrets: NonNullable<McpLaunch['secrets']> },
    taskId: string,
  ) {
    const host = new URL(launch.url ?? '').hostname;
    const final: McpLaunch = {
      ...launch,
      entry: '',
      ...(asked.secrets.length ? { secrets: asked.secrets } : {}),
    };
    await this.deps.store.transition(id, 'inspected', `Hosted at ${host}`, {
      inspection: { wheels: [], vulnerabilities: [], blocking: [], flags: [], launch: final },
    });
    await this.deps.events.append(taskId, 'capability.inspected', 'capability-agent', {
      capabilityId: id,
      hostedAt: host,
    });
    return {
      ok: true as const,
      launch: final,
      report: {
        wheels: [],
        alreadyInBase: [],
        totalNewBytes: 0,
        vulnerabilities: [],
        flags: [`Hosted by someone else: everything a bot sends to it goes to ${host}.`],
        blocking: [],
      },
    };
  }

  /** The hash of everything in a Node layer, computed in the sandbox with no network. */
  private async nodeTree(volume: string, taskId: string | null): Promise<string | null> {
    const run = await this.deps.sandbox.execute({
      taskId,
      kind: 'capability-inspect',
      label: 'hash the staged Node packages (offline)',
      code: NODE_TREE,
      readOnlyMounts: [{ volume, containerPath: '/layer' }],
      limits: { timeoutMs: 300_000, memoryMb: 512 },
    });
    await run.result.cleanup();
    return (run.summary as { tree?: string } | undefined)?.tree ?? null;
  }

  /**
   * A server from npm: installed with its install scripts switched off (so none of its code runs),
   * into a volume that becomes its layer if the person approves. Parsed as data, like a wheel.
   */
  private async inspectNode(
    id: string,
    pkg: string,
    version: string,
    launch: McpLaunch,
    asked: { domains: string[]; secrets: NonNullable<McpLaunch['secrets']> },
    taskId: string,
  ) {
    const image = this.deps.nodeImage ?? NODE_IMAGE;
    const fail = async (reason: string) => {
      await this.deps.store.transition(id, 'rejected', reason);
      return { ok: false as const, detail: reason };
    };
    if (!(await this.deps.sandbox.runner.imageExists(image))) {
      return fail(`Node servers need the image ${image}: run npm run sandbox:build.`);
    }
    const volume = volumeName(id, version);
    await this.deps.sandbox.runner.removeVolume(volume).catch(() => undefined);
    const stage = async (overrides?: Record<string, string>) => {
      const download = await this.deps.sandbox.execute({
        taskId,
        kind: 'capability-inspect',
        label: `download ${pkg}@${version} (install scripts off)${overrides ? ', known vulnerabilities fixed' : ''}`,
        code: withParams(NPM_STAGE, { spec: `${pkg}@${version}`, overrides }),
        image,
        network: 'egress',
        writableMounts: [{ volume, containerPath: '/layer' }],
        limits: { timeoutMs: 600_000, memoryMb: 1024, tmpMb: 512, pids: 256 },
      });
      await download.result.cleanup();
      if (download.result.status !== 'succeeded') {
        return { error: `Could not obtain ${pkg}: ${download.result.stderr.slice(-300)}` };
      }
      const inspection = await this.deps.sandbox.execute({
        taskId,
        kind: 'capability-inspect',
        label: `inspect ${pkg} (offline)`,
        code: withParams(NPM_INSPECT, { package: pkg }),
        readOnlyMounts: [{ volume, containerPath: '/layer' }],
        limits: { timeoutMs: 300_000, memoryMb: 512 },
      });
      await inspection.result.cleanup();
      const staged = inspection.summary as
        { wheels?: WheelInfo[]; tree?: string; bin?: unknown; scripts?: string[] } | undefined;
      const script = scriptFromBin(pkg, staged?.bin);
      if (inspection.result.status !== 'succeeded' || !staged?.wheels || !staged.tree || !script) {
        return { error: `${pkg} declares no program to start, or could not be inspected.` };
      }
      return {
        wheels: staged.wheels,
        tree: staged.tree,
        script,
        scripts: staged.scripts ?? [],
        vulnerabilities: await queryOsv(staged.wheels, fetch, 'npm'),
      };
    };
    const first = await stage();
    if ('error' in first) {
      await this.deps.sandbox.runner.removeVolume(volume).catch(() => undefined);
      return fail(String(first.error));
    }
    // A vulnerable dependency with a fix in the same major version: take the fix, and judge again.
    const fixes = first.vulnerabilities?.some((v) => v.ids.length > 0)
      ? await sameMajorFixes(first.vulnerabilities)
      : null;
    const fixing = fixes && Object.keys(fixes).length > 0 ? fixes : null;
    const second = fixing ? await stage(fixing) : first;
    if ('error' in second) {
      await this.deps.sandbox.runner.removeVolume(volume).catch(() => undefined);
      return fail(String(second.error));
    }
    const found = second;
    const { script, vulnerabilities } = found;
    const policy = evaluatePolicy(found.wheels, vulnerabilities, undefined, 'card');
    const warnings = await describeAdvisories(vulnerabilities ?? []);
    if (fixing) {
      const was = (name: string) => first.wheels.find((w) => w.name === name)?.version ?? '?';
      policy.flags.push(
        `Dependencies updated to fix known vulnerabilities (not what its authors shipped): ${Object.entries(
          fixing,
        )
          .map(([name, to]) => `${name} ${was(name)} to ${to}`)
          .join(', ')}.`,
      );
    }
    if ((found.scripts ?? []).length > 0) {
      policy.flags.push(
        `Install scripts were not run for: ${(found.scripts ?? []).slice(0, 8).join(', ')}. If one is needed, the server will not start.`,
      );
    }
    if (policy.blocking.length > 0) {
      await this.deps.sandbox.runner.removeVolume(volume).catch(() => undefined);
      return fail(`Rejected ${id} at inspection: ${policy.blocking.join('; ')}`);
    }
    const final: McpLaunch = {
      ...launch,
      entry: '',
      script: `node_modules/${pkg}/${script}`,
      ...(asked.domains.length ? { domains: asked.domains } : {}),
      ...(asked.secrets.length ? { secrets: asked.secrets } : {}),
    };
    await this.deps.store.transition(
      id,
      'inspected',
      `${found.wheels.length} new packages inspected`,
      {
        inspection: {
          wheels: found.wheels,
          vulnerabilities,
          ...policy,
          launch: final,
          node: { volume, tree: found.tree },
        },
      },
    );
    return {
      ok: true as const,
      launch: final,
      report: {
        wheels: found.wheels.map((w) => ({
          name: w.name,
          version: w.version,
          license: w.license,
          sizeBytes: w.size,
          sha256: w.sha256,
          nativeLibs: w.native_libs,
        })),
        alreadyInBase: [],
        totalNewBytes: found.wheels.reduce((n, w) => n + w.size, 0),
        vulnerabilities: vulnerabilities ?? 'unknown',
        flags: policy.flags,
        blocking: policy.blocking,
        ...(warnings.length ? { warnings } : {}),
      },
    };
  }

  /**
   * Calls an approved tool of an enabled MCP capability for a task step. The server
   * runs sandboxed with the task's data mounted read-only. Returns the tool's text.
   */
  async callTool(
    capabilityId: string,
    tool: string,
    args: Record<string, unknown>,
    inputs: RunInput[],
    owner?: string | null,
    /** Gets every file the tool produced, while it still exists. */
    save?: (file: { name: string; path: string }) => Promise<void>,
  ): Promise<
    | { ok: true; text: string; refused?: string[]; files?: string[] }
    | { ok: false; detail: string; refused?: string[] }
  > {
    const c = await this.deps.store.get(capabilityId);
    const launch = c ? this.launchOf(c) : undefined;
    if (!c || c.kind !== 'mcp-server' || !launch || !c.layerPath || !(await this.usable(c))) {
      return { ok: false, detail: `${capabilityId} is not an enabled MCP capability.` };
    }
    if (launch.runtime === 'remote' && inputs.length > 0) {
      return {
        ok: false,
        detail: `${capabilityId} is hosted by someone else, and files are not sent to third parties this way. Use a server that runs here.`,
      };
    }
    // The reviewed SQL server reads its one table from this name.
    const named =
      capabilityId === 'mcp-server-motherduck' && inputs.length === 1 && inputs[0]
        ? [{ ...inputs[0], name: 'data.csv' }]
        : inputs;
    // A server holding someone's key works only for them.
    const holders = (await this.deps.secrets?.names(capabilityId)) ?? [];
    if (owner !== undefined && holders.some((h) => h.owner !== null && h.owner !== owner)) {
      return { ok: false, detail: `${capabilityId} holds another person's key.` };
    }
    const values = holders.length
      ? Object.values((await this.deps.secrets?.reveal(capabilityId)) ?? {})
      : [];
    let refused: string[] = [];
    try {
      const result = await this.withServer(
        capabilityId,
        c.layerPath,
        launch,
        named,
        async (s) => {
          const r = await s.call(tool, args);
          return { ...r, files: save ? await collectToolFiles(s.outputDir, r.blobs, save) : [] };
        },
        (hosts) => {
          refused = hosts;
        },
      );
      const text = scrubSecrets(result.text, values);
      if (result.isError) return { ok: false, detail: text.slice(0, 2000), refused };
      await this.recordUse([capabilityId]);
      return { ok: true, text, refused, ...(result.files.length ? { files: result.files } : {}) };
    } catch (err) {
      return {
        ok: false,
        detail: scrubSecrets((err as Error).message, values).slice(0, 2000),
        refused,
      };
    }
  }

  /** A user denial applies to this task only; the capability is not condemned globally. */
  async reject(proposal: CapabilityProposal, taskId: string, note?: string) {
    const id = proposal.capabilityId;
    await this.deps.store.note(id, `Denied by user for task ${taskId}${note ? `: ${note}` : ''}`);
    // A Node server's staged packages live in a volume; nobody will come back for them.
    const staged = (await this.deps.store.get(id))?.inspection as {
      node?: { volume?: string };
    } | null;
    if (staged?.node?.volume) {
      await this.deps.sandbox.runner.removeVolume(staged.node.volume).catch(() => undefined);
    }
    await this.deps.events.append(taskId, 'capability.rejected', 'capability-agent', {
      capabilityId: id,
      scope: 'task',
      reasons: [note ?? 'denied by user'],
    });
  }

  /** An internal failure (integrity, install, missing test) rejects the capability. */
  private async fail(id: string, taskId: string, reason: string) {
    await this.deps.store.transition(id, 'rejected', reason);
    await this.deps.events.append(taskId, 'capability.rejected', 'capability-agent', {
      capabilityId: id,
      scope: 'global',
      reasons: [reason],
    });
  }
}
