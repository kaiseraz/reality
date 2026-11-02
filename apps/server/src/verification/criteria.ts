import { z } from 'zod';
import type { StepResult } from '../orchestrator/graph.ts';

/**
 * Success criteria set by a person, checked against evidence by code (adapted from Astra's
 * verification layer).
 *
 * - A criterion names a result value ("trend_per_year") and what it must be: a range, a
 *   target with tolerance, or a text it must equal or contain.
 * - Evidence (B1, B2 …) is made by the system from the summaries of completed steps, never
 *   by a model.
 * - The verdict is computed here: verified, partial, not verified or refuted.
 * - Criteria are set before the run. Once a task runs, they are locked, so the goal cannot
 *   move to meet the result.
 */
export const Criterion = z
  .object({
    /** Result value to check, e.g. "trend_per_year" or "peak_month". */
    field: z.string().trim().min(1).max(80),
    /** Only evidence from this step (optional). */
    step: z.string().trim().min(1).max(80).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    target: z.number().finite().optional(),
    /** Absolute tolerance around target. */
    tolerance: z.number().nonnegative().optional(),
    /** Relative tolerance around target, in percent. */
    tolerancePercent: z.number().nonnegative().max(1000).optional(),
    /** Text value: must equal this (case-insensitive). */
    equals: z.string().trim().min(1).max(200).optional(),
    /** Text value: must contain this (case-insensitive). */
    contains: z.string().trim().min(1).max(200).optional(),
    note: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine(
    (c) =>
      c.min !== undefined ||
      c.max !== undefined ||
      c.target !== undefined ||
      c.equals !== undefined ||
      c.contains !== undefined,
    {
      message:
        'A criterion needs min, max, target, equals or contains; otherwise nothing is checkable.',
    },
  )
  .refine((c) => c.min === undefined || c.max === undefined || c.min <= c.max, {
    message: 'min is greater than max.',
  });
export type Criterion = z.infer<typeof Criterion>;

export interface Evidence {
  id: string;
  stepId: string;
  values: Record<string, number | string | boolean>;
}

export type CriterionStatus = 'met' | 'missed' | 'open' | 'not_checkable';
export interface CriterionResult extends Criterion {
  id: string;
  status: CriterionStatus;
  actual: number | string | boolean | null;
  evidenceId: string | null;
  expected: string;
}

export type Verdict = 'verified' | 'partial' | 'not_verified' | 'refuted' | 'no_criteria';

/** Evidence from completed steps, numbered in step order; only scalar values count. */
export function evidenceFrom(results: StepResult[]): Evidence[] {
  const out: Evidence[] = [];
  for (const r of results) {
    if (r.status !== 'done' || !r.summary || typeof r.summary !== 'object') continue;
    const values: Evidence['values'] = {};
    for (const [k, v] of Object.entries(r.summary as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) values[k] = v;
      else if (typeof v === 'string' || typeof v === 'boolean') values[k] = v;
    }
    if (Object.keys(values).length > 0)
      out.push({ id: `B${out.length + 1}`, stepId: r.stepId, values });
  }
  return out;
}

export function expectedText(c: Criterion): string {
  const parts: string[] = [];
  if (c.target !== undefined) {
    const tol =
      c.tolerance ?? (c.tolerancePercent !== undefined ? `${c.tolerancePercent}%` : undefined);
    parts.push(tol !== undefined ? `${c.target} ± ${tol}` : `${c.target}`);
  }
  if (c.min !== undefined) parts.push(`≥ ${c.min}`);
  if (c.max !== undefined) parts.push(`≤ ${c.max}`);
  if (c.equals !== undefined) parts.push(`= “${c.equals}”`);
  if (c.contains !== undefined) parts.push(`contains “${c.contains}”`);
  return parts.join(', ');
}

/** Checks one criterion against the latest evidence that carries its value. */
export function checkCriterion(c: Criterion, id: string, evidence: Evidence[]): CriterionResult {
  const base = { ...c, id, expected: expectedText(c) };
  const found = [...evidence]
    .reverse()
    .find((e) => (c.step === undefined || e.stepId === c.step) && c.field in e.values);
  if (!found) return { ...base, status: 'open', actual: null, evidenceId: null };
  const actual = found.values[c.field] ?? null;
  const hit = { ...base, actual, evidenceId: found.id };
  if (c.equals !== undefined || c.contains !== undefined) {
    const s = String(actual).toLowerCase();
    const ok =
      (c.equals === undefined || s === c.equals.toLowerCase()) &&
      (c.contains === undefined || s.includes(c.contains.toLowerCase()));
    return { ...hit, status: ok ? 'met' : 'missed' };
  }
  if (typeof actual !== 'number') return { ...hit, status: 'not_checkable' };
  let ok = true;
  if (c.min !== undefined && actual < c.min) ok = false;
  if (c.max !== undefined && actual > c.max) ok = false;
  if (c.target !== undefined) {
    const tol =
      c.tolerance ??
      (c.tolerancePercent !== undefined ? (Math.abs(c.target) * c.tolerancePercent) / 100 : 0);
    if (Math.abs(actual - c.target) > tol + 1e-12) ok = false;
  }
  return { ...hit, status: ok ? 'met' : 'missed' };
}

export function verdictOf(results: CriterionResult[]): Verdict {
  if (results.length === 0) return 'no_criteria';
  if (results.some((r) => r.status === 'missed')) return 'refuted';
  const met = results.filter((r) => r.status === 'met').length;
  if (met === results.length) return 'verified';
  return met > 0 ? 'partial' : 'not_verified';
}

const NUMBER =
  /(?<![A-Za-z\d])-?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)(?:[eE][+-]?\d+)?/g;

/** "1,200" and "2,400,000" are thousands; "1,5" is a decimal comma. */
const numberOf = (s: string) =>
  Number(/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.'));

/**
 * Numbers in a text that no evidence backs (Astra's rule): each must match an evidence value
 * (also as a percentage, or rounded to two decimals) or a number from the request. Small
 * integers (counts, list markers) and years are ignored.
 */
export function unbackedNumbers(text: string, evidence: Evidence[], request = ''): string[] {
  const allowed: number[] = [];
  const collect = (s: string) => {
    // "2030-07-07T09:30:00": the T glues the hour to the date, and the hour is a number too.
    for (const m of s.replace(/(\d)T(?=\d)/g, '$1 ').matchAll(NUMBER)) {
      allowed.push(numberOf(m[0]));
    }
  };
  for (const e of evidence) {
    for (const v of Object.values(e.values)) {
      if (typeof v === 'number') allowed.push(v, v * 100);
      else if (typeof v === 'string') collect(v);
    }
  }
  collect(request);
  const backed = (n: number) =>
    allowed.some((a) => {
      if (!Number.isFinite(a)) return false;
      const tol = Math.max(1e-9, Math.abs(a) * 0.005, 0.005);
      return Math.abs(n - a) <= tol || Math.abs(n - Math.round(a * 100) / 100) <= 1e-9;
    });
  const out: string[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const n = numberOf(m[0]);
    if (!Number.isFinite(n)) continue;
    if (Number.isInteger(n) && Math.abs(n) <= 12) continue;
    if (Number.isInteger(n) && n >= 1900 && n <= 2100) continue;
    if (!backed(n) && !out.includes(m[0])) out.push(m[0]);
    if (out.length >= 30) break;
  }
  return out;
}

/** Result values each recipe reports, offered when a person adds a criterion. */
export const RESULT_FIELDS: Record<
  string,
  { field: string; label: string; kind: 'number' | 'text' }[]
> = {
  aggregate_time: [
    { field: 'trend_per_year', label: 'Linear trend per year', kind: 'number' },
    { field: 'total', label: 'Total', kind: 'number' },
    { field: 'mean', label: 'Mean per period', kind: 'number' },
    { field: 'last_value', label: 'Last value', kind: 'number' },
    { field: 'change', label: 'Change first to last', kind: 'number' },
  ],
  breakdown: [
    { field: 'top_group', label: 'Largest group by total', kind: 'text' },
    { field: 'top_share', label: 'Share of the largest group (0–1)', kind: 'number' },
    { field: 'top_group_by_mean', label: 'Group with the highest average', kind: 'text' },
    { field: 'top_mean', label: 'Highest average per row', kind: 'number' },
  ],
  decompose: [
    { field: 'significant', label: 'Seasonality significant (true/false)', kind: 'text' },
    { field: 'p_value', label: 'p-value of the seasonality test', kind: 'number' },
    { field: 'seasonal_amplitude', label: 'Seasonal amplitude', kind: 'number' },
    { field: 'peak_month', label: 'Peak month', kind: 'text' },
  ],
  correlate: [
    { field: 'top_variable', label: 'Strongest associated variable', kind: 'text' },
    { field: 'top_r', label: 'Its correlation r', kind: 'number' },
  ],
  thin_film: [
    { field: 'peak_reflectance', label: 'Peak reflectance (0–1)', kind: 'number' },
    { field: 'peak_wavelength_nm', label: 'Peak wavelength (nm)', kind: 'number' },
    { field: 'bandwidth_nm', label: 'Band width at half peak (nm)', kind: 'number' },
  ],
  ring_resonator: [
    { field: 'fsr_nm', label: 'Free spectral range (nm)', kind: 'number' },
    { field: 'q_loaded', label: 'Loaded Q', kind: 'number' },
    { field: 'extinction_db', label: 'Extinction (dB)', kind: 'number' },
    { field: 'thermal_shift_pm_per_k', label: 'Thermal shift (pm/K)', kind: 'number' },
  ],
  stack_tolerance: [
    { field: 'yield', label: 'Fabrication yield (0–1)', kind: 'number' },
    { field: 'worst_peak_reflectance', label: 'Worst peak reflectance', kind: 'number' },
    { field: 'centre_std_nm', label: 'Spread of the centre wavelength (nm)', kind: 'number' },
  ],
  quantum_circuit: [
    { field: 'top_state', label: 'Most likely basis state', kind: 'text' },
    { field: 'top_probability', label: 'Its probability', kind: 'number' },
    { field: 'entangled', label: 'Entangled (true/false)', kind: 'text' },
    { field: 'entropy_bits', label: 'Measurement entropy (bits)', kind: 'number' },
  ],
  molecule: [
    { field: 'formula', label: 'Formula', kind: 'text' },
    { field: 'mol_weight', label: 'Molar mass (g/mol)', kind: 'number' },
    { field: 'logp', label: 'logP', kind: 'number' },
    { field: 'tpsa', label: 'TPSA (Å²)', kind: 'number' },
  ],
  fcc_crystal: [
    { field: 'a0_angstrom', label: 'Lattice constant (Å)', kind: 'number' },
    { field: 'bulk_modulus_GPa', label: 'Bulk modulus (GPa)', kind: 'number' },
    { field: 'cohesive_energy_eV', label: 'Cohesive energy (eV)', kind: 'number' },
    { field: 'deviation_percent', label: 'Deviation from experiment (%)', kind: 'number' },
  ],
  rocket_engine: [
    { field: 'isp_vac_s', label: 'Vacuum Isp, ideal (s)', kind: 'number' },
    { field: 'isp_sl_s', label: 'Sea-level Isp, ideal (s)', kind: 'number' },
    { field: 'delivered_isp_vac_s', label: 'Vacuum Isp, delivered (s)', kind: 'number' },
    { field: 'thrust_vac_kN', label: 'Vacuum thrust (kN)', kind: 'number' },
    { field: 'chamber_temperature_K', label: 'Chamber temperature (K)', kind: 'number' },
    { field: 'throat_heat_flux_MW_m2', label: 'Throat heat flux (MW/m²)', kind: 'number' },
  ],
  launch_vehicle: [
    { field: 'liftoff_mass_kg', label: 'Liftoff mass (kg)', kind: 'number' },
    { field: 'payload_fraction', label: 'Payload fraction (0–1)', kind: 'number' },
    { field: 'delta_v_margin_m_s', label: 'Delta-v margin (m/s)', kind: 'number' },
    { field: 'reaches_orbit', label: 'Reaches orbit (true/false)', kind: 'text' },
    { field: 'liftoff_twr', label: 'Liftoff thrust-to-weight', kind: 'number' },
  ],
  ascent_trajectory: [
    { field: 'orbit_reached', label: 'Orbit reached (true/false)', kind: 'text' },
    {
      field: 'propellant_margin_kg',
      label: 'Propellant left after circularising (kg)',
      kind: 'number',
    },
    { field: 'max_q_kPa', label: 'Max-Q (kPa)', kind: 'number' },
    { field: 'max_accel_g', label: 'Peak acceleration (g)', kind: 'number' },
    { field: 'apoapsis_km', label: 'Apoapsis (km)', kind: 'number' },
  ],
  rocket_tanks: [
    { field: 'tank_mass_total_kg', label: 'Tank mass in total (kg)', kind: 'number' },
    { field: 'min_buckling_margin', label: 'Smallest buckling margin', kind: 'number' },
    { field: 'min_pressure_margin', label: 'Smallest pressure margin', kind: 'number' },
    { field: 'longest_tank_m', label: 'Longest tank (m)', kind: 'number' },
  ],
  pcb_design: [
    { field: 'nets_routed', label: 'Nets routed', kind: 'number' },
    { field: 'drc_violations', label: 'Design-rule violations', kind: 'number' },
    { field: 'design_ok', label: 'All nets routed and rules met (true/false)', kind: 'text' },
    { field: 'track_length_mm', label: 'Track length (mm)', kind: 'number' },
    { field: 'vias', label: 'Vias', kind: 'number' },
  ],
  pcb_recheck: [
    { field: 'nets_routed', label: 'Nets routed', kind: 'number' },
    { field: 'drc_violations', label: 'Design-rule violations', kind: 'number' },
    { field: 'design_ok', label: 'All nets routed and rules met (true/false)', kind: 'text' },
  ],
  design_assembly: [
    { field: 'total_mass_kg', label: 'Total mass (kg)', kind: 'number' },
    { field: 'interference_count', label: 'Interfering part pairs', kind: 'number' },
    { field: 'constraints_met', label: 'Constraints met', kind: 'number' },
    { field: 'design_ok', label: 'Meets all requirements (true/false)', kind: 'text' },
    { field: 'extent_x_mm', label: 'Size along x (mm)', kind: 'number' },
    { field: 'part_count', label: 'Parts', kind: 'number' },
  ],
  rocket_cad: [
    { field: 'part_count', label: 'Parts', kind: 'number' },
    { field: 'length_mm', label: 'Length (mm)', kind: 'number' },
    { field: 'invalid_parts', label: 'Invalid parts', kind: 'number' },
  ],
  forecast: [
    { field: 'forecast_end', label: 'Forecast at the end of the horizon', kind: 'number' },
    { field: 'backtest_mae', label: 'Backtest error (MAE)', kind: 'number' },
    { field: 'skill', label: 'Improvement over the naive forecast (0–1)', kind: 'number' },
    { field: 'beats_naive', label: 'Beats the naive forecast (true/false)', kind: 'text' },
  ],
};
