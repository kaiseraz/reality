import type {
  BoardTask,
  BoardTaskStatus,
  BotView,
  ChatCard,
  ChatState,
  ChatSummary,
  CreateBotRequest,
  CreateProjectRequest,
  ProjectSummary,
  ProjectTask,
  TaskEvent,
  TaskSpec,
  TaskStatus,
  TaskSummary,
  WorkspacePatchOp,
  WorkspaceSpec,
} from '@reality/schemas';
import type { Column } from '@reality/workspace';

export interface Health {
  status: 'ok';
  configured: { database: boolean; llm: boolean };
  planner: 'anthropic' | 'meta' | 'rules' | 'fake';
  sandboxProblem: string | null;
}

export interface KnowledgeSource {
  id: string;
  kind: 'note' | 'url' | 'file';
  name: string;
  url: string | null;
  status: 'ready' | 'empty' | 'failed';
  error: string | null;
  passages: number;
  words: number;
  createdAt: string;
}

export interface KnowledgeHit {
  sourceId: string;
  source: string;
  line: number;
  text: string;
  score: number;
}

export interface Work {
  title: string;
  year: number | null;
  authors: string;
  venue: string | null;
  citedBy: number;
  doi: string | null;
  url: string | null;
  abstract: string;
}

export interface MissionCriterionInput {
  field: string;
  min?: number;
  max?: number;
  target?: number;
  tolerancePercent?: number;
  equals?: string;
}

export interface Mission {
  id: string;
  chatId: string;
  goal: string;
  status: 'running' | 'finished' | 'failed' | 'stopped' | 'timeout' | 'out_of_budget';
  verdict: string | null;
  summary: string | null;
  reportPageId: string | null;
  hours: number;
  maxTasks: number;
  autoApprove: boolean;
  startedAt: string;
  endsAt: string;
  finishedAt: string | null;
  tasksUsed: number;
  /** Cost budget in costUnit (credits, €), or null for none. */
  costBudget: number | null;
  spent: number;
  costUnit: string;
  allowInstalls: string[];
  allowDomains: string[];
  rounds: number;
  maxRounds: number;
  /** Decisions waiting for you: plans or installs outside the frame, questions. */
  openDecisions: string[];
  liveVerdict: string;
  criteria: {
    id: string;
    field: string;
    expected: string;
    status: 'met' | 'missed' | 'open' | 'not_checkable';
    actual: unknown;
    evidenceId: string | null;
  }[];
  journal: { text: string; at: string }[];
}

export interface PageSummary {
  id: string;
  title: string;
  version: number;
  author: string;
  change: string;
  chars: number;
  createdAt: string;
  updatedAt: string;
}

export interface PageVersionInfo {
  version: number;
  author: string;
  change: string;
  chars: number;
  taskId: string | null;
  createdAt: string;
}

export interface PageDetail extends PageSummary {
  content: string;
  versions: PageVersionInfo[];
}

export type Schedule =
  | { type: 'daily'; time: string }
  | { type: 'weekdays'; time: string }
  | { type: 'weekly'; time: string; day: number }
  | { type: 'interval'; minutes: number };

export interface RoutineInput {
  name: string;
  request: string;
  schedule: Schedule;
  sample: string | null;
  botId: string | null;
  pageId: string | null;
  autoApprove: boolean;
  enabled: boolean;
}

export interface Routine extends RoutineInput {
  id: string;
  nextRun: string | null;
  lastRun: string | null;
  createdAt: string;
  runs: {
    taskId: string;
    status: TaskStatus;
    startedAt: string;
    handled: string | null;
    note: string | null;
  }[];
}

export interface StepResult {
  stepId: string;
  status: 'done' | 'failed' | 'not_executed' | 'skipped';
  detail: string;
  runId?: string;
  artifacts?: string[];
  summary?: unknown;
}

export interface RunRecord {
  id: string;
  stepId: string | null;
  kind: string;
  label: string;
  code: string;
  image: string;
  status: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  createdAt: string;
}

export interface CheckResult {
  criterionId: string;
  status: 'passed' | 'failed' | 'unverified';
  detail: string;
  runId?: string;
  evidence?: unknown;
}

export interface TaskDetail extends TaskSummary {
  status: TaskStatus;
  state: {
    spec?: TaskSpec | null;
    stepResults?: StepResult[];
    verification?: CheckResult[];
    error?: string | null;
    budget?: { modelCalls: number; maxModelCalls: number; steps: number };
  } | null;
  pendingApproval: unknown;
}

export type Cell = string | number | null;
export interface RowsPage {
  columns: Column[];
  total: number;
  offset: number;
  rows: Record<string, Cell>[];
}

