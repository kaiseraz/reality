import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { BotView } from '@reality/schemas';
import { api, type Mission, type MissionCriterionInput } from '../api.ts';
import { BotAvatar } from '../bots/BotAvatar.tsx';
import { Icon } from '../ui/Icon.tsx';
import { relativeTime } from '../ui/status.ts';

type Op = 'min' | 'max' | 'target' | 'equals';
interface Row {
  field: string;
  op: Op;
  value: string;
  tolerance: string;
}

const OP_LABEL: Record<Op, string> = { min: '≥', max: '≤', target: '≈ (±%)', equals: '=' };

export const VERDICT: Record<string, { label: string; tone: string }> = {
  verified: { label: 'verified', tone: 'good' },
  partial: { label: 'partly verified', tone: 'warn' },
  not_verified: { label: 'not verified', tone: 'warn' },
  refuted: { label: 'refuted', tone: 'bad' },
  no_criteria: { label: 'no criteria', tone: '' },
};
export const STATUS: Record<Mission['status'], string> = {
  running: 'running',
  finished: 'finished',
  failed: 'failed',
  stopped: 'stopped',
  timeout: 'time is up',
  out_of_budget: 'budget used up',
};

/** A cost in its unit, short. */
export function money(v: number, unit: string): string {
  const n = v === 0 ? '0' : v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(2);
  return `${n} ${unit}`;
}

/** A comma- or space-separated list. */
const listOf = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

interface Example {
  label: string;
  goal: string;
  rows: Row[];
  maxTasks?: number;
  installs?: string;
}

const EXAMPLES: Example[] = [
  {
    label: 'A circuit board',
    goal: 'Design a 50 x 35 mm two-layer board for an NE555 astable timer: the 555 in SOIC8, two resistors and two capacitors (0603) for the timing, a 470 ohm resistor and a red LED (0603) on the output, and a 2-pin power header at the left edge. Route everything with no design-rule violations.',
    rows: [
      { field: 'design_ok', op: 'equals', value: 'true', tolerance: '' },
      { field: 'drc_violations', op: 'max', value: '0', tolerance: '' },
    ],
    maxTasks: 8,
  },
  {
    label: 'A machine assembly',
    goal: 'Design a pillow-block bearing assembly: a steel base plate (120 x 60 x 12 mm) with four 9 mm mounting holes, an aluminium housing on it with a 28 mm bore along x, a 20 mm steel shaft 140 mm long, two bearings (20 mm bore, 28 mm outside, 12 mm wide) pressed into the bore, and four M8 bolts in the plate holes. Nothing may intersect and the total mass must stay under 3 kg.',
    rows: [
      { field: 'interference_count', op: 'max', value: '0', tolerance: '' },
      { field: 'total_mass_kg', op: 'max', value: '3', tolerance: '' },
    ],
    maxTasks: 8,
  },
  {
    label: 'A rocket to orbit',
    goal: 'Design a two-stage rocket on methane and liquid oxygen that puts 5 tonnes into a 400 km orbit from 28.5 degrees latitude. Size the engine first, use its Isp for the staging, then fly it and make sure it reaches the orbit with propellant to spare.',
    rows: [
      { field: 'orbit_reached', op: 'equals', value: 'true', tolerance: '' },
      { field: 'propellant_margin_kg', op: 'min', value: '0', tolerance: '' },
    ],
    maxTasks: 12,
    installs: 'cantera',
  },
  {
    label: 'A Bragg mirror',
    goal: 'Design a Bragg mirror with 8 pairs at 1550 nm',
    rows: [{ field: 'peak_reflectance', op: 'min', value: '0.999', tolerance: '' }],
  },
  {
    label: 'Copper lattice',
    goal: 'Lattice constant of copper',
    rows: [{ field: 'a0_angstrom', op: 'target', value: '3.615', tolerance: '1' }],
  },
];

function toCriterion(r: Row): MissionCriterionInput | null {
  if (!r.field.trim() || !r.value.trim()) return null;
  if (r.op === 'equals') return { field: r.field.trim(), equals: r.value.trim() };
  const v = Number(r.value);
  if (!Number.isFinite(v)) return null;
  if (r.op === 'target') {
    return { field: r.field.trim(), target: v, tolerancePercent: Number(r.tolerance) || 1 };
  }
  return { field: r.field.trim(), [r.op]: v };
}

