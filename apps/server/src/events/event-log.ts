import { EventEmitter } from 'node:events';
import type pg from 'pg';
import type { Actor, EventType, TaskEvent } from '@reality/schemas';

interface EventRow {
  id: string; // bigserial arrives as string
  task_id: string;
  type: EventType;
  actor: Actor;
  payload: unknown;
  created_at: Date;
}

function toEvent(row: EventRow): TaskEvent {
  return {
    id: Number(row.id),
    taskId: row.task_id,
    type: row.type,
    actor: row.actor,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Durable, append-only event log with in-process fan-out for live subscribers (SSE).
 * Subscribers that reconnect replay from the database using the last id they saw,
 * so nothing depends on the in-memory emitter surviving a restart.
 */
export class EventLog {
  private readonly bus = new EventEmitter();

  constructor(private readonly pool: pg.Pool) {
    this.bus.setMaxListeners(0);
  }

  async append(taskId: string, type: EventType, actor: Actor, payload: unknown = {}) {
    const { rows } = await this.pool.query<EventRow>(
      `INSERT INTO events (task_id, type, actor, payload) VALUES ($1, $2, $3, $4) RETURNING *`,
      [taskId, type, actor, JSON.stringify(payload)],
    );
    const event = toEvent(rows[0] as EventRow);
    this.bus.emit(taskId, event);
    return event;
  }

  async list(taskId: string, afterId = 0): Promise<TaskEvent[]> {
    const { rows } = await this.pool.query<EventRow>(
      'SELECT * FROM events WHERE task_id = $1 AND id > $2 ORDER BY id',
      [taskId, afterId],
    );
    return rows.map(toEvent);
  }

  subscribe(taskId: string, listener: (event: TaskEvent) => void): () => void {
    this.bus.on(taskId, listener);
    return () => this.bus.off(taskId, listener);
  }
}
