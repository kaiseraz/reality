import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CapabilityEngine } from '../src/capabilities/engine.ts';
import { SecretStore } from '../src/capabilities/secrets.ts';
import { loadConfig } from '../src/config.ts';
import { LabPresets } from '../src/lab/plan.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

/**
 * The whole way for the three kinds of server, against the real registries and the real Docker:
 * a Node server with a key, a Python server behind the gateway, a hosted server.
 * Opt-in (downloads, needs the images): RUN_NETWORK_TESTS=1.
 */
const enabled = process.env.RUN_NETWORK_TESTS === '1';

describe.skipIf(!enabled)('tool servers of every kind (network)', () => {
  let runtime: Runtime;
  const engineOf = () => runtime.capabilityEngine as CapabilityEngine;
  let pool: pg.Pool;
  let dir: string;

  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-tools-e2e-'));
    runtime = await createRuntime(
      loadConfig({
        AUTH: 'off',
        COMPUTERS: 'on',
        DATABASE_URL: TEST_DATABASE_URL,
        ARTIFACT_DIR: dir,
        CAPABILITY_DIR: dir,
      }),
      { planner: new RuleBasedPlanner(), log: { error: () => {} } },
    );
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Asks the way a bot does, up to the card the person sees. */
  async function askFor(params: Record<string, unknown>) {
    const task = await runtime.tasks.create(`Get an MCP server: ${String(params.need)}`, {
      start: false,
    });
    await new LabPresets(pool).set(task.id, 'acquire_library', { mcp: true, ...params });
    await runtime.tasks.start(task.id);
    await runtime.tasks.settled(task.id);
    await runtime.tasks.decide(task.id, { approved: true, by: 'user' }); // the plan
    await runtime.tasks.settled(task.id);
    const detail = await runtime.tasks.get(task.id);
    expect(detail?.status, JSON.stringify(detail?.state?.stepResults ?? [])).toBe(
      'awaiting_approval',
    );
    const pending = detail?.pendingApproval as { proposal: Record<string, unknown> };
    return { taskId: task.id, proposal: pending.proposal };
  }

  async function approve(taskId: string) {
    await runtime.tasks.decide(taskId, { approved: true, by: 'user' });
    await runtime.tasks.settled(taskId);
    const detail = await runtime.tasks.get(taskId);
    const step = (detail?.state?.stepResults ?? []).find(
      (r: { stepId: string }) => r.stepId === 'acquire',
    );
    expect(step?.status, step?.detail).toBe('done');
  }

  it('a Node server from npm: nothing of it runs before approval, and it gets its key', async () => {
    const { taskId, proposal } = await askFor({
      need: 'mcp reference server that exercises all features of the protocol, everything server',
      secrets: ['REALITY_TEST_SETTING'],
    });
    expect(proposal.package).toBe('@modelcontextprotocol/server-everything');
    expect(proposal.runtime).toBe('node');
    expect(proposal.secrets).toEqual([{ name: 'REALITY_TEST_SETTING' }]);
    const id = String(proposal.capabilityId);
    expect((await runtime.capabilities.get(id))?.state).toBe('inspected');

    const value = 'value-that-must-never-surface-1234';
    await engineOf().setSecrets(id, { REALITY_TEST_SETTING: value, PATH: '/x' }, null);
    await approve(taskId);
    expect((await runtime.capabilities.get(id))?.state).toBe('enabled');

    const listed = await engineOf().listTools(id);
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    if (!listed.ok) return;
    const envTool = listed.tools.find((t) => /env/i.test(t.name));
    expect(envTool, listed.tools.map((t) => t.name).join()).toBeDefined();
    const out = await engineOf().callTool(id, String(envTool?.name), {}, []);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    // The server had the key in its environment; what comes back has it cut out.
    expect(out.text).toContain('REALITY_TEST_SETTING');
    expect(out.text).toContain('[secret removed]');
    expect(out.text).not.toContain(value);
    // And only the name that server declared was stored.
    const { rows } = await pool.query(
      'SELECT name FROM capability_secrets WHERE capability_id = $1',
      [id],
    );
    expect(rows.map((r: { name: string }) => r.name)).toEqual(['REALITY_TEST_SETTING']);
  }, 900_000);

  it('a server with a person-approved way out: that domain works, others are refused and named', async () => {
    const { taskId, proposal } = await askFor({
      need: 'fetch web pages and convert them to markdown',
      domains: ['example.com'],
    });
    expect(proposal.package).toBe('mcp-server-fetch');
    expect(proposal.domains).toContain('example.com');
    expect(proposal.domains).not.toContain('iana.org');
    await approve(taskId);

    const args = (url: string) => ({ url, raw: true });
    const fine = await engineOf().callTool(
      'mcp-server-fetch',
      'fetch',
      args('https://example.com/'),
      [],
    );
    expect(fine.ok, JSON.stringify(fine)).toBe(true);
    if (fine.ok) expect(fine.text).toMatch(/Example Domain/);

    const shut = await engineOf().callTool(
      'mcp-server-fetch',
      'fetch',
      args('https://www.iana.org/'),
      [],
    );
    expect(shut.ok).toBe(false);
    expect(shut.refused).toContain('www.iana.org');

    // The person allows it on a card; from the next call it works.
    await engineOf().allowDomain('mcp-server-fetch', 'iana.org');
    const open = await engineOf().callTool(
      'mcp-server-fetch',
      'fetch',
      args('https://www.iana.org/'),
      [],
    );
    expect(open.ok, JSON.stringify(open)).toBe(true);
  }, 900_000);

  it('files go into a tool and what it writes comes back', async () => {
    const dir2 = await mkdtemp(join(tmpdir(), 'reality-tool-files-'));
    try {
      const csv = join(dir2, 'sales.csv');
      await writeFile(csv, 'region,revenue\nNorth,10\nSouth,4\nNorth,20\n');
      const { taskId } = await askFor({ need: 'run sql queries over a csv file' });
      await approve(taskId);
      const saved: { name: string; text: string }[] = [];
      const out = await engineOf().callTool(
        'mcp-server-motherduck',
        'execute_query',
        {
          sql: "COPY (SELECT region, SUM(revenue) AS total FROM data GROUP BY region ORDER BY total DESC) TO '/output/totals.csv' (HEADER)",
        },
        [{ name: 'sales.csv', hostPath: csv }],
        null,
        async (f) => {
          saved.push({ name: f.name, text: await readFile(f.path, 'utf8') });
        },
      );
      expect(out.ok, JSON.stringify(out)).toBe(true);
      expect(saved[0]?.name).toBe('totals.csv');
      expect(saved[0]?.text).toMatch(/North,30/);
      expect(saved[0]?.text).toMatch(/South,4/);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  }, 900_000);

  it('a hosted server: nothing installed, it says who gets the data, tools come from the server', async () => {
    // The real server; the listing narrowed to it, so that this test does not depend on what else
    // the registry happens to rank higher that day.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('registry.modelcontextprotocol.io')) {
        return new Response(
          JSON.stringify({
            servers: [
              {
                server: {
                  name: 'com.microsoft/learn',
                  description: 'Search official Microsoft Learn documentation',
                  remotes: [
                    { type: 'streamable-http', url: 'https://learn.microsoft.com/api/mcp' },
                  ],
                },
                _meta: {
                  'io.modelcontextprotocol.registry/official': {
                    status: 'active',
                    publishedAt: '2025-06-01T00:00:00Z',
                  },
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404, ...(init ? {} : {}) });
    }) as typeof fetch;
    const engine = new CapabilityEngine({
      store: runtime.capabilities,
      sandbox: runtime.sandbox,
      events: runtime.events,
      runs: runtime.runs,
      dir,
      secrets: new SecretStore(pool, join(dir, '.secret-key')),
      search: { fetchImpl },
    });
    const task = await runtime.tasks.create('Get a hosted server', { start: false });
    const prepared = await engine.prepare('search microsoft learn documentation [mcp]', task.id);
    expect(prepared.kind, JSON.stringify(prepared)).toBe('proposal');
    if (prepared.kind !== 'proposal') return;
    const p = prepared.proposal as unknown as Record<string, unknown>;
    expect(p.hostedAt).toBe('learn.microsoft.com');
    expect(JSON.stringify(p.flags)).toMatch(/goes to learn\.microsoft\.com/);

    const installed = await engine.install(prepared.proposal, task.id);
    expect(installed.ok, JSON.stringify(installed)).toBe(true);
    const id = String(p.capabilityId);
    expect((await runtime.capabilities.get(id))?.layerPath).toMatch(/^remote:https:/);
    const listed = await engine.listTools(id);
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    if (!listed.ok) return;
    expect(listed.tools.length).toBeGreaterThan(0);
    const search = listed.tools.find((t) => /search/i.test(t.name));
    expect(search).toBeDefined();
    const out = await engine.callTool(
      id,
      String(search?.name),
      { query: 'Azure Functions overview' },
      [],
    );
    expect(out.ok, JSON.stringify(out)).toBe(true);
  }, 300_000);
});
