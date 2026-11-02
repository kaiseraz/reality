import type pg from 'pg';

export type RunKind =
  | 'analysis'
  | 'check'
  | 'research'
  | 'capability-inspect'
  | 'capability-install'
  | 'capability-test';

export interface RunRecord {
  id: string;
  taskId: string | null;
  stepId: string | null;
  kind: RunKind;
  label: string;
  code: string;
  image: string;
  status: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  inputs: unknown;
  outputs: unknown;
  summary: unknown;
  createdAt: string;
}

interface Row {
  id: string;
  task_id: string | null;
  step_id: string | null;
  kind: RunKind;
  label: string;
  code: string;
  image: string;
  status: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  inputs: unknown;
  outputs: unknown;
  summary: unknown;
  created_at: Date;
}

const toRecord = (r: Row): RunRecord => ({
  id: r.id,
  taskId: r.task_id,
  stepId: r.step_id,
  kind: r.kind,
  label: r.label,
  code: r.code,
  image: r.image,
  status: r.status,
  exitCode: r.exit_code,
  stdout: r.stdout,
  stderr: r.stderr,
  durationMs: r.duration_ms,
  inputs: r.inputs,
  outputs: r.outputs,
  summary: r.summary,
  createdAt: r.created_at.toISOString(),
});

/** Append-only record of every sandbox execution: the exact code, limits, result. */
export class RunStore {
  constructor(private readonly pool: pg.Pool) {}

  async insert(r: Omit<RunRecord, 'createdAt'>): Promise<RunRecord> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO runs (id, task_id, step_id, kind, label, code, image, status, exit_code,
                         stdout, stderr, duration_ms, inputs, outputs, summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        r.id,
        r.taskId,
        r.stepId,
        r.kind,
        r.label,
        r.code,
        r.image,
        r.status,
        r.exitCode,
        r.stdout,
        r.stderr,
        r.durationMs,
        JSON.stringify(r.inputs),
        JSON.stringify(r.outputs),
        r.summary === undefined ? null : JSON.stringify(r.summary),
      ],
    );
    return toRecord(rows[0] as Row);
  }

  async listForTask(taskId: string): Promise<RunRecord[]> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM runs WHERE task_id = $1 ORDER BY created_at',
      [taskId],
    );
    return rows.map(toRecord);
  }
}