/** Missions: say the goal and how success is measured, read the verdict in the morning. */
export function MissionsPage({ openChat }: { openChat: (id: string) => void }) {
  const [missions, setMissions] = useState<Mission[] | null>(null);
  const [bots, setBots] = useState<BotView[]>([]);
  const [fields, setFields] = useState<Record<string, { field: string; label: string }[]>>({});
  const [goal, setGoal] = useState('');
  const [team, setTeam] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([{ field: '', op: 'min', value: '', tolerance: '' }]);
  const [hours, setHours] = useState(8);
  const [maxTasks, setMaxTasks] = useState(10);
  const [autoApprove, setAutoApprove] = useState(true);
  const [costBudget, setCostBudget] = useState('');
  const [installs, setInstalls] = useState('');
  const [domains, setDomains] = useState('');
  const [maxRounds, setMaxRounds] = useState(12);
  const [unit, setUnit] = useState('credits');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .missions()
      .then(setMissions)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    api
      .bots()
      .then((b) => {
        setBots(b);
        // A mission needs a team: the lead is on it unless someone chooses otherwise.
        setTeam((t) => (t.length > 0 ? t : b.filter((x) => x.isMain).map((x) => x.id)));
      })
      .catch(() => setBots([]));
    api
      .missionFields()
      .then(setFields)
      .catch(() => setFields({}));
    api
      .missionPricing()
      .then((p) => setUnit(p.unit))
      .catch(() => undefined);
    return () => clearInterval(t);
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const m = await api.createMission({
        goal: goal.trim(),
        botIds: team,
        criteria: rows.map(toCriterion).filter((c): c is MissionCriterionInput => c !== null),
        hours,
        maxTasks,
        autoApprove,
        ...(Number(costBudget) > 0 ? { costBudget: Number(costBudget) } : {}),
        allowInstalls: listOf(installs),
        allowDomains: listOf(domains),
        maxRounds,
      });
      openChat(m.chatId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const set = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="page">
      <header className="page-head">
        <div className="grow">
          <h1>Missions</h1>
          <p>
            Give your team a goal and say how success is measured, then let it work, also overnight.
            Code decides the verdict from independently checked results; a bot cannot declare
            success on its own.
          </p>
        </div>
      </header>

      <form className="card mission-form" onSubmit={(e) => void create(e)}>
        <strong>New mission</strong>
        <textarea
          aria-label="Goal"
          rows={2}
          required
          placeholder="Goal, e.g. Design a Bragg mirror with 8 pairs at 1550 nm"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
        <div className="row examples">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              type="button"
              className="mention"
              title={ex.goal}
              onClick={() => {
                setGoal(ex.goal);
                setRows(ex.rows);
                setMaxTasks(ex.maxTasks ?? 10);
                setInstalls(ex.installs ?? '');
              }}
            >
              {ex.label}
            </button>
          ))}
        </div>
        <div className="field-label">Success means</div>
        {rows.map((r, i) => (
          <div key={i} className="row criterion-row">
            <input
              aria-label="Result value"
              list="mission-fields"
              placeholder="Result value, e.g. peak_reflectance"
              value={r.field}
              onChange={(e) => set(i, { field: e.target.value })}
            />
            <select
              aria-label="Comparison"
              value={r.op}
              onChange={(e) => set(i, { op: e.target.value as Op })}
            >
              {(Object.keys(OP_LABEL) as Op[]).map((o) => (
                <option key={o} value={o}>
                  {OP_LABEL[o]}
                </option>
              ))}
            </select>
            <input
              aria-label="Value"
              placeholder="Value"
              value={r.value}
              onChange={(e) => set(i, { value: e.target.value })}
            />
            {r.op === 'target' && (
              <input
                aria-label="Tolerance in percent"
                placeholder="± %"
                value={r.tolerance}
                onChange={(e) => set(i, { tolerance: e.target.value })}
              />
            )}
            <button
              type="button"
              className="btn-ghost"
              aria-label="Remove criterion"
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
            >
              <Icon name="x" />
            </button>
          </div>
        ))}
        <datalist id="mission-fields">
          {Object.entries(fields).flatMap(([engine, list]) =>
            list.map((f) => (
              <option key={`${engine}.${f.field}`} value={f.field}>
                {f.label} ({engine})
              </option>
            )),
          )}
        </datalist>
        <div>
          <button
            type="button"
            className="btn-ghost"
            onClick={() =>
              setRows((rs) => [...rs, { field: '', op: 'min', value: '', tolerance: '' }])
            }
          >
            <Icon name="plus" /> Add criterion
          </button>
        </div>
        <div className="field-label">Team</div>
        <div className="row">
          {bots.length === 0 && (
            <span className="muted small">Add bots on the Team page first.</span>
          )}
          {bots.map((b) => (
            <label key={b.id} className={`chip-check ${team.includes(b.id) ? 'on' : ''}`}>
              <input
                type="checkbox"
                checked={team.includes(b.id)}
                onChange={(e) =>
                  setTeam((t) => (e.target.checked ? [...t, b.id] : t.filter((x) => x !== b.id)))
                }
              />
              <BotAvatar bot={b} size={20} showStatus={false} /> {b.name}
            </label>
          ))}
        </div>
        <div className="row">
          <label className="inline-field">
            Time budget
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {[0.5, 1, 2, 4, 8, 12, 24].map((h) => (
                <option key={h} value={h}>
                  {h < 1 ? `${h * 60} min` : `${h} h`}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-field">
            Up to
            <input
              type="number"
              min={1}
              max={50}
              value={maxTasks}
              onChange={(e) => setMaxTasks(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
            />
            tasks
          </label>
          <label className="inline-field">
            Model budget
            <input
              type="number"
              min={0}
              step="any"
              placeholder="none"
              style={{ width: 96 }}
              aria-label="Model budget"
              value={costBudget}
              onChange={(e) => setCostBudget(e.target.value)}
            />
            {unit}
          </label>
          <label className="inline-field">
            Up to
            <input
              type="number"
              min={1}
              max={100}
              value={maxRounds}
              onChange={(e) =>
                setMaxRounds(Math.max(1, Math.min(100, Number(e.target.value) || 1)))
              }
            />
            rounds
          </label>
        </div>
        <div className="field-label">Allowed overnight without asking</div>
        <input
          aria-label="Libraries it may install"
          placeholder="Libraries it may install, e.g. statsmodels, rdkit"
          value={installs}
          onChange={(e) => setInstalls(e.target.value)}
        />
        <input
          aria-label="Sites its computers may visit"
          placeholder="Sites its computers may visit, e.g. celestrak.org, arxiv.org"
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
        />
        <small className="muted">
          Everything else waits for the morning without stopping the rest. At 80 % of the model
          budget the team wraps up; at 100 % the mission closes with a report.
        </small>
        <label className="check">
          <input
            type="checkbox"
            checked={autoApprove}
            onChange={(e) => setAutoApprove(e.target.checked)}
          />
          <span>
            <strong>Approve safe plans automatically</strong>
            <small className="muted">
              Plans with built-in engines and machine-checked results run without asking. Installing
              a library waits for you unless it is allowed above.
            </small>
          </span>
        </label>
        <div>
          <button
            type="submit"
            className="btn-primary"
            disabled={busy || !goal.trim() || team.length === 0}
          >
            <Icon name="target" /> Start mission
          </button>
        </div>
      </form>
      {error && (
        <p className="callout tone-bad" role="alert" style={{ marginTop: 12 }}>
          <Icon name="alert" /> <span>{error}</span>
        </p>
      )}

      <ul className="plain mission-list">
        {(missions ?? []).map((m) => {
          const v =
            VERDICT[m.status === 'running' ? m.liveVerdict : (m.verdict ?? '')] ??
            VERDICT.no_criteria;
          return (
            <li key={m.id} className="card">
              <button className="page-row" onClick={() => openChat(m.chatId)}>
                <Icon name="target" />
                <span className="grow">
                  <strong>{m.goal}</strong>
                  <small className="muted">
                    {STATUS[m.status]} · {m.tasksUsed} of {m.maxTasks} tasks ·{' '}
                    {money(m.spent, m.costUnit)}
                    {m.costBudget !== null ? ` of ${money(m.costBudget, m.costUnit)}` : ''} ·{' '}
                    {m.status === 'running'
                      ? `ends ${relativeTime(m.endsAt)}`
                      : `closed ${relativeTime(m.finishedAt ?? m.startedAt)}`}
                  </small>
                </span>
                <span className={`verify-chip ${v?.tone ?? ''}`}>
                  {m.status === 'running' ? 'now: ' : ''}
                  {v?.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
