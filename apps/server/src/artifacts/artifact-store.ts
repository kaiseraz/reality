import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Papa from 'papaparse';
import type pg from 'pg';
import type { ArtifactRef } from '@reality/schemas';
import type { Column, ColumnType } from '@reality/workspace';

export const MAX_CSV_BYTES = 20 * 1024 * 1024;
const MAX_COLUMNS = 200;

export class ArtifactRejectedError extends Error {}

/** Where an artifact came from. Derived artifacts name the run and inputs that produced them. */
export type Provenance =
  | { kind: 'upload' }
  | { kind: 'derived'; runId: string; stepId?: string; recipe?: string; inputs: string[] }
  /** A cleaned copy of an upload made by trusted core code; every change is listed. */
  | { kind: 'prepared'; from: string; notes: string[] }
  /** The main result of another task in the same project, handed over as input data. */
  | { kind: 'handoff'; fromTask: string; artifact: string };

/** A no-data marker made only of 9s (e.g. -9.99, -99.99, -0.99, -999), as used in many data files. */
const NINES = /^-(9+(\.9+)?|0?\.9+)$/;

/**
 * Cleans an upload for analysis, conservatively, and says exactly what it changed:
 * - comment lines are dropped (they are not data);
 * - negative all-9s values (e.g. -9.99) in a column whose other values are all ≥ 0 are
 *   treated as missing; other suspicious values (e.g. -1) are only flagged;
 * - without a date column, `year` + `month` (+ `day`) columns become a `date` column.
 * Returns undefined when nothing needs to change.
 */
export function prepareCsv(text: string): { text: string; notes: string[] } | undefined {
  const notes: string[] = [];
  const commentLines = text.split(/\r?\n/).filter((l) => COMMENT_LINE.test(l)).length;
  if (commentLines > 0) notes.push(`Dropped ${commentLines} comment lines (starting with "#").`);

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    comments: '#',
  });
  const fields = parsed.meta.fields ?? [];
  const rows = parsed.data.map((r) => ({ ...r }));
  if (fields.length === 0 || rows.length === 0) return undefined;

  for (const name of fields) {
    const values = rows.map((r) => (r[name] ?? '').trim()).filter((v) => v !== '');
    if (values.length === 0 || !values.every((v) => NUMBER.test(v))) continue;
    const markers = [...new Set(values.filter((v) => NINES.test(v)))];
    const others = values.filter((v) => !NINES.test(v)).map(Number);
    if (markers.length === 1 && others.length > 0 && others.every((n) => n >= 0)) {
      const marker = markers[0] as string;
      const count = values.filter((v) => v === marker).length;
      for (const r of rows) if ((r[name] ?? '').trim() === marker) r[name] = '';
      notes.push(
        `Column "${name}": ${count} values of ${marker} treated as missing (no-data marker; all other values are ≥ 0).`,
      );
    } else if (
      others.length > 0 &&
      others.filter((n) => n < 0).every((n) => n === -1) &&
      others.some((n) => n === -1) &&
      others.filter((n) => n >= 0).length > others.length / 2
    ) {
      const count = others.filter((n) => n === -1).length;
      notes.push(
        `Column "${name}": -1 appears ${count} times while all other values are ≥ 0; it may mean "no data" but was kept as a number.`,
      );
    }
  }

  const byName = (re: RegExp) => fields.find((f) => re.test(f.trim()));
  const hasDate = fields.some((f) => {
    const values = rows.map((r) => (r[f] ?? '').trim()).filter((v) => v !== '');
    return values.length > 0 && values.every((v) => DATE.test(v));
  });
  const yearCol = byName(/^(year|yyyy)$/i);
  const monthCol = byName(/^(month|mm)$/i);
  const dayCol = byName(/^(day|dd)$/i);
  const intIn = (col: string, lo: number, hi: number) =>
    rows.every((r) => {
      const n = Number((r[col] ?? '').trim());
      return Number.isInteger(n) && n >= lo && n <= hi;
    });
  let outFields = fields;
  if (
    !hasDate &&
    yearCol &&
    monthCol &&
    !fields.includes('date') &&
    intIn(yearCol, 1000, 3000) &&
    intIn(monthCol, 1, 12) &&
    (!dayCol || intIn(dayCol, 1, 31))
  ) {
    const pad = (v: string) => v.trim().padStart(2, '0');
    for (const r of rows) {
      r.date = `${(r[yearCol] ?? '').trim()}-${pad(r[monthCol] ?? '')}-${dayCol ? pad(r[dayCol] ?? '') : '01'}`;
    }
    outFields = ['date', ...fields];
    notes.push(
      `Added column "date" from "${yearCol}" and "${monthCol}"${dayCol ? ` and "${dayCol}"` : ' (first day of each month)'}.`,
    );
  }

  if (notes.length === 0) return undefined;
  return {
    text: Papa.unparse({
      fields: outFields,
      data: rows.map((r) => outFields.map((f) => r[f] ?? '')),
    }),
    notes,
  };
}

