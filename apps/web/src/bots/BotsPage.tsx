import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { BotRole, BotView, ChatSummary, Presence } from '@reality/schemas';
import { api } from '../api.ts';
import { Icon } from '../ui/Icon.tsx';
import { relativeTime } from '../ui/status.ts';
import { BotAvatar, ROLE } from './BotAvatar.tsx';
import { BotFigure, PRESENCE_TEXT } from './BotFigure.tsx';

const NAMES = ['Mila', 'Jonas', 'Ada', 'Theo', 'Noor', 'Lina', 'Emil', 'Zoe'];
const PREVIEW: Presence[] = [
  'idle',
  'thinking',
  'talking',
  'working',
  'searching',
  'reading',
  'waiting',
  'celebrate',
];
const COLORS = ['#7a1f35', '#3f2557', '#5b2448', '#1b1b20', '#ececee'];
const PERSONA: Record<BotRole, string> = {
  analyst: 'Precise and calm. Lets the data speak and says plainly what it cannot show.',
  researcher: 'Curious and thorough. Always names the source and how strong it is.',
  engineer: 'Practical. Builds the simplest thing that works and tests it.',
  reviewer: 'Friendly but sceptical. Asks for the evidence behind every claim.',
  lead: 'Organised. Splits work, hands it to the right person and keeps everyone moving.',
};

export function statusText(b: BotView): string {
  if (b.status === 'working') return `Working on “${b.current?.request ?? ''}”`;
  if (b.status === 'waiting') return `Waiting for you: “${b.current?.request ?? ''}”`;
  return b.done > 0 ? `Free · ${b.done} done` : 'Free';
}

