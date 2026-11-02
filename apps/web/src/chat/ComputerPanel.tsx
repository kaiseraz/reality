import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { BotView } from '@reality/schemas';
import { api, type ComputerView } from '../api.ts';
import { Icon } from '../ui/Icon.tsx';
import { relativeTime } from '../ui/status.ts';
import { ComputerScreen } from './ComputerScreen.tsx';

const KIND: Record<string, string> = {
  command: '$',
  file: 'File',
  browse: 'Web',
  network: 'Net',
  access: 'Access',
  power: 'Power',
};

const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`;

/**
 * A bot's own computer: its live screen (watched, or held by the person while the bot
 * pauses), what it may reach on the internet, what it did, and its files. The screen
 * comes through Reality, so the same sign-in applies and the computer's key never
 * reaches the browser.
 */
export function ComputerPanel({
  bot,
  chatId,
  working,
  lean = false,
}: {
  bot: BotView;
  chatId?: string | undefined;
  /** The live activity while this bot's turn runs, even when the computer still boots. */
  working?: string | undefined;
  /** Lean: only the live screen. Internet/activity/files move into collapsed details. */
  lean?: boolean;
}) {
  const [view, setView] = useState<ComputerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [control, setControl] = useState(false);
  const [domain, setDomain] = useState('');

  const load = useCallback(() => {
    api
      .computer(bot.id)
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [bot.id]);
  useEffect(() => {
    load();
    // While the bot works (or its machine is still booting) poll fast, so the
    // screen flips from "off" to live without a manual refresh.
    const t = setInterval(load, working ? 2000 : 5000);
    return () => clearInterval(t);
  }, [load, working]);

  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    fn()
      .then(load)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const allow = (e: FormEvent) => {
    e.preventDefault();
    if (!domain.trim()) return;
    act(() => api.allowDomain(bot.id, domain.trim()).then(() => setDomain('')));
  };

  /** Take the desktop: the bot's turn holds server-side before its next tool call. */
  const takeover = () => {
    if (!chatId) return;
    act(() => api.takeOverDesktop(chatId, bot.id));
    setControl(true);
  };
  /** Hand the desktop back; the note lands in the chat and wakes the bot. */
  const handBack = (note: string) => {
    act(() => api.handBackDesktop(chatId ?? '', bot.id, note || undefined));
    setControl(false);
  };

  if (!view) return <p className="muted">{error ?? 'Loading the computer…'}</p>;

  const panelSections = (
    <PanelSections
      bot={bot}
      view={view}
      busy={busy}
      domain={domain}
      setDomain={setDomain}
      allow={allow}
      act={act}
      hideActivity={lean}
    />
  );

  return (
    <div className="computer">
      {!lean && (
        <div className="computer-head">
          <span className={`dot tone-${view.running ? 'ok' : 'neutral'}`} />
          <strong>{bot.name}'s computer</strong>
          <span className="muted small">{view.running ? 'on' : 'off'}</span>
          <span className="grow" />
          {view.running ? (
            <button
              className="btn-ghost small"
              disabled={busy}
              onClick={() => act(() => api.stopComputer(bot.id))}
            >
              Turn off
            </button>
          ) : (
            <button
              className="btn-primary small"
              disabled={busy || !view.imageReady}
              onClick={() => act(() => api.startComputer(bot.id))}
            >
              <Icon name="play" size={14} /> {busy ? 'Starting…' : 'Turn on'}
            </button>
          )}
        </div>
      )}
      {error && <p className="callout tone-bad small">{error}</p>}
      {!view.imageReady && (
        <p className="muted small">
          The computer image is not installed on this machine yet (docker pull
          ghcr.io/agent-infra/sandbox:1.11.0).
        </p>
      )}

      {view.running ? (
        <ComputerScreen
          botId={bot.id}
          name={bot.name}
          control={control}
          onTakeover={takeover}
          onHandBack={handBack}
          onLeaveControl={() => handBack('')}
          lean={lean}
        />
      ) : (
        <div className="computer-off">
          <Icon name="monitor" size={28} />
          <p className="muted small">
            {working
              ? `${bot.name} is starting it up — it turns on by itself when needed.`
              : `Off. It starts by itself when ${bot.name} needs it; files in its home folder stay.`}
          </p>
          {!working && (
            <button
              className="btn-primary small"
              disabled={busy || !view.imageReady}
              onClick={() => act(() => api.startComputer(bot.id))}
            >
              <Icon name="play" size={14} /> {busy ? 'Starting…' : 'Turn on'}
            </button>
          )}
        </div>
      )}

      {lean && <LiveFeed view={view} working={working} name={bot.name} />}

      {lean ? (
        <details className="computer-details">
          <summary>
            <Icon name="lock" size={13} /> Internet &amp; files
          </summary>
          <div className="computer-details-body">{panelSections}</div>
        </details>
      ) : (
        panelSections
      )}
    </div>
  );
}

/**
 * What the bot is doing on its computer right now, as a short live feed. The
 * desktop picture alone cannot show this: the bots work through the computer's
 * API (shell, files, browser), so a maximised browser window would hide it all.
 * The computer's log is the truth — commands, files and pages as they happen.
 */
function LiveFeed({
  view,
  working,
  name,
}: {
  view: ComputerView;
  working?: string | undefined;
  name: string;
}) {
  const entries = view.history.filter((h) => h.kind !== 'power').slice(0, 4);
  return (
    <section className="pc-feed" aria-label={`${name}'s live activity`}>
      <div className="pc-feed-head">
        <span className={`dot ${working ? 'tone-info live' : 'tone-neutral'}`} />
        <strong>{working ? `${name} is working` : 'On this computer'}</strong>
        {working && <span className="muted small pc-feed-now">{working}</span>}
      </div>
      {entries.length === 0 ? (
        <p className="muted small pc-feed-empty">
          Nothing yet — commands, files and pages show up here as {name} works.
        </p>
      ) : (
        <ul className="plain pc-feed-list">
          {entries.map((h) => (
            <li key={h.id}>
              <span className="log-kind">{KIND[h.kind] ?? h.kind}</span>
              <code className="log-text" title={h.summary}>
                {h.summary}
              </code>
              {typeof h.detail.exitCode === 'number' && h.detail.exitCode !== 0 && (
                <span className="bad small">exit {h.detail.exitCode}</span>
              )}
              <span className="meta">{relativeTime(h.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PanelSections({
  bot,
  view,
  busy,
  domain,
  setDomain,
  allow,
  act,
  hideActivity = false,
}: {
  bot: BotView;
  view: ComputerView;
  busy: boolean;
  domain: string;
  setDomain: (d: string) => void;
  allow: (e: FormEvent) => void;
  act: (fn: () => Promise<unknown>) => void;
  hideActivity?: boolean;
}) {
  return (
    <>
      <section className="computer-section">
        <h4>
          <Icon name="lock" size={13} /> Internet
        </h4>
        <p className="muted small">
          Closed by default. {bot.name} reaches only these domains (and their subdomains):
        </p>
        <div className="row wrap">
          {view.allowed.length === 0 && <span className="muted small">none yet</span>}
          {view.allowed.map((d) => (
            <span key={d} className="chip">
              {d}
              <button
                className="chip-x"
                aria-label={`Remove ${d}`}
                disabled={busy}
                onClick={() => act(() => api.revokeDomain(bot.id, d))}
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
        <form className="row" onSubmit={allow}>
          <input
            className="grow"
            aria-label="Allow a domain"
            placeholder="pypi.org"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
          <button type="submit" disabled={busy || !domain.trim()}>
            Allow
          </button>
        </form>
      </section>

      {!hideActivity && (
        <section className="computer-section">
          <h4>
            <Icon name="clock" size={13} /> Activity
          </h4>
          {view.history.length === 0 ? (
            <p className="muted small">Nothing yet.</p>
          ) : (
            <ul className="plain computer-log">
              {view.history.slice(0, 30).map((h) => (
                <li key={h.id} className={`log-${h.kind}`}>
                  <span className="log-kind">{KIND[h.kind] ?? h.kind}</span>
                  <code className="log-text">{h.summary}</code>
                  {typeof h.detail.exitCode === 'number' && h.detail.exitCode !== 0 && (
                    <span className="bad small">exit {h.detail.exitCode}</span>
                  )}
                  <span className="meta">{relativeTime(h.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {view.running && (
        <section className="computer-section">
          <h4>
            <Icon name="folder" size={13} /> Files
          </h4>
          {view.files.filter((f) => !f.dir).length === 0 ? (
            <p className="muted small">The home folder is empty.</p>
          ) : (
            <ul className="plain computer-files">
              {view.files
                .filter((f) => !f.dir)
                .sort((a, b) => {
                  const engineer = (p: string) =>
                    /\.(kicad_pcb|kicad_sch|kicad_pro|step|stp|stl|gbr|gbl|gtl|pcb)$/i.test(p)
                      ? 0
                      : 1;
                  return engineer(a.path) - engineer(b.path);
                })
                .slice(0, 80)
                .map((f) => {
                  const isHardware = /\.(kicad_pcb|kicad_sch|step|stp|stl|gbr|gbl|gtl|pcb)$/i.test(
                    f.path,
                  );
                  return (
                    <li key={f.path} className={isHardware ? 'hardware-file' : ''}>
                      <Icon name={isHardware ? 'target' : 'file'} size={13} />
                      <span className="grow" title={f.path}>
                        {f.path}
                      </span>
                      <span className="meta">{size(f.size)}</span>
                    </li>
                  );
                })}
            </ul>
          )}
          <p className="muted small" style={{ marginTop: 6 }}>
            KiCad boards open live with <code>kicad</code>, CAD models with <code>freecad</code> on
            :99 — the bot does this itself when it designs hardware.
          </p>
        </section>
      )}
    </>
  );
}
