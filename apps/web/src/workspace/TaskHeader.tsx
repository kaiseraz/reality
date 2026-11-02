import { useEffect, useState, type ChangeEvent } from 'react';
import type { TaskEvent } from '@reality/schemas';
import { api, isProjectRef, type TaskDetail } from '../api.ts';
import { Icon } from '../ui/Icon.tsx';
import { statusOf } from '../ui/status.ts';

type Stage = 'plan' | 'approve' | 'run' | 'verify' | 'done';
const STAGES: { id: Stage; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'approve', label: 'Approve' },
  { id: 'run', label: 'Run in sandbox' },
  { id: 'verify', label: 'Verify' },
  { id: 'done', label: 'Done' },
];

/** Where the task is: the current stage, and whether it waits for the user or failed there. */
export function progressOf(
  task: TaskDetail | null,
  events: TaskEvent[],
): { current: Stage; state: 'active' | 'wait' | 'failed' | 'done' } {
  if (!task) return { current: 'plan', state: 'active' };
  const hasPlan = Boolean(task.state?.spec);
  const verifying = events.some((e) => e.type === 'check.completed');
  const kind = (task.pendingApproval as { kind?: string } | null)?.kind;
  switch (task.status) {
    case 'draft':
    case 'planning':
      return { current: 'plan', state: 'active' };
    case 'awaiting_approval':
      return { current: kind === 'capability-approval' ? 'run' : 'approve', state: 'wait' };
    case 'running':
      return { current: verifying ? 'verify' : 'run', state: 'active' };
    case 'completed':
      return { current: 'done', state: 'done' };
    case 'rejected':
      return { current: 'approve', state: 'failed' };
    default:
      return { current: !hasPlan ? 'plan' : verifying ? 'verify' : 'run', state: 'failed' };
  }
}

function Stepper({ task, events }: { task: TaskDetail | null; events: TaskEvent[] }) {
  const p = progressOf(task, events);
  const at = STAGES.findIndex((s) => s.id === p.current);
  return (
    <ol className="stepper" aria-label="progress">
      {STAGES.map((s, i) => {
        const cls =
          p.state === 'done' || i < at
            ? 'done'
            : i === at
              ? p.state === 'failed'
                ? 'failed'
                : `current ${p.state === 'wait' ? 'wait' : ''}`
              : '';
        return (
          <li key={s.id} className={cls} aria-current={i === at ? 'step' : undefined}>
            <span className="node">
              {cls === 'done' ? (
                <Icon name="check" size={12} />
              ) : cls === 'failed' ? (
                <Icon name="x" size={12} />
              ) : null}
            </span>
            {s.label}
          </li>
        );
      })}
    </ol>
  );
}

const ANSWER_ORDER = [
  'forecast',
  'correlate',
  'query',
  'season_by_group',
  'decompose',
  'breakdown',
];

/**
 * The lines a person wants first: what each analysis step found. The answer-specific steps
 * (forecast, correlation, decomposition, …) come before the plain totals over time.
 */
function findingsOf(task: TaskDetail): string[] {
  const skip = new Set(['profile', 'verify', 'acquire']);
  const done = (task.state?.stepResults ?? []).filter(
    (r) => r.status === 'done' && !skip.has(r.stepId),
  );
  const rank = (id: string) => {
    const i = ANSWER_ORDER.indexOf(id);
    return i < 0 ? ANSWER_ORDER.length : i;
  };
  const specific = done
    .filter((r) => r.stepId !== 'aggregate')
    .sort((a, b) => rank(a.stepId) - rank(b.stepId));
  const lines: string[] = [];
  for (const r of specific.length > 0 ? specific : done) {
    for (const line of r.detail.split('\n').slice(0, 2)) {
      const t = line.trim();
      if (t && !t.startsWith('Daily values summed')) lines.push(t);
    }
  }
  return lines.slice(0, 6);
}

