import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { BotView, Presence } from '@reality/schemas';
import { BotFigure, PRESENCE_TEXT } from './BotFigure.tsx';

/**
 * The team at the top of a chat. A bot that joins is born from the first one, the way the two dots in
 * the logo pull apart: a drop stretches out of it on a thinning neck, tears off, lands in its place and
 * becomes the new bot. The neck is real: plain circles through a blur and a hard alpha cut melt together
 * wherever they come close.
 */

const SHOWN = 4;
const NEXT_CHILD_S = 0.35;
const FLIGHT_S = 0.9;

const stillMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Birth {
  id: string;
  dx: number;
  delay: number;
}

export function BotTeamStack({
  team,
  scope,
  size,
  stateOf,
}: {
  team: BotView[];
  /** What this team belongs to: a different chat is not a bigger team. */
  scope: string;
  size: number;
  stateOf: (id: string) => Presence;
}) {
  const box = useRef<HTMLDivElement>(null);
  const known = useRef<{ scope: string; ids: Set<string> } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [scene, setScene] = useState<{ x: number; y: number; births: Birth[] } | null>(null);
  const shown = team.slice(0, SHOWN);
  const ids = shown.map((b) => b.id).join(' ');

  useLayoutEffect(() => {
    const now = shown.map((b) => b.id);
    if (now.length === 0) return;
    const before = known.current?.scope === scope ? known.current.ids : null;
    known.current = { scope, ids: new Set(now) };
    // The first look only learns who is already there.
    if (!before || !box.current || stillMotion()) return;
    const fresh = now.filter((id) => !before.has(id));
    const first = now[0];
    if (fresh.length === 0 || !first || fresh.includes(first)) return;
    const centre = (id: string) => {
      const el = box.current?.querySelector<HTMLElement>(`[data-bot="${id}"]`);
      return el
        ? { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2 }
        : null;
    };
    const from = centre(first);
    if (!from) return;
    const births = fresh.flatMap((id, i) => {
      const to = centre(id);
      return to ? [{ id, dx: to.x - from.x, delay: 0.15 + i * NEXT_CHILD_S }] : [];
    });
    setScene({ x: from.x, y: from.y, births });
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setScene(null),
      (0.5 + fresh.length * NEXT_CHILD_S + FLIGHT_S) * 1000,
    );
    // Only a changed team starts this; the ids say everything about it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, scope]);
  useLayoutEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div ref={box} className="chat-team" aria-label={`${team.length} bots in this chat`}>
      {scene && (
        <svg className="bot-bud" aria-hidden width="1" height="1">
          <defs>
            <filter id="bot-bud-goo" x="-50%" y="-200%" width="800%" height="500%">
              <feGaussianBlur in="SourceGraphic" stdDeviation={size / 11} />
              <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8" />
            </filter>
          </defs>
          <g filter="url(#bot-bud-goo)">
            <circle cx={scene.x} cy={scene.y} r={size * 0.44} className="bot-bud-mother" />
            {scene.births.map((b) => (
              <circle
                key={b.id}
                cx={scene.x}
                cy={scene.y}
                r={size * 0.4}
                className="bot-bud-drop"
                style={
                  {
                    '--bud-x': `${b.dx}px`,
                    '--bud-delay': `${b.delay}s`,
                    '--bud-time': `${FLIGHT_S}s`,
                  } as CSSProperties
                }
              />
            ))}
          </g>
        </svg>
      )}
      {shown.map((b) => {
        const birth = scene?.births.find((x) => x.id === b.id);
        return (
          <span
            key={b.id}
            data-bot={b.id}
            className={`chat-member${birth ? ' chat-member-born' : ''}`}
            title={`${b.name}: ${PRESENCE_TEXT[stateOf(b.id)]}`}
            style={
              birth
                ? ({ '--born-at': `${birth.delay + FLIGHT_S * 0.8}s` } as CSSProperties)
                : undefined
            }
          >
            <BotFigure
              name={b.name}
              main={b.isMain}
              state={stateOf(b.id)}
              size={size}
              title={b.name}
            />
          </span>
        );
      })}
      {team.length > SHOWN && <span className="chat-member-more">+{team.length - SHOWN}</span>}
    </div>
  );
}
