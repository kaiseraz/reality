import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { ChatCard } from '@reality/schemas';
import { api } from '../api.ts';
import { Icon } from '../ui/Icon.tsx';
import { Atoms3D, type Atom } from './Atoms3D.tsx';
import { BarChart, histogram, LineChart } from './Charts.tsx';
import { PcbView } from './PcbView.tsx';

// The 3D viewer pulls in three.js; load it only when a CAD card actually appears.
const CadView = lazy(() => import('./CadView.tsx').then((m) => ({ default: m.CadView })));

type LabCard = Extract<ChatCard, { kind: 'lab' }>;
type Row = Record<string, unknown>;

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v));
const fmt = (v: unknown, digits = 4) =>
  typeof v === 'number'
    ? Math.abs(v) >= 1e4
      ? v.toExponential(2)
      : String(+v.toPrecision(digits))
    : String(v ?? '');

/** The tables of a simulation, by file name (result.csv, bonds.csv …). */
function useTables(card: LabCard): Record<string, Row[]> | null {
  const [tables, setTables] = useState<Record<string, Row[]> | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all(
      card.artifacts.map(
        async (a) => [a.name, (await api.rows(a.id, { offset: 0, limit: 5000 })).rows] as const,
      ),
    )
      .then((pairs) => live && setTables(Object.fromEntries(pairs)))
      .catch(() => live && setTables({}));
    return () => {
      live = false;
    };
  }, [card.artifacts]);
  return tables;
}

