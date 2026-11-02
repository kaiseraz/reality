import { Blobatar } from '@blobatar/react';
import { useGaze } from '@blobatar/react/gaze';
import type { Presence } from '@reality/schemas';
import { happy, idle, smug, surprised, thinking, unsure } from 'blobatar/expression';
import 'blobatar/motion.css';
import 'blobatar/gaze.css';
import { useResolvedTheme } from '../ui/hooks.ts';

/**
 * A bot's figure: a blob figure (@blobatar) made from its name, so the same name is the same
 * creature everywhere. What the bot is doing shows in its face; figures big enough to see it
 * follow the pointer with their eyes.
 */

export const PRESENCE_TEXT: Record<Presence, string> = {
  idle: 'free',
  thinking: 'thinking',
  talking: 'writing',
  working: 'working',
  searching: 'searching',
  reading: 'reading',
  waiting: 'waiting for you',
  celebrate: 'done',
};

const FACE_OF: Record<Presence, typeof idle> = {
  idle,
  thinking,
  talking: happy,
  working: thinking,
  searching: unsure,
  reading: smug,
  waiting: surprised,
  celebrate: happy,
};

type FigureProps = {
  /** Whose figure this is; the whole look follows from it. */
  name: string;
  /** The main bot wears the interface's own colours instead of those from its name. */
  main?: boolean | undefined;
  state?: Presence;
  size?: number;
  title?: string;
};

export function BotFigure({ name, main, state = 'idle', size = 40, title }: FigureProps) {
  const theme = useResolvedTheme();
  const palette = main
    ? theme === 'dark'
      ? { head: '#ffffff', eye: '#0b0b0d' }
      : { head: '#111114', eye: '#ffffff' }
    : undefined;
  const label = `${title ?? name}, ${PRESENCE_TEXT[state]}`;
  return (
    <span
      className="bot-figure"
      role="img"
      aria-label={label}
      style={{ width: size, height: size }}
    >
      {size >= 48 && typeof window.matchMedia === 'function' ? (
        <LookingFigure name={name} state={state} size={size} palette={palette} />
      ) : (
        <Blobatar
          name={name}
          size={size}
          {...(palette ? { palette } : {})}
          expression={FACE_OF[state]}
          animate={state === 'idle' ? 'hover' : 'always'}
        />
      )}
    </span>
  );
}

function LookingFigure({
  name,
  state,
  size,
  palette,
}: Required<Pick<FigureProps, 'name' | 'state' | 'size'>> & {
  palette: { head: string; eye: string } | undefined;
}) {
  const { ref } = useGaze({ travel: 3 });
  return (
    <Blobatar
      ref={ref}
      name={name}
      size={size}
      {...(palette ? { palette } : {})}
      expression={FACE_OF[state]}
      animate="always"
    />
  );
}
