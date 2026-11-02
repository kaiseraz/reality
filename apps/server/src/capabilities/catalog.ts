import type { McpLaunch } from './mcp.ts';

/**
 * Allowlisted discovery sources for the MVP: a curated catalog that maps capability
 * needs to known candidate packages, enriched with live PyPI metadata. Open-ended
 * search of the whole package index is deliberately out of scope (see ADR 0007).
 */
export interface CatalogCandidate {
  package: string;
  /** Python library (mounted for recipes) or MCP server (called as a tool). Default: library. */
  kind?: 'python-package' | 'mcp-server';
  /** For MCP servers: the reviewed launch configuration. Without it a server is ineligible. */
  mcp?: McpLaunch;
  /** Capability id this candidate provides (what recipes declare in `requires`). */
  provides: string;
  /** How well it fits the need, judged when the catalog entry was reviewed (0..1). */
  fit: number;
  fitNote: string;
}

export interface CatalogEntry {
  need: RegExp;
  label: string;
  candidates: CatalogCandidate[];
}

export const CATALOG: CatalogEntry[] = [
  {
    need: /time.?series (decomposition|forecasting)|seasonal|stl|decompos|forecast/i,
    label: 'time-series decomposition and forecasting',
    candidates: [
      {
        package: 'statsmodels',
        provides: 'statsmodels',
        fit: 1,
        fitNote:
          'Provides STL seasonal-trend decomposition (statsmodels.tsa.seasonal.STL) and Holt-Winters forecasting (statsmodels.tsa.holtwinters).',
      },
      {
        package: 'pmdarima',
        provides: 'pmdarima',
        fit: 0.5,
        fitNote:
          'ARIMA toolkit; decomposition is a secondary feature and it depends on statsmodels anyway.',
      },
      {
        package: 'prophet',
        provides: 'prophet',
        fit: 0.4,
        fitNote:
          'Forecasting model with seasonality components, not a classical decomposition; heavy Stan backend.',
      },
    ],
  },
];

CATALOG.push({
  need: /chem|molecul|smiles|rdkit|cheminformatics/i,
  label: 'cheminformatics',
  candidates: [
    {
      package: 'rdkit',
      provides: 'rdkit',
      fit: 1,
      fitNote:
        'The standard open-source cheminformatics toolkit: SMILES parsing, descriptors (MolWt, logP, TPSA), 3D embedding (ETKDG) and the MMFF94 force field. BSD-3-Clause, wheels for Linux.',
    },
  ],
});

CATALOG.push({
  need: /\bcad\b|b-?rep|solid model|step file|opencascade|geometry kernel|3d model/i,
  label: 'cad',
  candidates: [
    {
      package: 'cadquery-ocp-novtk',
      provides: 'ocp',
      fit: 1,
      fitNote:
        'Python bindings (OCP) for the Open CASCADE Technology geometry kernel: B-rep solids, booleans, lofts, meshing and STEP export with part names. The bindings are Apache-2.0; the bundled OCCT libraries are LGPL-2.1 with the OCCT exception, used unmodified as a separate library (allowed by the owner).',
    },
  ],
});

CATALOG.push({
  need: /thermochem|combustion|equilibrium|propellant|rocket engine|cantera/i,
  label: 'combustion',
  candidates: [
    {
      package: 'cantera',
      provides: 'cantera',
      fit: 1,
      fitNote:
        'Open-source chemical kinetics and thermodynamics (BSD-3-Clause): Gibbs-minimising chemical equilibrium, the NASA thermo database (nasa_gas.yaml, 200-6000 K) and transport properties; wheels for Linux.',
    },
  ],
});

/** Read-only SQL over the task's CSV, exposed as table "data" in an in-memory DuckDB. */
export const DUCKDB_INIT_SQL = [
  'SET autoinstall_known_extensions = false',
  'SET autoload_known_extensions = false',
  "CREATE VIEW data AS SELECT * FROM read_csv('/input/data.csv', auto_detect = true)",
].join('; ');

CATALOG.push({
  need: /sql|query|queries|duckdb/i,
  label: 'sql queries',
  candidates: [
    {
      package: 'mcp-server-motherduck',
      provides: 'mcp-server-motherduck',
      kind: 'mcp-server',
      fit: 1,
      fitNote:
        'MCP server by MotherDuck for local DuckDB: execute_query runs DuckDB SQL; read-only by default, maintained.',
      mcp: {
        entry: 'mcp_server_motherduck:main',
        // In-memory database (needs --read-write; discarded with the container) holding a
        // view over the read-only mounted CSV. No network, extension downloads disabled.
        args: [
          '--transport',
          'stdio',
          '--db-path',
          ':memory:',
          '--read-write',
          '--home-dir',
          '/tmp',
          '--max-rows',
          '10000',
          '--max-chars',
          '5000000',
          '--init-sql',
          DUCKDB_INIT_SQL,
        ],
        allowedTools: ['execute_query'],
      },
    },
    {
      package: 'mcp-server-duckdb',
      provides: 'mcp-server-duckdb',
      kind: 'mcp-server',
      fit: 0.8,
      fitNote: 'DuckDB MCP server (community); no release since May 2025.',
    },
    {
      package: 'mcp-server-sqlite',
      provides: 'mcp-server-sqlite',
      kind: 'mcp-server',
      fit: 0.6,
      fitNote: 'Official MCP reference server for SQLite (archived); would need CSV import first.',
    },
  ],
});

