import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { BotView } from '@reality/schemas';
import { api, type PageSummary, type Routine, type Sample, type Schedule } from '../api.ts';
import { Icon } from '../ui/Icon.tsx';
import { relativeTime, statusOf } from '../ui/status.ts';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NEW_PAGE = '__new__';

export function scheduleText(s: Schedule): string {
  if (s.type === 'interval') {
    return s.minutes % 60 === 0 ? `Every ${s.minutes / 60} h` : `Every ${s.minutes} min`;
  }
  if (s.type === 'daily') return `Daily at ${s.time}`;
  if (s.type === 'weekdays') return `Weekdays at ${s.time}`;
  return `${DAYS[s.day] ?? '?'}s at ${s.time}`;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Routines: tasks that start themselves on a schedule, optionally writing to a page. */
export function RoutinesPage({
  openTask,
  openPage,
}: {
  openTask: (id: string) => void;
  openPage: (id: string) => void;
}) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [bots, setBots] = useState<BotView[]>([]);
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [request, setRequest] = useState('');
  const [sample, setSample] = useState('');
  const [botId, setBotId] = useState('');
  const [pageId, setPageId] = useState('');
  const [type, setType] = useState<Schedule['type']>('weekly');
  const [time, setTime] = useState('08:00');
  const [day, setDay] = useState(1);
  const [minutes, setMinutes] = useState(60);
  const [autoApprove, setAutoApprove] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .routines()
      .then(setRoutines)
      .catch((e: unknown) => setError(message(e)));
    // Runs add versions to pages: keep the shown version numbers current.
    api
      .pages()
      .then(setPages)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    api
      .bots()
      .then(setBots)
      .catch(() => setBots([]));
    api
      .pages()
      .then(setPages)
      .catch(() => setPages([]));
    api
      .samples()
      .then((s) => setSamples(Array.isArray(s) ? s : []))
      .catch(() => setSamples([]));
    return () => clearInterval(t);
  }, [load]);

  const schedule: Schedule =
    type === 'interval'
      ? { type, minutes }
      : type === 'weekly'
        ? { type, time, day }
        : { type, time };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let target: string | null = pageId || null;
      if (pageId === NEW_PAGE) {
        target = (await api.createPage(name.trim(), `# ${name.trim()}\n`)).id;
      }
      await api.createRoutine({
        name: name.trim(),
        request: request.trim(),
        schedule,
        sample: sample || null,
        botId: botId || null,
        pageId: target,
        autoApprove,
        enabled: true,
      });
      setName('');
      setRequest('');
      load();
      api
        .pages()
        .then(setPages)
        .catch(() => undefined);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    }
    load();
  };

  return (
    <div className="page">
      <header className="page-head">
        <div className="grow">
          <h1>Routines</h1>
          <p>
            Tasks that start themselves on a schedule, also while you are away. Each run is a normal
            task with a plan and independent checks. Times are the server’s local time.
          </p>
        </div>
      </header>

      <form className="card routine-form" onSubmit={(e) => void create(e)}>
        <strong>New routine</strong>
        <input
          aria-label="Name"
          placeholder="Name, e.g. Weekly bike check"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          aria-label="Task"
          rows={2}
          required
          placeholder="What should run each time? e.g. Which weather situation drives bike rentals (cnt)?"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
        />
        <div className="row">
          <select
            aria-label="Repeat"
            value={type}
            onChange={(e) => setType(e.target.value as Schedule['type'])}
          >
            <option value="daily">Daily</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">Weekly</option>
            <option value="interval">Every few hours</option>
          </select>
          {type === 'weekly' && (
            <select aria-label="Day" value={day} onChange={(e) => setDay(Number(e.target.value))}>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          )}
          {type === 'interval' ? (
            <select
              aria-label="Interval"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            >
              {[15, 30, 60, 120, 240, 360, 720].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} min` : `${m / 60} h`}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="time"
              aria-label="Time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              required
            />
          )}
        </div>
        <div className="row">
          <select aria-label="Data" value={sample} onChange={(e) => setSample(e.target.value)}>
            <option value="">No data (research question)</option>
            {samples.map((s) => (
              <option key={s.id} value={s.id}>
                Data: {s.title}
              </option>
            ))}
          </select>
          <select aria-label="Bot" value={botId} onChange={(e) => setBotId(e.target.value)}>
            <option value="">No bot</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                Done by {b.name}
              </option>
            ))}
          </select>
          <select aria-label="Page" value={pageId} onChange={(e) => setPageId(e.target.value)}>
            <option value="">Do not write to a page</option>
            <option value={NEW_PAGE}>Add results to a new page</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                Add results to “{p.title}”
              </option>
            ))}
          </select>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={autoApprove}
            onChange={(e) => setAutoApprove(e.target.checked)}
          />
          <span>
            <strong>Approve plans automatically when safe</strong>
            <small className="muted">
              Only plans with reviewed recipes, no new capability and machine-checked criteria.
              Anything else waits for you in the inbox.
            </small>
          </span>
        </label>
        <div>
          <button
            type="submit"
            className="btn-primary"
            disabled={busy || !name.trim() || !request.trim()}
          >
            <Icon name="plus" /> Create routine
          </button>
        </div>
      </form>
      {error && (
        <p className="callout tone-bad" role="alert" style={{ marginTop: 12 }}>
          <Icon name="alert" /> <span>{error}</span>
        </p>
      )}

      {routines && routines.length === 0 && (
        <p className="muted" style={{ marginTop: 12 }}>
          No routines yet.
        </p>
      )}
      <ul className="plain routine-list">
        {(routines ?? []).map((r) => {
          const bot = bots.find((b) => b.id === r.botId);
          const page = pages.find((p) => p.id === r.pageId);
          return (
            <li key={r.id} className="card">
              <div className="row">
                <span className="grow">
                  <strong>{r.name}</strong>
                  <small className="muted routine-meta">
                    {scheduleText(r.schedule)}
                    {r.enabled && r.nextRun ? ` · next ${when(r.nextRun)}` : ' · paused'}
                    {bot ? ` · ${bot.name}` : ''}
                    {r.autoApprove ? ' · approves safe plans' : ' · asks you'}
                  </small>
                </span>
                <button onClick={() => void act(() => api.runRoutine(r.id))}>
                  <Icon name="play" /> Run now
                </button>
                <button
                  onClick={() => void act(() => api.updateRoutine(r.id, { enabled: !r.enabled }))}
                >
                  {r.enabled ? 'Pause' : 'Resume'}
                </button>
                <button
                  className="btn-ghost"
                  aria-label={`Delete ${r.name}`}
                  onClick={() => void act(() => api.deleteRoutine(r.id))}
                >
                  <Icon name="x" />
                </button>
              </div>
              <p className="routine-request">{r.request}</p>
              {page && (
                <button className="link" onClick={() => openPage(page.id)}>
                  <Icon name="file" /> {page.title} (version {page.version})
                </button>
              )}
              {r.runs.length > 0 && (
                <ul className="plain routine-runs">
                  {r.runs.slice(0, 5).map((run) => {
                    const s = statusOf(run.status);
                    return (
                      <li key={run.taskId}>
                        <button className="task-item" onClick={() => openTask(run.taskId)}>
                          <span className={`dot tone-${s.tone} ${s.live ? 'live' : ''}`} />
                          <span className="title">
                            {s.label}
                            {run.note ? ` · ${run.note}` : ''}
                          </span>
                          <span className="meta">{relativeTime(run.startedAt)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