export interface CapabilityRecord {
  id: string;
  need: string;
  kind: 'python-package' | 'mcp-server';
  package: string;
  version: string | null;
  state: 'discovered' | 'inspected' | 'tested' | 'enabled' | 'trusted' | 'rejected';
  license: string | null;
  tests: { name: string; description: string; passed: boolean; result: unknown }[] | null;
  permissions: { network: string; mount: string; path: string };
  limitations: string[];
  uses: number;
  history: { at: string; from: string | null; to: string; reason: string }[];
  updatedAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  planner: string;
  tasks: ProjectTask[];
  files: { id: string; filename: string; rowCount: number; columnNames: string[] }[];
  usage: { tasksStarted: number; sandboxMinutes: number };
  events: { id: number; type: string; actor: string; payload: unknown; createdAt: string }[];
}

export interface InboxItem {
  taskId: string;
  request: string;
  since: string;
  kind: string;
  summary: string;
  project: { id: string; goal: string } | null;
  /** Why the project policy left this decision to you. */
  reason: string | null;
}

export interface CriterionInput {
  field: string;
  step?: string;
  min?: number;
  max?: number;
  target?: number;
  tolerance?: number;
  tolerancePercent?: number;
  equals?: string;
  contains?: string;
}

export interface CriteriaState {
  locked: boolean;
  verdict: 'verified' | 'partial' | 'not_verified' | 'refuted' | 'no_criteria';
  criteria: (CriterionInput & {
    id: string;
    status: 'met' | 'missed' | 'open' | 'not_checkable';
    actual: number | string | boolean | null;
    evidenceId: string | null;
    expected: string;
  })[];
  evidence: { id: string; stepId: string; values: Record<string, number | string | boolean> }[];
  fields: { recipe: string; field: string; label: string; kind: 'number' | 'text' }[];
  unbacked: Record<string, string[]>;
}

/** A project reference as the server sends it; anything else is treated as no project. */
export function isProjectRef(p: unknown): p is { id: string; goal: string } {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as { id?: unknown }).id === 'string' &&
    typeof (p as { goal?: unknown }).goal === 'string'
  );
}

export interface Me {
  authEnabled: boolean;
  setupRequired: boolean;
  user: { id: string; email: string; role: 'admin' | 'member' } | null;
}

export interface Account {
  id: string;
  email: string;
  role: 'admin' | 'member';
  createdAt: string;
}

export interface Sample {
  id: string;
  title: string;
  description: string;
  question: string;
  source: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  if (res.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('reality-unauthenticated'));
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
      errors?: string[];
    };
    throw new ApiError(
      res.status,
      body.message ?? body.errors?.join('; ') ?? body.error ?? `HTTP ${res.status}`,
      body.errors,
    );
  }
  return (await res.json()) as T;
}

/** A bot's own computer: whether it runs, what it may reach, its files and history. */
export interface ComputerView {
  botId: string;
  running: boolean;
  imageReady: boolean;
  allowed: string[];
  files: { path: string; size: number; dir: boolean }[];
  history: {
    id: number;
    kind: string;
    summary: string;
    detail: Record<string, unknown>;
    at: string;
  }[];
}

export interface FolderStatus {
  path: string | null;
  files: { path: string; size: number; state: 'copied' | 'beside-yours' | 'too-big' | 'waiting' }[];
}

export interface FolderListing {
  path: string;
  parent: string | null;
  dirs: string[];
  roots: { name: string; path: string }[];
}

const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

