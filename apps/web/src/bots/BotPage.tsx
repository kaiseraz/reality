import { useCallback, useEffect, useState } from 'react';
import type { BotView, TaskSummary } from '@reality/schemas';
import { api } from '../api.ts';
import { ChatView } from '../chat/ChatView.tsx';
import { Icon } from '../ui/Icon.tsx';
import { relativeTime, statusOf } from '../ui/status.ts';
import { ROLE } from './BotAvatar.tsx';

/** One bot: your direct chat with it, plus its profile and the Reality tasks it ran. */
export function BotPage({
  id,
  openTask,
  onRemoved,
}: {
  id: string;
  openTask: (taskId: string) => void;
  onRemoved: () => void;
}) {
  const [bot, setBot] = useState<(BotView & { tasks: TaskSummary[] }) | null>(null);

  const load = useCallback(() => {
    api
      .bot(id)
      .then(setBot)
      .catch(() => setBot(null));
  }, [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const remove = async () => {
    if (!bot || !window.confirm(`Remove ${bot.name} from the team?`)) return;
    await api.deleteBot(bot.id).catch(() => undefined);
    onRemoved();
  };

  const profile = bot && (
    <div className="bot-profile">
      <strong>{bot.name}</strong>
      <span className="muted">
        {ROLE[bot.role].label} · {ROLE[bot.role].about}
      </span>
      {bot.persona && <p className="small">{bot.persona}</p>}
      {bot.tasks.length > 0 && (
        <details>
          <summary className="small">Reality tasks ({bot.tasks.length})</summary>
          <ul className="plain">
            {bot.tasks.slice(0, 10).map((t) => {
              const s = statusOf(t.status);
              return (
                <li key={t.id}>
                  <button className="task-item" onClick={() => openTask(t.id)}>
                    <span className={`dot tone-${s.tone} ${s.live ? 'live' : ''}`} />
                    <span className="title">{t.request}</span>
                    <span className="meta">{relativeTime(t.updatedAt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {!bot.isMain && (
        <span className="muted small">
          Record: {bot.record.met} met, {bot.record.failed} failed
          {bot.resting ? ' · resting' : ''}
        </span>
      )}
      {!bot.isMain && (
        <button className="btn-ghost small" onClick={() => void remove()}>
          <Icon name="x" size={14} /> Remove from team
        </button>
      )}
    </div>
  );

  return <ChatView key={id} botId={id} header={profile} />;
}
