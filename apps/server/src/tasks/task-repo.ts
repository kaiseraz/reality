import type pg from 'pg';
import type { TaskStatus, TaskSummary } from '@reality/schemas';

interface TaskRow {
  id: string;
  request: string;
  status: TaskStatus;
  created_at: Date;
  updated_at: Date;
  bot_id: string | null;
}

function toSummary(row: TaskRow): TaskSummary {
  return {
    id: row.id,
    request: row.request,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    botId: row.bot_id ?? null,
  };
}

export class TaskRepo {
  constructor(private readonly pool: pg.Pool) {}

  async create(
    id: string,
    request: string,
    status: TaskStatus,
    ownerId: string | null = null,
    botId: string | null = null,
  ): Promise<TaskSummary> {
    const { rows } = await this.pool.query<TaskRow>(
      `INSERT INTO tasks (id, request, status, owner_id, bot_id) VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, request, status, ownerId, botId],
    );
    return toSummary(rows[0] as TaskRow);
  }

  async get(id: string): Promise<TaskSummary | undefined> {
    const { rows } = await this.pool.query<TaskRow>('SELECT * FROM tasks WHERE id = $1', [id]);
    return rows[0] ? toSummary(rows[0]) : undefined;
  }

  /** All tasks, or only those an account may see (its own; admins also see unowned ones). */
  async list(
    limit = 50,
    viewer?: { id: string; role: 'admin' | 'member' },
  ): Promise<TaskSummary[]> {
    const { rows } = viewer
      ? await this.pool.query<TaskRow>(
          `SELECT * FROM tasks t
           WHERE (owner_id = $2 OR ($3 AND owner_id IS NULL))
             AND NOT EXISTS (SELECT 1 FROM project_tasks p WHERE p.task_id = t.id)
           ORDER BY created_at DESC LIMIT $1`,
          [limit, viewer.id, viewer.role === 'admin'],
        )
      : await this.pool.query<TaskRow>(
          `SELECT * FROM tasks t
             WHERE NOT EXISTS (SELECT 1 FROM project_tasks p WHERE p.task_id = t.id)
             ORDER BY created_at DESC LIMIT $1`,
          [limit],
        );
    return rows.map(toSummary);
  }

  /** Tasks waiting for a decision, including project tasks, for one account or all. */
  async listWaiting(viewer?: { id: string; role: 'admin' | 'member' }): Promise<TaskSummary[]> {
    const { rows } = viewer
      ? await this.pool.query<TaskRow>(
          `SELECT * FROM tasks WHERE status = 'awaiting_approval'
             AND (owner_id = $1 OR ($2 AND owner_id IS NULL)) ORDER BY updated_at`,
          [viewer.id, viewer.role === 'admin'],
        )
      : await this.pool.query<TaskRow>(
          "SELECT * FROM tasks WHERE status = 'awaiting_approval' ORDER BY updated_at",
        );
    return rows.map(toSummary);
  }

  async listByStatus(statuses: readonly TaskStatus[]): Promise<TaskSummary[]> {
    const { rows } = await this.pool.query<TaskRow>(
      'SELECT * FROM tasks WHERE status = ANY($1) ORDER BY created_at',
      [statuses],
    );
    return rows.map(toSummary);
  }

  async setStatus(id: string, status: TaskStatus): Promise<void> {
    await this.pool.query('UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1', [
      id,
      status,
    ]);
  }
}
