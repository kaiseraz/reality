import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { TaskSummary } from '@reality/schemas';
import { api, type Health } from './api.ts';
import { CommandPalette, type Command } from './CommandPalette.tsx';
import { Home, type StartRequest } from './Home.tsx';
import { Sidebar } from './Sidebar.tsx';
import { ChatView } from './chat/ChatView.tsx';
import { BrandMark, Icon } from './ui/Icon.tsx';
import { useRoute, useTheme } from './ui/hooks.ts';
import { WorkspaceView } from './workspace/WorkspaceView.tsx';

// Secondary pages load on first navigation, so the start screen and chats stay light.
// The demo path (home, task workspace, chat) above remains in the initial bundle.
const CapabilitiesPage = lazy(() =>
  import('./CapabilitiesPage.tsx').then((m) => ({ default: m.CapabilitiesPage })),
);
const TeamPage = lazy(() => import('./TeamPage.tsx').then((m) => ({ default: m.TeamPage })));
const BotPage = lazy(() => import('./bots/BotPage.tsx').then((m) => ({ default: m.BotPage })));
const BotsPage = lazy(() => import('./bots/BotsPage.tsx').then((m) => ({ default: m.BotsPage })));
const KnowledgePage = lazy(() =>
  import('./knowledge/KnowledgePage.tsx').then((m) => ({ default: m.KnowledgePage })),
);
const PagesPage = lazy(() =>
  import('./pages/PagesPage.tsx').then((m) => ({ default: m.PagesPage })),
);
const DocPage = lazy(() => import('./pages/DocPage.tsx').then((m) => ({ default: m.DocPage })));
const RoutinesPage = lazy(() =>
  import('./routines/RoutinesPage.tsx').then((m) => ({ default: m.RoutinesPage })),
);
const MissionsPage = lazy(() =>
  import('./missions/MissionsPage.tsx').then((m) => ({ default: m.MissionsPage })),
);
const InboxPage = lazy(() =>
  import('./projects/InboxPage.tsx').then((m) => ({ default: m.InboxPage })),
);
const NewProjectPage = lazy(() =>
  import('./projects/NewProjectPage.tsx').then((m) => ({ default: m.NewProjectPage })),
);
const ProjectPage = lazy(() =>
  import('./projects/ProjectPage.tsx').then((m) => ({ default: m.ProjectPage })),
);

/**
 * Shell: navigation and task list on the left; the start screen, a task's adaptive
 * workspace (composed from registry components via WorkspaceSpec patches) or the
 * capability library on the right.
 */