export interface ArtifactMeta {
  provenance: Provenance;
  ref: ArtifactRef;
  taskId: string;
  filename: string;
  sizeBytes: number;
  rowCount: number;
  columns: Column[];
}

type Cell = string | number | null;
interface Parsed {
  columns: Column[];
  rows: Record<string, Cell>[];
}

const NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function inferType(values: string[]): ColumnType {
  const present = values.map((v) => v.trim()).filter((v) => v !== '');
  if (present.length === 0) return 'string';
  if (present.every((v) => NUMBER.test(v))) return 'number';
  if (present.every((v) => DATE.test(v) && !Number.isNaN(Date.parse(v)))) return 'date';
  return 'string';
}

const COMMENT_LINE = /^[ \t]*#/;

function columnStats(name: string, values: string[]): Column {
  const present = values.map((v) => v.trim()).filter((v) => v !== '');
  const type = inferType(values);
  const column: Column = { name, type, distinct: new Set(present).size };
  if (type === 'number' && present.length > 0) {
    const nums = present.map(Number);
    column.integer = nums.every((n) => Number.isInteger(n));
    column.min = Math.min(...nums);
    column.max = Math.max(...nums);
  }
  if (type === 'date' && present.length > 0) {
    const sorted = [...present].sort();
    const [first, last] = [sorted[0], sorted.at(-1)];
    if (first !== undefined && last !== undefined) {
      column.minDate = first;
      column.maxDate = last;
    }
  }
  return column;
}

function parseCsv(text: string): Parsed {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    // Lines starting with "#" are comments (common in scientific data files).
    comments: '#',
  });
  const fatal = result.errors.find((e) => e.type === 'Delimiter' || e.type === 'Quotes');
  if (fatal) throw new ArtifactRejectedError(`CSV parse error: ${fatal.message}`);

  // papaparse silently renames duplicate headers (a, a_1); treat that as an error.
  if (result.meta.renamedHeaders && Object.keys(result.meta.renamedHeaders).length > 0) {
    throw new ArtifactRejectedError('Duplicate column names.');
  }
  const names = result.meta.fields ?? [];
  if (names.length === 0) throw new ArtifactRejectedError('CSV has no header row.');
  if (names.length > MAX_COLUMNS)
    throw new ArtifactRejectedError(`More than ${MAX_COLUMNS} columns.`);
  if (names.some((n) => n.trim() === '')) throw new ArtifactRejectedError('Empty column name.');
  if (new Set(names).size !== names.length)
    throw new ArtifactRejectedError('Duplicate column names.');
  if (result.data.length === 0) throw new ArtifactRejectedError('CSV has no data rows.');

  const columns = names.map((name) =>
    columnStats(
      name,
      result.data.map((r) => r[name] ?? ''),
    ),
  );
  const rows = result.data.map((raw) => {
    const row: Record<string, Cell> = {};
    for (const c of columns) {
      const v = (raw[c.name] ?? '').trim();
      row[c.name] = v === '' ? null : c.type === 'number' ? Number(v) : v;
    }
    return row;
  });
  return { columns, rows };
}

interface ArtifactRow {
  id: string;
  task_id: string;
  sha256: string;
  media_type: string;
  filename: string;
  size_bytes: number;
  row_count: number;
  columns: Column[];
  provenance: Provenance;
}

function toMeta(r: ArtifactRow): ArtifactMeta {
  return {
    provenance: r.provenance,
    ref: { id: r.id, sha256: r.sha256, mediaType: r.media_type },
    taskId: r.task_id,
    filename: r.filename,
    sizeBytes: r.size_bytes,
    rowCount: r.row_count,
    columns: r.columns,
  };
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Writes a content-addressed file once. The same content always has the same name, so a
 * file that is already there is already right; otherwise it is written to a temporary name
 * and moved into place, so two tasks storing the same data at once (on Windows the second
 * open fails with EBUSY) never collide or leave a half-written file.
 */
async function storeOnce(path: string, text: string): Promise<void> {
  if (await exists(path)) return;
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    // Another writer got there first with the same content: that is fine.
    if (!(await exists(path))) throw err;
  }
}

