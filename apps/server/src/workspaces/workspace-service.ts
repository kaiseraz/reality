import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ActionIntent, WorkspaceSpec, type Actor, type WorkspacePatchOp } from '@reality/schemas';
import {
  applyPatch,
  initialWorkspace,
  isLayoutOnly,
  opsForCapabilities,
  opsForDataset,
  registry,
  type EngineContext,
} from '@reality/workspace';
import type { ArtifactMeta, ArtifactStore } from '../artifacts/artifact-store.ts';
import type { EventLog } from '../events/event-log.ts';
import type { TaskService } from '../tasks/task-service.ts';

export class WorkspaceNotFoundError extends Error {}
export class PatchRejectedError extends Error {
  constructor(readonly errors: string[]) {
    super(`Patch rejected:\n${errors.join('\n')}`);
  }
}
export class ActionRejectedError extends Error {}
export class NothingToUndoError extends Error {}

type AfterCommit = (cb: () => Promise<unknown>) => void;

/** Artifact ids referenced anywhere in a set of ops or a spec. */
function artifactIds(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => artifactIds(v, out));
  else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.kind === 'artifact' && obj.artifact && typeof obj.artifact === 'object') {
      const id = (obj.artifact as { id?: unknown }).id;
      if (typeof id === 'string') out.add(id);
    }
    Object.values(obj).forEach((v) => artifactIds(v, out));
  }
  return out;
}

/**
 * The workspace engine's persistence and routing layer. Patches are validated by the
 * shared engine against the registry and against real artifact columns, applied under a
 * row lock, and recorded with their inverse for undo.
 */
