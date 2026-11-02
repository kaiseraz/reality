import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type pg from 'pg';

/**
 * Knowledge: a person's own sources (notes, web pages, text files), split into
 * overlapping passages and searched with BM25. Deterministic, no model and no
 * embedding service needed; every hit names its source and line.
 */

const PASSAGE = 900;
const OVERLAP = 150;
const MAX_PASSAGES = 3000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SOURCES = 200;

export type SourceKind = 'note' | 'url' | 'file';

export interface KnowledgeSource {
  id: string;
  kind: SourceKind;
  name: string;
  url: string | null;
  status: 'ready' | 'empty' | 'failed';
  error: string | null;
  passages: number;
  words: number;
  createdAt: string;
}

export interface KnowledgeHit {
  sourceId: string;
  source: string;
  line: number;
  text: string;
  /** 0–1, relative to the best hit of this search. */
  score: number;
}

export class KnowledgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

/** HTML to readable text: scripts and styles out, tags out, common entities resolved. */
export function htmlToText(html: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    '#39': "'",
    nbsp: ' ',
    auml: 'ä',
    ouml: 'ö',
    uuml: 'ü',
    Auml: 'Ä',
    Ouml: 'Ö',
    Uuml: 'Ü',
    szlig: 'ß',
  };
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-zA-Z#0-9]+);/g, (m, e: string) => entities[e] ?? m)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

const STOP = new Set(
  (
    'der die das und oder aber wenn dann als auch für von mit bei nach aus dem den des ein eine ' +
    'ist sind war wird werden kann nicht nur noch sich sie er es wir ihr ' +
    'the and for that with this from are was were will can not you your our its have has what which how'
  ).split(' '),
);

export const tokenize = (s: string): string[] =>
  (s.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []).filter((t) => !STOP.has(t));

/** Overlapping passages so sentences are not torn apart; a short text is still one passage. */
export function passagesOf(text: string): { text: string; line: number }[] {
  const clean = text.replace(/\r\n/g, '\n');
  const out: { text: string; line: number }[] = [];
  for (let i = 0; i < clean.length && out.length < MAX_PASSAGES; i += PASSAGE - OVERLAP) {
    const slice = clean.slice(i, i + PASSAGE).trim();
    if (slice.length < 40) continue;
    out.push({ text: slice, line: clean.slice(0, i).split('\n').length });
  }
  if (out.length === 0 && clean.trim()) out.push({ text: clean.trim(), line: 1 });
  return out;
}

interface Doc {
  terms: Record<string, number>;
  length: number;
}