export const api = {
  me: () => fetch('/api/auth/me').then((r) => json<Me>(r)),
  setup: (email: string, password: string) =>
    post('/api/auth/setup', { email, password }).then((r) => json<unknown>(r)),
  login: (email: string, password: string) =>
    post('/api/auth/login', { email, password }).then((r) => json<unknown>(r)),
  logout: () => post('/api/auth/logout').then((r) => json<unknown>(r)),
  users: () => fetch('/api/auth/users').then((r) => json<Account[]>(r)),
  addUser: (email: string, password: string, role: 'admin' | 'member') =>
    post('/api/auth/users', { email, password, role }).then((r) => json<Account>(r)),
  health: () => fetch('/api/health').then((r) => json<Health>(r)),
  projects: () => fetch('/api/projects').then((r) => json<ProjectSummary[]>(r)),
  /** A task's lab results as cards (charts, CAD, facts). */
  labCards: (id: string) => fetch(`/api/tasks/${id}/lab`).then((r) => json<ChatCard[]>(r)),
  project: (id: string) => fetch(`/api/projects/${id}`).then((r) => json<ProjectDetail>(r)),
  createProject: (body: Partial<CreateProjectRequest> & { goal: string }) =>
    post('/api/projects', body).then((r) => json<ProjectDetail>(r)),
  addProjectFile: async (id: string, file: File) =>
    fetch(`/api/projects/${id}/files?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: await file.text(),
    }).then((r) => json<unknown>(r)),
  addProjectTask: (
    id: string,
    t: { request: string; title?: string; dependsOn: string[]; inputFrom?: string },
  ) => post(`/api/projects/${id}/tasks`, t).then((r) => json<{ taskId: string }>(r)),
  pauseProject: (id: string) => post(`/api/projects/${id}/pause`).then((r) => json<unknown>(r)),
  resumeProject: (id: string) => post(`/api/projects/${id}/resume`).then((r) => json<unknown>(r)),
  inbox: () => fetch('/api/inbox').then((r) => json<InboxItem[]>(r)),
  bots: () => fetch('/api/bots').then((r) => json<BotView[]>(r)),
  bot: (id: string) =>
    fetch(`/api/bots/${id}`).then((r) => json<BotView & { tasks: TaskSummary[] }>(r)),
  createBot: (body: CreateBotRequest) => post('/api/bots', body).then((r) => json<BotView>(r)),
  deleteBot: (id: string) =>
    fetch(`/api/bots/${id}`, { method: 'DELETE' }).then((r) => json<unknown>(r)),
  missions: () => fetch('/api/missions').then((r) => json<Mission[]>(r)),
  mission: (id: string) => fetch(`/api/missions/${id}`).then((r) => json<Mission>(r)),
  missionFields: () =>
    fetch('/api/missions/fields').then((r) =>
      json<Record<string, { field: string; label: string; kind: 'number' | 'text' }[]>>(r),
    ),
  createMission: (body: {
    goal: string;
    botIds: string[];
    criteria: MissionCriterionInput[];
    hours: number;
    maxTasks: number;
    autoApprove: boolean;
    costBudget?: number;
    allowInstalls: string[];
    allowDomains: string[];
    maxRounds: number;
  }) => post('/api/missions', body).then((r) => json<Mission>(r)),
  /** The unit model costs are counted in (credits, €, or k tokens without prices). */
  missionPricing: () => fetch('/api/missions/pricing').then((r) => json<{ unit: string }>(r)),
  stopMission: (id: string) => post(`/api/missions/${id}/stop`).then((r) => json<Mission>(r)),
  chatMission: (chatId: string) =>
    fetch(`/api/chats/${chatId}/mission`).then((r) => (r.status === 404 ? null : json<Mission>(r))),
  chats: () => fetch('/api/chats').then((r) => json<ChatSummary[]>(r)),
  chatFolder: (id: string) => fetch(`/api/chats/${id}/folder`).then((r) => json<FolderStatus>(r)),
  setChatFolder: (id: string, path: string) =>
    fetch(`/api/chats/${id}/folder`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then((r) => json<{ path: string }>(r)),
  openChatFolder: (id: string) =>
    post(`/api/chats/${id}/folder/open`).then((r) => json<unknown>(r)),
  folders: (path?: string) =>
    fetch(`/api/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`).then((r) =>
      json<FolderListing>(r),
    ),
  chat: (id: string) => fetch(`/api/chats/${id}`).then((r) => json<ChatState>(r)),
  computers: () => fetch('/api/computers').then((r) => json<{ running: string[] }>(r)),
  computer: (botId: string) =>
    fetch(`/api/bots/${botId}/computer`).then((r) => json<ComputerView>(r)),
  startComputer: (botId: string) =>
    post(`/api/bots/${botId}/computer/start`).then((r) => json<unknown>(r)),
  stopComputer: (botId: string) =>
    post(`/api/bots/${botId}/computer/stop`).then((r) => json<unknown>(r)),
  /** The person holds this bot's desktop; its running chat turn pauses. */
  takeOverDesktop: (chatId: string, botId: string) =>
    post(`/api/chats/${chatId}/takeover/${botId}`).then((r) => json<ChatState>(r)),
  /** Back to the bot, with what was done or what comes next. */
  handBackDesktop: (chatId: string, botId: string, note?: string) =>
    post(`/api/chats/${chatId}/handback/${botId}`, note ? { note } : {}).then((r) =>
      json<ChatState>(r),
    ),
  allowDomain: (botId: string, domain: string) =>
    post(`/api/bots/${botId}/computer/access`, { domain }).then((r) => json<unknown>(r)),
  revokeDomain: (botId: string, domain: string) =>
    fetch(`/api/bots/${botId}/computer/access/${encodeURIComponent(domain)}`, {
      method: 'DELETE',
    }).then((r) => json<unknown>(r)),
  botChat: (botId: string) => fetch(`/api/bots/${botId}/chat`).then((r) => json<ChatState>(r)),
  createGroup: (title: string, botIds: string[]) =>
    post('/api/chats', { title, botIds }).then((r) => json<ChatState>(r)),
  /** Another direct chat with one bot (e.g. a fresh conversation with the lead). */
  createChat: (title: string, botId: string) =>
    post('/api/chats', { title, botIds: [botId], kind: 'dm' }).then((r) => json<ChatState>(r)),
  attachChatFile: (id: string, file: File) =>
    fetch(`/api/chats/${id}/files?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    }).then((r) => json<ChatState>(r)),
  sendChat: (id: string, text: string, sample?: string) =>
    post(`/api/chats/${id}/messages`, sample ? { text, sample } : { text }).then((r) =>
      json<ChatState>(r),
    ),
  answerChat: (id: string, messageId: number, answer: string) =>
    post(`/api/chats/${id}/answers/${messageId}`, { answer }).then((r) => json<ChatState>(r)),
  decideChatPlan: (
    id: string,
    taskId: string,
    approved: boolean,
    secrets?: Record<string, string>,
  ) =>
    post(`/api/chats/${id}/plans/${taskId}`, { approved, ...(secrets ? { secrets } : {}) }).then(
      (r) => json<ChatState>(r),
    ),
  updateBoardTask: (
    id: string,
    taskId: number,
    body: { status?: BoardTaskStatus; ownerBot?: string; title?: string },
  ) =>
    fetch(`/api/chats/${id}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<BoardTask>(r)),
  renameChat: (id: string, title: string) =>
    fetch(`/api/chats/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }).then((r) => json<ChatState>(r)),
  updateBot: (id: string, body: { figure?: string; color?: string }) =>
    fetch(`/api/bots/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<BotView>(r)),
  stopChat: (id: string) => post(`/api/chats/${id}/stop`).then((r) => json<unknown>(r)),
  deleteChat: (id: string) =>
    fetch(`/api/chats/${id}`, { method: 'DELETE' }).then((r) => json<unknown>(r)),
  pages: () => fetch('/api/pages').then((r) => json<PageSummary[]>(r)),
  page: (id: string) => fetch(`/api/pages/${id}`).then((r) => json<PageDetail>(r)),
  pageVersion: (id: string, version: number) =>
    fetch(`/api/pages/${id}/versions/${version}`).then((r) =>
      json<PageVersionInfo & { content: string }>(r),
    ),
  createPage: (title: string, content = '') =>
    post('/api/pages', { title, content }).then((r) => json<PageDetail>(r)),
  savePage: (
    id: string,
    body: { content: string; title?: string; change?: string; baseVersion: number },
  ) =>
    fetch(`/api/pages/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<PageDetail>(r)),
  restorePage: (id: string, version: number) =>
    post(`/api/pages/${id}/restore`, { version }).then((r) => json<PageDetail>(r)),
  deletePage: (id: string) =>
    fetch(`/api/pages/${id}`, { method: 'DELETE' }).then((r) => json<unknown>(r)),
  taskToPage: (taskId: string, body: { pageId?: string; title?: string }) =>
    post(`/api/tasks/${taskId}/page`, body).then((r) => json<PageDetail>(r)),
  routines: () => fetch('/api/routines').then((r) => json<Routine[]>(r)),
  createRoutine: (body: RoutineInput) => post('/api/routines', body).then((r) => json<Routine>(r)),
  updateRoutine: (id: string, body: Partial<RoutineInput>) =>
    fetch(`/api/routines/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<Routine>(r)),
  deleteRoutine: (id: string) =>
    fetch(`/api/routines/${id}`, { method: 'DELETE' }).then((r) => json<unknown>(r)),
  runRoutine: (id: string) =>
    post(`/api/routines/${id}/run`).then((r) => json<{ taskId: string }>(r)),
  knowledge: () => fetch('/api/knowledge').then((r) => json<KnowledgeSource[]>(r)),
  addKnowledge: (
    body:
      | { kind: 'note'; name: string; text: string }
      | { kind: 'url'; url: string; name?: string }
      | { kind: 'file'; name: string; text: string },
  ) => post('/api/knowledge', body).then((r) => json<KnowledgeSource>(r)),
  deleteKnowledge: (id: string) =>
    fetch(`/api/knowledge/${id}`, { method: 'DELETE' }).then((r) => json<unknown>(r)),
  searchKnowledge: (q: string) =>
    fetch(`/api/knowledge/search?q=${encodeURIComponent(q)}`).then((r) => json<KnowledgeHit[]>(r)),
  literature: (q: string) =>
    fetch(`/api/literature?q=${encodeURIComponent(q)}`).then((r) => json<Work[]>(r)),
  criteria: (taskId: string) =>
    fetch(`/api/tasks/${taskId}/criteria`).then((r) => json<CriteriaState>(r)),
  addCriterion: (taskId: string, c: CriterionInput) =>
    post(`/api/tasks/${taskId}/criteria`, c).then((r) => json<{ id: string }>(r)),
  removeCriterion: (taskId: string, id: string) =>
    fetch(`/api/tasks/${taskId}/criteria/${id}`, { method: 'DELETE' }).then((r) =>
      json<unknown>(r),
    ),
  followUp: (taskId: string, request: string) =>
    post(`/api/tasks/${taskId}/follow-up`, { request }).then((r) => json<TaskSummary>(r)),
  taskProject: (id: string) =>
    fetch(`/api/tasks/${id}/project`).then((r) => json<{ id: string; goal: string } | null>(r)),
  listTasks: () => fetch('/api/tasks').then((r) => json<TaskSummary[]>(r)),
  getTask: (id: string) => fetch(`/api/tasks/${id}`).then((r) => json<TaskDetail>(r)),
  createTask: (request: string, start = true, botId?: string) =>
    post('/api/tasks', { request, start, ...(botId ? { botId } : {}) }).then((r) =>
      json<TaskSummary>(r),
    ),
  startTask: (id: string) =>
    post(`/api/tasks/${id}/start`).then((r) => json<{ accepted: true }>(r)),
  capabilities: () => fetch('/api/capabilities').then((r) => json<CapabilityRecord[]>(r)),
  samples: () => fetch('/api/samples').then((r) => json<Sample[]>(r)),
  attachSample: (taskId: string, sampleId: string) =>
    post(`/api/tasks/${taskId}/samples/${encodeURIComponent(sampleId)}`).then((r) =>
      json<unknown>(r),
    ),
  runs: (taskId: string) => fetch(`/api/tasks/${taskId}/runs`).then((r) => json<RunRecord[]>(r)),
  decide: (id: string, approved: boolean) =>
    post(`/api/tasks/${id}/approval`, { approved }).then((r) => json<{ accepted: true }>(r)),
  history: (id: string) => fetch(`/api/tasks/${id}/history`).then((r) => json<TaskEvent[]>(r)),

  getWorkspace: (taskId: string) =>
    fetch(`/api/tasks/${taskId}/workspace`).then((r) => json<WorkspaceSpec>(r)),
  patchWorkspace: (id: string, baseVersion: number, ops: WorkspacePatchOp[]) =>
    post(`/api/workspaces/${id}/patches`, { baseVersion, ops }).then((r) => json<WorkspaceSpec>(r)),
  undo: (id: string) => post(`/api/workspaces/${id}/undo`).then((r) => json<WorkspaceSpec>(r)),
  action: (id: string, instanceId: string, actionId: string, payload: unknown) =>
    post(`/api/workspaces/${id}/actions`, { instanceId, actionId, payload }).then((r) =>
      json<{ accepted: true }>(r),
    ),

  uploadCsv: async (taskId: string, file: File) =>
    fetch(`/api/tasks/${taskId}/artifacts?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: await file.text(),
    }).then((r) => json<unknown>(r)),
  rows: (
    artifactId: string,
    q: { offset: number; limit: number; sort?: string; desc?: boolean },
  ) => {
    const params = new URLSearchParams({ offset: String(q.offset), limit: String(q.limit) });
    if (q.sort) params.set('sort', q.sort);
    if (q.desc) params.set('desc', 'true');
    return fetch(`/api/artifacts/${artifactId}/rows?${params}`).then((r) => json<RowsPage>(r));
  },

  /** Live event stream; EventSource reconnects and resumes via Last-Event-ID itself. */
  subscribe(id: string, onEvent: (e: TaskEvent) => void): () => void {
    // No EventSource (e.g. a test environment): no live updates, but nothing breaks.
    if (typeof EventSource === 'undefined') return () => undefined;
    const source = new EventSource(`/api/tasks/${id}/events`);
    source.addEventListener('task-event', (msg) => {
      onEvent(JSON.parse((msg as MessageEvent<string>).data) as TaskEvent);
    });
    return () => source.close();
  },
};
