import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';

export type Role = 'admin' | 'member';
export interface User {
  id: string;
  email: string;
  role: Role;
}

export class AuthError extends Error {
  constructor(
    readonly code: 'invalid_credentials' | 'exists' | 'setup_done' | 'weak_password',
    message: string,
  ) {
    super(message);
  }
}

const SESSION_DAYS = 30;
const MIN_PASSWORD = 10;
// scrypt cost: N=2^15, r=8, p=1 (about 32 MiB, ~50 ms): OWASP's recommended minimum.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;

function derive(password: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const normalize = (email: string) => email.trim().toLowerCase();

// Verifying against a fixed hash for unknown accounts keeps response times alike, so
// timing does not reveal which e-mail addresses have accounts.
let dummyHash: Promise<string> | undefined;

/** Accounts, password login and server-side sessions (only token hashes are stored). */
export class AuthService {
  constructor(private readonly pool: pg.Pool) {}

  async hasUsers(): Promise<boolean> {
    const { rows } = await this.pool.query('SELECT 1 FROM users LIMIT 1');
    return rows.length > 0;
  }

  /** First account only; it becomes the admin. */
  async setup(email: string, password: string): Promise<User> {
    if (await this.hasUsers()) throw new AuthError('setup_done', 'Setup is already complete.');
    return this.createUser(email, password, 'admin');
  }

  async createUser(email: string, password: string, role: Role): Promise<User> {
    if (password.length < MIN_PASSWORD) {
      throw new AuthError(
        'weak_password',
        `Use at least ${MIN_PASSWORD} characters for the password.`,
      );
    }
    const user: User = { id: randomUUID(), email: normalize(email), role };
    try {
      await this.pool.query(
        'INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, $4)',
        [user.id, user.email, await hashPassword(password), role],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AuthError('exists', 'An account with this e-mail already exists.');
      }
      throw err;
    }
    return user;
  }

  async listUsers(): Promise<(User & { createdAt: string })[]> {
    const { rows } = await this.pool.query<User & { created_at: Date }>(
      'SELECT id, email, role, created_at FROM users ORDER BY created_at',
    );
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async login(email: string, password: string): Promise<{ user: User; token: string }> {
    const { rows } = await this.pool.query<User & { password_hash: string }>(
      'SELECT id, email, role, password_hash FROM users WHERE email = $1',
      [normalize(email)],
    );
    const row = rows[0];
    if (!row) {
      dummyHash ??= hashPassword(randomBytes(12).toString('hex'));
      await verifyPassword(password, await dummyHash);
      throw new AuthError('invalid_credentials', 'E-mail or password is wrong.');
    }
    if (!(await verifyPassword(password, row.password_hash))) {
      throw new AuthError('invalid_credentials', 'E-mail or password is wrong.');
    }
    const user: User = { id: row.id, email: row.email, role: row.role };
    return { user, token: await this.createSession(user.id) };
  }

  async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, now() + make_interval(days => $3))`,
      [sha256(token), userId, SESSION_DAYS],
    );
    return token;
  }

  async userForSession(token: string | undefined): Promise<User | null> {
    if (!token) return null;
    const { rows } = await this.pool.query<User>(
      `SELECT u.id, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)],
    );
    return rows[0] ?? null;
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  }

  /** Whether the account may see a task: its own, or (admins) one created without accounts. */
  async canAccessTask(user: User, taskId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ owner_id: string | null }>(
      'SELECT owner_id FROM tasks WHERE id = $1',
      [taskId],
    );
    const row = rows[0];
    if (!row) return false;
    return row.owner_id === user.id || (row.owner_id === null && user.role === 'admin');
  }

  async canAccessBot(user: User, botId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ owner_id: string | null }>(
      'SELECT owner_id FROM bots WHERE id = $1',
      [botId],
    );
    const row = rows[0];
    if (!row) return false;
    return row.owner_id === user.id || (row.owner_id === null && user.role === 'admin');
  }

  async canAccessProject(user: User, projectId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ owner_id: string | null }>(
      'SELECT owner_id FROM projects WHERE id = $1',
      [projectId],
    );
    const row = rows[0];
    if (!row) return false;
    return row.owner_id === user.id || (row.owner_id === null && user.role === 'admin');
  }

  async taskOfWorkspace(workspaceId: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ task_id: string }>(
      'SELECT task_id FROM workspaces WHERE id = $1',
      [workspaceId],
    );
    return rows[0]?.task_id;
  }

  async taskOfFile(fileId: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ task_id: string }>(
      'SELECT task_id FROM task_files WHERE id = $1',
      [fileId],
    );
    return rows[0]?.task_id;
  }

  async taskOfArtifact(artifactId: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ task_id: string }>(
      'SELECT task_id FROM artifacts WHERE id = $1',
      [artifactId],
    );
    return rows[0]?.task_id;
  }
}

/** Failed logins per key (e-mail and client address), so passwords cannot be guessed quickly. */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    const recent = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.failures.set(key, recent);
    return recent.length >= this.max;
  }

  fail(key: string, now = Date.now()): void {
    this.failures.set(key, [...(this.failures.get(key) ?? []), now]);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
