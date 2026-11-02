import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import type { StepResult } from '../src/orchestrator/graph.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

/**
 * MCP servers as a capability source, end to end with the real mcp-server-motherduck
 * from PyPI. Opt-in (downloads ~60 MB): RUN_NETWORK_TESTS=1.
 */
const enabled = process.env.RUN_NETWORK_TESTS === '1';
const SAMPLE = new URL('../../../samples/sales_weekly.csv', import.meta.url);

describe.skipIf(!enabled)('MCP capability end to end (network)', () => {
  let runtime: Runtime;
  let dir: string;

  async function startTask(request: string) {
    const task = await runtime.tasks.create(request, { start: false });
    await runtime.artifacts.putCsv(task.id, 'sales_weekly.csv', await readFile(SAMPLE, 'utf8'));
    await runtime.tasks.start(task.id);
    await runtime.tasks.settled(task.id);
    return task.id;
  }
  const results = async (id: string) =>
    new Map(
      ((await runtime.tasks.get(id))?.state?.stepResults ?? []).map((r: StepResult) => [
        r.stepId,
        r,
      ]),
    );
  const verification = async (id: string) =>
    new Map(
      ((await runtime.tasks.get(id))?.state?.verification ?? []).map((c) => [c.criterionId, c]),
    );

  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-mcp-e2e-'));
    runtime = await createRuntime(
      loadConfig({
        AUTH: 'off',
        DATABASE_URL: TEST_DATABASE_URL,
        ARTIFACT_DIR: dir,
        CAPABILITY_DIR: dir,
      }),
      { planner: new RuleBasedPlanner(), log: { error: () => {} } },
    );
  }, 60_000);
  afterAll(async () => {
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  });

  let first: string;

  it('proposes an MCP server with its allowed tools before installing anything', async () => {
    first = await startTask(
      'Run SELECT region, SUM(revenue) AS total FROM data GROUP BY region ORDER BY total DESC',
    );
    await runtime.tasks.decide(first, { approved: true }); // the plan
    await runtime.tasks.settled(first);

    const detail = await runtime.tasks.get(first);
    expect(detail?.status).toBe('awaiting_approval');
    const pending = detail?.pendingApproval as { kind: string; proposal: Record<string, unknown> };
    expect(pending.kind).toBe('capability-approval');
    expect(pending.proposal.package).toBe('mcp-server-motherduck');
    expect(pending.proposal.kind).toBe('mcp-server');
    expect(pending.proposal.mcp).toMatchObject({ allowedTools: ['execute_query'] });
    expect(pending.proposal.blocking).toEqual([]);
    const candidates = pending.proposal.candidates as { package: string; eligible: boolean }[];
    expect(candidates.find((c) => c.package === 'mcp-server-duckdb')?.eligible).toBe(false);
  }, 900_000);

  it('installs into a volume, passes the MCP requirement test, runs the query, verifies it independently', async () => {
    await runtime.tasks.decide(first, { approved: true }); // the capability
    await runtime.tasks.settled(first);

    const r = await results(first);
    expect(r.get('acquire')?.status, r.get('acquire')?.detail).toBe('done');
    expect(r.get('query')?.status, r.get('query')?.detail).toBe('done');
    const summary = r.get('query')?.summary as { rows: number; columns: string[] };
    expect(summary).toMatchObject({ rows: 2, columns: ['region', 'total'] });

    const v = await verification(first);
    expect(v.get('sql')?.status, v.get('sql')?.detail).toBe('passed');
    expect(v.get('rows')?.status).toBe('passed');

    const cap = await runtime.capabilities.get('mcp-server-motherduck');
    expect(cap?.kind).toBe('mcp-server');
    expect(cap?.state).toBe('enabled');
    expect(cap?.layerPath).toMatch(/^volume:reality-cap-mcp-server-motherduck-/);
    const tested = (cap?.tests as { passed: boolean; result: { tools: { name: string }[] } }[])[0];
    expect(tested?.passed).toBe(true);
    expect(tested?.result.tools.map((t) => t.name)).toContain('execute_query');

    // The result appeared in the workspace as a table and a bar chart.
    const ws = await runtime.workspaces.getByTask(first);
    const views = Object.values(ws!.components).map((c) => `${c.type}:${String(c.props.title)}`);
    expect(views).toContain('DataTable:query_result.csv');
    expect(views.some((v) => v.startsWith('Chart:total by region'))).toBe(true);
  }, 900_000);

  it('reuses the server without reinstalling; DuckDB-only syntax is honestly not verified', async () => {
    const second = await startTask(
      'Run SELECT region, median(revenue) AS med FROM data GROUP BY ALL ORDER BY region',
    );
    const spec = (await runtime.tasks.get(second))?.state?.spec;
    expect(spec?.workflow.map((s) => s.id)).toEqual(['profile', 'query', 'verify']);
    await runtime.tasks.decide(second, { approved: true });
    await runtime.tasks.settled(second);

    expect((await results(second)).get('query')?.status).toBe('done');
    const v = await verification(second);
    expect(v.get('sql')?.status).toBe('unverified');
    expect(v.get('sql')?.detail).toMatch(/SQLite/);
    const installs = (await runtime.runs.listForTask(second)).filter((x) =>
      x.kind.startsWith('capability'),
    );
    expect(installs).toEqual([]);
  }, 600_000);

  it('refuses a write statement before it reaches the server', async () => {
    const task = await runtime.tasks.create('Run DELETE FROM data', { start: false });
    // Not a SELECT: the rule planner does not treat it as SQL, so no tool step exists.
    await runtime.artifacts.putCsv(task.id, 'x.csv', 'a,b\n1,2\n');
    await runtime.tasks.start(task.id);
    await runtime.tasks.settled(task.id);
    const plan = (await runtime.tasks.get(task.id))?.state?.spec;
    expect(plan?.workflow.some((s) => s.tool)).toBe(false);
  }, 120_000);
});
