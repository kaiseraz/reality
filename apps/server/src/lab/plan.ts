import type pg from 'pg';
import {
  PlannerError,
  type Planner,
  type PlannerInput,
  type PlannerOutput,
} from '../planner/planner.ts';
import { getLabEngine, LAB_ENGINES, MOLECULES, MORSE } from './engines.ts';

/**
 * Plans for the lab. A simulation becomes an ordinary task: acquire the engine's library
 * if it is missing (with the user's approval), run the engine in the sandbox, verify its
 * claims independently. The same plan is used whoever asked: a bot in a chat (preset), the
 * rule-based planner (keywords below) or a model (which may also plan lab steps itself).
 */
export function labPlan(
  engineName: string,
  raw: Record<string, unknown>,
  request: string,
  available: readonly string[],
  model: string,
): PlannerOutput {
  const engine = getLabEngine(engineName);
  if (!engine) throw new PlannerError(`Unknown lab engine "${engineName}".`, false);
  // Defaults filled in, so the simulation and its check see the same parameters.
  const parsed = engine.params.safeParse(raw);
  const params = parsed.success ? parsed.data : raw;
  const missing = engine.requires.filter((c) => !available.includes(c));
  const steps: Record<string, unknown>[] = [];
  if (missing.length > 0 && engine.need) {
    steps.push({
      id: 'acquire',
      description: `Acquire and test a ${engine.need} library`,
      agent: 'capability-agent',
      dependsOn: [],
      capability: engine.need,
    });
  }
  steps.push(
    {
      id: 'simulate',
      description: `${engine.title}: ${describe(engine.name, params)}`,
      agent: 'lab-agent',
      dependsOn: steps.map((s) => s.id),
      recipe: { name: engine.name, params },
    },
    {
      id: 'verify',
      description: 'Recompute the claims independently',
      agent: 'verification-agent',
      dependsOn: ['simulate'],
    },
  );
  const draft = {
    goal: request,
    constraints: [],
    requiredOutputs: [engine.title],
    resources: [],
    risks: [
      `Lab engine ${engine.name} (${engine.domain}). ${engine.description}`,
      ...(missing.length > 0
        ? [`Needs ${missing.join(', ')}, which is acquired first and only after your approval.`]
        : []),
    ],
    acceptanceCriteria: [
      {
        id: 'recomputed',
        description: engine.checkDescription,
        checkType: 'recompute',
        check: { name: engine.check, params: { step: 'simulate', ...params } },
      },
      ...(engine.alsoChecks ?? []).map((c, i) => ({
        id: `recomputed_${i + 2}`,
        description: c.description,
        checkType: 'recompute',
        check: { name: c.name, params: { step: 'simulate', ...params } },
      })),
    ],
    workflow: steps,
    missingCapabilities: missing.length > 0 && engine.need ? [{ need: engine.need }] : [],
    candidateWorkspaces: ['lab'],
  };
  return { draft, model, usage: { inputTokens: 0, outputTokens: 0 } };
}

function describe(engine: string, p: Record<string, unknown>): string {
  const bragg = p.bragg as
    { high?: unknown; low?: unknown; pairs?: unknown; center_nm?: unknown } | undefined;
  switch (engine) {
    case 'thin_film':
    case 'stack_tolerance':
      return bragg
        ? `${String(bragg.pairs ?? 8)}-pair ${String(bragg.high ?? 'tio2')}/${String(bragg.low ?? 'sio2')} Bragg mirror at ${String(bragg.center_nm ?? 1550)} nm`
        : `${Array.isArray(p.layers) ? p.layers.length : 0}-layer stack`;
    case 'ring_resonator':
      return `ring of radius ${String(p.radius_um ?? 20)} µm around ${String(p.center_nm ?? 1550)} nm`;
    case 'quantum_circuit':
      return String(p.circuit ?? `${String(p.preset ?? 'bell')} state`);
    case 'molecule':
      return String(p.name ?? p.smiles ?? '');
    case 'turbofan':
      return `${String(p.fan_blades ?? 22)} fan blades, ${String(p.hpc_stages ?? 9)} compressor stages, fan diameter ${String(p.fan_diameter_mm ?? 1600)} mm`;
    case 'cad_model':
      return 'model code written by the team';
    case 'fcc_crystal':
      return `${String(p.element)} (${MORSE[String(p.element)]?.name ?? ''})`;
    case 'rocket_engine':
      return `${String(p.propellant)} at ${String(p.chamber_pressure_bar)} bar, ${String(p.thrust_kN)} kN`;
    case 'launch_vehicle':
    case 'ascent_trajectory':
      return `${Array.isArray(p.stages) ? p.stages.length : 0} stages, ${String(p.payload_kg)} kg to ${String(p.orbit_altitude_km)} km`;
    case 'rocket_tanks':
      return `tanks of ${Array.isArray(p.stages) ? p.stages.length : 0} stages`;
    case 'pcb_design':
      return `${Array.isArray(p.parts) ? p.parts.length : 0} parts, ${Array.isArray(p.nets) ? p.nets.length : 0} nets`;
    case 'pcb_recheck':
      return 'the board as saved after a hand edit';
    case 'design_assembly':
      return `${Array.isArray(p.parts) ? p.parts.length : 0} part definitions`;
    case 'rocket_cad':
      return `${Array.isArray(p.stages) ? p.stages.length : 0}-stage vehicle`;
    default:
      return '';
  }
}

