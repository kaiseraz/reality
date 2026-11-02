import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  DockviewReact,
  themeDark,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type SerializedDockview,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import type { BotView, TaskEvent, WorkspaceSpec } from '@reality/schemas';
import { api, isProjectRef, ApiError, type TaskDetail } from '../api.ts';
import { makeEmit, useWorkspace, WorkspaceContext, type WorkspaceData } from './context.ts';
import { planPanels, regionOf } from './reconcile.ts';
import { RENDERERS } from './renderers.ts';
import { TaskHeader } from './TaskHeader.tsx';
import { Thread } from './Thread.tsx';
import { BrandMark, Icon } from '../ui/Icon.tsx';
import { statusOf } from '../ui/status.ts';
import { useResolvedTheme } from '../ui/hooks.ts';

const LAYOUT_SAVE_DELAY_MS = 800;
const USER_INPUT_WINDOW_MS = 1000;

function InstancePanel(props: IDockviewPanelProps<{ instanceId: string }>) {
  const ws = useWorkspace();
  const id = props.params.instanceId;
  const instance = ws.spec.components[id];
  const emit = useMemo(
    () => (instance ? makeEmit(id, instance, ws.sendAction) : null),
    [id, instance, ws.sendAction],
  );
  if (!instance || !emit) return null; // being removed
  const Renderer = RENDERERS[instance.type];
  if (!Renderer) return <p role="alert">No renderer for {instance.type}.</p>;
  return (
    <div className="panel" data-instance={id} title={`Added by ${instance.provenance.proposedBy}`}>
      <Renderer instanceId={id} instance={instance} emit={emit} />
    </div>
  );
}

const PANEL_COMPONENTS = { instance: InstancePanel };

function Dock({
  spec,
  onUserLayout,
}: {
  spec: WorkspaceSpec;
  onUserLayout: (layout: unknown) => void;
}) {
  const dock = useRef<DockviewApi | null>(null);
  const theme = useResolvedTheme();
  // Dockview reports layout changes asynchronously, so a "programmatic" flag cannot tell
  // automatic placement from user arrangement. Only persist after real user input.
  const lastInput = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const specRef = useRef(spec);
  // Declared before the reconcile effect below, so it runs first on every commit.
  useEffect(() => {
    specRef.current = spec;
  }, [spec]);

  const reconcile = useCallback(() => {
    const d = dock.current;
    if (!d) return;
    const plan = planPanels(
      d.panels.map((p) => p.id),
      specRef.current,
    );
    for (const id of plan.remove) {
      const panel = d.getPanel(id);
      if (panel) d.removePanel(panel);
    }
    for (const p of plan.add) {
      d.addPanel({
        id: p.id,
        component: 'instance',
        title: p.title,
        params: { instanceId: p.id },
        ...(p.position && d.getPanel(p.position.referencePanel) ? { position: p.position } : {}),
      });
    }
    // When the side column is first created, keep it narrow so results get the space.
    // Later user resizes are never overridden (only panels added in this batch count).
    const anchor = plan.add.find((p) => regionOf(specRef.current, p.id) === 'side' && !p.position);
    if (anchor && d.width > 0) {
      d.getPanel(anchor.id)?.group.api.setSize({ width: Math.round(Math.min(420, d.width * 0.3)) });
    }
    for (const r of plan.retitle) {
      const panel = d.getPanel(r.id);
      if (panel && panel.title !== r.title) panel.api.setTitle(r.title);
    }
  }, []);

  const onReady = (event: DockviewReadyEvent) => {
    dock.current = event.api;
    if (specRef.current.layout) {
      try {
        event.api.fromJSON(specRef.current.layout as SerializedDockview);
      } catch {
        event.api.clear(); // stale or invalid layout: fall back to placement rules
      }
    }
    reconcile();
    event.api.onDidLayoutChange(() => {
      // Only changes that follow user input closely (a drag ends in pointerup) count.
      if (Date.now() - lastInput.current > USER_INPUT_WINDOW_MS) return;
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => onUserLayout(event.api.toJSON()), LAYOUT_SAVE_DELAY_MS);
    });
  };

  useEffect(reconcile, [spec, reconcile]);
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const touched = () => {
    lastInput.current = Date.now();
  };
  return (
    <div
      className="dock"
      onPointerDownCapture={touched}
      onPointerUpCapture={touched}
      onKeyDownCapture={touched}
    >
      <DockviewReact
        components={PANEL_COMPONENTS}
        onReady={onReady}
        theme={theme === 'dark' ? themeDark : themeLight}
      />
    </div>
  );
}

const VIEW_KEY = 'reality.taskView';
function savedView(): 'thread' | 'workspace' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'workspace' ? 'workspace' : 'thread';
  } catch {
    return 'thread';
  }
}

/**
 * A task: by default as a conversation (question, plan, decision, results, checks); on demand
 * as the full adaptive workspace composed from registry components.
 */
