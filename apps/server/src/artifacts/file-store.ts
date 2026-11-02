import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

/**
 * Binary results of a step that are not tables: CAD assemblies (STEP), meshes (STL) and
 * similar. Stored content-addressed next to the artifacts, tied to the task and step that
 * made them, downloadable by whoever may see the task.
 */

export interface StoredFile {
  id: string;
  taskId: string | null;
  stepId: string | null;
  /** Set for files of a chat: only that person gets them. */
  ownerId: string | null;
  name: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

const MEDIA: Record<string, string> = {
  step: 'model/step',
  stp: 'model/step',
  stl: 'model/stl',
  glb: 'model/gltf-binary',
  json: 'application/json',
  txt: 'text/plain',
};

export const mediaTypeOf = (name: string) =>
  MEDIA[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

interface Row {
  id: string;
  task_id: string | null;
  step_id: string | null;
  owner_id: string | null;
  name: string;
  media_type: string;
  size_bytes: string;
  sha256: string;
  created_at: Date;
}

const toFile = (r: Row): StoredFile => ({
  id: r.id,
  taskId: r.task_id,
  stepId: r.step_id,
  ownerId: r.owner_id,
  name: r.name,
  mediaType: r.media_type,
  sizeBytes: Number(r.size_bytes),
  sha256: r.sha256,
  createdAt: r.created_at.toISOString(),
});

export class FileStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly dir: string,
  ) {}

  async put(
    taskId: string | null,
    stepId: string | null,
    name: string,
    hostPath: string,
    ownerId: string | null = null,
  ): Promise<StoredFile> {
    const data = await readFile(hostPath);
    const sha256 = createHash('sha256').update(data).digest('hex');
    await mkdir(join(this.dir, 'files'), { recursive: true });
    await copyFile(hostPath, join(this.dir, 'files', sha256));
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO task_files (id, task_id, step_id, name, media_type, size_bytes, sha256, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [randomUUID(), taskId, stepId, name, mediaTypeOf(name), data.length, sha256, ownerId],
    );
    const row = rows[0];
    if (!row) throw new Error('file not stored');
    return toFile(row);
  }

  async get(id: string): Promise<StoredFile | undefined> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM task_files WHERE id = $1', [id]);
    return rows[0] ? toFile(rows[0]) : undefined;
  }

  async forStep(taskId: string, stepId: string): Promise<StoredFile[]> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM task_files WHERE task_id = $1 AND step_id = $2 ORDER BY name',
      [taskId, stepId],
    );
    return rows.map(toFile);
  }

  filePath(f: StoredFile): string {
    return join(this.dir, 'files', f.sha256);
  }
}
