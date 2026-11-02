import { useEffect, useState, type FormEvent } from 'react';
import type { BotView } from '@reality/schemas';
import { api, type Sample } from '../api.ts';
import { BotAvatar, ROLE } from '../bots/BotAvatar.tsx';
import { Icon } from '../ui/Icon.tsx';

const EXAMPLE = `Bike sharing review:
1. Which factors influence daily bike rentals (cnt)?
2. Which weather situation (weathersit) drives bike rentals (cnt)?
3. Is there a seasonal pattern in daily bike rentals (cnt)?`;

/** A long-term goal becomes a project: tasks, dependencies, data, autonomy and budget. */
export function NewProjectPage({ onCreated }: { onCreated: (id: string) => void }) {
  const [goal, setGoal] = useState('');
  const [samples, setSamples] = useState<Sample[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [bots, setBots] = useState<BotView[]>([]);
  const [team, setTeam] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [autonomy, setAutonomy] = useState<'ask-every-plan' | 'ask-critical'>('ask-every-plan');
  const [maxParallel, setMaxParallel] = useState(2);
  const [maxTasks, setMaxTasks] = useState(20);
  const [maxMinutes, setMaxMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .bots()
      .then((b) => setBots(Array.isArray(b) ? b : []))
      .catch(() => setBots([]));
  }, []);
  useEffect(() => {
    api
      .samples()
      .then((s) => setSamples(Array.isArray(s) ? s : []))
      .catch(() => setSamples([]));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Created paused, so every task sees the uploaded files; then started.
      const project = await api.createProject({
        goal: goal.trim(),
        autonomy,
        maxParallel,
        budget: { maxTasks, maxSandboxMinutes: maxMinutes },
        samples: chosen,
        team,
        start: false,
      });
      for (const f of files) await api.addProjectFile(project.id, f);
      await api.resumeProject(project.id);
      onCreated(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div className="grow">
          <h1>New project</h1>
          <p>
            A long-term goal, worked on by agents in the background, also while you are away. Each
            line or numbered item becomes a task; a line starting with “then” or mentioning “the
            result” builds on the one before.
          </p>
        </div>
      </header>
      <form className="project-form" onSubmit={(e) => void submit(e)}>
        <section className="card">
          <label htmlFor="goal" className="field-label">
            Goal
          </label>
          <textarea
            id="goal"
            rows={6}
            value={goal}
            placeholder={EXAMPLE}
            onChange={(e) => setGoal(e.target.value)}
          />
          <button type="button" className="btn-ghost" onClick={() => setGoal(EXAMPLE)}>
            <Icon name="sparkle" /> Use the example
          </button>
        </section>

        <section className="card">
          <span className="field-label">Data for every task</span>
          <div className="checks">
            {samples.map((s) => (
              <label key={s.id} className="check">
                <input
                  type="checkbox"
                  checked={chosen.includes(s.id)}
                  onChange={(e) =>
                    setChosen((c) =>
                      e.target.checked ? [...c, s.id] : c.filter((x) => x !== s.id),
                    )
                  }
                />
                <span>
                  <strong>{s.title}</strong>
                  <small className="muted">{s.description}</small>
                </span>
              </label>
            ))}
          </div>
          <label className="button btn-ghost" htmlFor="project-files">
            <Icon name="upload" /> Add CSV files
          </label>
          <input
            id="project-files"
            type="file"
            accept=".csv,text/csv"
            multiple
            hidden
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
          {files.length > 0 && <p className="muted">{files.map((f) => f.name).join(', ')}</p>}
        </section>

        <section className="card">
          <span className="field-label">Who works on it?</span>
          {bots.length === 0 ? (
            <p className="muted">
              No team yet. Without bots, tasks run unassigned. Add bots on the Team page.
            </p>
          ) : (
            <div className="checks">
              {bots.map((b) => (
                <label key={b.id} className="check">
                  <input
                    type="checkbox"
                    checked={team.includes(b.id)}
                    onChange={(e) =>
                      setTeam((t) =>
                        e.target.checked ? [...t, b.id] : t.filter((x) => x !== b.id),
                      )
                    }
                  />
                  <BotAvatar bot={b} size={28} />
                  <span>
                    <strong>{b.name}</strong>
                    <small className="muted">{ROLE[b.role].label}</small>
                  </span>
                </label>
              ))}
            </div>
          )}
          {team.length > 0 && (
            <small className="muted">
              Each bot works on one task at a time, so at most {team.length} tasks run at once.
            </small>
          )}
        </section>

        <section className="card">
          <span className="field-label">Autonomy</span>
          <div className="choices">
            <label className={`choice ${autonomy === 'ask-every-plan' ? 'on' : ''}`}>
              <input
                type="radio"
                name="autonomy"
                checked={autonomy === 'ask-every-plan'}
                onChange={() => setAutonomy('ask-every-plan')}
              />
              <strong>Ask me for every plan</strong>
              <small>Nothing runs until you approve each task’s plan.</small>
            </label>
            <label className={`choice ${autonomy === 'ask-critical' ? 'on' : ''}`}>
              <input
                type="radio"
                name="autonomy"
                checked={autonomy === 'ask-critical'}
                onChange={() => setAutonomy('ask-critical')}
              />
              <strong>Only critical decisions</strong>
              <small>
                Plans that use only reviewed analyses, need nothing new installed and are fully
                machine-checked run without asking. Installations and AI-written code always ask
                you.
              </small>
            </label>
          </div>
          <div className="row limits">
            <label>
              Tasks in parallel
              <select value={maxParallel} onChange={(e) => setMaxParallel(Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Max. tasks
              <input
                type="number"
                min={1}
                max={200}
                value={maxTasks}
                onChange={(e) => setMaxTasks(Number(e.target.value))}
              />
            </label>
            <label>
              Max. sandbox minutes
              <input
                type="number"
                min={1}
                max={10000}
                value={maxMinutes}
                onChange={(e) => setMaxMinutes(Number(e.target.value))}
              />
            </label>
          </div>
        </section>

        {error && (
          <p className="callout tone-bad" role="alert">
            <Icon name="alert" /> <span>Could not create the project: {error}</span>
          </p>
        )}
        <div className="row">
          <button type="submit" className="btn-primary btn-lg" disabled={busy || !goal.trim()}>
            <Icon name="play" /> {busy ? 'Creating…' : 'Create and start'}
          </button>
        </div>
      </form>
    </div>
  );
}
