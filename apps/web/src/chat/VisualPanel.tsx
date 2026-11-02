import { useEffect, useMemo, useState } from 'react';
import type { ChatMessage } from '@reality/schemas';
import { Icon } from '../ui/Icon.tsx';

export type Visual = {
  id: number;
  botName: string;
  card: Extract<ChatMessage['card'], { kind: 'visual' }>;
};

/** A request to show a visual; a new object each time, so asking twice for one still counts. */
export type VisualFocus = { id: number };

/** What the bots draw for the person, beside the chat: a whiteboard, not only a computer. */
export function VisualPanel({ visuals, focus }: { visuals: Visual[]; focus: VisualFocus | null }) {
  // Oldest first. Every title is one board; its messages are the board's versions.
  const titles = useMemo(() => [...new Set(visuals.map((v) => v.card.title))], [visuals]);
  // A choice by hand holds until the next time something asks for a visual.
  const [pick, setPick] = useState<{ id: number | null; under: VisualFocus | null } | null>(null);
  const setChosen = (id: number | null) => setPick({ id, under: focus });
  const chosen = pick?.under === focus ? pick.id : (focus?.id ?? null);
  const [big, setBig] = useState(false);

  const latest = visuals.at(-1);
  const shown = visuals.find((v) => v.id === chosen) ?? latest;
  const versions = visuals.filter((v) => v.card.title === shown?.card.title);

  useEffect(() => {
    if (!big) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBig(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [big]);

  if (!shown) return null;
  return (
    <div className={`visual-panel ${big ? 'big' : ''}`}>
      <div className="visual-head">
        {titles.length > 1 ? (
          <select
            aria-label="Choose a visual"
            value={shown.card.title}
            onChange={(e) =>
              setChosen(visuals.filter((v) => v.card.title === e.target.value).at(-1)?.id ?? null)
            }
          >
            {titles.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        ) : (
          <strong className="visual-title">{shown.card.title}</strong>
        )}
        {versions.length > 1 && (
          <select
            aria-label="Version"
            value={shown.id}
            onChange={(e) => setChosen(Number(e.target.value))}
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.card.version}
              </option>
            ))}
          </select>
        )}
        <span className="grow" />
        <a
          className="btn-ghost small"
          href={`/api/files/${shown.card.fileId}?download=1`}
          download
          title="Download"
        >
          <Icon name="file" size={13} />
        </a>
        <button type="button" className="btn-ghost small" onClick={() => setBig((b) => !b)}>
          {big ? 'Close' : 'Big'}
        </button>
      </div>
      {shown.card.media === 'image' ? (
        <img
          className="visual-frame"
          src={`/api/files/${shown.card.fileId}`}
          alt={shown.card.title}
        />
      ) : (
        <iframe
          key={shown.card.fileId}
          className="visual-frame"
          title={shown.card.title}
          sandbox="allow-scripts"
          src={`/api/files/${shown.card.fileId}/visual`}
        />
      )}
      <p className="muted small visual-note">Drawn by {shown.botName}. Not a checked result.</p>
    </div>
  );
}
