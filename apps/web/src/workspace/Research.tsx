import { useEffect, useState } from 'react';
import type { TaskSpec } from '@reality/schemas';
import { api, type StepResult } from '../api.ts';
import { Icon } from '../ui/Icon.tsx';

type Row = Record<string, unknown>;
export const citations = (n: number) => `${n} citation${n === 1 ? '' : 's'}`;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** The rows a research step stored (sources, passages or claims). */
function useRows(artifactId: string | undefined): Row[] | null {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    if (!artifactId) return;
    let live = true;
    api
      .rows(artifactId, { offset: 0, limit: 50 })
      .then((page) => live && setRows(page.rows))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [artifactId]);
  return rows;
}

function Answer({ result }: { result: StepResult }) {
  const rows = useRows(result.artifacts?.[0]);
  const summary = (result.summary ?? {}) as { answer?: string; claims?: number; grounded?: number };
  return (
    <div className="answer-card">
      {summary.answer && <p>{summary.answer}</p>}
      {rows && rows.length > 0 && (
        <ol className="plain claims">
          {rows.map((r) => (
            <li key={str(r.n)}>
              <span>
                {str(r.claim)}
                <span className="ref-chip">{str(r.ref)}</span>
                {str(r.quote_found) === 'yes' ? (
                  <span className="good" title="Quote found verbatim in the source">
                    {' '}
                    <Icon name="check" size={12} />
                  </span>
                ) : (
                  <span className="bad" title="Quote not found in the cited source">
                    {' '}
                    <Icon name="alert" size={12} /> quote not in source
                  </span>
                )}
              </span>
              <blockquote>“{str(r.quote)}”</blockquote>
            </li>
          ))}
        </ol>
      )}
      {summary.claims !== undefined && (
        <small className="muted">
          {summary.grounded} of {summary.claims} claims quote their source verbatim.
        </small>
      )}
    </div>
  );
}

function Sources({ result, kind }: { result: StepResult; kind: 'literature' | 'knowledge' }) {
  const rows = useRows(result.artifacts?.[0]);
  if (!rows || rows.length === 0) return null;
  return (
    <details className="more" open={kind === 'literature'}>
      <summary>
        {kind === 'literature' ? `Literature (${rows.length})` : `Your sources (${rows.length})`}
      </summary>
      <ol className="plain hits">
        {rows.map((r) => (
          <li key={str(r.ref)}>
            <div className="hit-head">
              <span className="ref-chip">{str(r.ref)}</span>
              {kind === 'literature' ? (
                <>
                  <strong>
                    {str(r.url) ? (
                      <a href={str(r.url)} target="_blank" rel="noreferrer noopener">
                        {str(r.title)}
                      </a>
                    ) : (
                      str(r.title)
                    )}
                  </strong>
                  <span className="muted">
                    {[str(r.authors), str(r.year), str(r.venue), citations(Number(r.cited_by))]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </>
              ) : (
                <>
                  <strong>{str(r.source)}</strong>
                  <span className="muted">line {str(r.line)}</span>
                </>
              )}
            </div>
            {kind === 'knowledge' && <p>{str(r.text).slice(0, 300)}</p>}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Research results in the conversation: the cited answer first, then what it rests on. */
export function Research({ plan, results }: { plan: TaskSpec; results: StepResult[] }) {
  const done = (recipe: string) =>
    plan.workflow
      .filter((s) => s.agent === 'research-agent' && s.recipe?.name === recipe)
      .map((s) => results.find((r) => r.stepId === s.id && r.status === 'done'))
      .filter((r): r is StepResult => r !== undefined);
  const answers = done('synthesize');
  const literature = done('literature');
  const knowledge = done('knowledge');
  if (answers.length + literature.length + knowledge.length === 0) return null;
  return (
    <>
      {answers.map((r) => (
        <Answer key={r.stepId} result={r} />
      ))}
      {literature.map((r) => (
        <Sources key={r.stepId} result={r} kind="literature" />
      ))}
      {knowledge.map((r) => (
        <Sources key={r.stepId} result={r} kind="knowledge" />
      ))}
    </>
  );
}