const MATERIAL_INDEX: Record<string, number> = {
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
const idx = (m: unknown) => (typeof m === 'number' ? m : (MATERIAL_INDEX[String(m)] ?? 1.5));

/** The layer stack drawn to scale: light for low index, deep for high index. */
function StackDiagram({ params }: { params: Record<string, unknown> }) {
  const layers = useMemo(() => {
    const explicit = params.layers as { material: unknown; thickness_nm: number }[] | undefined;
    if (explicit?.length)
      return explicit.map((l) => ({
        n: idx(l.material),
        d: l.thickness_nm,
        name: String(l.material),
      }));
    const b = (params.bragg ?? {}) as {
      high?: unknown;
      low?: unknown;
      pairs?: number;
      center_nm?: number;
    };
    const hi = idx(b.high ?? 'tio2');
    const lo = idx(b.low ?? 'sio2');
    const c = b.center_nm ?? 1550;
    return Array.from({ length: b.pairs ?? 8 }, () => [
      { n: hi, d: c / (4 * hi), name: String(b.high ?? 'tio2') },
      { n: lo, d: c / (4 * lo), name: String(b.low ?? 'sio2') },
    ]).flat();
  }, [params]);
  const total = layers.reduce((s, l) => s + l.d, 0) || 1;
  // Left edge of each layer, from the thicknesses before it.
  const starts = layers.map(
    (_, i) => (layers.slice(0, i).reduce((a, l) => a + l.d, 0) / total) * 400,
  );
  return (
    <div
      className="stack-diagram"
      aria-label={`${layers.length} layers, ${Math.round(total)} nm in total`}
    >
      <span className="stack-end">{String(params.incident ?? 'air')}</span>
      <svg viewBox="0 0 400 40" preserveAspectRatio="none">
        {layers.map((l, i) => {
          const w = (l.d / total) * 400;
          const t = Math.min(1, (l.n - 1) / 2.6);
          const el = (
            <rect
              key={i}
              x={starts[i]}
              y={0}
              width={w + 0.3}
              height={40}
              fill={`hsl(${210 - t * 30} 70% ${80 - t * 45}%)`}
            >
              <title>
                {l.name}: n = {l.n}, {l.d.toFixed(1)} nm
              </title>
            </rect>
          );
          return el;
        })}
      </svg>
      <span className="stack-end">{String(params.substrate ?? 'glass')}</span>
    </div>
  );
}

/** Circuit drawn from the circuit text: one wire per qubit, one column per gate. */
function CircuitDiagram({ circuit, qubits }: { circuit: string; qubits: number }) {
  const ops = circuit
    .split(';')
    .map((p) => p.trim().split(/\s+/))
    .filter((t) => t[0]);
  const colW = 44;
  const rowH = 30;
  const width = 40 + ops.length * colW + 20;
  const height = qubits * rowH + 10;
  const y = (q: number) => 20 + q * rowH;
  return (
    <svg
      className="circuit"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Circuit: ${circuit}`}
    >
      {Array.from({ length: qubits }, (_, q) => (
        <g key={q}>
          <text x={4} y={y(q) + 4}>
            q{q}
          </text>
          <line x1={28} x2={width - 8} y1={y(q)} y2={y(q)} className="wire" />
        </g>
      ))}
      {ops.map((t, i) => {
        const g = (t[0] ?? '').toLowerCase();
        const cx = 40 + i * colW + colW / 2;
        const qs = t
          .slice(1)
          .filter((a) => /^\d+$/.test(a))
          .map(Number);
        if ((g === 'cx' || g === 'cnot' || g === 'cz') && qs.length >= 2) {
          const [c, tq] = qs as [number, number];
          return (
            <g key={i}>
              <line x1={cx} x2={cx} y1={y(c)} y2={y(tq)} className="wire-strong" />
              <circle cx={cx} cy={y(c)} r={4} className="dot" />
              {g === 'cz' ? (
                <circle cx={cx} cy={y(tq)} r={4} className="dot" />
              ) : (
                <g>
                  <circle cx={cx} cy={y(tq)} r={9} className="target" />
                  <line x1={cx - 9} x2={cx + 9} y1={y(tq)} y2={y(tq)} className="wire-strong" />
                  <line x1={cx} x2={cx} y1={y(tq) - 9} y2={y(tq) + 9} className="wire-strong" />
                </g>
              )}
            </g>
          );
        }
        if (g === 'swap' && qs.length >= 2) {
          const [a, b] = qs as [number, number];
          return (
            <g key={i}>
              <line x1={cx} x2={cx} y1={y(a)} y2={y(b)} className="wire-strong" />
              {[a, b].map((q) => (
                <g key={q}>
                  <line
                    x1={cx - 5}
                    x2={cx + 5}
                    y1={y(q) - 5}
                    y2={y(q) + 5}
                    className="wire-strong"
                  />
                  <line
                    x1={cx - 5}
                    x2={cx + 5}
                    y1={y(q) + 5}
                    y2={y(q) - 5}
                    className="wire-strong"
                  />
                </g>
              ))}
            </g>
          );
        }
        return (
          <g key={i}>
            <rect
              x={cx - 14}
              y={y(qs[0] ?? 0) - 11}
              width={28}
              height={22}
              rx={5}
              className="gate"
            />
            <text x={cx} y={y(qs[0] ?? 0) + 4} textAnchor="middle" className="gate-label">
              {g.toUpperCase()}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function fccCell(element: string, a: number): { atoms: Atom[]; edges: [Atom, Atom][] } {
  const atoms: Atom[] = [];
  const corners = [0, 1];
  for (const x of corners)
    for (const y of corners)
      for (const z of corners) atoms.push({ el: element, x: x * a, y: y * a, z: z * a });
  for (const [x, y, z] of [
    [0.5, 0.5, 0],
    [0.5, 0.5, 1],
    [0.5, 0, 0.5],
    [0.5, 1, 0.5],
    [0, 0.5, 0.5],
    [1, 0.5, 0.5],
  ] as const)
    atoms.push({ el: element, x: x * a, y: y * a, z: z * a });
  const c = (x: number, y: number, z: number): Atom => ({
    el: element,
    x: x * a,
    y: y * a,
    z: z * a,
  });
  const edges: [Atom, Atom][] = [];
  for (const u of corners)
    for (const v of corners) {
      edges.push([c(0, u, v), c(1, u, v)], [c(u, 0, v), c(u, 1, v)], [c(u, v, 0), c(u, v, 1)]);
    }
  return { atoms, edges };
}

/** The engine's chamber and bell nozzle, drawn to scale from its contour. */
function NozzleDiagram({ rows }: { rows: Record<string, number>[] }) {
  if (rows.length < 2) return null;
  const xs = rows.map((r) => r.x_mm ?? 0);
  const rs = rows.map((r) => r.r_mm ?? 0);
  const x0 = Math.min(...xs);
  const len = Math.max(...xs) - x0 || 1;
  const rmax = Math.max(...rs) || 1;
  const W = 400;
  const H = Math.max(60, Math.min(220, (W * 2 * rmax) / len));
  const sx = (x: number) => 4 + ((x - x0) / len) * (W - 8);
  const sy = (r: number) => H / 2 - (r / rmax) * (H / 2 - 4);
  const top = rows.map((r, i) => `${i ? 'L' : 'M'}${sx(r.x_mm ?? 0)},${sy(r.r_mm ?? 0)}`).join('');
  const bottom = [...rows]
    .reverse()
    .map((r) => `L${sx(r.x_mm ?? 0)},${H - sy(r.r_mm ?? 0)}`)
    .join('');
  return (
    <svg
      className="nozzle"
      viewBox={`0 0 ${W} ${H}`}
      style={{ display: 'block', width: '100%', maxHeight: 150, margin: '6px 0 10px' }}
      role="img"
      aria-label="Chamber and nozzle contour"
    >
      <path
        d={`${top}${bottom}Z`}
        fill="var(--accent-soft, #6e7bf233)"
        stroke="var(--accent, #6e7bf2)"
      />
      <line
        x1={0}
        x2={W}
        y1={H / 2}
        y2={H / 2}
        stroke="currentColor"
        strokeOpacity={0.2}
        strokeDasharray="4 4"
      />
    </svg>
  );
}

function Facts({ items }: { items: [string, unknown, string?][] }) {
  return (
    <dl className="lab-facts">
      {items
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v, unit]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>
              {fmt(v)}
              {unit ? <span className="muted"> {unit}</span> : null}
            </dd>
          </div>
        ))}
    </dl>
  );
}

/** A simulation result drawn for its domain: compact in the chat, large on the screen. */
export function LabView({ card: given, large = false }: { card: LabCard; large?: boolean }) {
  // Pages poll and hand over a new object with the same content: that must not reload the files
  // or rebuild a 3D scene someone is looking at.
  const json = JSON.stringify(given);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const card = useMemo(() => given, [json]);
  const tables = useTables(card);
  const s = card.summary;
  const result = tables?.['result.csv'] ?? [];
  const h = large ? 300 : 200;
  const numeric = (rows: Row[]) =>
    rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, n(v)])));

  let view: React.ReactNode = <p className="muted">Loading the simulation…</p>;
  if (tables) {
    switch (card.engine) {
      case 'thin_film':
        view = (
          <>
            <StackDiagram params={card.params} />
            <LineChart
              rows={numeric(result)}
              x="wavelength_nm"
              series={[
                { key: 'R', label: 'Reflectance', color: '#6e7bf2' },
                { key: 'T', label: 'Transmission', color: '#10a37f' },
              ]}
              xLabel="Wavelength (nm)"
              yLabel="Fraction"
              yMin={0}
              yMax={1}
              height={h}
              marks={[{ x: n(s.peak_wavelength_nm), label: `${fmt(s.peak_wavelength_nm)} nm` }]}
            />
            <Facts
              items={[
                ['Peak reflectance', s.peak_reflectance],
                ['At', s.peak_wavelength_nm, 'nm'],
                ['Band (half peak)', s.bandwidth_nm, 'nm'],
                ['Layers', s.layers],
                ['Total thickness', s.total_thickness_nm, 'nm'],
              ]}
            />
          </>
        );
        break;
      case 'ring_resonator':
        view = (
          <>
            <LineChart
              rows={numeric(result)}
              x="wavelength_nm"
              series={[{ key: 'T', label: 'Transmission', color: '#e0803c' }]}
              xLabel="Wavelength (nm)"
              yLabel="Transmission"
              yMin={0}
              yMax={1}
              height={h}
              marks={[{ x: n(s.resonance_nm), label: `${fmt(s.resonance_nm, 7)} nm` }]}
            />
            <Facts
              items={[
                ['FSR', s.fsr_nm, 'nm'],
                ['Loaded Q', s.q_loaded],
                ['Extinction', s.extinction_db, 'dB'],
                ['Coupling', s.coupling],
                ['Thermal shift', s.thermal_shift_pm_per_k, 'pm/K'],
              ]}
            />
          </>
        );
        break;
      case 'stack_tolerance':
        view = (
          <>
            <BarChart
              items={histogram(result.map((r) => n(r.peak_wavelength_nm)))}
              yLabel="Runs"
              color="#9b7cf0"
              height={h}
            />
            <p className="muted small">
              Peak wavelength over {String(s.runs)} simulated fabrications (nm)
            </p>
            <Facts
              items={[
                [
                  'Yield',
                  typeof s.yield === 'number' ? `${(s.yield * 100).toFixed(1)} %` : s.yield,
                ],
                ['Mean peak R', s.mean_peak_reflectance],
                ['Worst peak R', s.worst_peak_reflectance],
                ['Centre spread', s.centre_std_nm, 'nm'],
                ['Thickness error σ', s.sigma_nm, 'nm'],
              ]}
            />
          </>
        );
        break;
      case 'quantum_circuit': {
        const items = result
          .map((r) => ({ label: `|${String(r.state)}⟩`, value: n(r.probability) }))
          .sort((a, b) => b.value - a.value)
          .slice(0, 16);
        view = (
          <>
            <CircuitDiagram circuit={String(s.circuit ?? '')} qubits={n(s.qubits) || 1} />
            <BarChart items={items} yLabel="Probability" max={1} height={h} />
            <Facts
              items={[
                ['Qubits', s.qubits],
                ['Gates', s.gates],
                ['Most likely', `|${String(s.top_state)}⟩`],
                ['Probability', s.top_probability],
                ['Entropy', s.entropy_bits, 'bits'],
                ['Entangled', s.entangled ? 'yes' : 'no'],
              ]}
            />
          </>
        );
        break;
      }
      case 'molecule': {
        const atoms = result
          .filter((r) => r.x !== '' && r.x !== null)
          .map((r) => ({ el: String(r.element), x: n(r.x), y: n(r.y), z: n(r.z) }));
        const bonds = (tables['bonds.csv'] ?? []).map((b) => ({
          a: n(b.a),
          b: n(b.b),
          order: n(b.order),
        }));
        view = (
          <>
            <Atoms3D
              atoms={atoms}
              bonds={bonds}
              height={large ? 340 : 240}
              label={`3D structure of ${String(s.formula)}`}
            />
            <Facts
              items={[
                ['Formula', s.formula],
                ['Molar mass', s.mol_weight, 'g/mol'],
                ['logP', s.logp],
                ['TPSA', s.tpsa, 'Å²'],
                ['H-bond donors / acceptors', `${String(s.h_donors)} / ${String(s.h_acceptors)}`],
                ['MMFF energy', s.mmff_energy_kcal_mol, 'kcal/mol'],
              ]}
            />
          </>
        );
        break;
      }
      case 'turbofan':
      case 'cad_model':
      case 'rocket_cad':
        view = (
          <Suspense fallback={<div className="empty">Loading 3D view…</div>}>
            <CadView card={card} large={large} />
          </Suspense>
        );
        break;
      case 'pcb_design':
      case 'pcb_recheck':
        view = <PcbView card={card} rows={result} />;
        break;
      case 'design_assembly': {
        const interferences = (s.interferences as [string, string, number][] | undefined) ?? [];
        const constraints =
          (s.constraints as [string, string, string, number, number, number, boolean][]) ?? [];
        const requirements = (s.requirements as [string, number, number, boolean][]) ?? [];
        view = (
          <>
            <Suspense fallback={<div className="empty">Loading 3D view…</div>}>
              <CadView card={card} large={large} />
            </Suspense>
            <Facts
              items={[
                ['Verdict', s.design_ok ? 'meets its requirements' : 'needs rework'],
                ['Mass', s.total_mass_kg, 'kg'],
                [
                  'Size x / y / z',
                  `${fmt(s.extent_x_mm)} / ${fmt(s.extent_y_mm)} / ${fmt(s.extent_z_mm)}`,
                  'mm',
                ],
                [
                  'Centre of mass',
                  (s.centre_of_mass_mm as number[] | undefined)?.join(' / '),
                  'mm',
                ],
                [
                  'Interferences',
                  `${interferences.length} in ${fmt(s.interference_pairs_tested)} pairs tested`,
                ],
                ['Constraints met', `${fmt(s.constraints_met)} of ${fmt(s.constraints_total)}`],
              ]}
            />
            {(interferences.length > 0 || constraints.length > 0 || requirements.length > 0) && (
              <ul className="lab-notes">
                {interferences.map(([a, b, v]) => (
                  <li key={`${a}-${b}`} className="bad">
                    {a} intersects {b} by {fmt(v)} mm³
                  </li>
                ))}
                {constraints.map(([type, a, b, want, tol, got, ok]) => (
                  <li key={`${type}-${a}-${b}`} className={ok ? 'good' : 'bad'}>
                    {type} {a} – {b}: measured {fmt(got)} mm, wanted {fmt(want)} ± {fmt(tol)} mm
                  </li>
                ))}
                {requirements.map(([key, limit, actual, ok]) => (
                  <li key={key} className={ok ? 'good' : 'bad'}>
                    {key}: {fmt(actual)} (limit {fmt(limit)})
                  </li>
                ))}
              </ul>
            )}
          </>
        );
        break;
      }
      case 'rocket_engine':
        view = (
          <>
            <NozzleDiagram rows={numeric(tables['contour.csv'] ?? [])} />
            <LineChart
              rows={numeric(tables['of_sweep.csv'] ?? [])}
              x="of_ratio"
              series={[
                { key: 'isp_vac_s', label: 'Isp vacuum', color: '#6e7bf2' },
                { key: 'isp_sl_s', label: 'Isp sea level', color: '#e0803c' },
              ]}
              xLabel="Mixture ratio O/F"
              yLabel="Ideal Isp (s)"
              height={h}
              marks={[{ x: n(s.of_ratio), label: `O/F ${fmt(s.of_ratio, 3)}` }]}
            />
            <Facts
              items={[
                ['Propellant', s.propellant_name],
                [
                  'Chamber',
                  `${fmt(s.chamber_pressure_bar)} bar, ${fmt(s.chamber_temperature_K)} K`,
                ],
                ['Isp vacuum / sea level', `${fmt(s.isp_vac_s)} / ${fmt(s.isp_sl_s)}`, 's'],
                ['Delivered Isp vacuum', s.delivered_isp_vac_s, 's'],
                ['c*', s.cstar_m_s, 'm/s'],
                [
                  'Thrust vacuum / sea level',
                  `${fmt(s.thrust_vac_kN)} / ${fmt(s.thrust_sl_kN)}`,
                  'kN',
                ],
                ['Mass flow', s.mass_flow_kg_s, 'kg/s'],
                [
                  'Throat / exit',
                  `${fmt(s.throat_diameter_mm)} / ${fmt(s.exit_diameter_mm)}`,
                  'mm',
                ],
                ['Expansion ratio', s.expansion_ratio],
                ['Throat heat flux', s.throat_heat_flux_MW_m2, 'MW/m²'],
                ['Flow separation at sea level', s.separation_at_sea_level ? 'likely' : 'no'],
              ]}
            />
          </>
        );
        break;
      case 'launch_vehicle':
        view = (
          <>
            <BarChart
              items={result.map((r) => ({
                label: String(r.name),
                value: n(r.ignition_mass_kg) / 1000,
              }))}
              yLabel="Mass at ignition (t)"
              color="#6e7bf2"
              height={h}
            />
            <Facts
              items={[
                ['Liftoff mass', n(s.liftoff_mass_kg) / 1000, 't'],
                ['Payload', n(s.payload_kg) / 1000, 't'],
                ['Payload fraction', n(s.payload_fraction) * 100, '%'],
                ['Delta-v', `${fmt(s.delta_v_total_m_s)} of ${fmt(s.delta_v_required_m_s)}`, 'm/s'],
                [
                  'Split per stage',
                  (s.delta_v_split_m_s as number[] | undefined)?.join(' / '),
                  'm/s',
                ],
                ['Liftoff thrust-to-weight', s.liftoff_twr],
                [
                  'Suggested thrust per stage',
                  result.map((r) => fmt(n(r.suggested_thrust_kN))).join(' / '),
                  'kN',
                ],
                ['Reaches orbit', s.reaches_orbit ? 'yes' : 'no'],
                ['Problems', (s.problems as string[] | undefined)?.join('; ')],
              ]}
            />
          </>
        );
        break;
      case 'ascent_trajectory':
        view = (
          <>
            <LineChart
              rows={numeric(result)}
              x="downrange_km"
              series={[{ key: 'altitude_km', label: 'Altitude', color: '#6e7bf2' }]}
              xLabel="Downrange (km)"
              yLabel="Altitude (km)"
              yMin={0}
              height={h}
            />
            <LineChart
              rows={numeric(result)}
              x="t_s"
              series={[{ key: 'q_kPa', label: 'Dynamic pressure', color: '#e0803c' }]}
              xLabel="Time (s)"
              yLabel="Dynamic pressure (kPa)"
              yMin={0}
              height={Math.round(h * 0.7)}
              marks={[{ x: n(s.max_q_time_s), label: 'max-Q' }]}
            />
            <LineChart
              rows={numeric(result)}
              x="t_s"
              series={[{ key: 'accel_g', label: 'Acceleration', color: '#10a37f' }]}
              xLabel="Time (s)"
              yLabel="Acceleration (g)"
              yMin={0}
              height={Math.round(h * 0.7)}
            />
            <Facts
              items={[
                ['Orbit', s.orbit_reached ? `reached, ${fmt(s.apoapsis_km)} km` : 'not reached'],
                ['Propellant left', s.propellant_margin_kg, 'kg'],
                ['Max-Q', `${fmt(s.max_q_kPa)} kPa at ${fmt(s.max_q_time_s)} s`],
                ['Peak acceleration', s.max_accel_g, 'g'],
                [
                  'Losses: gravity / drag / steering',
                  `${fmt(s.gravity_loss_m_s)} / ${fmt(s.drag_loss_m_s)} / ${fmt(s.steering_loss_m_s)}`,
                  'm/s',
                ],
                ['Circularisation', s.circularization_delta_v_m_s, 'm/s'],
                [
                  'Events',
                  (s.events as [string, number, number][] | undefined)
                    ?.map(([e, t]) => `${e} ${Math.round(t)} s`)
                    .join(' · '),
                ],
              ]}
            />
          </>
        );
        break;
      case 'rocket_tanks':
        view = (
          <>
            <BarChart
              items={result.map((r) => ({
                label: `${String(r.name)} ${String(r.tank)}`,
                value: n(r.mass_kg),
              }))}
              yLabel="Tank mass (kg)"
              color="#9b7cf0"
              height={h}
            />
            <Facts
              items={[
                ['Tank structure in total', n(s.tank_mass_total_kg) / 1000, 't'],
                ['Smallest pressure margin', n(s.min_pressure_margin) * 100, '%'],
                ['Smallest buckling margin', n(s.min_buckling_margin) * 100, '%'],
                ['Longest tank', s.longest_tank_m, 'm'],
              ]}
            />
          </>
        );
        break;
      case 'fcc_crystal': {
        const cell = fccCell(String(s.element), n(s.a0_angstrom) || 3.6);
        view = (
          <>
            <div className="lab-split">
              <Atoms3D
                atoms={cell.atoms}
                edges={cell.edges}
                atomScale={1.15}
                height={large ? 300 : 200}
                label={`fcc unit cell of ${String(s.element)}`}
              />
              <LineChart
                rows={numeric(result)}
                x="a_angstrom"
                series={[{ key: 'energy_eV', label: 'Energy', color: '#d0803c' }]}
                xLabel="Lattice constant (Å)"
                yLabel="Energy per atom (eV)"
                height={h}
                marks={[
                  { x: n(s.a0_angstrom), label: 'minimum', color: '#d0803c' },
                  { x: n(s.a_exp_angstrom), label: 'experiment', color: '#10a37f' },
                ]}
              />
            </div>
            <Facts
              items={[
                ['Lattice constant', s.a0_angstrom, 'Å'],
                ['Experiment', s.a_exp_angstrom, 'Å'],
                ['Deviation', s.deviation_percent, '%'],
                ['Cohesive energy', s.cohesive_energy_eV, 'eV'],
                ['Bulk modulus', s.bulk_modulus_GPa, 'GPa'],
              ]}
            />
          </>
        );
        break;
      }
      default:
        view = <Facts items={Object.entries(s).map(([k, v]) => [k, v] as [string, unknown])} />;
    }
  }

  return (
    <div className={`lab-view ${large ? 'large' : ''}`}>
      <div className="chat-card-head">
        <Icon name="sparkle" size={15} />
        <strong>{card.title}</strong>
        <span
          className={`verify-chip ${card.verified ? 'good' : card.verified === false ? 'warn' : ''}`}
        >
          {card.verified
            ? 'verified independently'
            : card.verified === false
              ? 'check failed'
              : 'not checked'}
        </span>
        <a className="muted" href={`#/task/${card.taskId}`}>
          open task
        </a>
      </div>
      {view}
      {typeof s.model === 'string' && <p className="muted small lab-model">Model: {s.model}</p>}
    </div>
  );
}
