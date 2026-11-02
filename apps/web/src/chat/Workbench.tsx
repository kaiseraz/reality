import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotView, ChatState } from '@reality/schemas';
import { api, type Mission } from '../api.ts';
import { MissionPanel } from '../missions/MissionPanel.tsx';
import { Card } from './Cards.tsx';
import { ComputersOverview } from './ComputersOverview.tsx';
import { FilesPanel } from './ProjectFolder.tsx';
import { VisualPanel, type Visual, type VisualFocus } from './VisualPanel.tsx';

type Tab = 'mission' | 'computers' | 'visuals' | 'files' | 'results';

const WIDTH_KEY = 'reality.workbench.width';
const clampWidth = (w: number) =>
  Math.round(Math.max(320, Math.min(w, Math.max(360, window.innerWidth - 560))));

/** The workbench's width, set by dragging its left edge and remembered. */
function useWidth(): [number, (e: React.PointerEvent) => void] {
  const [width, setWidth] = useState(() => {
    let saved: number;
    try {
      saved = Number(localStorage.getItem(WIDTH_KEY)) || 0;
    } catch {
      saved = 0;
    }
    return clampWidth(saved || window.innerWidth * 0.42);
  });
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    let last = w0;
    const move = (ev: PointerEvent) => {
      last = clampWidth(w0 + (x0 - ev.clientX));
      setWidth(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      try {
        localStorage.setItem(WIDTH_KEY, String(last));
      } catch {
        // Storage unavailable: the width lasts for this page only.
      }
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return [width, start];
}

/**
 * The workbench beside the chat, reduced to what the person watches: the bots'
 * computers, live. Mission chats get a mission tab; a plan still opens for
 * approval in the chat itself. Once there are checked results they get a tab too,
 * since the chat keeps only decisions: the 3D views, checks and files live there. What a bot
 * draws for the person gets one as well, and that one does come to the front.
 */
const noop = () => undefined;

export function Workbench({
  state,
  team,
  header,
  focusVisual = null,
  onFolderChange = noop,
}: {
  state: ChatState;
  team: BotView[];
  header?: React.ReactNode;
  /** The message of a visual to bring to the front. */
  focusVisual?: VisualFocus | null;
  onFolderChange?: () => void;
}) {
  // A tab chosen by hand holds until the next visual asks to be seen.
  const [pick, setPick] = useState<{ tab: Tab; under: VisualFocus | null }>({
    tab: 'computers',
    under: null,
  });
  const tab = pick.under === focusVisual ? pick.tab : 'visuals';
  const setTab = (t: Tab) => setPick({ tab: t, under: focusVisual });
  const [width, startResize] = useWidth();
  const [mission, setMission] = useState<Mission | null>(null);
  const messageCount = state.messages.length;
  // Newest first; the computers stay in front, a new result does not pull the view away.
  const results = state.messages
    .flatMap((m) => (m.role === 'card' && m.card ? [{ id: m.id, card: m.card }] : []))
    .filter((r) => r.card.kind === 'lab' || r.card.kind === 'result')
    .reverse();
  const visuals: Visual[] = state.messages.flatMap((m) =>
    m.role === 'card' && m.card?.kind === 'visual'
      ? [
          {
            id: m.id,
            botName: team.find((b) => b.id === m.botId)?.name ?? 'A bot',
            card: m.card,
          },
        ]
      : [],
  );
  const tabs: Tab[] = [
    ...(mission ? (['mission'] as const) : []),
    'computers',
    ...(visuals.length > 0 ? (['visuals'] as const) : []),
    ...(state.hostFolder ? (['files'] as const) : []),
    ...(results.length > 0 ? (['results'] as const) : []),
  ];
  const loadMission = useCallback(() => {
    api
      .chatMission(state.id)
      .then((m) => {
        setMission(m);
        // A mission chat opens on its mission tab the first time.
        if (m && !seenMission.current) {
          seenMission.current = true;
          setPick({ tab: 'mission', under: null });
        }
      })
      .catch(() => setMission(null));
  }, [state.id]);
  const seenMission = useRef(false);
  useEffect(() => {
    loadMission();
  }, [loadMission, messageCount]);

  return (
    <aside className="chat-side workbench" aria-label="Workbench" style={{ width }}>
      <div
        className="workbench-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Drag to resize the workbench"
        onPointerDown={startResize}
      />
      {header}
      {tabs.length > 1 && (
        <div className="seg" role="tablist" aria-label="Workbench">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'on' : ''}
              onClick={() => setTab(t)}
            >
              {t === 'mission'
                ? 'Mission'
                : t === 'computers'
                  ? 'Computers'
                  : t === 'files'
                    ? 'Files'
                    : t === 'visuals'
                      ? `Visuals (${new Set(visuals.map((v) => v.card.title)).size})`
                      : `Checks (${results.length})`}
            </button>
          ))}
        </div>
      )}

      {tab === 'mission' && mission && <MissionPanel mission={mission} onChange={loadMission} />}

      {tab === 'computers' && (
        <ComputersOverview team={team} presence={state.presence} chatId={state.id} />
      )}

      {tab === 'visuals' && <VisualPanel visuals={visuals} focus={focusVisual} />}

      {tab === 'files' && <FilesPanel chatId={state.id} onChange={onFolderChange} />}

      {tab === 'results' && (
        <div className="workbench-results">
          {results.map((r) => (
            <Card key={r.id} card={r.card} busy={false} onPlan={noop} onAnswer={noop} />
          ))}
        </div>
      )}
    </aside>
  );
}