const num = (re: RegExp, s: string) => {
  const m = re.exec(s);
  return m?.[1] ? Number(m[1].replace(',', '.')) : undefined;
};

/**
 * Recognises a lab question without a model (keywords, numbers with units, element and
 * molecule names). Returns nothing for anything it is not sure about.
 */
/** Structures, heat, fluids and fields, in the words engineers ask in (English and German). */
function physicsIntent(s: string): { engine: string; params: Record<string, unknown> } | undefined {
  if (/cavity|lid[- ]driven|kavit[aä]t|deckelgetrieben/.test(s)) {
    const re = num(/re(?:ynolds)?\s*(?:=|number|zahl)?\s*(\d+)/, s);
    const reynolds = Math.max(10, Math.min(1000, re ?? 100));
    return {
      engine: 'cavity_flow',
      params: {
        reynolds,
        ...(reynolds > 400 ? { grid: 129 } : reynolds > 100 ? { grid: 97 } : {}),
      },
    };
  }
  if (/\bfins?\b|k[uü]hlrippe|heat ?sink|k[uü]hlk[oö]rper/.test(s)) {
    return { engine: 'heat_fin', params: {} };
  }
  if (/microstrip|mikrostreifen|characteristic impedance|wellenwiderstand/.test(s)) {
    return { engine: 'microstrip', params: {} };
  }
  if (
    /plate with a hole|hole in a plate|lochplatte|stress concentration|kerbwirkung|kerbfaktor/.test(
      s,
    )
  ) {
    return { engine: 'structural_fea', params: { case: 'plate_hole' } };
  }
  if (
    /cantilever|kragbalken|kragarm|beam (deflection|stress)|biegebalken|\bfea\b|finite element/.test(
      s,
    )
  ) {
    return { engine: 'structural_fea', params: { case: 'cantilever' } };
  }
  return undefined;
}

