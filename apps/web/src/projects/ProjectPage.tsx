import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ProjectTask } from '@reality/schemas';
import type { BotView } from '@reality/schemas';
import { api, type ProjectDetail } from '../api.ts';
import { BotAvatar } from '../bots/BotAvatar.tsx';
import { Icon } from '../ui/Icon.tsx';
import { relativeTime, type Tone } from '../ui/status.ts';

const COLUMNS: { id: ProjectTask['board'][]; title: string; tone: Tone }[] = [
  { id: ['waiting', 'blocked'], title: 'Waiting', tone: 'neutral' },
  { id: ['running'], title: 'Running', tone: 'info' },
  { id: ['needs_you'], title: 'Needs you', tone: 'warn' },
  { id: ['done'], title: 'Done', tone: 'ok' },
  { id: ['failed'], title: 'Failed', tone: 'bad' },
];

const PROJECT_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Working', tone: 'info' },
  paused: { label: 'Paused', tone: 'neutral' },
  completed: { label: 'Completed', tone: 'ok' },
  failed: { label: 'Stopped', tone: 'bad' },
  budget_exceeded: { label: 'Budget reached', tone: 'bad' },
};

/** Human-readable project log. */
function describe(e: ProjectDetail['events'][number], titleOf: (id: string) => string): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const task = typeof p.taskId === 'string' ? titleOf(p.taskId) : String(p.title ?? '');
  switch (e.type) {
    case 'project.created':
      return `Project created with ${String(p.tasks)} tasks (${p.planner === 'user' ? 'your task list' : String(p.planner)}).`;
    case 'task.started':
      return `Started “${task}”.`;
    case 'policy.approved':
      return `Policy approved the plan of “${task}”: ${String(p.reason)}`;
    case 'policy.deferred':
      return `“${task}” waits for you: ${String(p.reason)}`;
    case 'handoff':
      return `“${task}” received ${String(p.filename)} (${String(p.rows)} rows) from “${titleOf(String(p.fromTask))}”.`;
    case 'handoff.missing':
      return `“${task}”: ${String(p.reason)}`;
    case 'project.completed':
      return `All ${String(p.total)} tasks completed.`;
    case 'project.failed':
      return `Stopped: ${String(p.done)} of ${String(p.total)} tasks completed.`;
    case 'project.blocked':
      return String(p.reason);
    case 'project.budget_exceeded':
      return 'Budget reached; no new tasks are started.';
    case 'project.paused':
      return 'Paused.';
    case 'project.resumed':
      return 'Started.';
    case 'project.file_added':
      return `Data added: ${String(p.filename)}.`;
    case 'task.added':
      return `Task added: “${task}”.`;
    default:
      return e.type;
  }
}

