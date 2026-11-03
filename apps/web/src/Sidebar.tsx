import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { BotView, ChatSummary } from '@reality/schemas';
import { api, type Health } from './api.ts';
import { BotAvatar, ROLE } from './bots/BotAvatar.tsx';
import { BrandMark, Icon } from './ui/Icon.tsx';
import type { Route, ThemePref } from './ui/hooks.ts';
import { relativeTime } from './ui/status.ts';

/** The team and its chats, kept fresh while the sidebar is shown. */
function useTeam() {
  const [bots, setBots] = useState<BotView[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => {
      api
        .bots()
        .then((b) => live && setBots(Array.isArray(b) ? b : []))
        .catch(() => undefined)
        .finally(() => live && setLoaded(true));
      api
        .chats()
        .then((c) => live && setChats(Array.isArray(c) ? c : []))
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return { bots, chats, loaded };
}

/**
 * Astra's sidebar: brand row, search, the team (bots with their figures and last words) or
 * the task history, a short navigation and the person at the bottom.
 */
export function Sidebar({
  route,
  go,
  onNewTask,
  health,
  theme,
  setTheme,
  capabilityCount,
  open,
  user,
  onLogout,
  collapsed = false,
  onToggle,
}: {
  route: Route;
  go: (r: Route) => void;
  onNewTask: () => void;
  health: Health | null;
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  capabilityCount: number | null;
  open: boolean;
  user?: { email: string; role: 'admin' | 'member' } | null | undefined;
  onLogout?: (() => void) | undefined;
  /** Narrow rail instead of the full sidebar (Ctrl+B). */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState<'more' | 'me' | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const { bots, chats, loaded: teamLoaded } = useTeam();
  const needle = q.trim().toLowerCase();
  // One entry per conversation: the title is the job, and the avatar stack is whoever
  // works on it — the lead alone, until it spawns specialists for the task. Spawned
  // bots never become entries of their own; they join the stack of their job.
  const leadId = bots.find((b) => b.isMain)?.id;
  const [gone, setGone] = useState<string[]>([]);
  const [menuChat, setMenuChat] = useState<string | null>(null);
  const [renamed, setRenamed] = useState<Record<string, string>>({});
  const byId = new Map(bots.map((b) => [b.id, b]));
  // Every conversation with words in it belongs in the list, not only the lead's jobs:
  // a direct chat with one employee (opened from its bot page) has no lead in botIds
  // and used to vanish from the sidebar completely. Empty placeholders stay hidden.
  const leadChats = chats
    .filter(
      (c) =>
        !gone.includes(c.id) &&
        ((leadId !== undefined && c.botIds.includes(leadId)) || c.last.trim() !== ''),
    )
    .filter(
      (c) =>
        !needle ||
        c.title.toLowerCase().includes(needle) ||
        (c.last ?? '').toLowerCase().includes(needle),
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  // Close the small menus on any click elsewhere.
  useEffect(() => {
    if (!menu && !menuChat) return;
    const close = () => {
      setMenu(null);
      setMenuChat(null);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu, menuChat]);

  const nav = (
    page: Route['page'],
    icon: Parameters<typeof Icon>[0]['name'],
    label: string,
    active: boolean,
    extra?: ReactNode,
  ) => (
    <button className={`nav-link ${active ? 'active' : ''}`} onClick={() => go({ page } as Route)}>
      <Icon name={icon} /> {label}
      {extra}
    </button>
  );

  const who =
    user?.email ??
    (health?.planner === 'meta'
      ? 'Meta Muse Spark'
      : health?.planner === 'anthropic'
        ? 'Claude'
        : health
          ? 'Built-in planner'
          : 'Connecting…');

  // Collapsed: a narrow rail with the essentials; the drawer on phones is always full.
  if (collapsed && !open) {
    const railNav: [Route['page'], Parameters<typeof Icon>[0]['name'], string][] = [
      ['capabilities', 'puzzle', 'Capabilities'],
      ['knowledge', 'book', 'Knowledge'],
      ['pages', 'file', 'Pages'],
    ];
    return (
      <aside className="sidebar rail" aria-label="navigation">
        <button
          className="btn-ghost btn-icon rail-brand"
          title="Home"
          aria-label="Home"
          onClick={() => go({ page: 'home' })}
        >
          <BrandMark className="brand-mark" />
        </button>
        <button
          className="btn-ghost btn-icon"
          title="Expand sidebar (Ctrl B)"
          aria-label="Expand sidebar"
          onClick={onToggle}
        >
          <Icon name="panel" size={18} />
        </button>
        <button
          className="btn-ghost btn-icon"
          title="New chat"
          aria-label="New chat"
          onClick={onNewTask}
        >
          <Icon name="plus" size={18} />
        </button>
        <div className="rail-bots">
          {bots
            .filter((b) => b.isMain)
            .map((b) => {
              const active = route.page === 'bot' && route.id === b.id;
              return (
                <button
                  key={b.id}
                  className={`rail-bot ${active ? 'selected' : ''}`}
                  title={`${b.name} · ${ROLE[b.role].label}`}
                  aria-label={b.name}
                  onClick={() => go({ page: 'bot', id: b.id })}
                >
                  <BotAvatar bot={b} size={30} />
                  {b.status !== 'idle' && (
                    <span className={`dot tone-${b.status === 'waiting' ? 'warn' : 'info live'}`} />
                  )}
                </button>
              );
            })}
        </div>
        <span className="grow" />
        {railNav.map(([page, icon, label]) => (
          <button
            key={page}
            className={`btn-ghost btn-icon rail-nav ${route.page === page ? 'active' : ''}`}
            title={label}
            aria-label={label}
            onClick={() => go({ page } as Route)}
          >
            <Icon name={icon} size={18} />
          </button>
        ))}
        <span className="me-avatar rail-me" title={who}>
          {(user?.email ?? 'R').slice(0, 1).toUpperCase()}
        </span>
      </aside>
    );
  }

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="navigation">
      <div className="side-top">
        <a
          className="brand grow"
          href="#/"
          onClick={(e) => {
            e.preventDefault();
            go({ page: 'home' });
          }}
        >
          <BrandMark className="brand-mark" />
          Reality
        </a>
        <button
          className="btn-ghost btn-icon"
          aria-label="New chat"
          title="New chat"
          onClick={onNewTask}
        >
          <Icon name="plus" size={18} />
        </button>
        {onToggle && (
          <button
            className="btn-ghost btn-icon side-collapse"
            aria-label="Collapse sidebar"
            title="Collapse sidebar (Ctrl B)"
            onClick={onToggle}
          >
            <Icon name="panel" size={17} />
          </button>
        )}
      </div>

      <label className="side-search">
        <Icon name="search" size={15} />
        <input
          ref={search}
          type="search"
          placeholder="Search"
          aria-label="Search bots and tasks"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <kbd title="Command palette">Ctrl K</kbd>
      </label>

      <nav className="task-list" aria-label="conversations">
        <>
          <ul aria-label="Your conversations">
            {leadChats.slice(0, 12).map((c) => {
              const crew = c.botIds
                .map((id) => byId.get(id))
                .filter((b): b is BotView => b !== undefined)
                .sort((a, b) => Number(b.isMain) - Number(a.isMain));
              const title = renamed[c.id] ?? (c.title || c.last || 'New chat');
              const firstBot = crew[0];
              const sub =
                c.botIds.length > 1
                  ? `${c.botIds.length} bots${c.last && c.last !== title ? ` · ${c.last}` : ''}`
                  : firstBot && !firstBot.isMain
                    ? `${firstBot.name} · direct`
                    : 'Your lead';
              const chatActive = route.page === 'chat' && route.id === c.id;
              return (
                <li key={c.id} className="chat-row">
                  <button
                    className={`bot-row ${chatActive ? 'selected' : ''}`}
                    aria-current={chatActive ? 'page' : undefined}
                    onClick={() => go({ page: 'chat', id: c.id })}
                    title={title}
                  >
                    {crew.length <= 1 ? (
                      <span className="bot-row-fig">
                        {crew[0] && <BotAvatar bot={crew[0]} size={40} />}
                      </span>
                    ) : (
                      <span className="fig-stack" aria-hidden>
                        {crew.slice(0, 3).map((b) => (
                          <span key={b.id} className="fig-stack-item">
                            <BotAvatar bot={b} size={23} showStatus={false} />
                          </span>
                        ))}
                        {crew.length > 3 && (
                          <span className="fig-stack-more">+{crew.length - 3}</span>
                        )}
                      </span>
                    )}
                    <span className="bot-row-text">
                      <span className="bot-row-name">
                        <span className="bot-row-title">{title}</span>
                      </span>
                      <span className="bot-row-line">{sub}</span>
                    </span>
                    <span className="meta">{relativeTime(c.updatedAt)}</span>
                  </button>
                  <button
                    className="chat-del"
                    aria-label="Chat options"
                    aria-expanded={menuChat === c.id}
                    title="Rename, change the bot or delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuChat(menuChat === c.id ? null : c.id);
                    }}
                  >
                    <span className="dots-glyph" aria-hidden>
                      •••
                    </span>
                  </button>
                  {menuChat === c.id && (
                    <div className="chat-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMenuChat(null);
                          const next = window.prompt('Rename this chat', title);
                          if (next?.trim() && next.trim() !== title) {
                            setRenamed((r) => ({ ...r, [c.id]: next.trim() }));
                            void api.renameChat(c.id, next.trim()).catch(() => undefined);
                          }
                        }}
                      >
                        <Icon name="edit" size={14} /> Rename chat
                      </button>
                      <button
                        role="menuitem"
                        className="danger"
                        onClick={() => {
                          setMenuChat(null);
                          if (!window.confirm('Delete this chat?')) return;
                          setGone((g) => [...g, c.id]);
                          void api.deleteChat(c.id).catch(() => undefined);
                          if (chatActive) go({ page: 'home' });
                        }}
                      >
                        <Icon name="x" size={14} /> Delete chat
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
            {leadChats.length > 12 && (
              <li className="bot-tasks-more">+{leadChats.length - 12} more</li>
            )}
          </ul>
          {teamLoaded && leadChats.length === 0 && !needle && (
            <p className="empty-list">No chats yet — start one with +.</p>
          )}
          {needle && leadChats.length === 0 && <p className="empty-list">Nothing matches “{q}”.</p>}
        </>
      </nav>

      <div className="sidebar-foot">
        {nav(
          'capabilities',
          'puzzle',
          'Capabilities',
          route.page === 'capabilities',
          capabilityCount !== null ? <span className="count">{capabilityCount}</span> : null,
        )}
        {nav('knowledge', 'book', 'Knowledge', route.page === 'knowledge')}
        {nav('pages', 'file', 'Pages', route.page === 'pages' || route.page === 'doc')}
        <div className="menu-anchor">
          <button
            className={`nav-link ${menu === 'more' ? 'active' : ''}`}
            aria-expanded={menu === 'more'}
            onClick={(e) => {
              e.stopPropagation();
              setMenu(menu === 'more' ? null : 'more');
            }}
          >
            <Icon name="menu" /> More
          </button>
          {menu === 'more' && (
            <div className="side-menu" role="menu">
              {nav('bots', 'user', 'Manage bots', route.page === 'bots')}
              {user?.role === 'admin' && nav('team', 'lock', 'Accounts', route.page === 'team')}
            </div>
          )}
        </div>

        <div className="menu-anchor">
          <button
            className="me-row"
            aria-expanded={menu === 'me'}
            onClick={(e) => {
              e.stopPropagation();
              setMenu(menu === 'me' ? null : 'me');
            }}
            title={health?.sandboxProblem ?? 'Sandbox ready'}
          >
            <span className="me-avatar">{(user?.email ?? 'R').slice(0, 1).toUpperCase()}</span>
            <span className="me-text">
              <span className="me-name">{who}</span>
              <span className="me-sub">
                <span
                  className={`dot tone-${health ? (health.sandboxProblem ? 'bad' : 'ok') : 'neutral'}`}
                />
                {health ? (health.sandboxProblem ? 'Sandbox problem' : 'Sandbox ready') : '…'}
              </span>
            </span>
            <Icon name="command" size={15} />
          </button>
          {menu === 'me' && (
            <div className="side-menu" role="menu" onClick={(e) => e.stopPropagation()}>
              <div className="theme-switch" role="group" aria-label="Theme">
                {(
                  [
                    ['light', 'sun', 'Light'],
                    ['system', 'monitor', 'System'],
                    ['dark', 'moon', 'Dark'],
                  ] as const
                ).map(([t, icon, label]) => (
                  <button
                    key={t}
                    aria-pressed={theme === t}
                    aria-label={`${t} theme`}
                    title={`${label} theme`}
                    onClick={() => setTheme(t)}
                  >
                    <Icon name={icon} size={14} /> {label}
                  </button>
                ))}
              </div>
              {onLogout && (
                <button className="nav-link" onClick={onLogout}>
                  <Icon name="logout" /> Sign out
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