export function WorkspaceView({
  taskId,
  onEvent,
  onFollowUp,
}: {
  taskId: string;
  onEvent?: () => void;
  /** Starts a new task on the same data and opens it. */
  onFollowUp?: (request: string) => Promise<void>;
}) {
  const [view, setView] = useState<'thread' | 'workspace'>(savedView);
  const switchView = (v: 'thread' | 'workspace') => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Not persisted: fine.
    }
  };
  const [project, setProject] = useState<{ id: string; goal: string } | null>(null);
  const [bot, setBot] = useState<BotView | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .taskProject(taskId)
      .then((p) => !cancelled && setProject(isProjectRef(p) ? p : null))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [taskId]);
  const [spec, setSpec] = useState<WorkspaceSpec | null>(null);
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const versionRef = useRef(0);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  const loadSpec = useCallback(async () => {
    const s = await api.getWorkspace(taskId);
    versionRef.current = s.version;
    setSpec(s);
  }, [taskId]);

  useEffect(() => {
    let cancelled = false;
    const fail = (e: unknown) => {
      if (!cancelled) setNotice(e instanceof Error ? e.message : String(e));
    };
    // Results are dropped once this task view is gone (task switched or unmounted).
    const refreshSpec = () =>
      api
        .getWorkspace(taskId)
        .then((s) => {
          if (cancelled) return;
          versionRef.current = s.version;
          setSpec(s);
        })
        .catch(fail);
    const refreshTask = () =>
      api
        .getTask(taskId)
        .then((t) => {
          if (!cancelled) setTask(t);
        })
        .catch(fail);

    void refreshSpec();
    void refreshTask();
    const unsubscribe = api.subscribe(taskId, (event) => {
      setEvents((prev) => (prev.some((e) => e.id === event.id) ? prev : [...prev, event]));
      if (event.type.startsWith('workspace.') || event.type === 'artifact.added') {
        void refreshSpec();
      }
      void refreshTask();
      onEventRef.current?.();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [taskId]);

  const workspaceId = spec?.id;
  const sendAction = useCallback<WorkspaceData['sendAction']>(
    async (instanceId, actionId, payload) => {
      if (!workspaceId) return;
      await api.action(workspaceId, instanceId, actionId, payload);
    },
    [workspaceId],
  );

  const saveLayout = useCallback(
    (layout: unknown) => {
      if (!workspaceId) return;
      const attempt = (retry: boolean): Promise<void> =>
        api
          .patchWorkspace(workspaceId, versionRef.current, [{ op: 'setLayout', layout }])
          .then((s) => {
            versionRef.current = s.version;
          })
          .catch(async (e: unknown) => {
            // Someone else patched first: catch up and try once more.
            if (retry && e instanceof ApiError && e.status === 422) {
              await loadSpec();
              return attempt(false);
            }
          });
      void attempt(true);
    },
    [workspaceId, loadSpec],
  );

  const undo = async () => {
    if (!workspaceId) return;
    setNotice(null);
    try {
      await api.undo(workspaceId);
    } catch (e) {
      setNotice(e instanceof ApiError && e.status === 409 ? 'Nothing to undo.' : String(e));
    }
  };

  const attach = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.uploadCsv(taskId, file);
    } catch (err) {
      setNotice(err instanceof Error ? `Upload failed: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  };

  const botId = task?.botId ?? null;
  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    api
      .bot(botId)
      .then((b) => !cancelled && setBot(b))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [botId, task?.status]);

  const ctx = useMemo<WorkspaceData | null>(
    () => (spec ? { spec, task, events, sendAction } : null),
    [spec, task, events, sendAction],
  );

  if (!ctx || !spec) return <p className="pad">{notice ?? 'Loading…'}</p>;

  if (view === 'thread') {
    const s = statusOf(task?.status ?? 'draft');
    return (
      <section className="workspace" aria-label="task">
        <header className="thread-bar">
          <div className="grow" style={{ minWidth: 0 }}>
            {project && (
              <a className="crumb" href={`#/project/${project.id}`}>
                <Icon name="folder" size={12} /> {project.goal.split(String.fromCharCode(10))[0]}
              </a>
            )}
            <div className="title" title={task?.request}>
              {task?.request ?? ''}
            </div>
          </div>
          <span className={`pill tone-${s.tone}`} data-testid="status" data-status={task?.status}>
            {task ? s.label : '…'}
          </span>
          <button className="btn-ghost" onClick={() => switchView('workspace')}>
            <Icon name="layout" /> <span className="hide-sm">Workspace</span>
          </button>
        </header>
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        <WorkspaceContext.Provider value={ctx}>
          <Thread
            ctx={ctx}
            bot={bot}
            onFollowUp={async (request) => {
              if (onFollowUp) await onFollowUp(request);
            }}
            openWorkspace={() => switchView('workspace')}
          />
        </WorkspaceContext.Provider>
      </section>
    );
  }

  return (
    <section className="workspace" aria-label="workspace">
      <div className="thread-bar">
        <button className="btn-ghost" onClick={() => switchView('thread')}>
          <BrandMark className="brand-mark" /> Back to conversation
        </button>
      </div>
      <TaskHeader
        task={task}
        events={events}
        version={spec.version}
        busy={busy}
        onAttach={(e) => void attach(e)}
        onUndo={() => void undo()}
      />
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <WorkspaceContext.Provider value={ctx}>
        <Dock spec={spec} onUserLayout={saveLayout} />
      </WorkspaceContext.Provider>
    </section>
  );
}
