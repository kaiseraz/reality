import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { classifyLicense } from './catalog.ts';
import { needWords, relevance } from './search.ts';

/**
 * Skills from GitHub: a folder with a SKILL.md (know-how for a kind of work) and perhaps scripts.
 * A skill is written to instruct a bot, which makes it the most direct way to attack one. So it is
 * handled like the rest of what comes from outside: code finds and pins it to one commit and reads
 * it as text, nothing of it runs, a person approves it on a card showing what it says, and it gets
 * no rights of its own: its text reaches a bot marked as third-party, its scripts run only on the
 * bot's computer, which holds no keys. The scan catches the crude attacks, not a clever one; what
 * limits a clever one is that a skill has nothing to reach for.
 */

export const MIN_SKILL_STARS = 100;
const MIN_REPO_AGE_DAYS = 90;
const MAX_BODY = 200_000;
const MAX_TOTAL = 2_000_000;
const MAX_FILES = 60;
const SKILLS_PER_REPO = 60;
/** Well-known collections that are always looked through. */
const COLLECTIONS = ['anthropics/skills', 'obra/superpowers'];
/** What these were last seen to be, for when GitHub's API limit is used up. */
const KNOWN_COLLECTIONS: Record<string, RepoInfo> = {
  'anthropics/skills': {
    stars: 185_000,
    license: null,
    createdAt: '2025-10-01T00:00:00Z',
    archived: false,
  },
  'obra/superpowers': {
    stars: 300_000,
    license: 'MIT',
    createdAt: '2025-10-01T00:00:00Z',
    archived: false,
  },
};
const TEXT_FILE = /\.(md|txt|py|sh|js|mjs|ts|json|ya?ml|toml|html|css|xml|csv|tsv)$/i;
const SCRIPT_FILE = /\.(py|sh|js|mjs|ts)$/i;

export interface SkillFile {
  path: string;
  text: string;
}

export interface SkillScan {
  /** Reasons it is not offered at all. */
  blocking: string[];
  /** Things the person should see before approving. */
  flags: string[];
  /** Hosts its text and scripts mention. */
  hosts: string[];
  scripts: string[];
  /** Files left out because they are not text. */
  skipped: string[];
}

export interface SkillRecord {
  id: string;
  ownerId: string | null;
  name: string;
  description: string;
  repo: string;
  path: string;
  commit: string;
  license: string;
  stars: number;
  body: string;
  files: SkillFile[];
  scan: SkillScan;
  state: 'proposed' | 'enabled' | 'denied';
  uses: number;
}

/** The frontmatter and body of a SKILL.md, read as plain text. */
export function parseSkillFile(
  text: string,
): { name: string; description: string; license: string; body: string } | null {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const fields: Record<string, string> = {};
  let key = '';
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv?.[1]) {
      key = kv[1].toLowerCase();
      fields[key] = kv[2] ?? '';
    } else if (key && /^\s+\S/.test(line)) {
      fields[key] = `${fields[key] ?? ''} ${line.trim()}`;
    }
  }
  const clean = (v: string | undefined) =>
    (v ?? '')
      .replace(/^\s*[>|][+-]?\s*/, '')
      .replace(/^["']|["']$/g, '')
      .trim();
  const name = clean(fields.name).toLowerCase();
  const description = clean(fields.description);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || !description) return null;
  return { name, description, license: clean(fields.license), body: m[2] ?? '' };
}