export function App({
  user,
  onLogout,
}: {
  user?: { email: string; role: 'admin' | 'member' } | null;
  onLogout?: (() => void) | undefined;
} = {}) {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [capabilityCount, setCapabilityCount] = useState<number | null>(null);

  const [inboxCount, setInboxCount] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('reality.sidebar') === 'collapsed';
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem('reality.sidebar', c ? 'open' : 'collapsed');
      } catch {
        // Storage unavailable: the choice lasts for this page only.
      }
      return !c;
    });
  }, []);
  const [focusKey, setFocusKey] = useState(0);
  const { route, go: goRoute } = useRoute();
  const go = useCallback(
    (r: Parameters<typeof goRoute>[0]) => {
      setDrawerOpen(false);
      goRoute(r);
    },
    [goRoute],
  );
  const theme = useTheme();

  const loadTasks = useCallback(() => {
    api
      .listTasks()
      .then((t) => setTasks(Array.isArray(t) ? t : []))
      .catch(() => undefined);
    api
      .inbox()
      .then((i) => setInboxCount(Array.isArray(i) ? i.length : 0))
      .catch(() => undefined);
  }, []);

  // Decisions waiting for you show in the browser tab, also when the app is in the background.
  useEffect(() => {
    document.title = inboxCount > 0 ? `(${inboxCount}) Reality` : 'Reality';
  }, [inboxCount]);

  useEffect(() => {
    // Polled, so the banner clears after a server restart instead of sticking.
    const poll = () => {
      api
        .health()
        .then((h) => {
          setHealth(h);
          setHealthError(null);
        })
        .catch((e: unknown) => setHealthError(e instanceof Error ? e.message : String(e)));
      loadTasks();
      api
        .capabilities()
        .then((c) =>
          setCapabilityCount(
            Array.isArray(c)
              ? c.filter((x) => x.state === 'enabled' || x.state === 'trusted').length
              : null,
          ),
        )
        .catch(() => undefined);
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  }, [loadTasks]);

  /** The one entry point: a fresh chat with the lead, which decides what the job needs. */
  const newTask = useCallback(() => {
    void (async () => {
      try {
        const bots = await api.bots();
        const lead = bots.find((b) => b.isMain) ?? bots[0];
        if (!lead) throw new Error('No lead bot yet.');
        const chat = await api.createChat('New chat', lead.id);
        go({ page: 'chat', id: chat.id });
      } catch {
        go({ page: 'home' });
        setFocusKey((k) => k + 1);
      }
    })();
  }, [go]);

  /**
   * A brand-new chat with the lead for a start-screen request. Never reuse an older
   * conversation here: the first message from Home belongs to a fresh chat, not to
   * whatever team the lead worked with before.
   */
  const freshLeadChat = useCallback(async () => {
    const bots = await api.bots();
    const lead = bots.find((b) => b.isMain) ?? bots[0];
    if (!lead) throw new Error('No lead bot yet. Reload in a moment.');
    return api.createChat('New chat', lead.id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      // Ctrl+B folds the sidebar, like Claude.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);

  const start = async ({ request, file, sample }: StartRequest) => {
    // An uploaded file still takes the direct data path: create a draft, attach the
    // data, then start, so planning sees the schema. Everything else is a message to
    // the lead, which answers or turns it into a checked job with a plan.
    if (file) {
      const task = await api.createTask(request, false);
      await api.uploadCsv(task.id, file);
      await api.startTask(task.id);
      loadTasks();
      go({ page: 'task', id: task.id });
      return;
    }
    const chat = await freshLeadChat();
    await api.sendChat(chat.id, request, sample);
    loadTasks();
    go({ page: 'chat', id: chat.id });
  };

  const actions = useMemo<Command[]>(
    () => [
      { id: 'new', group: 'Actions', label: 'New chat with your lead', icon: 'plus', run: newTask },
      {
        id: 'bots',
        group: 'Actions',
        label: 'Manage bots',
        icon: 'user',
        run: () => go({ page: 'bots' }),
      },
      {
        id: 'knowledge',
        group: 'Actions',
        label: 'Open knowledge and literature',
        icon: 'book',
        run: () => go({ page: 'knowledge' }),
      },
      {
        id: 'pages',
        group: 'Actions',
        label: 'Open pages',
        icon: 'file',
        run: () => go({ page: 'pages' }),
      },
      {
        id: 'caps',
        group: 'Actions',
        label: 'Open capability library',
        icon: 'puzzle',
        run: () => go({ page: 'capabilities' }),
      },
      {
        id: 'theme',
        group: 'Actions',
        label: `Switch to ${theme.resolved === 'dark' ? 'light' : 'dark'} theme`,
        icon: theme.resolved === 'dark' ? 'sun' : 'moon',
        run: () => theme.setPref(theme.resolved === 'dark' ? 'light' : 'dark'),
      },
    ],
    [newTask, go, theme],
  );

  return (
    <div className={`app ${collapsed ? 'collapsed' : ''}`}>
      <header className="topbar">
        <button
          className="btn-ghost btn-icon"
          aria-label="Open navigation"
          onClick={() => setDrawerOpen(true)}
        >
          <Icon name="menu" />
        </button>
        <a className="brand grow" href="#/">
          <BrandMark className="brand-mark" /> Reality
        </a>
        <button className="btn-ghost btn-icon" aria-label="New chat" onClick={newTask}>
          <Icon name="plus" />
        </button>
      </header>
      {drawerOpen && <div className="scrim" onClick={() => setDrawerOpen(false)} />}
      <Sidebar
        route={route}
        go={go}
        onNewTask={newTask}
        health={health}
        theme={theme.pref}
        setTheme={theme.setPref}
        capabilityCount={capabilityCount}
        open={drawerOpen}
        user={user}
        onLogout={onLogout}
        collapsed={collapsed}
        onToggle={toggleSidebar}
      />
      <main className="main">
        <Suspense fallback={<div className="empty">Loading…</div>}>
          {route.page === 'task' ? (
            <WorkspaceView
              key={route.id}
              taskId={route.id}
              onEvent={loadTasks}
              onFollowUp={async (request) => {
                const next = await api.followUp(route.id, request);
                loadTasks();
                go({ page: 'task', id: next.id });
              }}
            />
          ) : route.page === 'project' ? (
            <ProjectPage
              key={route.id}
              id={route.id}
              openTask={(id) => go({ page: 'task', id })}
              onChanged={loadTasks}
            />
          ) : route.page === 'new-project' ? (
            <NewProjectPage
              onCreated={(id) => {
                loadTasks();
                go({ page: 'project', id });
              }}
            />
          ) : route.page === 'inbox' ? (
            <InboxPage
              openTask={(id) => go({ page: 'task', id })}
              openProject={(id) => go({ page: 'project', id })}
              onChanged={loadTasks}
            />
          ) : route.page === 'pages' ? (
            <PagesPage openPage={(id) => go({ page: 'doc', id })} />
          ) : route.page === 'doc' ? (
            <DocPage
              key={route.id}
              id={route.id}
              openTask={(id) => go({ page: 'task', id })}
              onRemoved={() => go({ page: 'pages' })}
            />
          ) : route.page === 'routines' ? (
            <RoutinesPage
              openTask={(id) => {
                loadTasks();
                go({ page: 'task', id });
              }}
              openPage={(id) => go({ page: 'doc', id })}
            />
          ) : route.page === 'knowledge' ? (
            <KnowledgePage />
          ) : route.page === 'bots' ? (
            <BotsPage
              openBot={(id) => go({ page: 'bot', id })}
              openChat={(id) => go({ page: 'chat', id })}
            />
          ) : route.page === 'missions' ? (
            <MissionsPage openChat={(id) => go({ page: 'chat', id })} />
          ) : route.page === 'chat' ? (
            <ChatView key={route.id} chatId={route.id} />
          ) : route.page === 'bot' ? (
            <BotPage
              key={route.id}
              id={route.id}
              openTask={(id) => {
                loadTasks();
                go({ page: 'task', id });
              }}
              onRemoved={() => go({ page: 'bots' })}
            />
          ) : route.page === 'capabilities' ? (
            <CapabilitiesPage />
          ) : route.page === 'team' && user?.role === 'admin' ? (
            <TeamPage />
          ) : (
            <Home health={health} healthError={healthError} onStart={start} focusKey={focusKey} />
          )}
        </Suspense>
      </main>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        tasks={tasks}
        actions={actions}
        openTask={(id) => go({ page: 'task', id })}
      />
    </div>
  );
}