export function labIntent(
  request: string,
): { engine: string; params: Record<string, unknown> } | undefined {
  const s = request.toLowerCase();
  const rocket = rocketIntent(s);
  if (rocket) return rocket;
  if (
    /jet engine|turbofan|turbojet|triebwerk|strahltriebwerk|gasturbine|gas turbine|flugzeugtriebwerk/.test(
      s,
    )
  ) {
    const fan = num(/(\d+)\s*(?:fan[- ]?blades|fan[- ]?schaufeln|bl[aä]tter)/, s);
    const hpc = num(/(\d+)\s*(?:hpc|compressor|verdichter)[- ]?(?:stages|stufen)/, s);
    const dia = num(/(\d+(?:[.,]\d+)?)\s*m(?:m)?\s*(?:fan|diameter|durchmesser)/, s);
    return {
      engine: 'turbofan',
      params: {
        ...(fan ? { fan_blades: Math.max(8, Math.min(40, fan)) } : {}),
        ...(hpc ? { hpc_stages: Math.max(1, Math.min(14, hpc)) } : {}),
        ...(dia ? { fan_diameter_mm: dia < 10 ? dia * 1000 : dia } : {}),
      },
    };
  }
  const physics = physicsIntent(s);
  if (physics) return physics;
  const center = num(/(\d{3,5}(?:[.,]\d+)?)\s*nm/, s);
  if (
    /\b(bell|ghz)\b|qubit|quantum (circuit|state|gate)|quantenschaltung|superposition|verschr[aä]nk|entangle/.test(
      s,
    )
  ) {
    const n = num(/(\d+)[\s-]*qubit/, s);
    if (/ghz/.test(s) || (n !== undefined && n > 2))
      return {
        engine: 'quantum_circuit',
        params: { preset: 'ghz', qubits: Math.min(10, Math.max(3, n ?? 3)) },
      };
    return { engine: 'quantum_circuit', params: { preset: 'bell' } };
  }
  const molecule = Object.keys(MOLECULES).find((m) => s.includes(m));
  const smiles = /smiles[:\s]+([A-Za-z0-9@+\-[\]()=#$/\\%.]+)/i.exec(request)?.[1];
  if (
    smiles ||
    (molecule && /molec|molek|structure|struktur|weight|gewicht|logp|descriptor|3d|chem/.test(s))
  ) {
    return { engine: 'molecule', params: smiles ? { smiles } : { name: molecule } };
  }
  const element = Object.entries(MORSE).find(
    ([sym, m]) => s.includes(m.name) || new RegExp(`\\b${sym.toLowerCase()}\\b`).test(s),
  )?.[0];
  if (
    element &&
    /lattice|gitter|bulk modulus|kompressionsmodul|cohesive|koh[aä]sion|crystal|kristall|fcc/.test(
      s,
    )
  ) {
    return { engine: 'fcc_crystal', params: { element } };
  }
  if (/ring ?resonator|ringresonator|microring|mikroring|\bfsr\b/.test(s)) {
    const radius = num(/(\d+(?:[.,]\d+)?)\s*(?:µm|um|micron|mikrometer)/, s);
    return {
      engine: 'ring_resonator',
      params: {
        ...(radius ? { radius_um: radius } : {}),
        ...(center ? { center_nm: center } : {}),
      },
    };
  }
  const isStack =
    /bragg|mirror|spiegel|thin[- ]film|d[uü]nnschicht|schichtstapel|coating|reflectance|reflektivit/.test(
      s,
    );
  if (isStack) {
    const pairs = num(/(\d+)\s*(?:pairs|paare|periods|perioden)/, s);
    const bragg = { ...(pairs ? { pairs } : {}), ...(center ? { center_nm: center } : {}) };
    const range = center
      ? { start_nm: Math.round(center * 0.6), stop_nm: Math.round(center * 1.45) }
      : {};
    if (/toleran|monte ?carlo|yield|ausbeute|fertigungs/.test(s)) {
      const sigma = num(/(\d+(?:[.,]\d+)?)\s*nm\s*(?:sigma|error|fehler|toleranz|tolerance)/, s);
      return {
        engine: 'stack_tolerance',
        params: { bragg, ...range, ...(sigma ? { sigma_nm: sigma } : {}) },
      };
    }
    return { engine: 'thin_film', params: { bragg, ...range } };
  }
  return undefined;
}

/** Rocket questions: engine, staging, ascent, tanks or the CAD model of the vehicle. */
function rocketIntent(s: string): { engine: string; params: Record<string, unknown> } | undefined {
  const propellant = /methan|methalox|lch4|raptor/.test(s)
    ? 'lox_ch4'
    : /wasserstoff|hydrogen|lh2|hydrolox|rs-?25|ssme/.test(s)
      ? 'lox_lh2'
      : /kerosin|kerosene|rp-?1|merlin/.test(s)
        ? 'lox_rp1'
        : /hydrazin|mmh|n2o4|storable|lagerf/.test(s)
          ? 'n2o4_mmh'
          : undefined;
  const km = num(/(\d{3,4})\s*km/, s);
  const tonnes = num(/(\d+(?:[.,]\d+)?)\s*(?:t|tonnen|tons?)\b/, s);
  const kg = num(/(\d+(?:[.,]\d+)?)\s*kg/, s);
  const payload = tonnes ? tonnes * 1000 : kg;
  const orbitParams = {
    ...(payload ? { payload_kg: Math.min(1e6, payload) } : {}),
    ...(km && km >= 150 && km <= 2000 ? { orbit_altitude_km: km } : {}),
  };
  if (
    /rocket engine|raketentriebwerk|raketenmotor|specific impulse|spezifische[rn]? impuls|\bisp\b|brennkammer|combustion chamber|raptor|merlin|rs-?25|ssme/.test(
      s,
    )
  ) {
    const bar = num(/(\d+(?:[.,]\d+)?)\s*bar/, s);
    const kn = num(/(\d+(?:[.,]\d+)?)\s*kn\b/, s);
    return {
      engine: 'rocket_engine',
      params: {
        ...(propellant ? { propellant } : {}),
        ...(bar ? { chamber_pressure_bar: Math.min(400, Math.max(2, bar)) } : {}),
        ...(kn ? { thrust_kN: kn } : {}),
      },
    };
  }
  if (!/rocket|rakete|launch vehicle|tr[aä]gerrakete|booster|orbit/.test(s)) return undefined;
  if (/\bcad\b|\b3d\b|\bstep\b|modell|model/.test(s)) return { engine: 'rocket_cad', params: {} };
  if (/tank|struktur|structure|beul|buckl/.test(s)) return { engine: 'rocket_tanks', params: {} };
  if (/ascent|aufstieg|trajector|flugbahn|max-?q|fliegen|\bfly\b/.test(s))
    return { engine: 'ascent_trajectory', params: orbitParams };
  return { engine: 'launch_vehicle', params: orbitParams };
}

/** Lab simulations a bot started: the task's plan is fixed, not left to a planner. */
export class LabPresets {
  constructor(private readonly pool: pg.Pool) {}

  async set(taskId: string, engine: string, params: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO task_presets (task_id, engine, params) VALUES ($1, $2, $3)
       ON CONFLICT (task_id) DO UPDATE SET engine = $2, params = $3`,
      [taskId, engine, params],
    );
  }

  async get(
    taskId: string,
  ): Promise<{ engine: string; params: Record<string, unknown> } | undefined> {
    const { rows } = await this.pool.query<{ engine: string; params: Record<string, unknown> }>(
      'SELECT engine, params FROM task_presets WHERE task_id = $1',
      [taskId],
    );
    return rows[0];
  }
}

/** A plan that only gets a library: search, inspect, approve, install, test. */
export function libraryPlan(
  need: string,
  packageName: string | undefined,
  request: string,
  mcp = false,
  domains: readonly string[] = [],
  secrets: readonly string[] = [],
) {
  const wanted = `${need.trim()}${packageName ? ` [package: ${packageName}]` : ''}${mcp ? ' [mcp]' : ''}${domains.length ? ` [domains: ${domains.join(',')}]` : ''}${secrets.length ? ` [secrets: ${secrets.join(',')}]` : ''}`;
  const draft = {
    goal: request,
    constraints: [],
    requiredOutputs: ['A tested library in an isolated layer'],
    resources: [],
    risks: [
      'A library found by search is not from the reviewed list: it is verified on PyPI, inspected offline and installed only after your approval.',
    ],
    acceptanceCriteria: [
      {
        id: 'installed',
        description:
          'The library is installed in an isolated layer and passed its test, with your approval',
        checkType: 'human',
      },
    ],
    workflow: [
      {
        id: 'acquire',
        description: `Find, inspect and install a library for: ${need.trim().slice(0, 200)}`,
        agent: 'capability-agent',
        dependsOn: [],
        capability: wanted,
      },
    ],
    missingCapabilities: [{ need: wanted }],
    candidateWorkspaces: [],
  };
  return { draft, model: 'library-preset', usage: { inputTokens: 0, outputTokens: 0 } };
}

/** Wraps any planner: preset lab tasks get their fixed plan; everything else goes through. */
export class LabAwarePlanner implements Planner {
  constructor(
    private readonly inner: Planner,
    private readonly presets: LabPresets,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  async propose(input: PlannerInput): Promise<PlannerOutput> {
    const preset = input.taskId ? await this.presets.get(input.taskId) : undefined;
    if (preset?.engine === 'acquire_library') {
      const p = preset.params as {
        need?: unknown;
        package?: unknown;
        mcp?: unknown;
        domains?: unknown;
        secrets?: unknown;
      };
      const names = (v: unknown) =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      return libraryPlan(
        typeof p.need === 'string' ? p.need : input.request,
        typeof p.package === 'string' ? p.package : undefined,
        input.request,
        p.mcp === true,
        names(p.domains),
        names(p.secrets),
      );
    }
    if (preset) {
      return labPlan(
        preset.engine,
        preset.params,
        input.request,
        input.availableCapabilities ?? [],
        'lab-preset',
      );
    }
    return this.inner.propose(input);
  }
}

export const LAB_ENGINE_NAMES = LAB_ENGINES.map((e) => e.name);
