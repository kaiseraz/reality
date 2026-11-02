import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Papa from 'papaparse';
import type pg from 'pg';
import {
  type Autonomy,
  type CreateProjectRequest,
  type ProjectStatus,
  type ProjectSummary,
  type ProjectTask,
  type ProjectTaskDraft,
  type TaskStatus,
  TERMINAL_STATUSES,
} from '@reality/schemas';
import { attachUpload, type AttachDeps } from '../artifacts/attach.ts';
import type { StepResult } from '../orchestrator/graph.ts';
import type { TaskService } from '../tasks/task-service.ts';
import { TaskStateError } from '../tasks/task-service.ts';
import { planPolicy } from './policy.ts';
import { validateProjectTasks, type ProjectPlanner } from './project-planner.ts';

export class ProjectNotFoundError extends Error {}
export class ProjectBudgetError extends Error {}

interface ProjectRow {
  id: string;
  owner_id: string | null;
  goal: string;
  status: ProjectStatus;
  autonomy: Autonomy;
  max_parallel: number;
  max_tasks: number;
  max_sandbox_minutes: number;
  planner: string;
  team: string[];
  created_at: Date;
  updated_at: Date;
}

interface TaskRow {
  task_id: string;
  position: number;
  title: string;
  request: string;
  status: TaskStatus;
  depends_on: string[];
  input_from: string | null;
  started_at: Date | null;
  bot_id: string | null;
}

export interface ProjectEvent {
  id: number;
  type: string;
  actor: string;
  payload: unknown;
  createdAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  planner: string;
  tasks: ProjectTask[];
  files: { id: string; filename: string; rowCount: number; columnNames: string[] }[];
  usage: { tasksStarted: number; sandboxMinutes: number };
  events: ProjectEvent[];
}

const RUNNING: readonly TaskStatus[] = ['planning', 'running'];
const FAILED: readonly TaskStatus[] = ['failed', 'rejected', 'budget_exceeded'];
/** Which step's result is "the" result of a task, when handing it to the next one. */
const RESULT_ORDER = [
  'forecast',
  'correlate',
  'query',
  'season_by_group',
  'decompose',
  'breakdown',
  'aggregate',
];

function boardOf(t: TaskRow, all: TaskRow[]): ProjectTask['board'] {
  if (t.status === 'completed') return 'done';
  if (FAILED.includes(t.status)) return 'failed';
  if (t.status === 'awaiting_approval') return 'needs_you';
  if (RUNNING.includes(t.status)) return 'running';
  const blocked = t.depends_on.some((d) => {
    const dep = all.find((x) => x.task_id === d);
    return dep !== undefined && FAILED.includes(dep.status);
  });
  return blocked ? 'blocked' : 'waiting';
}

function header(text: string): { rowCount: number; columnNames: string[] } {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    comments: '#',
    preview: 0,
  });
  return { rowCount: parsed.data.length, columnNames: parsed.meta.fields ?? [] };
}

/**
 * Projects (M7): a long-term goal as a tree of ordinary tasks, and the scheduler that runs
 * them. State lives in Postgres, so a restart continues where it stopped: tasks resume from
 * their checkpoints (TaskService.recover) and the next tick starts whatever became runnable.
 */
