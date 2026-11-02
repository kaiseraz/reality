import { useEffect, useState } from 'react';
import { api, type RunRecord } from '../../api.ts';
import { useWorkspace, type RendererProps } from '../context.ts';

/** Shows exactly what ran: code, status, duration and output of every sandbox run. */
export function RunLog(_props: RendererProps) {
  const { spec, events } = useWorkspace();
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const completed = events.filter((e) => e.type === 'run.completed').length;

  useEffect(() => {
    let cancelled = false;
    api
      .runs(spec.taskId)
      .then((r) => !cancelled && setRuns(r))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [spec.taskId, completed]);

  if (error)
    return (
      <p role="alert" className="pad">
        {error}
      </p>
    );
  if (!runs) return <p className="muted pad">Loading runs…</p>;
  if (runs.length === 0) return <p className="muted pad">No sandbox runs yet.</p>;

  return (
    <ol className="runs pad" aria-label="sandbox runs">
      {runs.map((r) => (
        <li key={r.id}>
          <details>
            <summary>
              <span className={`badge ${r.status}`}>{r.status}</span> <code>{r.label}</code>
              {r.stepId && <small> · step {r.stepId}</small>}
              <small className="muted">
                {' '}
                · {(r.durationMs / 1000).toFixed(1)} s · {r.kind}
              </small>
            </summary>
            <p className="muted">
              Image <code>{r.image}</code>, exit code {r.exitCode ?? '—'}, no network, read-only
              filesystem.
            </p>
            <h5>Code</h5>
            <pre>{r.code}</pre>
            {r.stdout && (
              <>
                <h5>Output</h5>
                <pre>{r.stdout}</pre>
              </>
            )}
            {r.stderr && (
              <>
                <h5>Errors</h5>
                <pre className="stderr">{r.stderr}</pre>
              </>
            )}
          </details>
        </li>
      ))}
    </ol>
  );
}
