import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { TaskEvent, WorkspaceSpec } from '@reality/schemas';
import { api, type PageSummary, type StepResult, type TaskDetail } from '../api.ts';
import { autoGrow } from '../Home.tsx';
import { BrandMark, Icon } from '../ui/Icon.tsx';
import { makeEmit, type WorkspaceData } from './context.ts';
import { RENDERERS } from './renderers.ts';
import { Criteria } from './Criteria.tsx';
import { Research } from './Research.tsx';
import { LabView } from '../lab/LabView.tsx';
import { BotAvatar, ROLE } from '../bots/BotAvatar.tsx';
import type { BotView, ChatCard } from '@reality/schemas';

/** Steps whose output is the answer, in the order a person wants to read them. */
const ANSWER_ORDER = [
  'forecast',
  'correlate',
  'query',
  'season_by_group',
  'decompose',
  'breakdown',
  'aggregate',
];
const SKIP = new Set(['profile', 'verify', 'acquire']);
const NEWLINE = String.fromCharCode(10);

function findings(results: StepResult[], shownElsewhere: ReadonlySet<string>): string[] {
  const rank = (id: string) => {
    const i = ANSWER_ORDER.indexOf(id);
    return i < 0 ? ANSWER_ORDER.length : i;
  };
  const done = results
    .filter((r) => r.status === 'done' && !SKIP.has(r.stepId) && !shownElsewhere.has(r.stepId))
    .sort((a, b) => rank(a.stepId) - rank(b.stepId));
  const specific = done.filter((r) => r.stepId !== 'aggregate');
  const lines: string[] = [];
  for (const r of specific.length > 0 ? specific : done) {
    for (const line of r.detail.split(NEWLINE).slice(0, 2)) {
      const t = line.trim();
      if (t && !t.startsWith('Daily values summed') && !t.startsWith('Acceptance criteria are')) {
        lines.push(t);
      }
    }
  }
  return lines.slice(0, 8);
}

/** Inputs the user (or the project) attached, by file name. */
function attachments(events: TaskEvent[]): string[] {
  const names = events
    .filter((e) => e.type === 'artifact.added')
    .map((e) => e.payload as { filename?: string; provenance?: { kind?: string } })
    .filter(
      (p) => !p.provenance || p.provenance.kind === 'upload' || p.provenance.kind === 'handoff',
    )
    .map((p) => p.filename ?? '')
    .filter(Boolean);
  return [...new Set(names)];
}