/** Characters nobody sees: a way to hide instructions from the person reading the card. */
const INVISIBLE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]|[\u{E0000}-\u{E007F}]/u;
const OVERRIDES =
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|system|all)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?)\b|\bdo not (tell|inform|show)\b[^.\n]{0,30}\b(user|person|human)\b/i;
const RISKY: [RegExp, string][] = [
  [/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'downloads a script and runs it'],
  [
    /base64\s+(-d|--decode)[^\n|]*\|\s*(ba|z)?sh\b|\beval\s*\(?\s*(atob|base64)/,
    'runs encoded code',
  ],
  [/~\/\.ssh|\.aws\/credentials|\/etc\/(passwd|shadow)|id_rsa/, 'mentions credential files'],
  [/\bprintenv\b|\bos\.environ\b|\bprocess\.env\b/, 'reads environment variables'],
  [/\b(sudo|chmod\s+777|rm\s+-rf\s+[/~])/, 'uses powerful system commands'],
  [
    /\b(api[_-]?key|token|password|secret)\b[^\n]{0,60}\b(send|post|upload|paste|share)\b/i,
    'talks of sending keys or tokens',
  ],
];

/** Reads everything as text; nothing of it runs. */
export function scanSkill(files: readonly SkillFile[], skipped: readonly string[] = []): SkillScan {
  const blocking: string[] = [];
  const flags = new Set<string>();
  const hosts = new Set<string>();
  for (const f of files) {
    if (INVISIBLE.test(f.text)) blocking.push(`${f.path} contains invisible characters`);
    if (OVERRIDES.test(f.text))
      blocking.push(`${f.path} tells a bot to ignore its rules or hide things`);
    for (const [pattern, what] of RISKY) {
      if (pattern.test(f.text)) flags.add(`${f.path} ${what}`);
    }
    for (const u of f.text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
      if (u[1]) hosts.add(u[1].toLowerCase());
    }
  }
  return {
    blocking,
    flags: [...flags],
    hosts: [...hosts].sort().slice(0, 30),
    scripts: files.filter((f) => SCRIPT_FILE.test(f.path)).map((f) => f.path),
    skipped: [...skipped],
  };
}

/** Whether a skill may be used: its own licence if it states one, else its repository's. */
export function skillLicense(
  declared: string,
  licenseFile: string,
  repoLicense: string | null,
): { allowed: boolean; license: string } {
  const own = `${declared} ${licenseFile.slice(0, 2000)}`;
  if (/proprietary|all rights reserved/i.test(own)) {
    return { allowed: false, license: 'proprietary' };
  }
  const name = /apache license|apache-2/i.test(own)
    ? 'Apache-2.0'
    : /\bMIT\b/.test(own)
      ? 'MIT'
      : /\bBSD\b/.test(own)
        ? 'BSD'
        : declared && classifyLicense(declared) === 'permissive'
          ? declared
          : '';
  if (name) return { allowed: true, license: name };
  if (repoLicense && classifyLicense(repoLicense) === 'permissive') {
    return { allowed: true, license: repoLicense };
  }
  return { allowed: false, license: declared || repoLicense || 'none stated' };
}

interface Row {
  id: string;
  owner_id: string | null;
  name: string;
  description: string;
  repo: string;
  path: string;
  commit_sha: string;
  license: string;
  stars: number;
  body: string;
  files: SkillFile[];
  scan: SkillScan;
  state: SkillRecord['state'];
  uses: number;
}
const toRecord = (r: Row): SkillRecord => ({
  id: r.id,
  ownerId: r.owner_id,
  name: r.name,
  description: r.description,
  repo: r.repo,
  path: r.path,
  commit: r.commit_sha,
  license: r.license,
  stars: r.stars,
  body: r.body,
  files: r.files,
  scan: r.scan,
  state: r.state,
  uses: r.uses,
});

interface RepoInfo {
  stars: number;
  license: string | null;
  createdAt: string;
  archived: boolean;
}
interface FoundSkill {
  repo: string;
  commit: string;
  dir: string;
  name: string;
  description: string;
  declared: string;
  info: RepoInfo;
  tree: string[];
  words: number;
}

export interface SkillDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** A token raises GitHub's limit of 60 requests an hour. Sent to api.github.com only. */
  githubToken?: string;
  /** Which of these plainly do something else (a model). It cannot add any. */
  ruleOut?: (need: string, skills: { package: string; says: string }[]) => Promise<string[]>;
  /** Which fits best (a model). It only orders what code let through. */
  best?: (need: string, skills: { package: string; says: string }[]) => Promise<string | null>;
}

