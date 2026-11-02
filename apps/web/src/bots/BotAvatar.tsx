import type { BotRole, BotView } from '@reality/schemas';
import { BotFigure } from './BotFigure.tsx';

export const ROLE: Record<BotRole, { label: string; about: string }> = {
  analyst: { label: 'Analyst', about: 'Data questions, statistics and forecasts' },
  researcher: { label: 'Researcher', about: 'Background, sources and context' },
  engineer: { label: 'Engineer', about: 'Tools, capabilities and data preparation' },
  reviewer: { label: 'Reviewer', about: 'Criteria, checks and second opinions' },
  lead: { label: 'Lead', about: 'Plans projects and keeps them moving' },
};

/**
 * A bot's face: its animated figure, moving according to its status (working, waiting for
 * you, free). Kept as the shared entry point so every place shows the same figure.
 */
export function BotAvatar({
  bot,
  size = 32,
  showStatus = true,
}: {
  bot: Pick<BotView, 'name'> & Partial<Pick<BotView, 'status' | 'isMain'>>;
  size?: number;
  showStatus?: boolean;
}) {
  const status = showStatus ? (bot.status ?? 'idle') : 'idle';
  return (
    <BotFigure
      name={bot.name}
      main={bot.isMain}
      state={status === 'working' ? 'working' : status === 'waiting' ? 'waiting' : 'idle'}
      size={size}
      title={bot.name}
    />
  );
}
