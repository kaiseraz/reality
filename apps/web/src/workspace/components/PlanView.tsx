import { useWorkspace, type RendererProps } from '../context.ts';

export function PlanView(_props: RendererProps) {
  const { task } = useWorkspace();
  const spec = task?.state?.spec;
  if (!task) return <p className="muted">Loading…</p>;
  if (!spec) {
    return (
      <p className="muted">
        {task.status === 'planning' ? 'Planning…' : 'No plan.'}
        {task.state?.error && <span role="alert"> {task.state.error}</span>}
      </p>
    );
  }
  const results = new Map(task.state?.stepResults?.map((r) => [r.stepId, r]));
  const checks = new Map(task.state?.verification?.map((c) => [c.criterionId, c]));

  return (
    <div className="pad">
      <p>
        <strong>Goal:</strong> {spec.goal}
      </p>
      {spec.risks.length > 0 && (
        <>
          <h4>Assumptions and risks</h4>
          <ul>
            {spec.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
      <h4>Steps</h4>
      <ol>
        {spec.workflow.map((step) => {
          const r = results.get(step.id);
          return (
            <li key={step.id}>
              <code>{step.agent}</code> {step.description}
              {r && <span className={`result ${r.status}`}> — {r.status.replace('_', ' ')}</span>}
              {r?.detail && <p className="step-detail">{r.detail}</p>}
            </li>
          );
        })}
      </ol>
      <h4>Acceptance criteria</h4>
      <ul>
        {spec.acceptanceCriteria.map((ac) => {
          const c = checks.get(ac.id);
          return (
            <li key={ac.id}>
              {ac.description} <small>({ac.checkType})</small>
              {c && <span className={`result ${c.status}`}> — {c.status}</span>}
              {c?.detail && <p className="step-detail">{c.detail}</p>}
            </li>
          );
        })}
      </ul>
      {spec.missingCapabilities.length > 0 && (
        <>
          <h4>Missing capabilities</h4>
          <ul>
            {spec.missingCapabilities.map((m) => (
              <li key={m.need}>
                {m.need} <small>({m.status})</small>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