export class SkillService {
  /** A repository's skills at a commit do not change; an hour of memory saves GitHub's limit. */
  private readonly repos = new Map<string, { at: number; skills: FoundSkill[] }>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly deps: SkillDeps = {},
  ) {}

  private get fetch() {
    return this.deps.fetchImpl ?? fetch;
  }

  private async github<T>(path: string): Promise<T | null> {
    const res = await this.fetch(`https://api.github.com${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        ...(this.deps.githubToken ? { authorization: `Bearer ${this.deps.githubToken}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (res?.status === 403 || res?.status === 429) {
      throw new Error('GitHub is limiting requests for now (set GITHUB_TOKEN to raise the limit).');
    }
    return res?.ok ? ((await res.json()) as T) : null;
  }

  private async raw(repo: string, commit: string, path: string): Promise<string | null> {
    const res = await this.fetch(
      `https://raw.githubusercontent.com/${repo}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`,
      { signal: AbortSignal.timeout(20_000) },
    ).catch(() => null);
    return res?.ok ? res.text() : null;
  }

  private async headCommit(repo: string): Promise<string | null> {
    const res = await this.fetch(
      `https://github.com/${repo}.git/info/refs?service=git-upload-pack`,
      {
        signal: AbortSignal.timeout(20_000),
      },
    ).catch(() => null);
    const sha = res?.ok ? /([0-9a-f]{40}) HEAD/.exec(await res.text())?.[1] : undefined;
    if (sha) return sha;
    return (await this.github<{ sha?: string }>(`/repos/${repo}/commits/HEAD`))?.sha ?? null;
  }

  private async filesAt(repo: string, sha: string): Promise<string[]> {
    const res = await this.fetch(
      `https://data.jsdelivr.com/v1/packages/gh/${repo}@${sha}?structure=flat`,
      { signal: AbortSignal.timeout(30_000) },
    ).catch(() => null);
    if (res?.ok) {
      const body = (await res.json().catch(() => null)) as { files?: { name?: string }[] } | null;
      const names = (body?.files ?? []).flatMap((f) => (f.name ? [f.name.replace(/^\//, '')] : []));
      if (names.length > 0) return names;
    }
    const tree = await this.github<{ tree?: { path?: string; type?: string }[] }>(
      `/repos/${repo}/git/trees/${sha}?recursive=1`,
    );
    return (tree?.tree ?? [])
      .filter((t) => t.type === 'blob' && t.path)
      .map((t) => t.path as string);
  }

  /** The skills a repository has, at its current commit; judged by code before anything else. */
  private async skillsIn(repo: string): Promise<FoundSkill[]> {
    const now = this.deps.now?.() ?? Date.now();
    const cached = this.repos.get(repo);
    if (cached && now - cached.at < 3_600_000) return cached.skills;
    // GitHub's API allows 60 requests an hour without a token, so it is the last resort: the
    // commit comes from git's own endpoint, the file list from jsDelivr. What only the API knows
    // (use, age) falls back to what is known about the collections Reality always looks through.
    let about: {
      stargazers_count?: number;
      license?: { spdx_id?: string } | null;
      created_at?: string;
      archived?: boolean;
    } | null = null;
    try {
      about = await this.github(`/repos/${repo}`);
    } catch (err) {
      if (!KNOWN_COLLECTIONS[repo]) throw err;
    }
    const known = KNOWN_COLLECTIONS[repo];
    const sha = await this.headCommit(repo);
    if ((!about && !known) || !sha) return [];
    const paths = await this.filesAt(repo, sha);
    const info: RepoInfo = about
      ? {
          stars: about.stargazers_count ?? 0,
          license:
            about.license?.spdx_id && about.license.spdx_id !== 'NOASSERTION'
              ? about.license.spdx_id
              : null,
          createdAt: about.created_at ?? '',
          archived: about.archived === true,
        }
      : (known as RepoInfo);
    const files = paths.filter((p) => /(^|\/)SKILL\.md$/.test(p)).slice(0, SKILLS_PER_REPO);
    const parsed = await Promise.all(
      files.map(async (p): Promise<FoundSkill | null> => {
        const text = await this.raw(repo, sha, p);
        const skill = text ? parseSkillFile(text) : null;
        if (!skill) return null;
        const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
        return {
          repo,
          commit: sha,
          dir,
          name: skill.name,
          description: skill.description,
          declared: skill.license,
          info,
          tree: paths.filter((q) => (dir ? q.startsWith(`${dir}/`) : !q.includes('/'))),
          words: 0,
        };
      }),
    );
    const skills = parsed.filter((s): s is FoundSkill => s !== null);
    this.repos.set(repo, { at: now, skills });
    return skills;
  }

  private async reposFor(need: string): Promise<string[]> {
    const words = needWords(need).slice(0, 3);
    const queries = [
      `${words.join(' ')} SKILL.md in:readme`,
      ...words.slice(0, 2).map((w) => `${w} topic:agent-skills`),
    ];
    const found = await Promise.all(
      queries.map((q) =>
        this.github<{ items?: { full_name?: string }[] }>(
          `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=3`,
        ).catch(() => null),
      ),
    );
    const named = found.flatMap((f) => f?.items ?? []).flatMap((i) => i.full_name ?? []);
    return [...new Set([...COLLECTIONS, ...named])]
      .filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r))
      .slice(0, 6);
  }

  /**
   * Looks for a skill and stores the best one that passes as "proposed". Names and descriptions
   * are read as data; which one is chosen rests on the words of the need, use, licence and the scan.
   */
  async find(
    need: string,
    ownerId: string | null,
  ): Promise<{ skill: SkillRecord; alternatives: string[] } | { detail: string }> {
    const words = needWords(need);
    if (words.length === 0) return { detail: 'Say what kind of work the skill is for.' };
    const now = this.deps.now?.() ?? Date.now();
    const notes: string[] = [];
    const repos = await this.reposFor(need);
    let limited = '';
    const all = (
      await Promise.all(
        repos.map((r) =>
          this.skillsIn(r).catch((err: Error) => {
            limited = err.message;
            return [] as FoundSkill[];
          }),
        ),
      )
    ).flat();
    if (limited) notes.push(limited);
    let ranked = all
      .map((s) => ({
        ...s,
        words: relevance(words, `${s.name.replace(/-/g, ' ')} ${s.description}`),
      }))
      .filter((s) => s.words > 0)
      .sort(
        (a, b) =>
          b.words +
          Math.log10(b.info.stars + 1) * 0.02 -
          (a.words + Math.log10(a.info.stars + 1) * 0.02),
      )
      .slice(0, 14);
    if (this.deps.ruleOut && ranked.length > 0) {
      const out = await this.deps
        .ruleOut(
          need,
          ranked.map((s) => ({
            package: `${s.repo}:${s.name}`,
            says: s.description.slice(0, 500),
          })),
        )
        .catch(() => [] as string[]);
      ranked = ranked.filter((s) => !out.includes(`${s.repo}:${s.name}`));
    }
    if (this.deps.best && ranked.length > 1) {
      const best = await this.deps
        .best(
          need,
          ranked.map((s) => ({
            package: `${s.repo}:${s.name}`,
            says: s.description.slice(0, 500),
          })),
        )
        .catch(() => null);
      ranked = [...ranked].sort(
        (a, b) => Number(`${b.repo}:${b.name}` === best) - Number(`${a.repo}:${a.name}` === best),
      );
    }
    const passing: { skill: SkillRecord }[] = [];
    for (const s of ranked) {
      const ageDays = (now - Date.parse(s.info.createdAt)) / 86_400_000;
      if (s.info.archived) notes.push(`${s.name}: its repository is archived`);
      else if (s.info.stars < MIN_SKILL_STARS) notes.push(`${s.name}: few people use ${s.repo}`);
      else if (!(ageDays >= MIN_REPO_AGE_DAYS)) notes.push(`${s.name}: ${s.repo} is too new`);
      else {
        const read = await this.read(s, ownerId);
        if ('why' in read) notes.push(`${s.name}: ${read.why}`);
        else passing.push({ skill: read.skill });
      }
      if (passing.length >= 3) break;
    }
    const first = passing[0];
    if (!first) {
      return {
        detail: `No skill for this passed the checks (looked through ${all.length}).${notes.length ? ` ${notes.slice(0, 6).join('; ')}.` : ''}`,
      };
    }
    // Only the one on the card is kept; a person never saw the others.
    await this.pool.query('DELETE FROM agent_skills WHERE id = ANY($1)', [
      passing.slice(1).map((p) => p.skill.id),
    ]);
    return {
      skill: first.skill,
      alternatives: passing.slice(1).map((p) => `${p.skill.name} (${p.skill.repo})`),
    };
  }

  /** Fetches everything at the pinned commit as text, judges it, stores it. Runs none of it. */
  private async read(
    s: FoundSkill,
    ownerId: string | null,
  ): Promise<{ skill: SkillRecord } | { why: string }> {
    const prefix = s.dir ? `${s.dir}/` : '';
    if (s.tree.length > MAX_FILES) return { why: `it has ${s.tree.length} files` };
    const text = s.tree.filter((p) => TEXT_FILE.test(p) && !p.split('/').includes('..'));
    const skipped = s.tree.filter((p) => !TEXT_FILE.test(p)).map((p) => p.slice(prefix.length));
    const fetched = await Promise.all(
      text.map(async (p) => ({
        path: p.slice(prefix.length),
        text: await this.raw(s.repo, s.commit, p),
      })),
    );
    const files = fetched.filter((f): f is SkillFile => f.text !== null);
    if (files.reduce((n, f) => n + f.text.length, 0) > MAX_TOTAL) return { why: 'it is too large' };
    const main = files.find((f) => f.path === 'SKILL.md');
    const parsed = main ? parseSkillFile(main.text) : null;
    if (!parsed || parsed.body.length > MAX_BODY) return { why: 'its SKILL.md cannot be used' };
    const licenseFile = files.find((f) => /^licen[sc]e(\.\w+)?$/i.test(f.path))?.text ?? '';
    const license = skillLicense(parsed.license, licenseFile, s.info.license);
    if (!license.allowed) return { why: `its licence does not allow this (${license.license})` };
    const scan = scanSkill(files, skipped);
    if (scan.blocking.length > 0) return { why: scan.blocking.join('; ') };
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO agent_skills
         (id, owner_id, name, description, repo, path, commit_sha, license, stars, body, files, scan)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        randomUUID(),
        ownerId,
        s.name,
        parsed.description.slice(0, 2000),
        s.repo,
        s.dir,
        s.commit,
        license.license,
        s.info.stars,
        parsed.body,
        JSON.stringify(files),
        JSON.stringify(scan),
      ],
    );
    return { skill: toRecord(rows[0] as Row) };
  }

  async get(id: string): Promise<SkillRecord | undefined> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM agent_skills WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  /** A person answered the card. Only what they saw, at that commit, becomes usable. */
  async decide(id: string, approved: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE agent_skills SET state = $2, files = CASE WHEN $2 = 'denied' THEN '[]'::jsonb ELSE files END
       WHERE id = $1 AND state = 'proposed'`,
      [id, approved ? 'enabled' : 'denied'],
    );
  }

  async enabled(ownerId: string | null): Promise<SkillRecord[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM agent_skills WHERE state = 'enabled' AND owner_id IS NOT DISTINCT FROM $1
       ORDER BY created_at`,
      [ownerId],
    );
    return rows.map(toRecord);
  }

  /** The approved skill of this name, counting the use. */
  async use(ownerId: string | null, name: string): Promise<SkillRecord | undefined> {
    const { rows } = await this.pool.query<Row>(
      `UPDATE agent_skills SET uses = uses + 1 WHERE id = (
         SELECT id FROM agent_skills
         WHERE state = 'enabled' AND owner_id IS NOT DISTINCT FROM $1 AND name = $2
         ORDER BY created_at DESC LIMIT 1) RETURNING *`,
      [ownerId, name],
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }
}
