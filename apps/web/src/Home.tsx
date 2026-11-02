import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import type { BotView } from '@reality/schemas';
import { api, type Health, type Sample } from './api.ts';
import { BotAvatar } from './bots/BotAvatar.tsx';
import { BrandMark, Icon } from './ui/Icon.tsx';

export interface StartRequest {
  request: string;
  file?: File | undefined;
  sample?: string | undefined;
}

/** Grows with its content, up to the CSS max-height. */
export function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function plannerNote(health: Health): string | null {
  if (health.planner === 'anthropic' || health.planner === 'meta') return null;
  return health.planner === 'rules'
    ? 'No AI model configured: using the built-in rule-based planner and analysis recipes (no LLM). Add META_MODEL_API_KEY (Muse Spark) or ANTHROPIC_API_KEY to .env for AI planning.'
    : 'Offline fake planner active — plans are placeholders.';
}

/** Start screen: one question, one input, a few suggestions. */
/** Good morning / afternoon / evening, by the local clock. */
function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 5
    ? 'Good evening.'
    : h < 12
      ? 'Good morning.'
      : h < 18
        ? 'Good afternoon.'
        : 'Good evening.';
}

export function Home({
  health,
  healthError,
  onStart,
  focusKey,
  onNewProject,
}: {
  health: Health | null;
  healthError: string | null;
  onStart: (r: StartRequest) => Promise<void>;
  /** Changes when "New task" is chosen, to focus the input. */
  focusKey: number;
  onNewProject?: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [lead, setLead] = useState<BotView | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api
      .samples()
      .then((s) => setSamples(Array.isArray(s) ? s : []))
      .catch(() => setSamples([]));
    api
      .bots()
      .then((b) => setLead(Array.isArray(b) ? (b.find((x) => x.isMain) ?? b[0] ?? null) : null))
      .catch(() => setLead(null));
  }, []);
  useEffect(() => {
    box.current?.focus();
  }, [focusKey]);

  const start = async (r: StartRequest, key: string) => {
    setSubmitting(key);
    setSubmitError(null);
    try {
      await onStart(r);
      setDraft('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      // Keep the draft so nothing typed is lost.
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(null);
    }
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft.trim() || submitting) return;
    void start({ request: draft.trim(), file: file ?? undefined }, 'composer');
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  };

  const note = health ? plannerNote(health) : null;

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-hero">
          <BrandMark className="home-logo" />
          <span className="home-word">Reality</span>
        </div>
        <p className="home-sub">{greeting()} How can I help?</p>

        {healthError && (
          <p className="callout tone-bad home-notices" role="alert">
            <Icon name="alert" />
            <span>Server unreachable: {healthError}</span>
          </p>
        )}
        {health?.sandboxProblem && (
          <p className="callout tone-bad home-notices">
            <Icon name="alert" />
            <span>Sandbox unavailable — analysis steps will fail: {health.sandboxProblem}</span>
          </p>
        )}

        <form
          className={`composer ${dragging ? 'dragging' : ''}`}
          onSubmit={submit}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <label htmlFor="request" className="sr-only">
            What do you want to accomplish?
          </label>
          <textarea
            id="request"
            ref={box}
            rows={1}
            value={draft}
            placeholder="Ask Reality anything…"
            onChange={(e) => {
              setDraft(e.target.value);
              autoGrow(e.target);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-foot">
            <label className="button round plain-icon" htmlFor="dataset" title="Attach a CSV file">
              <Icon name="plus" size={18} />
              <span className="sr-only">Attach CSV</span>
            </label>
            <input
              id="dataset"
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              hidden
              aria-label="Dataset (CSV, optional)"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <span className="file-chip">
                <Icon name="file" />
                <span>{file.name}</span>
                <button
                  type="button"
                  aria-label="Remove dataset"
                  onClick={() => {
                    setFile(null);
                    if (fileInput.current) fileInput.current.value = '';
                  }}
                >
                  <Icon name="x" size={14} />
                </button>
              </span>
            ) : (
              <span className="hint">Attach a CSV or drop it here</span>
            )}
            <span className="grow" />
            {lead && (
              <span
                className="hero-chip"
                title="Your lead: it decides what this needs and who works on it"
              >
                <BotAvatar bot={lead} size={18} showStatus={false} />
                {lead.name}
              </span>
            )}
            {health && (
              <span className="hero-chip">
                {health.planner === 'meta'
                  ? 'Muse Spark'
                  : health.planner === 'anthropic'
                    ? 'Claude'
                    : 'Built-in planner'}
              </span>
            )}
            <button
              type="submit"
              className="round send"
              aria-label="Send to your lead"
              title="Send to your lead (Enter)"
              disabled={submitting !== null || !draft.trim()}
            >
              <Icon name="arrowUp" size={18} />
            </button>
          </div>
        </form>
        {submitError && (
          <p className="callout tone-bad" role="alert" style={{ marginTop: 12 }}>
            <Icon name="alert" />
            <span>Could not send that: {submitError}</span>
          </p>
        )}

        {samples.length > 0 && (
          <div className="suggestions" aria-label="Examples with real data">
            {samples.map((s) => (
              <button
                key={s.id}
                className="suggestion"
                disabled={submitting !== null}
                title={`${s.question} (${s.source})`}
                onClick={() => void start({ request: s.question, sample: s.id }, s.id)}
              >
                <Icon name="chart" size={15} />
                <strong>{s.title}</strong>
                {submitting === s.id && <span className="muted">starting…</span>}
              </button>
            ))}
            {onNewProject && (
              <button className="suggestion" onClick={onNewProject}>
                <Icon name="folder" size={15} />
                <strong>Start a long-term project</strong>
              </button>
            )}
          </div>
        )}

        <p className="home-foot">
          {note ? (
            <span role="status">{note}</span>
          ) : (
            'Every result is checked independently before it is shown as verified.'
          )}
        </p>
      </div>
    </div>
  );
}