function Decision({ task }: { task: TaskDetail }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = task.pendingApproval as {
    kind?: string;
    proposal?: { package?: string; version?: string; need?: string; license?: string | null };
  } | null;
  const capability = request?.kind === 'capability-approval';
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
    <div className="decision" role="region" aria-label="decision">
      {capability ? (
        <>
          <strong>
            Install {request?.proposal?.package} {request?.proposal?.version}?
          </strong>
          <small>
            This step needs “{request?.proposal?.need}”, which the sandbox doesn’t have. The package
            was inspected offline; the full report, license and tests are in the workspace
            (Approvals). It is installed into an isolated, read-only layer and tested before use.
          </small>
        </>
      ) : (
        <>
          <strong>Approve this plan?</strong>
          <small>Nothing runs until you do. Every result will be checked independently.</small>
        </>
      )}
      <div className="row">
        <button className="btn-primary" disabled={busy} onClick={() => void decide(true)}>
          {capability ? 'Approve install' : 'Approve and run'}
        </button>
        <button disabled={busy} onClick={() => void decide(false)}>
          Deny
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

/** Keeps a finished result: as a new page, or as a new version of an existing one. */
function SaveToPage({ taskId }: { taskId: string }) {
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [target, setTarget] = useState('');
  const [saved, setSaved] = useState<{ id: string; title: string; version: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .pages()
      .then(setPages)
      .catch(() => setPages([]));
  }, []);
  const save = async () => {
    setError(null);
    try {
      const page = await api.taskToPage(taskId, target ? { pageId: target } : {});
      setSaved({ id: page.id, title: page.title, version: page.version });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  if (saved) {
    return (
      <p className="save-page">
        <Icon name="check" size={14} /> Saved to{' '}
        <a href={`#/page/${saved.id}`}>
          {saved.title} (version {saved.version})
        </a>
      </p>
    );
  }
  return (
    <div className="save-page row">
      <select aria-label="Save to page" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">As a new page</option>
        {pages.map((p) => (
          <option key={p.id} value={p.id}>
            Add to “{p.title}”
          </option>
        ))}
      </select>
      <button onClick={() => void save()}>
        <Icon name="file" /> Save result
      </button>
      {error && <span className="bad">{error}</span>}
    </div>
  );
}

/** A lab task's results drawn for their domain (spectra, nozzles, trajectories, CAD). */
function useLabCards(taskId: string | undefined, key: string) {
  const [cards, setCards] = useState<Extract<ChatCard, { kind: 'lab' }>[]>([]);
  useEffect(() => {
    if (!taskId) return;
    let live = true;
    api
      .labCards(taskId)
      .then((c) => live && setCards(c.filter((x) => x.kind === 'lab')))
      .catch(() => live && setCards([]));
    return () => {
      live = false;
    };
  }, [taskId, key]);
  return cards;
}

function Figure({ id, ctx }: { id: string; ctx: WorkspaceData }) {
  const instance = ctx.spec.components[id];
  if (!instance) return null;
  const Renderer = RENDERERS[instance.type];
  if (!Renderer) return null;
  return (
    <div className="figure">
      {instance.type === 'DataTable' && (
        <div className="figure-title">{String(instance.props.title ?? '')}</div>
      )}
      <Renderer instanceId={id} instance={instance} emit={makeEmit(id, instance, ctx.sendAction)} />
    </div>
  );
}

export function Thread({
  ctx,
  onFollowUp,
  openWorkspace,
  bot,
}: {
  ctx: WorkspaceData;
  /** The bot working on this task, if any: it answers under its own name. */
  bot?: BotView | null;
  onFollowUp: (request: string) => Promise<void>;
  openWorkspace: () => void;
}) {
  const { task, events, spec } = ctx;
  const plan = task?.state?.spec;
  const results = useMemo(() => (task?.state?.stepResults ?? []) as StepResult[], [task]);
  const checks = task?.state?.verification ?? [];
  const status = task?.status ?? 'draft';

  // Result views: charts and tables bound to derived artifacts (not the uploaded data).
  const derived = useMemo(
    () =>
      new Set(
        events
          .filter((e) => e.type === 'artifact.added')
          .map((e) => e.payload as { artifactId?: string; provenance?: { kind?: string } })
          .filter((p) => p.provenance?.kind === 'derived')
          .map((p) => p.artifactId),
      ),
    [events],
  );
  const views = useMemo(() => resultViews(spec, derived), [spec, derived]);
  const labCards = useLabCards(task?.id, `${task?.status}:${results.length}`);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await onFollowUp(draft.trim());
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const resultOf = new Map(results.map((r) => [r.stepId, r]));
  const running = status === 'running' || status === 'planning';
  const currentStep = running ? plan?.workflow.find((s) => !resultOf.has(s.id))?.id : undefined;
  const passed = checks.filter((c) => c.status === 'passed').length;
  const failedChecks = checks.filter((c) => c.status === 'failed').length;
  const files = attachments(events);
  // Research steps are shown as an answer with sources, not as one-line findings.
  const researchSteps = new Set(
    (plan?.workflow ?? []).filter((s) => s.agent === 'research-agent').map((s) => s.id),
  );
  const lines = findings(results, researchSteps);

  return (
    <>
      <div className="thread-scroll">
        <div className="thread">
          <div className="msg-user">
            {files.length > 0 && (
              <div className="row">
                {files.map((f) => (
                  <span key={f} className="file-chip">
                    <Icon name="file" />
                    <span>{f}</span>
                  </span>
                ))}
              </div>
            )}
            <div className="bubble">{task?.request ?? ''}</div>
          </div>

          <div className="msg-assistant">
            {bot ? (
              <BotAvatar bot={bot} size={28} />
            ) : (
              <div className="avatar">
                <BrandMark />
              </div>
            )}
            <div className="answer">
              {bot && (
                <div className="answer-by">
                  <strong>{bot.name}</strong> · {ROLE[bot.role].label}
                </div>
              )}
              {!plan && (
                <div className="status-line">
                  {status === 'failed' ? (
                    <span className="bad">{task?.state?.error ?? 'Planning failed.'}</span>
                  ) : (
                    <>
                      <span className="dot tone-info live" /> Thinking about a plan…
                    </>
                  )}
                </div>
              )}

              {plan && (
                <>
                  <p>
                    {status === 'awaiting_approval' && results.length === 0
                      ? 'Here is my plan:'
                      : status === 'completed'
                        ? 'Done. Here is what I did:'
                        : 'Working on it:'}
                  </p>
                  <ol className="steps">
                    {plan.workflow
                      .filter((s) => s.id !== 'verify')
                      .map((s) => {
                        const r = resultOf.get(s.id);
                        const mark =
                          r?.status === 'done'
                            ? 'done'
                            : r?.status === 'failed'
                              ? 'failed'
                              : s.id === currentStep
                                ? 'running'
                                : '';
                        return (
                          <li key={s.id}>
                            <span className={`mark ${mark}`}>
                              {mark === 'done' && <Icon name="check" size={11} />}
                              {mark === 'failed' && <Icon name="x" size={11} />}
                            </span>
                            <span>
                              {s.description}
                              {r?.status === 'skipped' && (
                                <span className="detail"> · skipped</span>
                              )}
                              {r?.status === 'failed' && (
                                <span className="detail">{NEWLINE + r.detail.slice(0, 300)}</span>
                              )}
                            </span>
                          </li>
                        );
                      })}
                  </ol>
                  {plan.risks.length > 0 && (
                    <details className="more">
                      <summary>Assumptions and notes ({plan.risks.length})</summary>
                      <ul>
                        {plan.risks.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )}

              {plan && task && (
                <Criteria
                  taskId={task.id}
                  refreshKey={`${status}:${results.length}:${checks.length}`}
                />
              )}

              {status === 'awaiting_approval' && task?.pendingApproval !== null && task && (
                <Decision task={task} />
              )}

              {plan && <Research plan={plan} results={results} />}

              {lines.length > 0 && (
                <ul className="finding-list">
                  {lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              )}

              {labCards.map((c) => (
                <LabView key={c.title + c.taskId} card={c} />
              ))}
              {lines.length > 0 &&
                labCards.length === 0 &&
                views.charts.map((id) => <Figure key={id} id={id} ctx={ctx} />)}
              {views.tables.length > 0 && (
                <details className="more">
                  <summary>Result tables ({views.tables.length})</summary>
                  {views.tables.map((id) => (
                    <div key={id} style={{ marginTop: 10 }}>
                      <Figure id={id} ctx={ctx} />
                    </div>
                  ))}
                </details>
              )}

              {checks.length > 0 && (
                <details className="more">
                  <summary>
                    <span className={`verified ${failedChecks > 0 ? 'bad' : ''}`}>
                      <Icon name={failedChecks > 0 ? 'alert' : 'check'} size={14} />
                      {passed} of {checks.length} results verified independently
                    </span>
                  </summary>
                  <ul>
                    {checks.map((c) => {
                      const ac = plan?.acceptanceCriteria.find((a) => a.id === c.criterionId);
                      return (
                        <li key={c.criterionId}>
                          <span className={`result ${c.status}`}>{c.status}</span> ·{' '}
                          {ac?.description ?? c.criterionId}
                          <div className="step-detail">{c.detail}</div>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              )}

              {(status === 'failed' || status === 'budget_exceeded') && plan && (
                <p className="bad">{task?.state?.error ?? 'The task stopped.'}</p>
              )}
              {status === 'rejected' && <p className="muted">You denied this. Nothing ran.</p>}

              {plan && (
                <button className="btn-ghost" onClick={openWorkspace}>
                  <Icon name="layout" /> Open workspace
                </button>
              )}
              {task && (status === 'completed' || status === 'failed') && results.length > 0 && (
                <SaveToPage key={task.id} taskId={task.id} />
              )}
            </div>
          </div>
        </div>
      </div>

      <form className="thread-composer" onSubmit={(e) => void send(e)}>
        <div className="composer">
          <label htmlFor="follow-up" className="sr-only">
            Ask a follow-up
          </label>
          <textarea
            id="follow-up"
            ref={box}
            rows={1}
            value={draft}
            placeholder="Ask a follow-up about the same data"
            onChange={(e) => {
              setDraft(e.target.value);
              autoGrow(e.target);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-foot">
            <span className="grow" />
            <button
              type="submit"
              className="round send"
              aria-label="Send follow-up"
              disabled={sending || !draft.trim()}
            >
              <Icon name="arrowUp" size={18} />
            </button>
          </div>
        </div>
        {error && (
          <p
            className="callout tone-bad"
            role="alert"
            style={{ maxWidth: 768, margin: '8px auto 0' }}
          >
            <Icon name="alert" /> <span>{error}</span>
          </p>
        )}
        <span className="hint">
          A follow-up continues this conversation on the same data; your lead asks before anything
          runs.
        </span>
      </form>
    </>
  );
}

/**
 * Charts and tables that show derived results (never the raw upload table or the profile).
 * Without any result chart, the chart of the input data is shown, so an answer is never
 * without a picture when one exists.
 */
export function resultViews(
  spec: WorkspaceSpec,
  derived: Set<string | undefined>,
): { charts: string[]; tables: string[] } {
  const charts: string[] = [];
  const inputCharts: string[] = [];
  const tables: string[] = [];
  for (const [id, c] of Object.entries(spec.components ?? {})) {
    const binding = c.bindings.rows;
    if (binding?.kind !== 'artifact') continue;
    if (!derived.has(binding.artifact.id)) {
      if (c.type === 'Chart') inputCharts.push(id);
      continue;
    }
    if (String(c.props.title ?? '').startsWith('profile')) continue;
    if (c.type === 'Chart') charts.push(id);
    else if (c.type === 'DataTable') tables.push(id);
  }
  return { charts: (charts.length > 0 ? charts : inputCharts).slice(0, 4), tables };
}