/** BM25 over all of a person's passages together, so hits from different sources compare. */
export function bm25(
  doc: Doc,
  query: string[],
  stats: { n: number; df: Map<string, number>; avgLength: number },
  k1 = 1.2,
  b = 0.75,
): number {
  let score = 0;
  for (const t of query) {
    const f = doc.terms[t];
    if (!f) continue;
    const n = stats.df.get(t) ?? 0;
    const idf = Math.log(1 + (stats.n - n + 0.5) / (n + 0.5));
    score +=
      idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / (stats.avgLength || 1))));
  }
  return score;
}

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/** Loopback, private, link-local and unique-local addresses: never fetched for a user. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) return PRIVATE_V4.some((r) => r.test(v4));
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

interface SourceRow {
  id: string;
  owner_id: string | null;
  kind: SourceKind;
  name: string;
  url: string | null;
  status: KnowledgeSource['status'];
  error: string | null;
  passages: number;
  words: number;
  created_at: Date;
}

const toSource = (r: SourceRow): KnowledgeSource => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  url: r.url,
  status: r.status,
  error: r.error,
  passages: r.passages,
  words: r.words,
  createdAt: r.created_at.toISOString(),
});

export class KnowledgeStore {
  constructor(
    private readonly pool: pg.Pool,
    /** Tests serve pages from localhost; production never fetches private addresses. */
    private readonly opts: { allowPrivateUrls?: boolean } = {},
  ) {}

  async list(ownerId: string | null): Promise<KnowledgeSource[]> {
    const { rows } = await this.pool.query<SourceRow>(
      'SELECT * FROM knowledge_sources WHERE owner_id IS NOT DISTINCT FROM $1 ORDER BY created_at',
      [ownerId],
    );
    return rows.map(toSource);
  }

  /** The source, only if it belongs to this owner. */
  async get(id: string, ownerId: string | null): Promise<KnowledgeSource | undefined> {
    const { rows } = await this.pool.query<SourceRow>(
      'SELECT * FROM knowledge_sources WHERE id = $1 AND owner_id IS NOT DISTINCT FROM $2',
      [id, ownerId],
    );
    return rows[0] ? toSource(rows[0]) : undefined;
  }

  async remove(id: string, ownerId: string | null): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM knowledge_sources WHERE id = $1 AND owner_id IS NOT DISTINCT FROM $2',
      [id, ownerId],
    );
    return (rowCount ?? 0) > 0;
  }

  async addNote(ownerId: string | null, name: string, text: string): Promise<KnowledgeSource> {
    return this.store(ownerId, 'note', name, null, text);
  }

  async addFile(ownerId: string | null, name: string, text: string): Promise<KnowledgeSource> {
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new KnowledgeError('File exceeds 2 MB.');
    if (text.includes('\u0000')) throw new KnowledgeError('This is not a text file.');
    const body = /\.html?$/i.test(name) ? htmlToText(text) : text;
    return this.store(ownerId, 'file', name, null, body);
  }

  async addUrl(ownerId: string | null, url: string, name?: string): Promise<KnowledgeSource> {
    const text = htmlToText(await this.fetchPage(url));
    return this.store(ownerId, 'url', name?.trim() || url, url, text);
  }

  /** Fetches a public web page, refusing private addresses at every redirect hop. */
  private async fetchPage(raw: string): Promise<string> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new KnowledgeError('Not a valid address.');
    }
    for (let hop = 0; hop < 4; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new KnowledgeError('Only http and https addresses can be added.');
      }
      if (!this.opts.allowPrivateUrls) {
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const addresses = isIP(host)
          ? [host]
          : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
        if (addresses.length === 0) throw new KnowledgeError(`Cannot resolve ${host}.`);
        if (addresses.some(isPrivateAddress)) {
          throw new KnowledgeError('Addresses in private or local networks are not fetched.');
        }
      }
      let res: Response;
      try {
        res = await fetch(url, {
          redirect: 'manual',
          headers: { 'user-agent': 'Reality/1.0 (knowledge source)' },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        throw new KnowledgeError(`The page is not reachable: ${(err as Error).message}`);
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url);
        continue;
      }
      if (!res.ok) throw new KnowledgeError(`The page answered ${res.status}.`);
      const type = res.headers.get('content-type') ?? '';
      if (type && !/text|html|json|xml/i.test(type)) {
        throw new KnowledgeError(`Only text pages can be added (got ${type}).`);
      }
      const body = await res.text();
      return body.slice(0, MAX_BYTES);
    }
    throw new KnowledgeError('Too many redirects.');
  }

  private async store(
    ownerId: string | null,
    kind: SourceKind,
    name: string,
    url: string | null,
    text: string,
  ): Promise<KnowledgeSource> {
    const { rows: count } = await this.pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM knowledge_sources WHERE owner_id IS NOT DISTINCT FROM $1',
      [ownerId],
    );
    if (Number(count[0]?.n ?? 0) >= MAX_SOURCES) {
      throw new KnowledgeError(`At most ${MAX_SOURCES} sources.`);
    }
    const id = randomUUID();
    const passages = passagesOf(text);
    const docs = passages.map((p) => {
      const tokens = tokenize(p.text);
      const terms: Record<string, number> = {};
      for (const t of tokens) terms[t] = (terms[t] ?? 0) + 1;
      return { ...p, terms, length: tokens.length };
    });
    const words = docs.reduce((s, d) => s + d.length, 0);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO knowledge_sources (id, owner_id, kind, name, url, status, error, passages, words)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          ownerId,
          kind,
          name.slice(0, 120),
          url,
          docs.length > 0 ? 'ready' : 'empty',
          docs.length > 0 ? null : 'No searchable text found.',
          docs.length,
          words,
        ],
      );
      for (const [i, d] of docs.entries()) {
        await client.query(
          `INSERT INTO knowledge_passages (source_id, position, line, text, terms, length)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, i, d.line, d.text, JSON.stringify(d.terms), d.length],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    const source = await this.get(id, ownerId);
    if (!source) throw new Error('knowledge source vanished');
    return source;
  }

  async search(ownerId: string | null, query: string, limit = 6): Promise<KnowledgeHit[]> {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];
    const { rows } = await this.pool.query<{
      source_id: string;
      name: string;
      line: number;
      text: string;
      terms: Record<string, number>;
      length: number;
    }>(
      `SELECT p.source_id, s.name, p.line, p.text, p.terms, p.length
         FROM knowledge_passages p JOIN knowledge_sources s ON s.id = p.source_id
        WHERE s.owner_id IS NOT DISTINCT FROM $1`,
      [ownerId],
    );
    if (rows.length === 0) return [];
    const df = new Map<string, number>();
    for (const r of rows) for (const t of terms) if (r.terms[t]) df.set(t, (df.get(t) ?? 0) + 1);
    const stats = {
      n: rows.length,
      df,
      avgLength: rows.reduce((s, r) => s + r.length, 0) / rows.length,
    };
    const scored = rows
      .map((r) => ({ r, score: bm25(r, terms, stats) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = scored[0]?.score ?? 1;
    return scored.slice(0, Math.max(1, Math.min(20, limit))).map(({ r, score }) => ({
      sourceId: r.source_id,
      source: r.name,
      line: r.line,
      text: r.text,
      score: Math.round((score / best) * 100) / 100,
    }));
  }
}
