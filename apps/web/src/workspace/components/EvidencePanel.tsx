import { useWorkspace, type RendererProps } from '../context.ts';

interface Evidence {
  checked?: number;
  max_abs_error?: number;
  mismatches?: unknown[];
}

const LABEL = {
  passed: 'Verified',
  failed: 'Failed',
  unverified: 'Not verified',
} as const;

/**
 * What was actually verified, and how. A result counts as verified only if an
 * independent check re-computed it; everything else is labelled as not verified.
 */
export function EvidencePanel(_props: RendererProps) {
  const { task } = useWorkspace();
  const spec = task?.state?.spec;
  if (!spec) return <p className="muted pad">No acceptance criteria yet.</p>;
  const results = new Map(task.state?.verification?.map((v) => [v.criterionId, v]));
  const counts = { passed: 0, failed: 0, unverified: 0 };
  for (const v of results.values()) counts[v.status] += 1;

  return (
    <div className="pad evidence">
      {results.size > 0 ? (
        <p>
          <span className="badge passed">{counts.passed} verified</span>{' '}
          <span className="badge failed">{counts.failed} failed</span>{' '}
          <span className="badge">{counts.unverified} not verified</span>
        </p>
      ) : (
        <p className="muted">Checks run after the plan&apos;s steps finish.</p>
      )}
      <ul>
        {spec.acceptanceCriteria.map((ac) => {
          const r = results.get(ac.id);
          const ev = (r?.evidence ?? {}) as Evidence;
          return (
            <li key={ac.id}>
              <span className={`badge ${r?.status ?? ''}`}>{r ? LABEL[r.status] : 'Pending'}</span>{' '}
              {ac.description}
              <div className="step-detail">
                {ac.check ? (
                  <>
                    Check <code>{ac.check.name}</code> ({ac.checkType})
                  </>
                ) : (
                  <>No machine check ({ac.checkType})</>
                )}
                {r && <> — {r.detail}</>}
                {ev.checked !== undefined && (
                  <>
                    {' '}
                    · {ev.checked} items checked
                    {ev.max_abs_error !== undefined &&
                      `, max error ${ev.max_abs_error.toExponential(1)}`}
                  </>
                )}
                {ev.mismatches && ev.mismatches.length > 0 && (
                  <pre>{JSON.stringify(ev.mismatches, null, 1)}</pre>
                )}
                {r?.runId && (
                  <small className="muted"> · run {r.runId.slice(0, 8)} (see Runs)</small>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
