import type pg from 'pg';
import { canTransition, type CapabilityState } from '@reality/schemas';

export interface WheelInfo {
  file: string;
  name: string;
  version: string | null;
  license: string;
  sha256: string;
  size: number;
  pth_files: string[];
  console_scripts: number;
  /** The console scripts as "name = module:function" lines (first ten). */
  scripts?: string[];
  native_libs: number;
  files: number;
  in_base: boolean;
  requires: number;
  error?: string;
}

export interface CapabilityRecord {
  id: string;
  need: string;
  kind: 'python-package' | 'mcp-server';
  package: string;
  version: string | null;
  state: CapabilityState;
  license: string | null;
  source: { registry: 'pypi' | 'npm' | 'hosted'; package: string; version: string | null };
  inspection: unknown;
  tests: unknown;
  layerPath: string | null;
  permissions: { network: 'none'; mount: 'read-only'; path: string };
  limitations: string[];
  uses: number;
  history: { at: string; from: CapabilityState | null; to: CapabilityState; reason: string }[];
  updatedAt: string;
}

interface Row {
  id: string;
  need: string;
  kind: 'python-package' | 'mcp-server';
  package: string;
  version: string | null;
  state: CapabilityState;
  license: string | null;
  source: CapabilityRecord['source'];
  inspection: unknown;
  tests: unknown;
  layer_path: string | null;
  permissions: CapabilityRecord['permissions'];
  limitations: string[];
  uses: number;
  history: CapabilityRecord['history'];
  updated_at: Date;
}

const toRecord = (r: Row): CapabilityRecord => ({
  id: r.id,
  need: r.need,
  kind: r.kind,
  package: r.package,
  version: r.version,
  state: r.state,
  license: r.license,
  source: r.source,
  inspection: r.inspection,
  tests: r.tests,
  layerPath: r.layer_path,
  permissions: r.permissions,
  limitations: r.limitations,
  uses: r.uses,
  history: r.history,
  updatedAt: r.updated_at.toISOString(),
});

export class IllegalTransitionError extends Error {}

/**
 * The capability registry. State changes go through transition(), which enforces the
 * lifecycle (discovered → inspected → tested → enabled → trusted, or → rejected).
 * No agent tool can write this table; only the engine does.
 */
export class CapabilityStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(id: string): Promise<CapabilityRecord | undefined> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM capabilities WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async list(): Promise<CapabilityRecord[]> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM capabilities ORDER BY updated_at DESC',
    );
    return rows.map(toRecord);
  }

  /** Starts (or restarts) a capability at "discovered" for a specific version. */
  /** Changes what is recorded about a capability without moving it (a domain a person allowed). */
  async setInspection(id: string, inspection: unknown): Promise<void> {
    await this.pool.query(
      'UPDATE capabilities SET inspection = $2, updated_at = now() WHERE id = $1',
      [id, JSON.stringify(inspection)],
    );
  }

  async discover(r: {
    id: string;
    need: string;
    package: string;
    version: string;
    license: string;
    reason: string;
    kind?: 'python-package' | 'mcp-server';
    registry?: 'pypi' | 'npm' | 'hosted';
  }): Promise<CapabilityRecord> {
    const entry = {
      at: new Date().toISOString(),
      from: null,
      to: 'discovered' as const,
      reason: r.reason,
    };
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO capabilities (id, need, kind, package, version, state, license, source, permissions, history)
       VALUES ($1, $2, $9, $3, $4, 'discovered', $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         need = EXCLUDED.need, kind = EXCLUDED.kind, version = EXCLUDED.version, state = 'discovered', license = EXCLUDED.license,
         source = EXCLUDED.source, inspection = NULL, tests = NULL, layer_path = NULL,
         history = capabilities.history || EXCLUDED.history, updated_at = now()
       RETURNING *`,
      [
        r.id,
        r.need,
        r.package,
        r.version,
        r.license,
        JSON.stringify({ registry: r.registry ?? 'pypi', package: r.package, version: r.version }),
        JSON.stringify({ network: 'none', mount: 'read-only', path: `/caps/${r.id}` }),
        JSON.stringify([entry]),
        r.kind ?? 'python-package',
      ],
    );
    return toRecord(rows[0] as Row);
  }

  async transition(
    id: string,
    to: CapabilityState,
    reason: string,
    fields: Partial<
      Pick<CapabilityRecord, 'inspection' | 'tests' | 'layerPath' | 'limitations'>
    > = {},
  ): Promise<CapabilityRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<Row>(
        'SELECT * FROM capabilities WHERE id = $1 FOR UPDATE',
        [id],
      );
      const current = rows[0];
      if (!current) throw new IllegalTransitionError(`Unknown capability ${id}`);
      if (!canTransition(current.state, to)) {
        throw new IllegalTransitionError(`${id}: ${current.state} → ${to} is not allowed`);
      }
      const entry = { at: new Date().toISOString(), from: current.state, to, reason };
      const { rows: updated } = await client.query<Row>(
        `UPDATE capabilities SET state = $2, history = history || $3::jsonb, updated_at = now(),
           inspection = COALESCE($4, inspection), tests = COALESCE($5, tests),
           layer_path = COALESCE($6, layer_path), limitations = COALESCE($7, limitations)
         WHERE id = $1 RETURNING *`,
        [
          id,
          to,
          JSON.stringify([entry]),
          fields.inspection === undefined ? null : JSON.stringify(fields.inspection),
          fields.tests === undefined ? null : JSON.stringify(fields.tests),
          fields.layerPath ?? null,
          fields.limitations === undefined ? null : JSON.stringify(fields.limitations),
        ],
      );
      await client.query('COMMIT');
      return toRecord(updated[0] as Row);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Appends a history note without changing state (e.g. a user denial for one task). */
  async note(id: string, reason: string): Promise<void> {
    const current = await this.get(id);
    if (!current) return;
    const entry = { at: new Date().toISOString(), from: current.state, to: current.state, reason };
    await this.pool.query(
      'UPDATE capabilities SET history = history || $2::jsonb, updated_at = now() WHERE id = $1',
      [id, JSON.stringify([entry])],
    );
  }

  async incrementUses(id: string): Promise<number> {
    const { rows } = await this.pool.query<{ uses: number }>(
      'UPDATE capabilities SET uses = uses + 1, updated_at = now() WHERE id = $1 RETURNING uses',
      [id],
    );
    return rows[0]?.uses ?? 0;
  }
}