function ApprovalBanner({ task }: { task: TaskDetail }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = task.pendingApproval as {
    kind?: string;
    proposal?: { package?: string; version?: string; need?: string };
  } | null;
  const isCapability = request?.kind === 'capability-approval';
  const spec = task.state?.spec;
  const decide = async (approved: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.decide(task.id, approved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="banner tone-warn" role="region" aria-label="approval needed">
      <Icon name="shield" />
      <span className="grow">
        {isCapability ? (
          <>
            <strong>
              Install {request?.proposal?.package} {request?.proposal?.version}?
            </strong>{' '}
            Needed for “{request?.proposal?.need}”. Details, license and tests are in the Approvals
            panel.
          </>
        ) : (
          <>
            <strong>Plan ready.</strong> {spec?.workflow.length ?? 0} steps,{' '}
            {spec?.acceptanceCriteria.length ?? 0} checks. Nothing runs until you approve.
          </>
        )}
        {error && <span role="alert"> {error}</span>}
      </span>
      <button className="btn-primary" disabled={busy} onClick={() => void decide(true)}>
        <Icon name="check" /> {isCapability ? 'Approve install' : 'Approve and run'}
      </button>
      <button disabled={busy} onClick={() => void decide(false)}>
        Deny
      </button>
    </div>
  );
}

function ResultBanner({ task }: { task: TaskDetail }) {
  const checks = task.state?.verification ?? [];
  const passed = checks.filter((c) => c.status === 'passed').length;
  const failed = checks.filter((c) => c.status === 'failed').length;
  const findings = findingsOf(task);
  const tone = failed > 0 ? 'bad' : 'ok';
  return (
    <div className={`banner tone-${tone}`} role="region" aria-label="result">
      <Icon name={failed > 0 ? 'alert' : 'check'} />
      <div className="grow">
        {findings.length > 0 ? (
          <ul className="findings">
            {findings.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : (
          <strong>Task completed.</strong>
        )}
      </div>
      {checks.length > 0 && (
        <span className={`pill tone-${tone}`}>
          {passed}/{checks.length} checks passed
        </span>
      )}
    </div>
  );
}

export function TaskHeader({
  task,
  events,
  version,
  busy,
  onAttach,
  onUndo,
}: {
  task: TaskDetail | null;
  events: TaskEvent[];
  version: number;
  busy: boolean;
  onAttach: (e: ChangeEvent<HTMLInputElement>) => void;
  onUndo: () => void;
}) {
  const s = statusOf(task?.status ?? 'draft');
  const taskId = task?.id;
  const [project, setProject] = useState<{ id: string; goal: string } | null>(null);
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    api
      .taskProject(taskId)
      .then((p) => !cancelled && setProject(isProjectRef(p) ? p : null))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [taskId]);
  return (
    <header className="task-head">
      {project && (
        <a className="crumb" href={`#/project/${project.id}`}>
          <Icon name="command" size={12} /> {project.goal.split(String.fromCharCode(10))[0]}
        </a>
      )}
      <div className="task-head-row">
        <h2 title={task?.request}>{task?.request ?? ''}</h2>
        <span className={`pill tone-${s.tone}`}>
          <span className={`dot tone-${s.tone} ${s.live ? 'live' : ''}`} />
          <span data-testid="status" data-status={task?.status}>
            {task ? s.label : '…'}
          </span>
        </span>
        <span className="version hide-sm" data-testid="version" title="Workspace version">
          v{version}
        </span>
        <label className={`button ${busy ? 'disabled' : ''}`} title="Attach a CSV">
          <Icon name="upload" />
          <span className="hide-sm">Attach CSV</span>
          <input type="file" accept=".csv,text/csv" hidden disabled={busy} onChange={onAttach} />
        </label>
        <button onClick={onUndo} title="Undo the last workspace change">
          <Icon name="undo" />
          <span className="hide-sm">Undo</span>
        </button>
      </div>
      <Stepper task={task} events={events} />
      {task?.status === 'awaiting_approval' && task.pendingApproval !== null && (
        <ApprovalBanner task={task} />
      )}
      {task?.status === 'completed' && <ResultBanner task={task} />}
      {(task?.status === 'failed' || task?.status === 'budget_exceeded') && (
        <div className="banner tone-bad" role="region" aria-label="error">
          <Icon name="alert" />
          <span className="grow">
            <strong>{s.label}.</strong> {task.state?.error ?? 'See the Plan and Runs panels.'}
          </span>
        </div>
      )}
    </header>
  );
}
