import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotView, Presence } from '@reality/schemas';
import { api } from '../api.ts';
import { BotAvatar } from '../bots/BotAvatar.tsx';
import { Icon } from '../ui/Icon.tsx';
import { ComputerPanel } from './ComputerPanel.tsx';

/** A bot mid-turn: anything a live turn sets except the end states. */
const BUSY: Presence[] = ['working', 'searching', 'reading', 'thinking', 'talking'];

/**
 * This chat's computers: every bot's screen small, side by side, all at once. A click makes one
 * big, with the others kept small above it, and a computer picked that way starts itself. Follow
 * lets the big screen go to whoever is working. "All screens" goes back to the wall.
 */
export function ComputersOverview({
  team,
  presence,
  chatId,
}: {
  team: BotView[];
  presence: Record<string, { state: Presence; activity: string }>;
  chatId?: string;
}) {
  const [fresh, setFresh] = useState<BotView[]>([]);
  const [running, setRunning] = useState<string[]>([]);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const [waking, setWaking] = useState<string[]>([]);
  // Last auto-start attempt per bot, so a stopped machine is retried at most rarely.
  const startAttempt = useRef(new Map<string, number>());

  const busyOf = (b: BotView) => BUSY.includes(presence[b.id]?.state ?? 'idle');

  const load = useCallback(() => {
    api
      .bots()
      .then((b) => {
        if (Array.isArray(b)) setFresh(b);
      })
      .catch(() => undefined);
    api
      .computers()
      .then((c) => {
        setRunning(c.running);
        setTick((t) => t + 1);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    // Small screens need to move while someone watches them.
    const frames = setInterval(() => setTick((n) => n + 1), 2000);
    return () => {
      clearInterval(t);
      clearInterval(frames);
    };
  }, [load]);

  // Strictly this chat's bots — never the whole fleet.
  const ordered = useMemo(() => {
    const byId = new Map(fresh.map((b) => [b.id, b]));
    return team.map((b) => byId.get(b.id) ?? b);
  }, [team, fresh]);

  // Follow the bot that is on its computer right now, not just the first busy
  // name in team order — the lead thinking must not hide a specialist's screen.
  const busyBots = ordered.filter(busyOf);
  const worker =
    busyBots.find((b) => /computer|brows|file/i.test(presence[b.id]?.activity ?? '')) ??
    busyBots[0];
  const picked = selected ? ordered.find((b) => b.id === selected) : undefined;
  const shown = (follow ? (worker ?? picked) : picked) ?? ordered[0];

  // One bot alone has nothing to compare with: its screen is simply big.
  const wall = showAll && ordered.length > 1;

  const startOne = (b: BotView) => {
    startAttempt.current.set(b.id, Date.now());
    setWaking((w) => (w.includes(b.id) ? w : [...w, b.id]));
    api
      .startComputer(b.id)
      .catch(() => undefined)
      .finally(() => setWaking((w) => w.filter((x) => x !== b.id)));
  };

  // A computer starts itself only when its bot actually works (or the person
  // picked this bot's screen on purpose). Merely opening the panel must not boot
  // an idle lead machine that then sits on a start page.
  useEffect(() => {
    if (!shown || wall) return;
    if (running.includes(shown.id) || waking.includes(shown.id)) return;
    const shouldStart = busyOf(shown) || shown.id === selected;
    if (!shouldStart) return;
    if (Date.now() - (startAttempt.current.get(shown.id) ?? 0) < 20_000) return;
    startOne(shown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown?.id, running, follow, selected, wall]);

  if (ordered.length === 0) return <p className="muted">No computers in this chat yet.</p>;
  if (!shown) return null;

  const shownPresence = presence[shown.id];
  const shownOn = running.includes(shown.id);
  const shownBusy = busyOf(shown);

  const tiles = ordered.map((b) => {
    const on = running.includes(b.id);
    const busy = busyOf(b);
    const needsYou = presence[b.id]?.state === 'waiting';
    return (
      <button
        key={b.id}
        type="button"
        className={`pc-tile ${on ? 'on' : ''} ${busy ? 'busy' : ''} ${needsYou ? 'needs-you' : ''} ${!wall && b.id === shown.id ? 'shown' : ''}`}
        aria-pressed={!wall && b.id === shown.id}
        onClick={() => {
          setSelected(b.id);
          setFollow(false);
          setShowAll(false);
        }}
        title={`Watch ${b.name}'s computer`}
      >
        <span className="pc-screen">
          <img
            src={`/api/bots/${b.id}/computer/thumb?t=${tick}`}
            alt={`${b.name}'s screen`}
            onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
            onLoad={(e) => (e.currentTarget.style.visibility = 'visible')}
          />
          {on && busy && (
            <span className="pc-tile-live">
              <span className="dot tone-info live" /> {presence[b.id]?.activity || 'working'}
            </span>
          )}
          {!on && (
            <span className="pc-off">
              <BotAvatar bot={b} size={wall ? 40 : 24} />
              <span>
                {waking.includes(b.id)
                  ? 'Starting…'
                  : busy
                    ? `working: ${presence[b.id]?.activity || 'on it'}`
                    : needsYou
                      ? 'Waiting for you'
                      : 'Computer off'}
              </span>
            </span>
          )}
        </span>
        <span className="pc-foot">
          <span
            className={`dot ${needsYou ? 'tone-warn' : busy ? 'tone-info live' : on ? 'tone-ok' : 'tone-neutral'}`}
          />
          <strong>{b.name}</strong>
          {busy && <span className="pc-busy">working</span>}
          {needsYou && <span className="pc-needs">needs you</span>}
        </span>
      </button>
    );
  });

  if (wall) {
    return (
      <div className="pcs-wrap">
        <div className="pcs-grid">{tiles}</div>
      </div>
    );
  }

  return (
    <div className="pcs-wrap">
      {ordered.length > 1 && (
        <div className="pcs-thumbs" aria-label="Bot computers">
          {tiles}
        </div>
      )}

      <div className="pcs-live-head">
        <span
          className={`dot ${shownBusy ? 'tone-info live' : shownOn ? 'tone-ok' : 'tone-neutral'}`}
        />
        <strong>{shown.name}</strong>
        {shownBusy && <span className="pc-live-badge">Live</span>}
        <span className="muted small pcs-live-act">
          {waking.includes(shown.id)
            ? 'starting its computer…'
            : shownBusy
              ? shownPresence?.activity || 'works on its computer'
              : shownOn
                ? 'computer on'
                : 'computer starts by itself when needed'}
        </span>
        <span className="grow" />
        {shownOn ? (
          <button
            type="button"
            className="btn-ghost small"
            onClick={() =>
              void api
                .stopComputer(shown.id)
                .catch(() => undefined)
                .then(load)
            }
          >
            Turn off
          </button>
        ) : (
          <button
            type="button"
            className="btn-ghost small"
            disabled={waking.includes(shown.id)}
            onClick={() => startOne(shown)}
          >
            Turn on
          </button>
        )}
        {ordered.length > 1 && (
          <>
            <button
              type="button"
              className={`btn-ghost small ${follow ? 'follow-on' : ''}`}
              aria-pressed={follow}
              onClick={() => setFollow((f) => !f)}
              title="Always show the bot that is working right now"
            >
              Follow live
            </button>
            <button type="button" className="btn-ghost small" onClick={() => setShowAll(true)}>
              <Icon name="panel" size={13} /> All screens
            </button>
          </>
        )}
      </div>

      <ComputerPanel
        key={shown.id}
        bot={shown}
        chatId={chatId}
        working={shownBusy ? shownPresence?.activity : undefined}
        lean
      />
    </div>
  );
}