export class ProjectService {
  /** Passes run one after another; at most one more waits behind the running one. */
  private chain: Promise<void> = Promise.resolve();
  private queued = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly deps: AttachDeps & {
      pool: pg.Pool;
      tasks: TaskService;
      planner: ProjectPlanner;
      dataDir: string;
      readSample?: (id: string) => Promise<{ filename: string; text: string } | undefined>;
      log?: { error: (obj: unknown, msg?: string) => void };
    },
  ) {}

  // ---- Creating and reading ------------------------------------------------------------

  async create(req: CreateProjectRequest, ownerId: string | null): Promise<ProjectDetail> {
    const id = randomUUID();
    const files: { filename: string; text: string }[] = [];
    for (const sample of req.samples) {
      const f = await this.deps.readSample?.(sample);
      if (!f) throw new ProjectNotFoundError(`Unknown example dataset "${sample}".`);
      files.push(f);
    }
    const ctx = {
      files: files.map((f) => ({ filename: f.filename, ...header(f.text) })),
      maxTasks: req.budget.maxTasks,
    };
    const drafts = req.tasks
      ? validateProjectTasks(req.tasks, req.budget.maxTasks)
      : await this.deps.planner.propose(req.goal, ctx);

    await this.deps.pool.query(
      `INSERT INTO projects (id, owner_id, goal, status, autonomy, max_parallel, max_tasks,
                             max_sandbox_minutes, planner, team)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        ownerId,
        req.goal,
        req.start ? 'active' : 'paused',
        req.autonomy,
        req.maxParallel,
        req.budget.maxTasks,
        req.budget.maxSandboxMinutes,
        req.tasks ? 'user' : this.deps.planner.name,
        JSON.stringify(req.team),
      ],
    );
    for (const f of files) await this.storeFile(id, f.filename, f.text);
    await this.addTasks(id, drafts, ownerId);
    await this.event(id, 'project.created', 'user', {
      goal: req.goal,
      tasks: drafts.length,
      planner: req.tasks ? 'user' : this.deps.planner.name,
      autonomy: req.autonomy,
    });
    this.kick();
    return this.detail(id);
  }

  async addTasks(projectId: string, drafts: ProjectTaskDraft[], ownerId: string | null) {
    const existing = await this.taskRows(projectId);
    const ids: string[] = [];
    for (const [i, d] of drafts.entries()) {
      const task = await this.deps.tasks.create(d.request, { start: false, ownerId });
      ids.push(task.id);
      const dependsOn = d.dependsOn.map((j) => ids[j] ?? '').filter(Boolean);
      const inputFrom = d.useResultOf !== undefined ? (ids[d.useResultOf] ?? null) : null;
      await this.deps.pool.query(
        `INSERT INTO project_tasks (task_id, project_id, position, title, depends_on, input_from)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [task.id, projectId, existing.length + i, d.title, JSON.stringify(dependsOn), inputFrom],
      );
    }
    return ids;
  }

  /** A task added later by the user; dependencies are ids of tasks already in the project. */
  async addTask(
    projectId: string,
    t: { title: string; request: string; dependsOn: string[]; inputFrom?: string | undefined },
    ownerId: string | null,
  ): Promise<string> {
    const p = await this.row(projectId);
    const rows = await this.taskRows(projectId);
    const known = new Set(rows.map((r) => r.task_id));
    for (const d of [...t.dependsOn, ...(t.inputFrom ? [t.inputFrom] : [])]) {
      if (!known.has(d)) throw new ProjectNotFoundError(`Task ${d} is not part of this project.`);
    }
    if (rows.length >= p.max_tasks) {
      throw new ProjectBudgetError(`The project budget allows ${p.max_tasks} tasks.`);
    }
    const task = await this.deps.tasks.create(t.request, { start: false, ownerId });
    const dependsOn = [...new Set([...t.dependsOn, ...(t.inputFrom ? [t.inputFrom] : [])])];
    await this.deps.pool.query(
      `INSERT INTO project_tasks (task_id, project_id, position, title, depends_on, input_from)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [task.id, projectId, rows.length, t.title, JSON.stringify(dependsOn), t.inputFrom ?? null],
    );
    await this.event(projectId, 'task.added', 'user', { taskId: task.id, title: t.title });
    // A finished project with new work becomes active again.
    if (p.status === 'completed' || p.status === 'failed')
      await this.setStatus(projectId, 'active');
    this.kick();
    return task.id;
  }

  async addFile(projectId: string, filename: string, text: string) {
    await this.storeFile(projectId, filename, text);
    await this.event(projectId, 'project.file_added', 'user', { filename });
  }

  private async storeFile(projectId: string, filename: string, text: string) {
    const fileId = randomUUID();
    const dir = join(this.deps.dataDir, 'projects', projectId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${fileId}.csv`);
    await writeFile(path, text, 'utf8');
    await this.deps.pool.query(
      'INSERT INTO project_files (id, project_id, filename, path) VALUES ($1, $2, $3, $4)',
      [fileId, projectId, filename.replace(/[^\w.\- ()]+/g, '_').slice(0, 200), path],
    );
  }

  async list(viewer?: { id: string; role: 'admin' | 'member' }): Promise<ProjectSummary[]> {
    const { rows } = viewer
      ? await this.deps.pool.query<ProjectRow>(
          `SELECT * FROM projects WHERE owner_id = $1 OR ($2 AND owner_id IS NULL)
           ORDER BY created_at DESC LIMIT 50`,
          [viewer.id, viewer.role === 'admin'],
        )
      : await this.deps.pool.query<ProjectRow>(
          'SELECT * FROM projects ORDER BY created_at DESC LIMIT 50',
        );
    const out: ProjectSummary[] = [];
    for (const p of rows) out.push(this.summary(p, await this.taskRows(p.id)));
    return out;
  }

  async detail(id: string): Promise<ProjectDetail> {
    const p = await this.row(id);
    const rows = await this.taskRows(id);
    const { rows: fileRows } = await this.deps.pool.query<{
      id: string;
      filename: string;
      path: string;
    }>('SELECT id, filename, path FROM project_files WHERE project_id = $1 ORDER BY created_at', [
      id,
    ]);
    const files = [];
    for (const f of fileRows) {
      files.push({ id: f.id, filename: f.filename, ...header(await readFile(f.path, 'utf8')) });
    }
    const { rows: ev } = await this.deps.pool.query<{
      id: string;
      type: string;
      actor: string;
      payload: unknown;
      created_at: Date;
    }>(`SELECT * FROM project_events WHERE project_id = $1 ORDER BY id DESC LIMIT 200`, [id]);
    return {
      ...this.summary(p, rows),
      planner: p.planner,
      tasks: rows.map((t) => ({
        taskId: t.task_id,
        position: t.position,
        title: t.title,
        request: t.request,
        dependsOn: t.depends_on,
        inputFrom: t.input_from,
        status: t.status,
        board: boardOf(t, rows),
        startedAt: t.started_at?.toISOString() ?? null,
        botId: t.bot_id,
      })),
      files,
      usage: await this.usage(id, rows),
      events: ev.map((e) => ({
        id: Number(e.id),
        type: e.type,
        actor: e.actor,
        payload: e.payload,
        createdAt: e.created_at.toISOString(),
      })),
    };
  }

  /** Why the policy left a task's decision to a person (latest note), if it did. */
  async deferralReason(taskId: string): Promise<string | undefined> {
    const { rows } = await this.deps.pool.query<{ reason: string }>(
      `SELECT payload->>'reason' AS reason FROM project_events
       WHERE type = 'policy.deferred' AND payload->>'taskId' = $1 ORDER BY id DESC LIMIT 1`,
      [taskId],
    );
    return rows[0]?.reason;
  }

  /** The project a task belongs to, if any. */
  async projectOfTask(taskId: string): Promise<{ id: string; goal: string } | undefined> {
    const { rows } = await this.deps.pool.query<{ id: string; goal: string }>(
      `SELECT p.id, p.goal FROM project_tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.task_id = $1`,
      [taskId],
    );
    return rows[0];
  }

  async setPaused(id: string, paused: boolean) {
    const p = await this.row(id);
    if (paused && p.status !== 'active') return;
    if (!paused && p.status !== 'paused') return;
    await this.setStatus(id, paused ? 'paused' : 'active');
    await this.event(id, paused ? 'project.paused' : 'project.resumed', 'user', {});
    if (!paused) this.kick();
  }

  private summary(p: ProjectRow, rows: TaskRow[]): ProjectSummary {
    return {
      id: p.id,
      goal: p.goal,
      status: p.status,
      autonomy: p.autonomy,
      maxParallel: p.max_parallel,
      budget: { maxTasks: p.max_tasks, maxSandboxMinutes: p.max_sandbox_minutes },
      team: p.team ?? [],
      createdAt: p.created_at.toISOString(),
      updatedAt: p.updated_at.toISOString(),
      counts: {
        total: rows.length,
        done: rows.filter((t) => t.status === 'completed').length,
        needsYou: rows.filter((t) => t.status === 'awaiting_approval').length,
      },
    };
  }

  private async row(id: string): Promise<ProjectRow> {
    const { rows } = await this.deps.pool.query<ProjectRow>(
      'SELECT * FROM projects WHERE id = $1',
      [id],
    );
    if (!rows[0]) throw new ProjectNotFoundError(id);
    return rows[0];
  }

  private async taskRows(projectId: string): Promise<TaskRow[]> {
    const { rows } = await this.deps.pool.query<TaskRow>(
      `SELECT pt.task_id, pt.position, pt.title, t.request, t.status, pt.depends_on,
              pt.input_from, pt.started_at, t.bot_id
       FROM project_tasks pt JOIN tasks t ON t.id = pt.task_id
       WHERE pt.project_id = $1 ORDER BY pt.position`,
      [projectId],
    );
    return rows;
  }

  private async usage(projectId: string, rows: TaskRow[]) {
    const { rows: r } = await this.deps.pool.query<{ ms: string | null }>(
      'SELECT SUM(duration_ms) AS ms FROM runs WHERE task_id = ANY($1)',
      [rows.map((t) => t.task_id)],
    );
    return {
      tasksStarted: rows.filter((t) => t.started_at !== null).length,
      sandboxMinutes: Math.round((Number(r[0]?.ms ?? 0) / 60_000) * 10) / 10,
    };
  }

  private async setStatus(id: string, status: ProjectStatus) {
    await this.deps.pool.query(
      'UPDATE projects SET status = $2, updated_at = now() WHERE id = $1',
      [id, status],
    );
  }

  private async event(projectId: string, type: string, actor: string, payload: unknown) {
    await this.deps.pool.query(
      'INSERT INTO project_events (project_id, type, actor, payload) VALUES ($1, $2, $3, $4)',
      [projectId, type, actor, JSON.stringify(payload)],
    );
    await this.deps.pool.query('UPDATE projects SET updated_at = now() WHERE id = $1', [projectId]);
  }

  // ---- Scheduler ----------------------------------------------------------------------

  /** Background loop: keeps every active project moving while the server runs. */
  start(intervalMs = 2000) {
    this.timer ??= setInterval(() => this.kick(), intervalMs);
    this.kick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  kick() {
    void this.tick().catch((err: unknown) => this.deps.log?.error({ err }, 'scheduler tick'));
  }

  /**
   * One pass over all active projects, never two at the same time. A call during a pass
   * queues one more pass (calls while one is queued share it), so every caller's pass sees
   * the state as of its call.
   */
  tick(): Promise<void> {
    if (this.queued) return this.chain;
    this.queued = true;
    this.chain = this.chain
      .catch(() => undefined)
      .then(async () => {
        this.queued = false;
        const { rows } = await this.deps.pool.query<ProjectRow>(
          "SELECT * FROM projects WHERE status = 'active' ORDER BY created_at",
        );
        for (const p of rows) await this.advance(p);
      });
    return this.chain;
  }

  private async advance(p: ProjectRow) {
    const rows = await this.taskRows(p.id);
    const usage = await this.usage(p.id, rows);

    if (usage.sandboxMinutes >= p.max_sandbox_minutes) {
      await this.setStatus(p.id, 'budget_exceeded');
      await this.event(p.id, 'project.budget_exceeded', 'policy', {
        sandboxMinutes: usage.sandboxMinutes,
        limit: p.max_sandbox_minutes,
      });
      return;
    }

    // 1. Policy: approve plans that need no person, report the others once.
    if (p.autonomy === 'ask-critical') {
      for (const t of rows.filter((x) => x.status === 'awaiting_approval')) {
        await this.applyPolicy(p, t);
      }
    }

    // 2. Finished? Every task terminal, or nothing can move any more.
    const current = await this.taskRows(p.id);
    if (current.every((t) => TERMINAL_STATUSES.includes(t.status))) {
      const ok = current.every((t) => t.status === 'completed');
      await this.setStatus(p.id, ok ? 'completed' : 'failed');
      await this.event(p.id, ok ? 'project.completed' : 'project.failed', 'system', {
        done: current.filter((t) => t.status === 'completed').length,
        total: current.length,
      });
      return;
    }

    // 3. Start tasks whose dependencies are done, up to the parallelism and task budget.
    let running = current.filter((t) => RUNNING.includes(t.status)).length;
    let started = current.filter((t) => t.started_at !== null).length;
    const done = new Set(current.filter((t) => t.status === 'completed').map((t) => t.task_id));
    const runnable = current.filter(
      (t) => t.status === 'draft' && t.depends_on.every((d) => done.has(d)),
    );
    // With a team, each free bot takes one task; a busy bot (planning or running anything)
    // waits. Without a team, tasks run unassigned as before.
    const free = await this.freeBots(p);
    for (const t of runnable) {
      if (running >= p.max_parallel) break;
      const bot = p.team.length > 0 ? (t.bot_id ?? free.shift()) : null;
      if (p.team.length > 0 && !bot) break;
      if (t.started_at === null && started >= p.max_tasks) {
        await this.setStatus(p.id, 'budget_exceeded');
        await this.event(p.id, 'project.budget_exceeded', 'policy', {
          tasksStarted: started,
          limit: p.max_tasks,
        });
        return;
      }
      if (bot && t.bot_id !== bot) {
        await this.deps.pool.query('UPDATE tasks SET bot_id = $2 WHERE id = $1', [t.task_id, bot]);
        t.bot_id = bot;
      }
      await this.startTask(p, t);
      running += 1;
      if (t.started_at === null) started += 1;
    }

    // 4. Stuck: nothing running, nothing waiting for a person, nothing runnable.
    const after = await this.taskRows(p.id);
    const moving = after.some(
      (t) =>
        RUNNING.includes(t.status) ||
        t.status === 'awaiting_approval' ||
        (t.status === 'draft' && t.depends_on.every((d) => done.has(d))),
    );
    if (!moving && after.some((t) => t.status === 'draft')) {
      await this.setStatus(p.id, 'failed');
      await this.event(p.id, 'project.blocked', 'system', {
        reason: 'Remaining tasks depend on tasks that failed or were rejected.',
      });
    }
  }

  private async applyPolicy(p: ProjectRow, t: TaskRow) {
    const detail = await this.deps.tasks.get(t.task_id);
    const pending = detail?.pendingApproval as { kind?: string } | null | undefined;
    const spec = detail?.state?.spec;
    if (pending?.kind !== 'plan-approval' || !spec) {
      // Capability installations and anything else always wait for a person.
      if (pending?.kind) {
        await this.defer(
          p,
          t,
          pending.kind === 'capability-approval'
            ? 'Installing a capability always needs a person.'
            : 'This decision needs a person.',
        );
      }
      return;
    }
    const verdict = planPolicy(spec, { budgetLeft: true });
    if (!verdict.approve) {
      await this.defer(p, t, verdict.reason);
      return;
    }
    try {
      await this.deps.tasks.decide(t.task_id, {
        approved: true,
        by: 'policy',
        note: `Approved by project policy: ${verdict.reason}`,
      });
      await this.event(p.id, 'policy.approved', 'policy', {
        taskId: t.task_id,
        title: t.title,
        reason: verdict.reason,
      });
    } catch (err) {
      if (!(err instanceof TaskStateError)) throw err; // decided meanwhile: fine
    }
  }

  /** Records once (also across restarts) why a decision was left to a person. */
  private async defer(p: ProjectRow, t: TaskRow, reason: string) {
    if ((await this.deferralReason(t.task_id)) === reason) return;
    await this.event(p.id, 'policy.deferred', 'policy', {
      taskId: t.task_id,
      title: t.title,
      reason,
    });
  }

  /** Team members not planning or running any task right now, in team order. */
  /** Bots with nothing open: a bot waiting for a decision still holds its task. */
  private async freeBots(p: ProjectRow): Promise<string[]> {
    if (p.team.length === 0) return [];
    const { rows } = await this.deps.pool.query<{ bot_id: string }>(
      `SELECT DISTINCT bot_id FROM tasks
       WHERE bot_id = ANY($1) AND status IN ('planning', 'running', 'awaiting_approval')`,
      [p.team],
    );
    const busy = new Set(rows.map((r) => r.bot_id));
    const { rows: existing } = await this.deps.pool.query<{ id: string }>(
      'SELECT id FROM bots WHERE id = ANY($1)',
      [p.team],
    );
    const exists = new Set(existing.map((r) => r.id));
    return p.team.filter((id) => exists.has(id) && !busy.has(id));
  }

  private async botName(id: string): Promise<string | null> {
    const { rows } = await this.deps.pool.query<{ name: string }>(
      'SELECT name FROM bots WHERE id = $1',
      [id],
    );
    return rows[0]?.name ?? null;
  }

  private async startTask(p: ProjectRow, t: TaskRow) {
    // Mark first: if the process stops while attaching, inputs are not attached twice.
    if (t.started_at === null) {
      await this.deps.pool.query('UPDATE project_tasks SET started_at = now() WHERE task_id = $1', [
        t.task_id,
      ]);
      const { rows: files } = await this.deps.pool.query<{ filename: string; path: string }>(
        'SELECT filename, path FROM project_files WHERE project_id = $1 ORDER BY created_at',
        [p.id],
      );
      for (const f of files) {
        await attachUpload(
          this.deps,
          t.task_id,
          f.filename,
          await readFile(f.path, 'utf8'),
          'system',
        );
      }
      if (t.input_from) await this.handOver(p, t, t.input_from);
    }
    try {
      await this.deps.tasks.start(t.task_id);
      await this.event(p.id, 'task.started', 'system', {
        taskId: t.task_id,
        title: t.title,
        ...(t.bot_id ? { botId: t.bot_id, bot: await this.botName(t.bot_id) } : {}),
      });
    } catch (err) {
      if (!(err instanceof TaskStateError)) throw err;
    }
  }

  /** The upstream task's main result table becomes this task's input data. */
  private async handOver(p: ProjectRow, t: TaskRow, fromTask: string) {
    const upstream = await this.deps.tasks.get(fromTask);
    const results = (upstream?.state?.stepResults ?? []) as StepResult[];
    const rank = (id: string) => {
      const i = RESULT_ORDER.indexOf(id);
      return i < 0 ? RESULT_ORDER.length : i;
    };
    const best = results
      .filter((r) => r.status === 'done' && (r.artifacts?.length ?? 0) > 0)
      .sort((a, b) => rank(a.stepId) - rank(b.stepId))[0];
    const artifactId = best?.artifacts?.[0];
    const meta = artifactId ? await this.deps.artifacts.get(artifactId) : undefined;
    if (!meta) {
      await this.event(p.id, 'handoff.missing', 'system', {
        taskId: t.task_id,
        fromTask,
        reason: 'The earlier task produced no result table; the task uses the project data.',
      });
      return;
    }
    const text = await readFile(this.deps.artifacts.filePath(meta), 'utf8');
    const handed = await this.deps.artifacts.putCsv(t.task_id, meta.filename, text, {
      kind: 'handoff',
      fromTask,
      artifact: meta.ref.id,
    });
    await this.deps.events.append(t.task_id, 'artifact.added', 'system', {
      artifactId: handed.ref.id,
      filename: handed.filename,
      rows: handed.rowCount,
      provenance: handed.provenance,
    });
    await this.deps.workspaces.onDatasetAdded(t.task_id, handed);
    await this.event(p.id, 'handoff', 'system', {
      taskId: t.task_id,
      fromTask,
      filename: meta.filename,
      rows: meta.rowCount,
    });
  }
}