export function findCandidate(id: string): CatalogCandidate | undefined {
  return CATALOG.flatMap((e) => e.candidates).find((c) => c.provides === id);
}

export function findCatalogEntry(need: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.need.test(need));
}

/** Facts about a candidate's latest release, from the PyPI JSON API. */
export interface PackageFacts {
  package: string;
  version: string;
  license: string;
  released: string | null;
  hasCompatibleWheel: boolean;
  /** When the very first release went up (from the release list), if PyPI gives it. */
  firstReleased?: string | null;
  dependencies: number;
  requiresPython: string | null;
  summary: string;
}

export interface CandidateAssessment extends CatalogCandidate {
  facts: PackageFacts | null;
  eligible: boolean;
  reasons: string[];
  score: number;
}

const PERMISSIVE =
  /\b(BSD|MIT|Apache|PSF|Python Software Foundation|ISC|MPL|Unlicense|0BSD|zlib)\b/i;
// "GPLv3" and "GNU General Public License" are how PyPI classifiers really read, so no word
// boundary after the abbreviation.
const COPYLEFT = /\b(A?GPL|LGPL)|GNU (Lesser |Affero )?General Public|copyleft/i;

export type LicenseClass = 'permissive' | 'copyleft' | 'unknown';
export function classifyLicense(text: string): LicenseClass {
  if (!text.trim()) return 'unknown';
  if (COPYLEFT.test(text) && !PERMISSIVE.test(text)) return 'copyleft';
  if (PERMISSIVE.test(text)) return 'permissive';
  return 'unknown';
}

/** Linux x86_64 wheel for CPython 3.12, or a pure-Python wheel. */
const COMPATIBLE_WHEEL =
  /(-cp312-cp312-manylinux[^ ]*x86_64|-py3-none-any|-py2\.py3-none-any|-cp312-abi3-manylinux[^ ]*x86_64)\.whl$/;

interface PyPiJson {
  info: {
    version: string;
    license?: string | null;
    license_expression?: string | null;
    classifiers?: string[];
    requires_dist?: string[] | null;
    requires_python?: string | null;
    summary?: string | null;
  };
  urls: { filename: string; packagetype: string; upload_time_iso_8601?: string }[];
  releases?: Record<string, { upload_time_iso_8601?: string }[]>;
}

export function factsFromPyPi(pkg: string, json: PyPiJson): PackageFacts {
  const licenseClassifiers = (json.info.classifiers ?? [])
    .filter((c) => c.startsWith('License ::'))
    .map((c) => c.split('::').at(-1)?.trim() ?? '');
  const licenseText =
    json.info.license_expression ||
    (json.info.license && json.info.license.length < 200 ? json.info.license : '') ||
    licenseClassifiers.join(', ');
  const released =
    json.urls
      .map((u) => u.upload_time_iso_8601)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
  return {
    package: pkg,
    version: json.info.version,
    license: licenseText || 'unknown',
    released,
    firstReleased:
      Object.values(json.releases ?? {})
        .flat()
        .map((u) => u.upload_time_iso_8601)
        .filter((t): t is string => Boolean(t))
        .sort()
        .at(0) ?? null,
    hasCompatibleWheel: json.urls.some(
      (u) => u.packagetype === 'bdist_wheel' && COMPATIBLE_WHEEL.test(u.filename),
    ),
    dependencies: (json.info.requires_dist ?? []).filter((d) => !d.includes('extra ==')).length,
    requiresPython: json.info.requires_python ?? null,
    summary: json.info.summary ?? '',
  };
}

/**
 * Deterministic comparison. Hard requirements: a compatible wheel (no install-time
 * code) and a license that is not copyleft. Score: fit, then maintenance recency,
 * then a small penalty for dependency count.
 */
export function assess(
  candidate: CatalogCandidate,
  facts: PackageFacts | null,
  now = Date.now(),
): CandidateAssessment {
  const reasons: string[] = [];
  if (!facts) {
    return {
      ...candidate,
      facts,
      eligible: false,
      reasons: ['Package metadata unavailable'],
      score: 0,
    };
  }
  if (candidate.kind === 'mcp-server' && !candidate.mcp) {
    reasons.push(
      'No reviewed launch configuration (arguments and allowed tools) for this MCP server',
    );
  }
  if (!facts.hasCompatibleWheel)
    reasons.push('No compatible wheel (would require running build scripts)');
  const license = classifyLicense(facts.license);
  if (license === 'copyleft')
    reasons.push(`Copyleft license (${facts.license}) needs legal review`);
  const ageDays = facts.released ? (now - Date.parse(facts.released)) / 86_400_000 : Infinity;
  const recency = ageDays < 365 ? 1 : ageDays < 730 ? 0.6 : 0.2;
  const score = candidate.fit * 0.7 + recency * 0.25 - Math.min(facts.dependencies, 20) * 0.0025;
  return {
    ...candidate,
    facts,
    eligible: reasons.length === 0,
    reasons,
    score: Number(score.toFixed(4)),
  };
}

export async function fetchFacts(
  pkg: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PackageFacts | null> {
  try {
    const res = await fetchImpl(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return factsFromPyPi(pkg, (await res.json()) as PyPiJson);
  } catch {
    return null;
  }
}
