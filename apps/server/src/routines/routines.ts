import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { TERMINAL_STATUSES, type TaskSpec, type TaskStatus } from '@reality/schemas';
import { attachUpload, type AttachDeps } from '../artifacts/attach.ts';
import type { PageStore } from '../pages/pages.ts';
import { taskReport } from '../pages/report.ts';
import { planPolicy } from '../projects/policy.ts';
import { TaskStateError, type TaskService } from '../tasks/task-service.ts';

/**
 * Routines: a task that starts itself on a schedule (a weekly literature digest, a daily
 * sales check). Each run is an ordinary task with plan, approval and verification. With
 * auto-approval, the deterministic project policy decides (never a model); anything it
 * would not approve waits in the inbox. A finished run can be appended to a page, which
 * keeps every earlier version.
 */

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time as HH:MM');

export const Schedule = z.discriminatedUnion('type', [
  z.object({ type: z.literal('daily'), time }),
  z.object({ type: z.literal('weekdays'), time }),
  z.object({ type: z.literal('weekly'), time, day: z.number().int().min(0).max(6) }),
  z.object({ type: z.literal('interval'), minutes: z.number().int().min(15).max(10_080) }),
]);
export type Schedule = z.infer<typeof Schedule>;

export const RoutineInput = z.object({
  name: z.string().trim().min(1).max(80),
  request: z.string().trim().min(1).max(10_000),
  schedule: Schedule,
  sample: z.string().max(40).nullable().default(null),
  botId: z.uuid().nullable().default(null),
  pageId: z.uuid().nullable().default(null),
  autoApprove: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export type RoutineInput = z.infer<typeof RoutineInput>;

export const RoutinePatch = RoutineInput.partial();

/**
 * The next run after `from`, in the server's local time. Missed runs (server off) are not
 * made up; the routine simply continues with its next regular time.
 */
export function nextRun(schedule: Schedule, from: Date): Date {
  if (schedule.type === 'interval') return new Date(from.getTime() + schedule.minutes * 60_000);
  const [h, m] = schedule.time.split(':').map(Number);
  for (let i = 0; i < 9; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(h ?? 0, m ?? 0, 0, 0);
    if (d <= from) continue;
    const wd = d.getDay();
    if (schedule.type === 'weekdays' && (wd === 0 || wd === 6)) continue;
    if (schedule.type === 'weekly' && wd !== schedule.day) continue;
    return d;
  }
  return new Date(from.getTime() + 86_400_000);
}

export interface RoutineView extends RoutineInput {
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

interface RoutineRow {
  id: string;
  owner_id: string | null;
  name: string;
  request: string;
  schedule: Schedule;
  sample: string | null;
  bot_id: string | null;
  page_id: string | null;
  auto_approve: boolean;
  enabled: boolean;
  next_run: Date | null;
  last_run: Date | null;
  created_at: Date;
}

export class RoutineError extends Error {}

export class RoutineService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy: Promise<void> | null = null;

  constructor(
    private readonly deps: AttachDeps & {
      pool: pg.Pool;
      tasks: TaskService;
      pages: PageStore;
      readSample: (id: string) => Promise<{ filename: string; text: string } | undefined>;
      log?: { error: (obj: unknown, msg?: string) => void };
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async list(ownerId: string | null): Promise<RoutineView[]> {
    const { rows } = await this.deps.pool.query<RoutineRow>(
      'SELECT * FROM routines WHERE owner_id IS NOT DISTINCT FROM $1 ORDER BY created_at',
      [ownerId],
    );
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(id: string, ownerId: string | null): Promise<RoutineView | undefined> {
    const row = await this.row(id, ownerId);
    return row ? this.view(row) : undefined;
  }

  private async row(id: string, ownerId: string | null): Promise<RoutineRow | undefined> {
    const { rows } = await this.deps.pool.query<RoutineRow>(
      'SELECT * FROM routines WHERE id = $1 AND owner_id IS NOT DISTINCT FROM $2',
      [id, ownerId],
    );
    return rows[0];
  }

  async create(ownerId: string | null, input: RoutineInput): Promise<RoutineView> {
    const { rows } = await this.deps.pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM routines WHERE owner_id IS NOT DISTINCT FROM $1',
      [ownerId],
    );
    if (Number(rows[0]?.n ?? 0) >= 50) throw new RoutineError('At most 50 routines.');
    const id = randomUUID();
    await this.deps.pool.query(
      `INSERT INTO routines (id, owner_id, name, request, schedule, sample, bot_id, page_id,
                             auto_approve, enabled, next_run)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        ownerId,
        input.name,
        input.request,
        JSON.stringify(input.schedule),
        input.sample,
        input.botId,
        input.pageId,
        input.autoApprove,
        input.enabled,
        input.enabled ? nextRun(input.schedule, this.now()) : null,
      ],
    );
    const view = await this.get(id, ownerId);
    if (!view) throw new Error('routine vanished');
    return view;
  }

  async update(
    id: string,
    ownerId: string | null,
    patch: z.infer<typeof RoutinePatch>,
  ): Promise<RoutineView | undefined> {
    const row = await this.row(id, ownerId);
    if (!row) return undefined;
    const merged: RoutineInput = {
      name: patch.name ?? row.name,
      request: patch.request ?? row.request,
      schedule: patch.schedule ?? row.schedule,
      sample: patch.sample !== undefined ? patch.sample : row.sample,
      botId: patch.botId !== undefined ? patch.botId : row.bot_id,
      pageId: patch.pageId !== undefined ? patch.pageId : row.page_id,
      autoApprove: patch.autoApprove ?? row.auto_approve,
      enabled: patch.enabled ?? row.enabled,
    };
    await this.deps.pool.query(
      `UPDATE routines SET name = $2, request = $3, schedule = $4, sample = $5, bot_id = $6,
              page_id = $7, auto_approve = $8, enabled = $9, next_run = $10 WHERE id = $1`,
      [
        id,
        merged.name,
        merged.request,
        JSON.stringify(merged.schedule),
        merged.sample,
        merged.botId,
        merged.pageId,
        merged.autoApprove,
        merged.enabled,
        merged.enabled ? nextRun(merged.schedule, this.now()) : null,
      ],
    );
    return this.get(id, ownerId);
  }

  async remove(id: string, ownerId: string | null): Promise<boolean> {
    const { rowCount } = await this.deps.pool.query(
      'DELETE FROM routines WHERE id = $1 AND owner_id IS NOT DISTINCT FROM $2',
      [id, ownerId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Starts one run now, outside the schedule. */
  async runNow(id: string, ownerId: string | null): Promise<string | undefined> {
    const row = await this.row(id, ownerId);
    return row ? this.launch(row) : undefined;
  }

  // ---- Scheduler ----------------------------------------------------------------------

  start(intervalMs = 15_000) {
    this.timer ??= setInterval(() => this.kick(), intervalMs);
    this.kick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  kick() {
    void this.tick().catch((err: unknown) => this.deps.log?.error({ err }, 'routine tick'));
  }

  /** One pass: start due routines, then move their runs along. Never two passes at once. */
  async tick(): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.pass().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async pass() {
    const now = this.now();
    const { rows: due } = await this.deps.pool.query<RoutineRow>(
      'SELECT * FROM routines WHERE enabled AND next_run IS NOT NULL AND next_run <= $1',
      [now],
    );
    for (const r of due) {
      // Reschedule first: a run that fails to start must not be retried every 15 seconds.
      await this.deps.pool.query('UPDATE routines SET next_run = $2 WHERE id = $1', [
        r.id,
        nextRun(r.schedule, now),
      ]);
      try {
        await this.launch(r);
      } catch (err) {
        this.deps.log?.error({ err, routine: r.id }, 'routine run did not start');
      }
    }

    const { rows: runs } = await this.deps.pool.query<
      RoutineRow & { task_id: string; handled: string | null; status: TaskStatus }
    >(
      `SELECT r.*, rr.task_id, rr.handled, t.status
         FROM routine_runs rr JOIN routines r ON r.id = rr.routine_id
         JOIN tasks t ON t.id = rr.task_id
        WHERE rr.handled IS DISTINCT FROM 'finished'`,
    );
    for (const run of runs) {
      try {
        await this.advance(run);
      } catch (err) {
        this.deps.log?.error({ err, task: run.task_id }, 'routine run');
      }
    }
  }

  private async advance(
    run: RoutineRow & { task_id: string; handled: string | null; status: TaskStatus },
  ) {
    const mark = (handled: string, note: string) =>
      this.deps.pool.query(
        'UPDATE routine_runs SET handled = $3, note = $4 WHERE routine_id = $1 AND task_id = $2',
        [run.id, run.task_id, handled, note],
      );

    if (run.status === 'awaiting_approval' && run.handled === null) {
      if (!run.auto_approve) return mark('deferred', 'Waiting for your approval in the inbox.');
      const task = await this.deps.tasks.get(run.task_id);
      const pending = task?.pendingApproval as { kind?: string } | null;
      const spec = task?.state?.spec as TaskSpec | undefined;
      if (pending?.kind !== 'plan-approval' || !spec) {
        return mark('deferred', 'This decision needs a person.');
      }
      const verdict = planPolicy(spec, { budgetLeft: true });
      if (!verdict.approve) return mark('deferred', verdict.reason);
      try {
        await this.deps.tasks.decide(run.task_id, {
          approved: true,
          by: 'policy',
          note: `Approved by routine policy: ${verdict.reason}`,
        });
      } catch (err) {
        if (!(err instanceof TaskStateError)) throw err;
      }
      return mark('approved', verdict.reason);
    }

    if (!TERMINAL_STATUSES.includes(run.status)) return;
    if (!run.page_id || run.status === 'rejected') {
      return mark('finished', `Run ended: ${run.status}.`);
    }
    const author = await this.authorOf(run);
    const report = await taskReport(this.deps, run.task_id, { by: author });
    const page = report
      ? await this.deps.pages.write(run.page_id, run.owner_id, {
          append: report,
          author,
          change: `Run ${run.status}`,
          taskId: run.task_id,
        })
      : undefined;
    return mark(
      'finished',
      page ? `Added to the page as version ${page.version}.` : 'The page no longer exists.',
    );
  }

  private async authorOf(r: RoutineRow): Promise<string> {
    if (!r.bot_id) return `Routine: ${r.name}`;
    const { rows } = await this.deps.pool.query<{ name: string }>(
      'SELECT name FROM bots WHERE id = $1',
      [r.bot_id],
    );
    return rows[0]?.name ?? `Routine: ${r.name}`;
  }

  private async launch(r: RoutineRow): Promise<string> {
    const file = r.sample ? await this.deps.readSample(r.sample) : undefined;
    if (r.sample && !file) throw new RoutineError(`Unknown example dataset "${r.sample}".`);
    const task = await this.deps.tasks.create(r.request, {
      start: false,
      ownerId: r.owner_id,
      botId: r.bot_id,
    });
    if (file) await attachUpload(this.deps, task.id, file.filename, file.text, 'system');
    await this.deps.pool.query('INSERT INTO routine_runs (routine_id, task_id) VALUES ($1, $2)', [
      r.id,
      task.id,
    ]);
    await this.deps.pool.query('UPDATE routines SET last_run = $2 WHERE id = $1', [
      r.id,
      this.now(),
    ]);
    await this.deps.tasks.start(task.id);
    return task.id;
  }

  private async view(r: RoutineRow): Promise<RoutineView> {
    const { rows } = await this.deps.pool.query<{
      task_id: string;
      status: TaskStatus;
      started_at: Date;
      handled: string | null;
      note: string | null;
    }>(
      `SELECT rr.task_id, t.status, rr.started_at, rr.handled, rr.note
         FROM routine_runs rr JOIN tasks t ON t.id = rr.task_id
        WHERE rr.routine_id = $1 ORDER BY rr.started_at DESC LIMIT 20`,
      [r.id],
    );
    return {
      id: r.id,
      name: r.name,
      request: r.request,
      schedule: r.schedule,
      sample: r.sample,
      botId: r.bot_id,
      pageId: r.page_id,
      autoApprove: r.auto_approve,
      enabled: r.enabled,
      nextRun: r.next_run?.toISOString() ?? null,
      lastRun: r.last_run?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
      runs: rows.map((x) => ({
        taskId: x.task_id,
        status: x.status,
        startedAt: x.started_at.toISOString(),
        handled: x.handled,
        note: x.note,
      })),
    };
  }
}