/** Your team: persistent bots you talk to, alone or in groups. */
export function BotsPage({
  openBot,
  openChat,
}: {
  openBot: (id: string) => void;
  openChat: (id: string) => void;
}) {
  const [bots, setBots] = useState<BotView[] | null>(null);
  const [groups, setGroups] = useState<ChatSummary[]>([]);
  const [name, setName] = useState('');
  const [role, setRole] = useState<BotRole>('analyst');
  const [persona, setPersona] = useState('');
  const [preview, setPreview] = useState<Presence>('idle');
  const [groupTitle, setGroupTitle] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuGroup, setMenuGroup] = useState<string | null>(null);

  // Close the group menu on any click elsewhere.
  useEffect(() => {
    if (!menuGroup) return;
    const close = () => setMenuGroup(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuGroup]);

  const load = useCallback(() => {
    api
      .bots()
      .then((b) => {
        setBots(b);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    api
      .chats()
      .then((c) => setGroups(c.filter((x) => x.kind === 'group')))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  const suggestion = NAMES.find((n) => !(bots ?? []).some((b) => b.name === n)) ?? 'Bot';
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createBot({
        name: name.trim() || suggestion,
        role,
        persona: persona.trim() || PERSONA[role],
        figure: 'orb',
        color: COLORS[0] ?? '#7a1f35',
      });
      setName('');
      setPersona('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createGroup = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const chat = await api.createGroup(groupTitle.trim() || 'Team', members);
      openChat(chat.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const working = (bots ?? []).filter((b) => b.status === 'working').length;

  return (
    <div className="page">
      <header className="page-head">
        <div className="grow">
          <h1>Your team</h1>
          <p>
            Bots you talk to like colleagues. They work with tools until a job is done, hand work to
            each other in groups, and ask you before anything runs that needs your decision.
            {bots && bots.length > 0 && ` ${working} of ${bots.length} working right now.`}
          </p>
        </div>
      </header>

      <div className="bot-grid">
        {(bots ?? []).map((b) => (
          <button key={b.id} className="bot-card" onClick={() => openBot(b.id)}>
            <BotAvatar bot={b} size={56} />
            <span className="bot-text">
              <strong>{b.name}</strong>
              <span className="muted">{ROLE[b.role].label}</span>
              <span className={`bot-status ${b.status}`}>{statusText(b)}</span>
            </span>
            <Icon name="arrow" size={16} />
          </button>
        ))}
      </div>

      <div className="team-forms">
        <form className="card bot-new" onSubmit={(e) => void add(e)}>
          <div className="bot-new-preview">
            <BotFigure name={name.trim() || suggestion} state={preview} size={96} />
            <div className="preview-states" role="radiogroup" aria-label="Try a state">
              {PREVIEW.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={preview === p}
                  className={preview === p ? 'on' : ''}
                  onClick={() => setPreview(p)}
                >
                  {PRESENCE_TEXT[p]}
                </button>
              ))}
            </div>
          </div>
          <div className="bot-new-fields">
            <strong>New team member</strong>
            <div className="row">
              <input
                aria-label="Name"
                placeholder={suggestion}
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
              />
              <select
                aria-label="Role"
                value={role}
                onChange={(e) => setRole(e.target.value as BotRole)}
              >
                {(Object.keys(ROLE) as BotRole[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE[r].label}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              aria-label="Personality"
              rows={2}
              placeholder={PERSONA[role]}
              value={persona}
              maxLength={600}
              onChange={(e) => setPersona(e.target.value)}
            />
            <div>
              <button type="submit" className="btn-primary" disabled={busy}>
                <Icon name="plus" /> Add {name.trim() || suggestion}
              </button>
            </div>
          </div>
        </form>

        <form className="card group-new" onSubmit={(e) => void createGroup(e)}>
          <strong>Groups</strong>
          {groups.length > 0 && (
            <ul className="plain group-list">
              {groups.map((g) => (
                <li key={g.id} className="chat-row">
                  <button className="task-item" onClick={() => openChat(g.id)}>
                    <span className="group-figs">
                      {g.botIds.slice(0, 4).map((id) => {
                        const b = (bots ?? []).find((x) => x.id === id);
                        return b ? <BotAvatar key={id} bot={b} size={22} /> : null;
                      })}
                    </span>
                    <span className="title">
                      {g.title}
                      {g.last && <small className="muted"> · {g.last}</small>}
                    </span>
                    <span className="meta">{relativeTime(g.updatedAt)}</span>
                  </button>
                  <button
                    className="chat-del"
                    aria-label="Team options"
                    aria-expanded={menuGroup === g.id}
                    title="Open, rename or delete this team"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuGroup(menuGroup === g.id ? null : g.id);
                    }}
                  >
                    <span className="dots-glyph" aria-hidden>
                      •••
                    </span>
                  </button>
                  {menuGroup === g.id && (
                    <div className="chat-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMenuGroup(null);
                          openChat(g.id);
                        }}
                      >
                        <Icon name="arrow" size={14} /> Open team
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMenuGroup(null);
                          const next = window.prompt('Rename this team', g.title);
                          if (next?.trim() && next.trim() !== g.title) {
                            const title = next.trim();
                            setGroups((gs) => gs.map((x) => (x.id === g.id ? { ...x, title } : x)));
                            void api.renameChat(g.id, title).catch(() => undefined);
                          }
                        }}
                      >
                        <Icon name="edit" size={14} /> Rename team
                      </button>
                      <button
                        role="menuitem"
                        className="danger"
                        onClick={() => {
                          setMenuGroup(null);
                          if (!window.confirm('Delete this team chat?')) return;
                          setGroups((gs) => gs.filter((x) => x.id !== g.id));
                          void api.deleteChat(g.id).catch(() => undefined);
                        }}
                      >
                        <Icon name="x" size={14} /> Delete team
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <input
            aria-label="Group name"
            placeholder="New group, e.g. Heat study"
            value={groupTitle}
            onChange={(e) => setGroupTitle(e.target.value)}
          />
          <div className="row">
            {(bots ?? []).map((b) => (
              <label key={b.id} className={`chip-check ${members.includes(b.id) ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  checked={members.includes(b.id)}
                  onChange={(e) =>
                    setMembers((m) =>
                      e.target.checked ? [...m, b.id] : m.filter((x) => x !== b.id),
                    )
                  }
                />
                <BotAvatar bot={b} size={20} showStatus={false} /> {b.name}
              </label>
            ))}
          </div>
          <div>
            <button type="submit" className="btn-primary" disabled={busy || members.length < 2}>
              <Icon name="plus" /> Start group chat
            </button>
            {members.length < 2 && <small className="muted"> Pick at least two bots.</small>}
          </div>
        </form>
      </div>

      {error && (
        <p className="callout tone-bad" role="alert" style={{ marginTop: 12 }}>
          <Icon name="alert" /> <span>{error}</span>
        </p>
      )}
    </div>
  );
}
