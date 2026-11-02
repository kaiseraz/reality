import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type pg from 'pg';

/**
 * API keys a person gives a tool server. They are written once through the approval card, stored
 * encrypted (AES-256-GCM), and read only by the engine at the moment it starts that server or
 * calls that hosted server. No API returns a value, the model never sees one, and a value that
 * comes back in a tool's output is cut out before a bot gets it. Only the person who set a secret
 * can have their bots use it.
 */

/** Names that would change how a program runs rather than configure a server. */
const FORBIDDEN =
  /^(PATH|HOME|USER|SHELL|PWD|LD_.*|DYLD_.*|PYTHON.*|NODE_.*|NPM_.*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|DOCKER_.*|MPLCONFIGDIR)$/i;

export const validSecretName = (n: string) =>
  /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(n) && !FORBIDDEN.test(n);

export class SecretStore {
  private key: Buffer | null = null;

  constructor(
    private readonly pool: pg.Pool,
    /** Where the key lives when SECRET_KEY is not set; outside the database, readable only here. */
    private readonly keyFile: string,
    private readonly configured?: string,
  ) {}

  private async getKey(): Promise<Buffer> {
    if (this.key) return this.key;
    if (this.configured) {
      this.key = createHash('sha256').update(this.configured).digest();
      return this.key;
    }
    if (!existsSync(this.keyFile)) {
      await mkdir(dirname(this.keyFile), { recursive: true });
      await writeFile(this.keyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
      await chmod(this.keyFile, 0o600).catch(() => undefined);
    }
    this.key = Buffer.from((await readFile(this.keyFile, 'utf8')).trim(), 'base64');
    if (this.key.length !== 32) throw new Error('The secret key file is damaged.');
    return this.key;
  }

  async set(capabilityId: string, name: string, value: string, owner: string | null) {
    if (!validSecretName(name)) throw new Error(`"${name}" cannot be used as a secret's name.`);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await this.getKey(), iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const sealed = [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
    await this.pool.query(
      `INSERT INTO capability_secrets (capability_id, name, owner_id, value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (capability_id, name)
       DO UPDATE SET owner_id = $3, value = $4, updated_at = now()`,
      [capabilityId, name, owner, sealed],
    );
  }

  /** The names set for a capability, and who set them. Values stay here. */
  async names(capabilityId: string): Promise<{ name: string; owner: string | null }[]> {
    const { rows } = await this.pool.query<{ name: string; owner_id: string | null }>(
      'SELECT name, owner_id FROM capability_secrets WHERE capability_id = $1',
      [capabilityId],
    );
    return rows.map((r) => ({ name: r.name, owner: r.owner_id }));
  }

  /** The values, for the engine alone, at the moment it starts or calls that server. */
  async reveal(capabilityId: string): Promise<Record<string, string>> {
    const { rows } = await this.pool.query<{ name: string; value: string }>(
      'SELECT name, value FROM capability_secrets WHERE capability_id = $1',
      [capabilityId],
    );
    const out: Record<string, string> = {};
    const key = await this.getKey();
    for (const r of rows) {
      const [iv, tag, body] = r.value.split('.').map((p) => Buffer.from(p, 'base64'));
      if (!iv || !tag || !body) continue;
      const d = createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      out[r.name] = Buffer.concat([d.update(body), d.final()]).toString('utf8');
    }
    return out;
  }
}

/** Cuts secret values out of text: a server may echo its key back in an error or a result. */
export function scrubSecrets(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of values) {
    if (v.length >= 4) out = out.split(v).join('[secret removed]');
  }
  return out;
}
