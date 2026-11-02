import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type CriteriaState, type CriterionInput } from '../api.ts';
import { Icon } from '../ui/Icon.tsx';

const VERDICT: Record<CriteriaState['verdict'], { text: string; tone: string } | null> = {
  verified: { text: 'All your criteria are met', tone: 'ok' },
  partial: { text: 'Some of your criteria are met, others are still open', tone: '' },
  not_verified: { text: 'Your criteria could not be checked yet', tone: '' },
  refuted: { text: 'The result misses at least one of your criteria', tone: 'bad' },
  no_criteria: null,
};

const MARK: Record<string, string> = { met: '✓', missed: '✗', open: '○', not_checkable: '–' };

/**
 * Success criteria a person sets before the run (Astra's rule: the goal cannot move once the
 * work starts) and their verdict afterwards, each tied to numbered evidence from the steps.
 */
export function Criteria({ taskId, refreshKey }: { taskId: string; refreshKey: string }) {
  const [state, setState] = useState<CriteriaState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState('');
  const [mode, setMode] = useState<'between' | 'about' | 'equals'>('between');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .criteria(taskId)
      .then((s) => {
        setState(s);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [taskId]);
  useEffect(load, [load, refreshKey]);

  if (!state) return error ? <p className="bad">{error}</p> : null;
  const chosen = state.fields.find((f) => f.field === field);
  const kind = chosen?.kind ?? 'number';

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!field) return;
    const num = (s: string) => (s.trim() === '' ? undefined : Number(s.replace(',', '.')));
    const body: CriterionInput = { field };
    if (kind === 'text' || mode === 'equals') body.equals = a.trim();
    else if (mode === 'between') {
      const lo = num(a);
      const hi = num(b);
      if (lo !== undefined) body.min = lo;
      if (hi !== undefined) body.max = hi;
    } else {
      const t = num(a);
      const p = num(b);
      if (t !== undefined) body.target = t;
      if (p !== undefined) body.tolerancePercent = p;
    }
    setBusy(true);
    setError(null);
    try {
      await api.addCriterion(taskId, body);
      setA('');
      setB('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await api.removeCriterion(taskId, id).catch(() => undefined);
    load();
  };

  const verdict = VERDICT[state.verdict];
  const unbacked = Object.entries(state.unbacked);

  return (
    <div className="criteria-box">
      {state.criteria.length > 0 && (
        <>
          {verdict && state.locked && (
            <div className={`verified ${verdict.tone === 'bad' ? 'bad' : ''}`}>
              <Icon name={verdict.tone === 'bad' ? 'alert' : 'check'} size={14} /> {verdict.text}
            </div>
          )}
          <ul className="criteria-list" aria-label="your success criteria">
            {state.criteria.map((c) => (
              <li key={c.id} className={`crit ${c.status}`}>
                <span className="crit-mark" aria-label={c.status}>
                  {MARK[c.status] ?? '○'}
                </span>
                <span className="grow">
                  <strong>{c.id}</strong> {c.field} {c.expected}
                  {c.actual !== null && (
                    <span className="muted">
                      {' '}
                      · measured {String(c.actual)}
                      {c.evidenceId ? ` (evidence ${c.evidenceId})` : ''}
                    </span>
                  )}
                </span>
                {!state.locked && (
                  <button
                    className="btn-ghost btn-icon"
                    aria-label={`Remove ${c.id}`}
                    onClick={() => void remove(c.id)}
                  >
                    <Icon name="x" size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {!state.locked && state.fields.length > 0 && (
        <form className="crit-form" onSubmit={(e) => void add(e)}>
          <span className="muted">Success criterion (optional), fixed once the task runs:</span>
          <div className="row">
            <select
              aria-label="Result value"
              value={field}
              onChange={(e) => setField(e.target.value)}
            >
              <option value="">Choose a result value…</option>
              {state.fields.map((f) => (
                <option key={`${f.recipe}.${f.field}`} value={f.field}>
                  {f.label}
                </option>
              ))}
            </select>
            {field && kind === 'number' && (
              <select
                aria-label="Comparison"
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
              >
                <option value="between">between</option>
                <option value="about">about (± %)</option>
              </select>
            )}
            {field && (
              <input
                aria-label={
                  kind === 'text' ? 'Expected value' : mode === 'about' ? 'Target' : 'Minimum'
                }
                placeholder={
                  kind === 'text' ? 'expected, e.g. May' : mode === 'about' ? 'target' : 'min'
                }
                value={a}
                onChange={(e) => setA(e.target.value)}
                size={10}
              />
            )}
            {field && kind === 'number' && (
              <input
                aria-label={mode === 'about' ? 'Tolerance in percent' : 'Maximum'}
                placeholder={mode === 'about' ? '± %' : 'max'}
                value={b}
                onChange={(e) => setB(e.target.value)}
                size={8}
              />
            )}
            <button type="submit" disabled={busy || !field || !a.trim()}>
              <Icon name="plus" /> Add
            </button>
          </div>
        </form>
      )}

      {unbacked.length > 0 && (
        <p className="callout tone-bad">
          <Icon name="alert" />
          <span>
            AI-written result text contains numbers without evidence:{' '}
            {unbacked.map(([step, nums]) => `${step}: ${nums.join(', ')}`).join('; ')}. Treat them
            with caution.
          </span>
        </p>
      )}

      {state.evidence.length > 0 && state.locked && (
        <details className="more">
          <summary>Evidence ({state.evidence.map((e) => e.id).join(', ')})</summary>
          <ul>
            {state.evidence.map((e) => (
              <li key={e.id}>
                <strong>{e.id}</strong> · {e.stepId}:{' '}
                {Object.entries(e.values)
                  .slice(0, 8)
                  .map(
                    ([k, v]) =>
                      `${k} = ${typeof v === 'number' ? Number(v.toPrecision(6)) : String(v)}`,
                  )
                  .join(', ')}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p className="bad">{error}</p>}
    </div>
  );
}
