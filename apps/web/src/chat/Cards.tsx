import { useState } from 'react';
import type { ChatCard } from '@reality/schemas';
import { Icon } from '../ui/Icon.tsx';
import { Markdown } from '../pages/markdown.tsx';
import { LabView } from '../lab/LabView.tsx';
import { citations } from '../workspace/Research.tsx';
import { ContractView, TeamProposal } from './TeamCards.tsx';

/**
 * Cards that wait for the person (approve a plan or install, hire a team, answer a
 * question, allow web access, accept reviewed work) stay in the chat. Everything
 * else — results, lab views, sources, finished contracts — is a record, and records
 * live in the workbench notebook, not between the chat bubbles.
 */
export function isActionableCard(card: ChatCard): boolean {
  switch (card.kind) {
    case 'file':
    case 'visual':
    case 'page':
      return true;
    case 'plan':
    case 'install':
      return card.status === 'waiting';
    case 'team':
    case 'access':
    case 'skill':
    case 'question':
      return card.status === 'open';
    case 'contract':
      return card.status === 'review';
    default:
      return false;
  }
}

/** The cards bots put into a chat: plans to approve, verified results, sources, questions … */
export function Card({
  card,
  busy,
  onPlan,
  onAnswer,
}: {
  card: ChatCard;
  busy: boolean;
  onPlan: (taskId: string, approved: boolean, secrets?: Record<string, string>) => void;
  onAnswer: (answer: string) => void;
}) {
  switch (card.kind) {
    case 'plan':
      return (
        <div className={`chat-card plan ${card.status}`}>
          <div className="chat-card-head">
            <Icon name="shield" size={15} />
            <strong>
              {card.status === 'waiting'
                ? 'Plan waiting for your approval'
                : card.status === 'running'
                  ? 'Plan approved, running'
                  : card.status === 'denied'
                    ? 'Plan denied, nothing ran'
                    : 'Plan approved'}
            </strong>
            <a className="muted" href={`#/task/${card.taskId}`}>
              open task
            </a>
          </div>
          <ol className="chat-steps">
            {card.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          {card.status === 'waiting' && (
            <div className="row">
              <button
                className="btn-primary"
                disabled={busy}
                onClick={() => onPlan(card.taskId, true)}
              >
                Approve and run
              </button>
              <button disabled={busy} onClick={() => onPlan(card.taskId, false)}>
                Deny
              </button>
              <small className="muted">
                Nothing runs before you approve. Every result is checked independently.
              </small>
            </div>
          )}
        </div>
      );

    case 'result': {
      const ok = card.status === 'completed';
      const all = card.verified.total > 0 && card.verified.passed === card.verified.total;
      return (
        <div className={`chat-card result ${ok ? 'ok' : 'bad'}`}>
          <div className="chat-card-head">
            <Icon name={ok ? 'check' : 'alert'} size={15} />
            <strong>{ok ? 'Result' : `Stopped: ${card.status}`}</strong>
            {card.verified.total > 0 && (
              <span className={`verify-chip ${all ? 'good' : 'warn'}`}>
                {card.verified.passed} of {card.verified.total} verified independently
              </span>
            )}
            {card.verified.review > 0 && (
              <span className="verify-chip">{card.verified.review} for your review</span>
            )}
            <a className="muted" href={`#/task/${card.taskId}`}>
              open task
            </a>
          </div>
          {card.answer && <p className="chat-answer">{card.answer}</p>}
          {card.lines.length > 0 && (
            <ul className="chat-lines">
              {card.lines.map((l, i) => (
                // How a bot uses what was installed is for the bot.
                <li key={i}>{l.replace(/\s*Use it with .*$/, '')}</li>
              ))}
            </ul>
          )}
        </div>
      );
    }

    case 'sources':
      return (
        <details className="chat-card sources">
          <summary>
            <Icon name="book" size={15} /> {card.items.length} works for “{card.query}”
          </summary>
          <ol className="plain chat-sources">
            {card.items.map((w) => (
              <li key={w.ref}>
                <span className="ref-chip">{w.ref}</span>{' '}
                {w.url ? (
                  <a href={w.url} target="_blank" rel="noreferrer noopener">
                    {w.title}
                  </a>
                ) : (
                  w.title
                )}{' '}
                <small className="muted">
                  {[w.authors, w.year, citations(w.citedBy)].filter(Boolean).join(' · ')}
                </small>
              </li>
            ))}
          </ol>
        </details>
      );

    case 'knowledge':
      return (
        <details className="chat-card sources">
          <summary>
            <Icon name="search" size={15} /> {card.items.length} passages from your notes for “
            {card.query}”
          </summary>
          <ol className="plain chat-sources">
            {card.items.map((k, i) => (
              <li key={i}>
                <span className="ref-chip">K{i + 1}</span> <strong>{k.source}</strong>{' '}
                <small className="muted">line {k.line}</small>
                <div className="muted">{k.text}</div>
              </li>
            ))}
          </ol>
        </details>
      );

    case 'question':
      return <Question card={card} busy={busy} onAnswer={onAnswer} />;

    case 'team':
      return <TeamProposal card={card} busy={busy} onAnswer={onAnswer} />;

    case 'contract':
      return <ContractView card={card} busy={busy} onAnswer={onAnswer} />;

    case 'access':
      return (
        <div className={`chat-card access ${card.status}`}>
          <div className="chat-card-head">
            <Icon name="lock" size={15} />
            <strong>
              {card.status === 'open'
                ? `Web access for ${card.server ? `the tool server ${card.server}` : 'its computer'}: ${card.domain}`
                : card.status === 'allowed'
                  ? `Allowed: ${card.domain}`
                  : `Not allowed: ${card.domain}`}
            </strong>
          </div>
          {card.reason && <p className="small">{card.reason}</p>}
          {card.status === 'open' ? (
            <div className="row">
              <button className="btn-primary" disabled={busy} onClick={() => onAnswer('Allow')}>
                Allow {card.domain}
              </button>
              <button disabled={busy} onClick={() => onAnswer('Deny')}>
                Deny
              </button>
              <span className="muted small">
                {card.server
                  ? 'Subdomains included. Everything else stays refused.'
                  : 'Subdomains included; revocable on the Computer tab.'}
              </span>
            </div>
          ) : null}
        </div>
      );

    case 'widget':
      return (
        <div className="chat-card widget">
          <div className="chat-card-head">
            <strong>{card.title}</strong>
          </div>
          {card.style === 'metrics' ? (
            <div className="chat-metrics">
              {card.items.map((i, n) => (
                <div key={n} className="stat">
                  <div className="label">{i.label}</div>
                  <div className="value">{i.value ?? ''}</div>
                </div>
              ))}
            </div>
          ) : (
            <ul className="plain chat-checklist">
              {card.items.map((i, n) => (
                <li key={n}>
                  {card.style === 'checklist' && (
                    <span className={`check-dot ${i.done ? 'done' : ''}`}>
                      {i.done && <Icon name="check" size={11} />}
                    </span>
                  )}
                  {i.url ? (
                    <a href={i.url} target="_blank" rel="noreferrer noopener">
                      {i.label}
                    </a>
                  ) : (
                    <span>{i.label}</span>
                  )}
                  {i.value && <span className="muted"> {i.value}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      );

    case 'page':
      // A document a bot wrote, readable where it was asked for; the whole page opens from here.
      return (
        <div className="chat-card artifact">
          <a className="artifact-head" href={`#/page/${card.pageId}`}>
            <span className="artifact-icon">
              <Icon name="file" size={16} />
            </span>
            <span className="artifact-name">
              <strong>{card.title}</strong>
              <span className="muted small">
                Document · version {card.version}
                {card.author ? ` · ${card.author}` : ''}
              </span>
            </span>
            <span className="artifact-open">Open</span>
          </a>
          {card.preview && (
            <a className="artifact-preview" href={`#/page/${card.pageId}`} tabIndex={-1}>
              <Markdown text={card.preview} />
            </a>
          )}
        </div>
      );

    case 'code':
      return (
        <details className="chat-card code">
          <summary>
            <Icon name="command" size={15} /> Ran code in the sandbox: {card.purpose}{' '}
            <span className={card.status === 'succeeded' ? 'good' : 'bad'}>({card.status})</span>
          </summary>
          <pre>{card.code}</pre>
          {card.stdout && <pre className="out">{card.stdout}</pre>}
          {card.stderr && <pre className="out bad">{card.stderr}</pre>}
        </details>
      );

    case 'mission': {
      const tone = card.verdict === 'verified' ? 'ok' : card.verdict === 'refuted' ? 'bad' : '';
      return (
        <div className={`chat-card result ${tone}`}>
          <div className="chat-card-head">
            <Icon name="target" size={15} />
            <strong>
              Mission {card.status} · verdict {card.verdict ?? '?'}
            </strong>
            {card.reportPageId && (
              <a className="muted" href={`#/page/${card.reportPageId}`}>
                report
              </a>
            )}
          </div>
          <p className="small">{card.goal}</p>
          <ul className="chat-lines">
            {card.criteria.map((c, i) => (
              <li
                key={i}
                className={c.status === 'met' ? 'good' : c.status === 'missed' ? 'bad' : 'muted'}
              >
                {c.field} {c.expected}:{' '}
                {c.actual === null || c.actual === undefined
                  ? 'no checked evidence'
                  : String(c.actual)}{' '}
                ({c.status})
              </li>
            ))}
          </ul>
          <small className="muted">
            The verdict is computed from independently checked results, not from what the team said.
          </small>
        </div>
      );
    }

    case 'install':
      return <InstallCard card={card} busy={busy} onPlan={onPlan} />;

    case 'lab':
      return (
        <div className="chat-card lab">
          <LabView card={card} />
        </div>
      );

    case 'skill':
      return (
        <div className={`chat-card plan ${card.status === 'open' ? 'waiting' : card.status}`}>
          <div className="chat-card-head">
            <Icon name="book" size={15} />
            <strong>
              {card.status === 'open'
                ? `Use the skill ${card.name}?`
                : card.status === 'approved'
                  ? `Skill approved: ${card.name}`
                  : `Skill not used: ${card.name}`}
            </strong>
            <a
              className="muted"
              href={`https://github.com/${card.repo}/tree/${card.commit}/${card.path}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              on GitHub
            </a>
          </div>
          <p className="small">{card.description}</p>
          <p className="small">
            <strong>Written by others, not reviewed by Reality.</strong> From {card.repo} (
            {card.stars.toLocaleString()} stars, {card.license}), fixed at commit{' '}
            {card.commit.slice(0, 7)}. Nothing of it has run. A bot would follow this as a method;
            it gets no keys or rights from it, and its scripts run only on the bot's own computer.
          </p>
          {card.flags.length > 0 && (
            <div className="install-warnings small">
              <strong>Look at these:</strong>
              <ul className="chat-lines">
                {card.flags.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}
          {card.scripts.length > 0 && (
            <p className="muted small">Scripts: {card.scripts.join(', ')}</p>
          )}
          {card.hosts.length > 0 && (
            <p className="muted small">Addresses it mentions: {card.hosts.join(', ')}</p>
          )}
          {card.alternatives.length > 0 && (
            <p className="muted small">Also found: {card.alternatives.join(', ')}</p>
          )}
          <details>
            <summary className="small">What it tells a bot to do</summary>
            <pre className="out skill-text">{card.preview}</pre>
          </details>
          {card.status === 'open' && (
            <div className="row">
              <button className="btn-primary" disabled={busy} onClick={() => onAnswer('Approve')}>
                Approve skill
              </button>
              <button disabled={busy} onClick={() => onAnswer('Deny')}>
                Deny
              </button>
            </div>
          )}
        </div>
      );

    case 'file':
      return (
        <div className="chat-card file-card">
          <Icon name="file" size={15} />{' '}
          <a href={`/api/files/${card.fileId}?download=1`} download={card.name}>
            <strong>{card.name}</strong>
          </a>{' '}
          <span className="muted small">
            {card.sizeBytes < 1024 * 1024
              ? `${Math.max(1, Math.round(card.sizeBytes / 1024))} KB`
              : `${(card.sizeBytes / 1024 / 1024).toFixed(1)} MB`}
            {card.note ? ` · ${card.note}` : ''}
          </span>
        </div>
      );

    case 'task':
      return (
        <div className="chat-card task-line">
          <Icon name="plus" size={14} /> Task #{card.taskId}: {card.title}
          {card.owner && <span className="muted"> → {card.owner}</span>}
        </div>
      );

    default:
      return null;
  }
}

function InstallCard({
  card,
  busy,
  onPlan,
}: {
  card: Extract<ChatCard, { kind: 'install' }>;
  busy: boolean;
  onPlan: (taskId: string, approved: boolean, secrets?: Record<string, string>) => void;
}) {
  const [typed, setTyped] = useState<Record<string, string>>({});
  const wanted = card.secrets ?? [];
  const missing = wanted.some((s) => !typed[s.name]?.trim());
  const hosted = card.hostedAt;
  const registry = card.runtime === 'node' ? 'npm' : hosted ? 'the MCP registry' : 'PyPI';
  return (
    <div className={`chat-card plan ${card.status}`}>
      <div className="chat-card-head">
        <Icon name="puzzle" size={15} />
        <strong>
          {card.status === 'waiting'
            ? hosted
              ? `Connect to ${card.package}?`
              : `Install ${card.package} ${card.version}?`
            : card.status === 'approved'
              ? `${hosted ? 'Connecting to' : 'Installing'} ${card.package} ${hosted ? '' : card.version}`
              : `Not ${hosted ? 'connected' : 'installed'}: ${card.package}`}
        </strong>
        <a className="muted" href={`#/task/${card.taskId}`}>
          full report
        </a>
      </div>
      <p className="small">{card.summary}</p>
      {hosted ? (
        <p className="small">
          <strong>Hosted by someone else, at {hosted}.</strong> Nothing is installed here, and
          everything a bot sends to it goes to {hosted}. Approve only if that is fine for what this
          chat works on. Only the tools it lists can be called, and what they return is treated as
          data, never as instructions.
        </p>
      ) : (
        card.mcp && (
          <p className="small">
            <strong>An MCP server: tools a bot can call.</strong> It runs as its own sandboxed
            process, read-only,{' '}
            {card.domains?.length ? 'with no way out but the gateway' : 'no network'}. After
            installation it lists its tools itself; only those can be called, and what they return
            is treated as data, never as instructions.
          </p>
        )
      )}
      {card.domains?.length ? (
        <p className="small">
          <strong>It may reach:</strong> {card.domains.join(', ')}. Every other host is refused and
          the bot is told which.
        </p>
      ) : null}
      {card.source === 'catalog' && card.mcp && (
        <p className="small">
          <strong>On Reality's reviewed list.</strong> It was started and called against its real
          service before it went on the list, and it must pass that again before it is enabled.
        </p>
      )}
      {card.source === 'search' && (
        <p className="small">
          <strong>Found by search, not from the reviewed list.</strong> Reality looked at{' '}
          {card.considered ?? 'several'} names; code checked this one in {registry}
          {hosted ? '' : ' and inspected its files without running them'}. Whether it does what you
          need shows in use.
          {card.alternatives?.length
            ? ` Also passed the same checks: ${card.alternatives.join(', ')}.`
            : ''}
        </p>
      )}
      {!hosted && (
        <dl className="lab-facts">
          <div>
            <dt>License</dt>
            <dd>{card.license}</dd>
          </div>
          <div>
            <dt>New packages</dt>
            <dd>{card.wheels.length}</dd>
          </div>
          <div>
            <dt>Inspection</dt>
            <dd className={card.blocking.length || card.warnings?.length ? 'bad' : 'good'}>
              {card.blocking.length
                ? `${card.blocking.length} problems`
                : card.warnings?.length
                  ? `${card.warnings.length} known vulnerabilities`
                  : 'no problems found'}
            </dd>
          </div>
        </dl>
      )}
      <p className="muted small">
        {hosted
          ? ''
          : card.runtime === 'node'
            ? 'Inspected without running it (install scripts off, licences, hashes, known vulnerabilities). '
            : 'Inspected offline (wheels only, licences, hashes, known vulnerabilities). '}
        Test before use: {card.test}
      </p>
      {card.warnings?.length ? (
        <div className="install-warnings small">
          <strong>Known vulnerabilities with no compatible fix.</strong> Approving means running it
          with these. It stays in its sandbox and reaches only the domains above, but a key you give
          it is within reach of its code.
          <ul className="chat-lines">
            {card.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {card.flags?.length ? (
        <ul className="chat-lines small">
          {card.flags
            // Every package has these; on the card they only bury what a person should read.
            .filter((f) => !/command-line scripts|compiled native code/.test(f))
            .map((f, i) => (
              <li key={i}>{f}</li>
            ))}
        </ul>
      ) : null}
      {card.status === 'waiting' && wanted.length > 0 && (
        <div className="install-secrets">
          {wanted.map((s) => (
            <label key={s.name} className="small">
              <strong>{s.name}</strong>
              {s.description ? ` (${s.description.slice(0, 160)})` : ''}
              <input
                type="password"
                autoComplete="off"
                aria-label={s.name}
                value={typed[s.name] ?? ''}
                onChange={(e) => setTyped({ ...typed, [s.name]: e.target.value })}
              />
            </label>
          ))}
          <small className="muted">
            Stored encrypted. Only this server gets it, only for your bots. The bots never see it.
          </small>
        </div>
      )}
      {card.status === 'waiting' && (
        <div className="row">
          <button
            className="btn-primary"
            disabled={busy || missing}
            onClick={() => onPlan(card.taskId, true, wanted.length ? typed : undefined)}
          >
            {hosted
              ? 'Approve connection'
              : card.warnings?.length
                ? 'Approve despite these'
                : 'Approve install'}
          </button>
          <button disabled={busy} onClick={() => onPlan(card.taskId, false)}>
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

function Question({
  card,
  busy,
  onAnswer,
}: {
  card: Extract<ChatCard, { kind: 'question' }>;
  busy: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <div className={`chat-card question ${card.status}`}>
      <div className="chat-card-head">
        <Icon name="info" size={15} />
        <strong>{card.status === 'open' ? 'Question for you' : 'Answered'}</strong>
      </div>
      <Markdown text={card.question} />
      {card.status === 'answered' ? (
        <p className="muted">Your answer: {card.answer}</p>
      ) : (
        <div className="row">
          {card.options.map((o) => (
            <button key={o} disabled={busy} onClick={() => onAnswer(o)}>
              {o}
            </button>
          ))}
          <input
            className="grow"
            aria-label="Your answer"
            placeholder={card.options.length ? 'Or answer in your own words' : 'Your answer'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && text.trim()) onAnswer(text.trim());
            }}
          />
        </div>
      )}
    </div>
  );
}