export class WorkspaceService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly events: EventLog,
    private readonly artifacts: ArtifactStore,
    private readonly tasks: TaskService,
  ) {}

  async createForTask(taskId: string): Promise<WorkspaceSpec> {
    const spec = initialWorkspace(randomUUID(), taskId);
    await this.pool.query(
      'INSERT INTO workspaces (id, task_id, version, spec) VALUES ($1, $2, $3, $4)',
      [spec.id, taskId, spec.version, JSON.stringify(spec)],
    );
    await this.events.append(taskId, 'workspace.created', 'system', {
      workspaceId: spec.id,
      components: Object.keys(spec.components),
    });
    return spec;
  }

  async get(id: string): Promise<WorkspaceSpec | undefined> {
    const { rows } = await this.pool.query<{ spec: unknown }>(
      'SELECT spec FROM workspaces WHERE id = $1',
      [id],
    );
    return rows[0] ? WorkspaceSpec.parse(rows[0].spec) : undefined;
  }

  async getByTask(taskId: string): Promise<WorkspaceSpec | undefined> {
    const { rows } = await this.pool.query<{ spec: unknown }>(
      'SELECT spec FROM workspaces WHERE task_id = $1',
      [taskId],
    );
    return rows[0] ? WorkspaceSpec.parse(rows[0].spec) : undefined;
  }

  /** Validates and applies a patch. Throws PatchRejectedError with all problems found. */
  async applyPatch(id: string, patch: unknown, actor: Actor): Promise<WorkspaceSpec> {
    return this.withLockedSpec(id, async (client, spec, afterCommit) => {
      const result = applyPatch(spec, patch, await this.engineContext(spec, patch));
      if (!result.ok) throw new PatchRejectedError(result.errors);
      const ops = (patch as { ops: WorkspacePatchOp[] }).ops;
      await this.commit(client, afterCommit, result.spec, {
        kind: 'apply',
        actor,
        ops,
        inverse: result.inverse,
      });
      return result.spec;
    });
  }

  /** Reverts the most recent content patch that has not been undone. Layout moves are skipped. */
  async undo(id: string, actor: Actor): Promise<WorkspaceSpec> {
    return this.withLockedSpec(id, async (client, spec, afterCommit) => {
      const { rows } = await client.query<{ version: number; inverse: WorkspacePatchOp[] }>(
        `SELECT version, inverse FROM workspace_patches
         WHERE workspace_id = $1 AND kind = 'apply' AND NOT layout_only AND undone_at IS NULL
         ORDER BY version DESC LIMIT 1`,
        [id],
      );
      const target = rows[0];
      if (!target) throw new NothingToUndoError('Nothing to undo.');

      const patch = {
        workspaceId: id,
        baseVersion: spec.version,
        proposedBy: actor,
        ops: target.inverse,
      };
      const result = applyPatch(spec, patch, await this.engineContext(spec, patch));
      if (!result.ok) throw new PatchRejectedError(result.errors);

      await client.query(
        'UPDATE workspace_patches SET undone_at = now() WHERE workspace_id = $1 AND version = $2',
        [id, target.version],
      );
      await this.commit(client, afterCommit, result.spec, {
        kind: 'undo',
        actor,
        ops: target.inverse,
        inverse: result.inverse,
        undoes: target.version,
      });
      return result.spec;
    });
  }

  /** Template rule: attaching a dataset adds a table (and a chart if it has a time series). */
  async onDatasetAdded(taskId: string, meta: ArtifactMeta): Promise<WorkspaceSpec | undefined> {
    const spec = await this.getByTask(taskId);
    if (!spec) return undefined;
    const ops = opsForDataset(spec, meta.ref, meta.filename, meta.columns, meta.rowCount);
    if (ops.length === 0) return spec;
    return this.applyPatch(
      spec.id,
      { workspaceId: spec.id, baseVersion: spec.version, proposedBy: 'system', ops },
      'system',
    );
  }

  /** Template rule: show the Capabilities panel once the capability agent is involved. */
  async onCapabilityActivity(taskId: string): Promise<void> {
    const spec = await this.getByTask(taskId);
    if (!spec) return;
    const ops = opsForCapabilities(spec);
    if (ops.length === 0) return;
    await this.applyPatch(
      spec.id,
      { workspaceId: spec.id, baseVersion: spec.version, proposedBy: 'system', ops },
      'system',
    );
  }

  /**
   * ActionIntent router. An action is accepted only if the instance exists in the
   * current spec, declares the action, the registry defines it, and its payload is
   * valid. Every accepted action is logged before it takes effect.
   */
  async handleAction(id: string, body: unknown): Promise<void> {
    const intent = ActionIntent.parse({ ...(body as object), workspaceId: id });
    const spec = await this.get(id);
    if (!spec) throw new WorkspaceNotFoundError(id);

    const instance = spec.components[intent.instanceId];
    if (!instance) throw new ActionRejectedError(`No component "${intent.instanceId}".`);
    if (!instance.actions.includes(intent.actionId)) {
      throw new ActionRejectedError(
        `${instance.type} instance does not expose "${intent.actionId}".`,
      );
    }
    const def = registry.get(instance.type)?.actions[intent.actionId];
    if (!def) throw new ActionRejectedError(`Action "${intent.actionId}" is not registered.`);
    const payload = def.payload.safeParse(intent.payload ?? {});
    if (!payload.success)
      throw new ActionRejectedError(`Invalid payload: ${payload.error.message}`);

    await this.events.append(spec.taskId, 'workspace.action', 'user', {
      instanceId: intent.instanceId,
      actionId: intent.actionId,
    });

    const route = `${instance.type}.${intent.actionId}`;
    const note = (payload.data as { note?: string }).note;
    switch (route) {
      case 'ApprovalQueue.approve':
      case 'ApprovalQueue.deny':
        await this.tasks.decide(spec.taskId, {
          approved: intent.actionId === 'approve',
          ...(note ? { note } : {}),
        });
        return;
      default:
        // A registered action with no handler is a bug, not something to silently ignore.
        throw new Error(`No handler for action ${route}.`);
    }
  }

  private async engineContext(spec: WorkspaceSpec, patch: unknown): Promise<EngineContext> {
    const ids = artifactIds([spec.components, patch]);
    const metas = await this.artifacts.getMany([...ids]);
    // Only artifacts of this task can be bound into its workspace.
    const columns = new Map(
      metas
        .filter((m) => m.taskId === spec.taskId)
        .map((m) => [m.ref.id, m.columns.map((c) => c.name)]),
    );
    return { registry, columnsOf: (artifactId) => columns.get(artifactId) };
  }

  private async withLockedSpec<T>(
    id: string,
    fn: (client: pg.PoolClient, spec: WorkspaceSpec, afterCommit: AfterCommit) => Promise<T>,
  ): Promise<T> {
    const pending: (() => Promise<unknown>)[] = [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ spec: unknown }>(
        'SELECT spec FROM workspaces WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!rows[0]) throw new WorkspaceNotFoundError(id);
      const result = await fn(client, WorkspaceSpec.parse(rows[0].spec), (cb) => pending.push(cb));
      await client.query('COMMIT');
      // Side effects that others observe (events) only after the change is visible.
      for (const cb of pending) await cb();
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async commit(
    client: pg.PoolClient,
    afterCommit: AfterCommit,
    spec: WorkspaceSpec,
    entry: {
      kind: 'apply' | 'undo';
      actor: Actor;
      ops: WorkspacePatchOp[];
      inverse: WorkspacePatchOp[];
      undoes?: number;
    },
  ) {
    await client.query(
      'UPDATE workspaces SET spec = $2, version = $3, updated_at = now() WHERE id = $1',
      [spec.id, JSON.stringify(spec), spec.version],
    );
    await client.query(
      `INSERT INTO workspace_patches (workspace_id, version, kind, actor, ops, inverse, layout_only, undoes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        spec.id,
        spec.version,
        entry.kind,
        entry.actor,
        JSON.stringify(entry.ops),
        JSON.stringify(entry.inverse),
        isLayoutOnly(entry.ops),
        entry.undoes ?? null,
      ],
    );
    afterCommit(() =>
      this.events.append(spec.taskId, 'workspace.patched', entry.actor, {
        workspaceId: spec.id,
        version: spec.version,
        kind: entry.kind,
        ops: entry.ops.map((o) => ('instanceId' in o ? `${o.op}:${o.instanceId}` : o.op)),
        ...(entry.undoes !== undefined ? { undoes: entry.undoes } : {}),
      }),
    );
  }
}
