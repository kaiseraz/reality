import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { BotView, ChatMessage, ChatState } from '@reality/schemas';
import { api, type Sample } from '../api.ts';
import { autoGrow } from '../Home.tsx';
import { BotFigure, PRESENCE_TEXT } from '../bots/BotFigure.tsx';
import { ROLE } from '../bots/BotAvatar.tsx';
import { BotTeamStack } from '../bots/BotBirths.tsx';
import { Markdown } from '../pages/markdown.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Card, isActionableCard } from './Cards.tsx';
import { FolderChip } from './ProjectFolder.tsx';
import type { VisualFocus } from './VisualPanel.tsx';
import { Workbench } from './Workbench.tsx';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A conversation with one bot or a group (Grok-Bot style): the team's figures move while
 * they work, plans arrive as cards to approve, verified results come back as cards, and the
 * board shows who does what.
 */
export function ChatView({
  chatId,
  botId,
  header,
}: {
  chatId?: string;
  botId?: string;
  /** Extra content for the side panel (e.g. a bot's profile). */
  header?: React.ReactNode;
}) {
  const [state, setRawState] = useState<ChatState | null>(null);
  // Every poll brings new objects for the same messages. Those that did not change keep theirs,
  // or a 3D view would download its files and rebuild its scene every few seconds.
  const setState = useCallback((next: ChatState) => {
    setRawState((prev) => {
      if (!prev || !Array.isArray(prev.messages) || !Array.isArray(next.messages)) return next;
      const known = new Map(prev.messages.map((m) => [m.id, m]));
      return {
        ...next,
        messages: next.messages.map((m) => {
          const old = known.get(m.id);
          return old && JSON.stringify(old) === JSON.stringify(m) ? old : m;
        }),
      };
    });
  }, []);
  const [bots, setBots] = useState<BotView[]>([]);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [draft, setDraft] = useState('');
  const [sample, setSample] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The workbench (computers) stays closed until the person opens it: a new chat
  // should start as a conversation, not as a wall of screens.
  const [board, setBoard] = useState(false);
  const [focusVisual, setFocusVisual] = useState<VisualFocus | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const lastId = useRef(0);
  // What this page already knew about when it opened: history does not pop open by itself.
  const seenVisual = useRef<number | null>(null);

  const load = useCallback(() => {
    const request = botId ? api.botChat(botId) : chatId ? api.chat(chatId) : null;
    request?.then(setState).catch((e: unknown) => setError(message(e)));
  }, [botId, chatId, setState]);

  useEffect(() => {
    load();
    api
      .samples()
      .then((s) => setSamples(Array.isArray(s) ? s : []))
      .catch(() => setSamples([]));
  }, [load]);

  // The crew changes while the chat is open: the lead hires specialists, so their
  // figures, names and @mentions must appear at once — no reload. Reload the fleet
  // immediately when the chat gets a member, and poll so looks stay fresh.
  const memberKey = Array.isArray(state?.botIds) ? state.botIds.join(',') : '';
  useEffect(() => {
    let live = true;
    const loadBots = () =>
      api
        .bots()
        .then((b) => {
          if (live) setBots(Array.isArray(b) ? b : []);
        })
        .catch(() => undefined);
    loadBots();
    const t = setInterval(loadBots, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [memberKey]);

  // Poll fast while bots work, slowly otherwise.
  const active =
    state?.running === true ||
    Object.values(state?.presence ?? {}).some((p) => p.state !== 'idle' && p.state !== 'waiting');
  useEffect(() => {
    const t = setInterval(load, active ? 1200 : 4000);
    return () => clearInterval(t);
  }, [load, active]);

  // Scroll to the newest message when one arrives.
  const newest = state?.messages?.at(-1)?.id ?? 0;
  useEffect(() => {
    if (newest > lastId.current) {
      lastId.current = newest;
      end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }
  }, [newest]);

  // A visual is drawn to be seen: a new one opens the panel beside the chat.
  const newestVisual =
    state?.messages?.findLast((m) => m.role === 'card' && m.card?.kind === 'visual')?.id ?? 0;
  useEffect(() => {
    if (!state) return;
    if (seenVisual.current === null) {
      seenVisual.current = newestVisual;
    } else if (newestVisual > seenVisual.current) {
      seenVisual.current = newestVisual;
      setBoard(true);
      setFocusVisual({ id: newestVisual });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestVisual, state === null]);

  if (!state || !Array.isArray(state.messages) || !Array.isArray(state.botIds) || !state.presence) {
    return (
      <div className="page">
        <p className={error ? 'bad' : 'muted'}>{error ?? 'Loading…'}</p>
      </div>
    );
  }

  const team = state.botIds
    .map((id) => bots.find((b) => b.id === id))
    .filter((b): b is BotView => b !== undefined);
  const botOf = (id: string | null) => team.find((b) => b.id === id);
  const presence = (id: string) => state.presence[id] ?? { state: 'idle' as const, activity: '' };
  const working = team.filter((b) =>
    ['thinking', 'talking', 'working', 'searching', 'reading'].includes(presence(b.id).state),
  );

  const act = async (fn: () => Promise<ChatState | unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      if (next && typeof next === 'object' && 'messages' in next) setState(next as ChatState);
      else load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    await act(() => api.sendChat(state.id, text, sample || undefined));
    setSample('');
  };

  const title = state.kind === 'dm' ? (team[0]?.name ?? state.title) : state.title;
  // Work steps and records are not in the thread, so they must not split up someone's messages.
  const seen = state.messages.filter(
    (m) => m.role !== 'action' && (m.role !== 'card' || (m.card && isActionableCard(m.card))),
  );

  return (
    <div className="chat-page">
      <div className="chat-main">
        <header className="chat-head">
          <BotTeamStack
            team={team}
            scope={chatId ?? botId ?? ''}
            size={state.kind === 'dm' ? 34 : 26}
            stateOf={(id) => presence(id).state}
          />
          <div className="grow chat-head-text">
            <h1 title={title}>{title}</h1>
            {/* One compact status line: who works, who waits — no "free" spam. */}
            <p className="muted chat-status">
              <span
                className={`dot tone-${state.running || working.length > 0 ? 'info live' : 'ok'}`}
              />
              {state.kind === 'dm' && team[0]
                ? `${ROLE[team[0].role].label} · ${presence(team[0].id).activity || PRESENCE_TEXT[presence(team[0].id).state]}`
                : (() => {
                    const waits = team
                      .filter((b) => presence(b.id).state === 'waiting')
                      .map((b) => b.name);
                    const bits = [
                      `${team.length} ${team.length === 1 ? 'bot' : 'bots'}`,
                      working.length > 0
                        ? working.length === 1
                          ? `${working[0]?.name} works`
                          : `${working.length} working`
                        : null,
                      waits.length > 0 ? `needs you: ${waits.join(', ')}` : null,
                    ].filter(Boolean);
                    return bits.join(' · ');
                  })()}
              {state.engine === 'rules' && ' · built-in rules'}
            </p>
          </div>
          {state.folders && (
            <FolderChip chatId={state.id} path={state.hostFolder} onChange={load} />
          )}
          {state.running && (
            <button className="btn-ghost" onClick={() => void act(() => api.stopChat(state.id))}>
              <Icon name="x" /> Stop
            </button>
          )}
          <button
            className="btn-ghost btn-icon head-toggle"
            onClick={() => setBoard((b) => !b)}
            aria-pressed={board}
            aria-label="Workbench"
            title="Workbench: the bots' computers live, and what they draw for you"
          >
            <Icon name="panel" size={18} />
          </button>
        </header>

        <div className="chat-scroll">
          <div className="chat-thread">
            {state.messages.length === 0 && (
              <div className="chat-empty">
                {team[0] && (
                  <BotFigure name={team[0].name} main={team[0].isMain} state="idle" size={120} />
                )}
                {state.kind === 'dm' && team[0] && (
                  <>
                    <h2>{team[0].name}</h2>
                    <span className="chat-empty-role">{ROLE[team[0].role].label}</span>
                  </>
                )}
                <p>
                  {state.kind === 'dm'
                    ? `Say hello to ${team[0]?.name ?? 'your bot'}. Ask a question, give a task, or attach example data.`
                    : `Your group. Write to everyone, or call someone with @${team[0]?.name ?? 'Name'}.`}
                </p>
              </div>
            )}
            {seen.map((m, i) => (
              <Message
                key={m.id}
                m={m}
                bot={botOf(m.botId)}
                busy={busy}
                inGroup={state.kind !== 'dm'}
                joinsPrevious={sameSpeaker(seen[i - 1], m)}
                joinsNext={sameSpeaker(m, seen[i + 1])}
                onVisual={(id) => {
                  setBoard(true);
                  setFocusVisual({ id });
                }}
                onPlan={(taskId, approved, secrets) =>
                  void act(() => api.decideChatPlan(state.id, taskId, approved, secrets))
                }
                onAnswer={(answer) => void act(() => api.answerChat(state.id, m.id, answer))}
              />
            ))}
            {working.map((b) => {
              const { state: now, activity } = presence(b.id);
              const typing = now === 'talking' || now === 'thinking';
              return (
                <div key={b.id} className="chat-typing">
                  <BotFigure name={b.name} main={b.isMain} state={now} size={30} />
                  <strong>{b.name}</strong>
                  {typing ? (
                    <span className="typing-dots" aria-label="is typing">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : (
                    <span>{activity || PRESENCE_TEXT[now]}…</span>
                  )}
                </div>
              );
            })}
            <div ref={end} />
          </div>
        </div>

        <form className="chat-composer" onSubmit={(e) => void send(e)}>
          {error && (
            <p className="callout tone-bad" role="alert">
              <Icon name="alert" /> <span>{error}</span>
            </p>
          )}
          <div className="composer">
            <label htmlFor="chat-input" className="sr-only">
              Message
            </label>
            <textarea
              id="chat-input"
              rows={1}
              value={draft}
              placeholder={
                state.kind === 'dm'
                  ? `Message ${team[0]?.name ?? 'your bot'}`
                  : `Message the group, @${team.map((b) => b.name).join(', @')}`
              }
              onChange={(e) => {
                setDraft(e.target.value);
                autoGrow(e.target);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-foot">
              <label className="composer-attach" title="Attach a file (up to 25 MB)">
                <Icon name="file" size={15} />
                <span className="sr-only">Attach a file</span>
                <input
                  type="file"
                  hidden
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void act(() => api.attachChatFile(state.id, file));
                  }}
                />
              </label>
              <select
                aria-label="Attach example data"
                value={sample}
                onChange={(e) => setSample(e.target.value)}
              >
                <option value="">No data</option>
                {samples.map((s) => (
                  <option key={s.id} value={s.id}>
                    Data: {s.title}
                  </option>
                ))}
              </select>
              {state.kind === 'group' &&
                team.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    className="mention"
                    onClick={() =>
                      setDraft((d) => `${d}${d && !d.endsWith(' ') ? ' ' : ''}@${b.name} `)
                    }
                  >
                    @{b.name}
                  </button>
                ))}
              <span className="grow" />
              <button
                type="submit"
                className="round send"
                aria-label="Send"
                disabled={busy || !draft.trim()}
              >
                <Icon name="arrowUp" size={18} />
              </button>
            </div>
          </div>
        </form>
      </div>

      {board && (
        <Workbench
          state={state}
          team={team}
          header={header}
          focusVisual={focusVisual}
          onFolderChange={load}
        />
      )}
    </div>
  );
}

/** Two messages in a row from one speaker read as one turn, the way a messenger shows them. */
const sameSpeaker = (a: ChatMessage | undefined, b: ChatMessage | undefined) =>
  !!a &&
  !!b &&
  ((a.role === 'user' && b.role === 'user') ||
    (a.role === 'bot' && b.role === 'bot' && a.botId === b.botId));

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function Message({
  m,
  bot,
  busy,
  inGroup,
  joinsPrevious,
  joinsNext,
  onVisual,
  onPlan,
  onAnswer,
}: {
  m: ChatMessage;
  bot: BotView | undefined;
  busy: boolean;
  inGroup: boolean;
  joinsPrevious: boolean;
  joinsNext: boolean;
  onVisual: (id: number) => void;
  onPlan: (taskId: string, approved: boolean, secrets?: Record<string, string>) => void;
  onAnswer: (answer: string) => void;
}) {
  if (m.role === 'user') {
    return (
      <div className={`msg-user ${joinsPrevious ? 'joined' : ''}`}>
        <div className="bubble">
          {m.text.split(/(@[A-Za-z][\w-]*)/g).map((part, i) =>
            part.startsWith('@') ? (
              <span className="mention" key={i}>
                {part}
              </span>
            ) : (
              part
            ),
          )}
          <time className="msg-time">{timeOf(m.createdAt)}</time>
        </div>
      </div>
    );
  }
  if (m.role === 'system') {
    return <div className="chat-system">{m.text.replace(/\s*\[sample:[a-z0-9_-]+\]/, '')}</div>;
  }
  // Work steps ("works on its computer", "writes a file") are not conversation:
  // they live in the workbench's Activity tab, not between the chat bubbles.
  if (m.role === 'action') return null;
  if (m.role === 'card' && m.card) {
    // Only decisions stay in the chat; records (results, finished contracts, lab
    // views, sources) are in the workbench notebook.
    if (!isActionableCard(m.card)) return null;
    if (m.card.kind === 'visual') {
      return (
        <div className="chat-card-row">
          <button type="button" className="chat-card visual-chip" onClick={() => onVisual(m.id)}>
            <Icon name="layout" size={15} /> <strong>{m.card.title}</strong>
            {m.card.version > 1 && <span className="muted small"> v{m.card.version}</span>}
            <span className="muted small"> · {bot?.name ?? 'A bot'} drew this</span>
          </button>
        </div>
      );
    }
    return (
      <div className="chat-card-row">
        <Card card={m.card} busy={busy} onPlan={onPlan} onAnswer={onAnswer} />
      </div>
    );
  }
  return (
    <div className={`chat-bot ${joinsPrevious ? 'joined' : ''}`}>
      {joinsNext ? (
        <span className="chat-bot-gap" />
      ) : bot ? (
        <BotFigure name={bot.name} main={bot.isMain} size={30} />
      ) : (
        <span className="avatar" />
      )}
      <div className="chat-bot-body">
        {inGroup && !joinsPrevious && (
          <div
            className="answer-by"
            style={bot ? ({ '--speaker': bot.color } as React.CSSProperties) : undefined}
          >
            {bot?.name ?? 'Bot'}
          </div>
        )}
        <Markdown text={m.text} />
        <time className="msg-time">{timeOf(m.createdAt)}</time>
        {m.card?.kind === 'unbacked' && (
          <div
            className="unbacked"
            title="Reality found these numbers in no tool result or verified result of this chat."
          >
            <Icon name="alert" size={13} /> Not backed by a source or result:{' '}
            {m.card.numbers.join(', ')}
          </div>
        )}
      </div>
    </div>
  );
}