export function ProjectPage({
  id,
  openTask,
  onChanged,
}: {
  id: string;
  openTask: (taskId: string) => void;
  onChanged?: () => void;
}) {
  const [p, setP] = useState<ProjectDetail | null>(null);
  const [bots, setBots] = useState<BotView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newTask, setNewTask] = useState('');
  const [after, setAfter] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .project(id)
      .then((d) => {
        setP(d);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  useEffect(() => {
    api
      .bots()
      .then((b) => setBots(Array.isArray(b) ? b : []))
      .catch(() => setBots([]));
  }, [p?.updatedAt]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, [load]);

  if (!p) {
    return (
      <div className="page">
        {error ? (
          <p className="callout tone-bad" role="alert">
            <Icon name="alert" /> <span>{error}</span>
          </p>
        ) : (
          <p className="muted">Loading project…</p>
        )}
      </div>
    );
  }

  const titleOf = (taskId: string) => p.tasks.find((t) => t.taskId === taskId)?.title ?? 'a task';
  const status = PROJECT_STATUS[p.status] ?? { label: p.status, tone: 'neutral' as Tone };
  const pct = p.counts.total ? Math.round((p.counts.done / p.counts.total) * 100) : 0;

  const toggle = async () => {
    setBusy(true);
    try {
      if (p.status === 'paused') await api.resumeProject(p.id);
      else await api.pauseProject(p.id);
      load();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!newTask.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addProjectTask(p.id, {
        request: newTask.trim(),
        dependsOn: after ? [after] : [],
        ...(after ? { inputFrom: after } : {}),
      });
      setNewTask('');
      setAfter('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page project">
      <header className="page-head">
        <div className="grow">
          <span className="eyebrow">
            <Icon name="command" size={14} /> Project
          </span>
          <h1 className="project-goal">{p.goal.split('\n')[0]}</h1>
          <p>
            {p.autonomy === 'ask-critical'
              ? 'Only critical decisions are asked; reviewed, fully checked plans run on their own.'
              : 'Every plan waits for your approval.'}{' '}
            Up to {p.maxParallel} tasks at a time · planned by{' '}
            {p.planner === 'user' ? 'you' : p.planner}
          </p>
        </div>
        <span className={`pill tone-${status.tone}`}>
          <span className={`dot tone-${status.tone} ${p.status === 'active' ? 'live' : ''}`} />
          {status.label}
        </span>
        {(p.status === 'active' || p.status === 'paused') && (
          <button disabled={busy} onClick={() => void toggle()}>
            <Icon name={p.status === 'paused' ? 'play' : 'x'} />
            {p.status === 'paused' ? 'Resume' : 'Pause'}
          </button>
        )}
      </header>

      <div className="stat-row">
        <div className="stat">
          <div className="label">Progress</div>
          <div className="value">
            {p.counts.done}/{p.counts.total}
          </div>
          <div className="meter">
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="stat">
          <div className="label">Needs you</div>
          <div className="value">{p.counts.needsYou}</div>
        </div>
        <div className="stat">
          <div className="label">Tasks started / budget</div>
          <div className="value">
            {p.usage.tasksStarted}/{p.budget.maxTasks}
          </div>
        </div>
        <div className="stat">
          <div className="label">Sandbox minutes / budget</div>
          <div className="value">
            {p.usage.sandboxMinutes}/{p.budget.maxSandboxMinutes}
          </div>
        </div>
      </div>

      <div className="board" aria-label="task board">
        {COLUMNS.map((col) => {
          const items = p.tasks.filter((t) => col.id.includes(t.board));
          return (
            <section key={col.title} className="column">
              <h3>
                <span className={`dot tone-${col.tone}`} /> {col.title}
                <span className="count">{items.length}</span>
              </h3>
              {items.map((t) => (
                <button key={t.taskId} className="task-card" onClick={() => openTask(t.taskId)}>
                  <strong>{t.title}</strong>
                  {(() => {
                    const b = bots.find((x) => x.id === t.botId);
                    return b ? (
                      <span className="card-bot">
                        <BotAvatar bot={b} size={18} showStatus={false} /> {b.name}
                      </span>
                    ) : null;
                  })()}
                  {t.board === 'blocked' && (
                    <small className="bad">Blocked: a dependency failed</small>
                  )}
                  {t.dependsOn.length > 0 && (
                    <small className="muted">After: {t.dependsOn.map(titleOf).join(', ')}</small>
                  )}
                  {t.inputFrom && (
                    <small className="muted">
                      <Icon name="arrow" size={12} /> Uses the result of “{titleOf(t.inputFrom)}”
                    </small>
                  )}
                </button>
              ))}
            </section>
          );
        })}
      </div>

      <div className="project-cols">
        <section className="card">
          <h3 className="card-title">Activity</h3>
          <ol className="project-log">
            {p.events.map((e) => (
              <li key={e.id}>
                <time title={new Date(e.createdAt).toLocaleString()}>
                  {relativeTime(e.createdAt)}
                </time>
                <span className={`badge ${e.actor === 'policy' ? 'state-enabled' : ''}`}>
                  {e.actor}
                </span>
                <span>{describe(e, titleOf)}</span>
              </li>
            ))}
          </ol>
        </section>
        <div className="side-stack">
          <section className="card">
            <h3 className="card-title">Data</h3>
            {p.files.length === 0 ? (
              <p className="muted">No data attached.</p>
            ) : (
              <ul className="plain">
                {p.files.map((f) => (
                  <li key={f.id}>
                    <Icon name="file" /> {f.filename}{' '}
                    <small className="muted">
                      {f.rowCount} rows · {f.columnNames.length} columns
                    </small>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <form className="card add-task" onSubmit={(e) => void add(e)}>
            <h3 className="card-title">Add a task</h3>
            <textarea
              rows={2}
              aria-label="New task"
              placeholder="Another question for this project"
              value={newTask}
              onChange={(e) => setNewTask(e.target.value)}
            />
            <label>
              Builds on (optional)
              <select value={after} onChange={(e) => setAfter(e.target.value)}>
                <option value="">Project data</option>
                {p.tasks.map((t) => (
                  <option key={t.taskId} value={t.taskId}>
                    Result of “{t.title}”
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={busy || !newTask.trim()}>
              <Icon name="plus" /> Add task
            </button>
            {error && (
              <p className="callout tone-bad" role="alert">
                <Icon name="alert" /> <span>{error}</span>
              </p>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
