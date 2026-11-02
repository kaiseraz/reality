import { useCallback, useEffect, useState } from 'react';
import { api, type InboxItem } from '../api.ts';
import { Icon } from '../ui/Icon.tsx';
import { relativeTime } from '../ui/status.ts';

/** Every decision waiting for you, across projects and single tasks. */
export function InboxPage({
  openTask,
  openProject,
  onChanged,
}: {
  openTask: (id: string) => void;
  openProject: (id: string) => void;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .inbox()
      .then((i) => {
        setItems(i);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load]);

  const decide = async (taskId: string, approved: boolean) => {
    setBusy(taskId);
    setError(null);
    try {
      await api.decide(taskId, approved);
      load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div className="grow">
          <h1>Inbox</h1>
          <p>Decisions your agents are waiting for. Nothing in here runs until you decide.</p>
        </div>
      </header>
      {error && (
        <p className="callout tone-bad" role="alert">
          <Icon name="alert" /> <span>{error}</span>
        </p>
      )}
      {items && items.length === 0 && (
        <div className="empty">
          <Icon name="check" size={28} />
          <p>Nothing waits for you. Your agents keep working on their own.</p>
        </div>
      )}
      <ul className="inbox">
        {(items ?? []).map((i) => (
          <li key={i.taskId} className="card inbox-item">
            <div className="inbox-icon">
              <Icon name={i.kind === 'capability-approval' ? 'puzzle' : 'shield'} />
            </div>
            <div className="grow">
              <strong>{i.summary}</strong>
              <p className="muted">{i.request}</p>
              {i.reason && (
                <p className="inbox-reason">
                  <Icon name="info" size={13} /> {i.reason}
                </p>
              )}
              <small className="muted">
                Waiting {relativeTime(i.since)}
                {i.project && (
                  <>
                    {' · '}
                    <a
                      href={`#/project/${i.project.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        if (i.project) openProject(i.project.id);
                      }}
                    >
                      {i.project.goal.split('\n')[0]}
                    </a>
                  </>
                )}
              </small>
            </div>
            <div className="inbox-actions">
              <button onClick={() => openTask(i.taskId)}>Review</button>
              {i.kind === 'plan-approval' && (
                <button
                  className="btn-primary"
                  disabled={busy === i.taskId}
                  onClick={() => void decide(i.taskId, true)}
                >
                  <Icon name="check" /> Approve plan
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