/**
 * Content-addressed storage for task data. Files live on disk by SHA-256; metadata
 * (including inferred column types) lives in Postgres. Parsed rows are cached in memory.
 */
export class ArtifactStore {
  private readonly cache = new Map<string, Parsed>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly dir: string,
  ) {}

  async putCsv(
    taskId: string,
    filename: string,
    text: string,
    provenance: Provenance = { kind: 'upload' },
  ): Promise<ArtifactMeta> {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_CSV_BYTES) throw new ArtifactRejectedError('File exceeds 20 MB.');
    const parsed = parseCsv(text);
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');

    await mkdir(this.dir, { recursive: true });
    await storeOnce(join(this.dir, sha256), text);
    this.cache.set(sha256, parsed);

    const safeName = filename.replace(/[^\w.\- ()]+/g, '_').slice(0, 200) || 'data.csv';
    const { rows } = await this.pool.query<ArtifactRow>(
      `INSERT INTO artifacts (id, task_id, sha256, media_type, filename, size_bytes, row_count, columns, provenance)
       VALUES ($1, $2, $3, 'text/csv', $4, $5, $6, $7, $8) RETURNING *`,
      [
        randomUUID(),
        taskId,
        sha256,
        safeName,
        bytes,
        parsed.rows.length,
        JSON.stringify(parsed.columns),
        JSON.stringify(provenance),
      ],
    );
    return toMeta(rows[0] as ArtifactRow);
  }

  /**
   * Stores a user upload unchanged and, if it needs cleaning (see prepareCsv), a prepared
   * copy that becomes the working dataset. Both are returned; the notes list every change.
   */
  async putUpload(
    taskId: string,
    filename: string,
    text: string,
  ): Promise<{ original: ArtifactMeta; prepared?: ArtifactMeta }> {
    const original = await this.putCsv(taskId, filename, text);
    const prep = prepareCsv(text);
    if (!prep) return { original };
    const base = filename.replace(/\.csv$/i, '');
    const prepared = await this.putCsv(taskId, `${base} (prepared).csv`, prep.text, {
      kind: 'prepared',
      from: original.ref.id,
      notes: prep.notes,
    });
    return { original, prepared };
  }

  /** Host path of the stored file (content-addressed), e.g. to mount into a sandbox. */
  filePath(meta: ArtifactMeta): string {
    return join(this.dir, meta.ref.sha256);
  }

  async get(id: string): Promise<ArtifactMeta | undefined> {
    const { rows } = await this.pool.query<ArtifactRow>('SELECT * FROM artifacts WHERE id = $1', [
      id,
    ]);
    return rows[0] ? toMeta(rows[0]) : undefined;
  }

  async getMany(ids: readonly string[]): Promise<ArtifactMeta[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query<ArtifactRow>(
      'SELECT * FROM artifacts WHERE id = ANY($1)',
      [ids],
    );
    return rows.map(toMeta);
  }

  async listForTask(taskId: string): Promise<ArtifactMeta[]> {
    const { rows } = await this.pool.query<ArtifactRow>(
      'SELECT * FROM artifacts WHERE task_id = $1 ORDER BY created_at',
      [taskId],
    );
    return rows.map(toMeta);
  }

  async rows(
    meta: ArtifactMeta,
    query: { offset: number; limit: number; sort?: string | undefined; desc?: boolean | undefined },
  ): Promise<{ columns: Column[]; total: number; offset: number; rows: Record<string, Cell>[] }> {
    const parsed = await this.load(meta.ref.sha256);
    let rows = parsed.rows;
    if (query.sort !== undefined) {
      const col = parsed.columns.find((c) => c.name === query.sort);
      if (!col) throw new ArtifactRejectedError(`Unknown column "${query.sort}".`);
      const dir = query.desc ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const x = a[col.name] ?? null;
        const y = b[col.name] ?? null;
        if (x === y) return 0;
        if (x === null) return 1; // nulls last regardless of direction
        if (y === null) return -1;
        return (x < y ? -1 : 1) * dir;
      });
    }
    return {
      columns: parsed.columns,
      total: rows.length,
      offset: query.offset,
      rows: rows.slice(query.offset, query.offset + query.limit),
    };
  }

  private async load(sha256: string): Promise<Parsed> {
    const hit = this.cache.get(sha256);
    if (hit) return hit;
    const text = await readFile(join(this.dir, sha256), 'utf8');
    const actual = createHash('sha256').update(text, 'utf8').digest('hex');
    if (actual !== sha256) throw new Error(`Artifact ${sha256} failed integrity check.`);
    const parsed = parseCsv(text);
    this.cache.set(sha256, parsed);
    return parsed;
  }
}
