import { randomUUID } from 'node:crypto';
import { Command } from '@langchain/langgraph';
import type { ApprovalDecision, TaskStatus, TaskSummary } from '@reality/schemas';
import type { EventLog } from '../events/event-log.ts';
import type { OrchestratorGraph, OrchestratorStateType } from '../orchestrator/graph.ts';
import { withUsageScope } from '../llm/usage.ts';
import type { TaskRepo } from './task-repo.ts';

export class TaskNotFoundError extends Error {}
export class TaskStateError extends Error {}

export interface TaskDetail extends TaskSummary {
  state: Partial<OrchestratorStateType> | null;
  pendingApproval: unknown;
}

/**
 * Owns task lifecycle: starting graph runs, resuming after approvals, and recovering
 * runs interrupted by a crash. Task status in the `tasks` table is derived here from
 * the graph's checkpointed state; it is the only writer of that column.
 */
export class TaskService {
  private readonly active = new Map<string, Promise<void>>();
  private readonly createHooks: ((taskId: string) => Promise<unknown>)[] = [];

  constructor(
    private readonly graph: OrchestratorGraph,
    private readonly repo: TaskRepo,
    private readonly events: EventLog,
    private readonly log: { error: (obj: unknown, msg?: string) => void } = console,
  ) {}

  /** Creates a task. With start=false it stays a draft (e.g. to attach data) until start(). */
  async create(
    request: string,
    opts: { start?: boolean; ownerId?: string | null; botId?: string | null } = {},
  ): Promise<TaskSummary> {
    const start = opts.start ?? true;
    const id = randomUUID();
    const task = await this.repo.create(
      id,
      request,
      start ? 'planning' : 'draft',
      opts.ownerId,
      opts.botId,
    );
    await this.events.append(id, 'task.created', 'user', { request });
    for (const hook of this.createHooks) await hook(id);
    if (start) this.run(id, { taskId: id, request });
    return task;
  }

  async start(taskId: string): Promise<void> {
    const task = await this.repo.get(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    if (task.status !== 'draft') throw new TaskStateError(`Task is ${task.status}, not a draft.`);
    await this.repo.setStatus(taskId, 'planning');
    this.run(taskId, { taskId, request: task.request });
  }

  /** Runs after a task is stored and before planning starts (e.g. creating its workspace). */
  onCreate(hook: (taskId: string) => Promise<unknown>): void {
    this.createHooks.push(hook);
  }

  async decide(taskId: string, decision: ApprovalDecision): Promise<void> {
    const task = await this.repo.get(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    if (task.status !== 'awaiting_approval' || this.active.has(taskId)) {
      throw new TaskStateError(`Task is ${task.status}, not awaiting approval.`);
    }
    // The graph records the decision; the final status (incl. 'rejected') is set in drive().
    await this.repo.setStatus(taskId, 'running');
    this.run(taskId, new Command({ resume: decision }));
  }

  async get(taskId: string): Promise<TaskDetail | undefined> {
    const task = await this.repo.get(taskId);
    if (!task) return undefined;
    const snapshot = await this.graph.getState(config(taskId));
    const pending = snapshot.tasks.flatMap((t) => t.interrupts.map((i) => i.value));
    return {
      ...task,
      state: (snapshot.values as Partial<OrchestratorStateType> | undefined) ?? null,
      pendingApproval: pending[0] ?? null,
    };
  }

  list(viewer?: { id: string; role: 'admin' | 'member' }): Promise<TaskSummary[]> {
    return this.repo.list(50, viewer);
  }

  listWaiting(viewer?: { id: string; role: 'admin' | 'member' }): Promise<TaskSummary[]> {
    return this.repo.listWaiting(viewer);
  }

  /** Resume runs that were in flight when the process stopped. Call once at startup. */
  async recover(): Promise<string[]> {
    const stranded = await this.repo.listByStatus(['planning', 'running']);
    for (const task of stranded) {
      const snapshot = await this.graph.getState(config(task.id));
      await this.events.append(task.id, 'task.resumed', 'system', {
        fromNodes: snapshot.next,
      });
      // No checkpoint yet: start from the beginning. Otherwise continue from the
      // last checkpoint (input null), without re-running completed nodes.
      const hasCheckpoint = snapshot.next.length > 0 || snapshot.values !== undefined;
      this.run(task.id, hasCheckpoint ? null : { taskId: task.id, request: task.request });
    }
    return stranded.map((t) => t.id);
  }

  /** Resolves when the task's current run (if any) has settled. For tests and shutdown. */
  async settled(taskId: string): Promise<void> {
    await this.active.get(taskId);
  }

  async settleAll(): Promise<void> {
    await Promise.all(this.active.values());
  }

  private run(taskId: string, input: Parameters<OrchestratorGraph['invoke']>[0]): void {
    const promise = this.drive(taskId, input)
      .catch(async (err: unknown) => {
        this.log.error({ err, taskId }, 'task run failed');
        const message = err instanceof Error ? err.message : String(err);
        await this.finish(taskId, 'failed', { error: message }).catch(() => undefined);
      })
      .finally(() => this.active.delete(taskId));
    this.active.set(taskId, promise);
  }

  private async drive(taskId: string, input: Parameters<OrchestratorGraph['invoke']>[0]) {
    // Save each step's checkpoint before the next one starts, so a crash never loses a
    // finished step and makes it run twice on resume.
    // Model calls in this run (planning, analysis code, research answers) count for the task.
    await withUsageScope({ taskId }, () =>
      this.graph.invoke(input, { ...config(taskId), durability: 'sync' }),
    );
    const snapshot = await this.graph.getState(config(taskId));
    const values = snapshot.values as OrchestratorStateType;
    const interrupts = snapshot.tasks.flatMap((t) => t.interrupts);

    if (interrupts.length > 0) {
      await this.repo.setStatus(taskId, 'awaiting_approval');
      await this.events.append(taskId, 'approval.requested', 'orchestrator', {
        request: interrupts[0]?.value,
      });
      return;
    }
    const outcome = values.outcome ?? 'failed';
    await this.finish(taskId, outcome, {
      error: values.error,
      budget: values.budget,
    });
  }

  private async finish(taskId: string, status: TaskStatus, payload: object) {
    await this.repo.setStatus(taskId, status);
    const type =
      status === 'completed'
        ? 'task.completed'
        : status === 'rejected'
          ? 'task.rejected'
          : status === 'budget_exceeded'
            ? 'task.budget_exceeded'
            : 'task.failed';
    await this.events.append(taskId, type, 'orchestrator', payload);
  }
}

function config(taskId: string) {
  return { configurable: { thread_id: taskId } };
}
