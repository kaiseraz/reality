import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * Pages: documents that people and bots write together (reports, protocols, digests).
 * Every change is stored as a new version. That matters more than an approval: at night
 * nobody is there to approve, but a version can always be taken back. Nothing is lost,
 * and every version says who wrote it and, for results, which task it came from.
 */

const MAX_CONTENT = 400_000;
const MAX_VERSIONS = 200;
const MAX_PAGES = 500;

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

export class PageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageError';
  }
}

/** Someone else saved first: the writer must look at the newer version before overwriting it. */
export class PageConflictError extends Error {
  constructor(readonly current: number) {
    super(`The page changed meanwhile (now version ${current}). Reload it before saving.`);
    this.name = 'PageConflictError';
  }
}

interface SummaryRow {
  id: string;
  title: string;
  version: number;
  author: string;
  change: string;
  chars: number;
  created_at: Date;
  updated_at: Date;
}

const SUMMARY_SQL = `
  SELECT p.id, p.title, p.version, v.author, v.change, length(v.content) AS chars,
         p.created_at, p.updated_at
    FROM pages p JOIN page_versions v ON v.page_id = p.id AND v.version = p.version`;

const toSummary = (r: SummaryRow): PageSummary => ({
  id: r.id,
  title: r.title,
  version: r.version,
  author: r.author,
  change: r.change,
  chars: Number(r.chars),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const clean = (s: string, max: number) => s.slice(0, max);

export class PageStore {
  constructor(private readonly pool: pg.Pool) {}

  async list(ownerId: string | null): Promise<PageSummary[]> {
    const { rows } = await this.pool.query<SummaryRow>(
      `${SUMMARY_SQL} WHERE p.owner_id IS NOT DISTINCT FROM $1 ORDER BY p.updated_at DESC`,
      [ownerId],
    );
    return rows.map(toSummary);
  }

  /** The page, only if it belongs to this owner. */
  async get(id: string, ownerId: string | null): Promise<PageDetail | undefined> {
    const { rows } = await this.pool.query<SummaryRow & { content: string }>(
      `${SUMMARY_SQL.replace('length(v.content) AS chars', 'length(v.content) AS chars, v.content')}
        WHERE p.id = $1 AND p.owner_id IS NOT DISTINCT FROM $2`,
      [id, ownerId],
    );
    const row = rows[0];
    if (!row) return undefined;
    const { rows: versions } = await this.pool.query<{
      version: number;
      author: string;
      change: string;
      chars: number;
      task_id: string | null;
      created_at: Date;
    }>(
      `SELECT version, author, change, length(content) AS chars, task_id, created_at
         FROM page_versions WHERE page_id = $1 ORDER BY version DESC`,
      [id],
    );
    return {
      ...toSummary(row),
      content: row.content,
      versions: versions.map((v) => ({
        version: v.version,
        author: v.author,
        change: v.change,
        chars: Number(v.chars),
        taskId: v.task_id,
        createdAt: v.created_at.toISOString(),
      })),
    };
  }

  async version(
    id: string,
    ownerId: string | null,
    version: number,
  ): Promise<(PageVersionInfo & { content: string }) | undefined> {
    const { rows } = await this.pool.query<{
      version: number;
      author: string;
      change: string;
      content: string;
      task_id: string | null;
      created_at: Date;
    }>(
      `SELECT v.* FROM page_versions v JOIN pages p ON p.id = v.page_id
        WHERE v.page_id = $1 AND v.version = $2 AND p.owner_id IS NOT DISTINCT FROM $3`,
      [id, version, ownerId],
    );
    const v = rows[0];
    return v
      ? {
          version: v.version,
          author: v.author,
          change: v.change,
          chars: v.content.length,
          content: v.content,
          taskId: v.task_id,
          createdAt: v.created_at.toISOString(),
        }
      : undefined;
  }

  async create(
    ownerId: string | null,
    input: { title: string; content: string; author: string; change?: string; taskId?: string },
  ): Promise<PageDetail> {
    const title = clean(input.title.trim(), 160);
    if (!title) throw new PageError('A page needs a title.');
    const { rows } = await this.pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM pages WHERE owner_id IS NOT DISTINCT FROM $1',
      [ownerId],
    );
    if (Number(rows[0]?.n ?? 0) >= MAX_PAGES) throw new PageError(`At most ${MAX_PAGES} pages.`);
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO pages (id, owner_id, title, version) VALUES ($1, $2, $3, 1)',
        [id, ownerId, title],
      );
      await client.query(
        `INSERT INTO page_versions (page_id, version, content, author, change, task_id)
         VALUES ($1, 1, $2, $3, $4, $5)`,
        [
          id,
          clean(input.content, MAX_CONTENT),
          clean(input.author, 80),
          clean(input.change ?? 'Created', 200),
          input.taskId ?? null,
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    const page = await this.get(id, ownerId);
    if (!page) throw new Error('page vanished');
    return page;
  }

  /**
   * Saves a new version. With baseVersion, the save is refused if someone saved in between
   * (a person and a routine writing at the same time must not overwrite each other).
   * A save that changes nothing creates no version.
   */
  async write(
    id: string,
    ownerId: string | null,
    input: {
      content?: string;
      /** Applied to the newest content inside the same transaction (safe for appending). */
      append?: string;
      title?: string;
      author: string;
      change: string;
      baseVersion?: number;
      taskId?: string;
    },
  ): Promise<PageDetail | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ version: number; title: string; content: string }>(
        `SELECT p.version, p.title, v.content
           FROM pages p JOIN page_versions v ON v.page_id = p.id AND v.version = p.version
          WHERE p.id = $1 AND p.owner_id IS NOT DISTINCT FROM $2
          FOR UPDATE OF p`,
        [id, ownerId],
      );
      const cur = rows[0];
      if (!cur) {
        await client.query('ROLLBACK');
        return undefined;
      }
      if (input.baseVersion !== undefined && input.baseVersion !== cur.version) {
        throw new PageConflictError(cur.version);
      }
      let content = input.content ?? cur.content;
      if (input.append !== undefined) {
        content = `${content}${content.trim() ? '\n\n' : ''}${input.append}`;
      }
      if (content.length > MAX_CONTENT)
        throw new PageError('The page is longer than 400,000 characters.');
      const title = input.title?.trim() ? clean(input.title.trim(), 160) : cur.title;
      if (content === cur.content && title === cur.title) {
        await client.query('ROLLBACK');
        return this.get(id, ownerId);
      }
      const next = cur.version + 1;
      if (content !== cur.content) {
        await client.query(
          `INSERT INTO page_versions (page_id, version, content, author, change, task_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            id,
            next,
            content,
            clean(input.author, 80),
            clean(input.change, 200),
            input.taskId ?? null,
          ],
        );
        await client.query(
          'UPDATE pages SET version = $2, title = $3, updated_at = now() WHERE id = $1',
          [id, next, title],
        );
        // Keep the newest versions; the first one stays as the origin of the page.
        await client.query(
          `DELETE FROM page_versions WHERE page_id = $1 AND version > 1 AND version <= $2`,
          [id, next - MAX_VERSIONS],
        );
      } else {
        await client.query('UPDATE pages SET title = $2, updated_at = now() WHERE id = $1', [
          id,
          title,
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return this.get(id, ownerId);
  }

  /** Taking a version back is itself a new version: the newer ones stay available. */
  async restore(
    id: string,
    ownerId: string | null,
    version: number,
    author: string,
  ): Promise<PageDetail | undefined> {
    const old = await this.version(id, ownerId, version);
    if (!old) return undefined;
    return this.write(id, ownerId, {
      content: old.content,
      author,
      change: `Restored version ${version}`,
    });
  }

  async remove(id: string, ownerId: string | null): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM pages WHERE id = $1 AND owner_id IS NOT DISTINCT FROM $2',
      [id, ownerId],
    );
    return (rowCount ?? 0) > 0;
  }
}
