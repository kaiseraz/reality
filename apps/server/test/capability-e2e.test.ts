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
 * The MVP's central demonstration, end to end with real network and real packages:
 * a task needs seasonal decomposition, the base sandbox lacks it, Reality discovers,
 * inspects, asks, installs, tests and uses statsmodels — then reuses it.
 * Opt-in (downloads ~60 MB): RUN_NETWORK_TESTS=1.
 */
const enabled = process.env.RUN_NETWORK_TESTS === '1';
const SAMPLE = new URL('../../../samples/sales_weekly.csv', import.meta.url);
const REQUEST = 'Is there a seasonal pattern in weekly revenue, and which regions drive it?';

describe.skipIf(!enabled)('capability acquisition end to end (network)', () => {
  let runtime: Runtime;
  let dir: string;

  async function startTask() {
    const task = await runtime.tasks.create(REQUEST, { start: false });
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

  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-e2e-'));
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

  it('asks for approval with a full inspection report before installing anything', async () => {
    first = await startTask();
    await runtime.tasks.decide(first, { approved: true }); // the plan
    await runtime.tasks.settled(first);

    const detail = await runtime.tasks.get(first);
    expect(detail?.status).toBe('awaiting_approval');
    const pending = detail?.pendingApproval as { kind: string; proposal: Record<string, unknown> };
    expect(pending.kind).toBe('capability-approval');
    expect(pending.proposal.package).toBe('statsmodels');
    expect(pending.proposal.blocking).toEqual([]);
    const names = (pending.proposal.wheels as { name: string }[]).map((w) => w.name);
    expect(names).toContain('statsmodels');
    expect(names).not.toContain('numpy'); // already in the base image
    expect((await runtime.capabilities.get('statsmodels'))?.state).toBe('inspected');
    expect((await results(first)).get('decompose')).toBeUndefined(); // nothing ran yet
  }, 900_000);

  it('installs, tests, enables and then uses the capability', async () => {
    await runtime.tasks.decide(first, { approved: true }); // the capability
    await runtime.tasks.settled(first);

    const r = await results(first);
    expect(r.get('acquire')?.status, r.get('acquire')?.detail).toBe('done');
    expect(r.get('decompose')?.status, r.get('decompose')?.detail).toBe('done');
    expect(r.get('season_by_group')?.status, r.get('season_by_group')?.detail).toBe('done');

    const decomposition = r.get('decompose')?.summary as {
      seasonal_strength: number;
      significant: boolean;
      p_value: number;
    };
    expect(decomposition.seasonal_strength).toBeGreaterThan(0.8); // strong, as generated
    expect(decomposition.significant).toBe(true);
    expect(decomposition.p_value).toBeLessThan(0.05);
    const byRegion = r.get('season_by_group')?.summary as { top_group: string };
    expect(byRegion.top_group).toBe('North'); // ground truth: amplitude 300 vs 120

    const cap = await runtime.capabilities.get('statsmodels');
    expect(cap?.state).toBe('enabled');
    expect(cap?.history.map((h) => h.to)).toEqual(['discovered', 'inspected', 'tested', 'enabled']);
    expect((cap?.tests as { passed: boolean }[])[0]?.passed).toBe(true);

    const v = new Map(
      ((await runtime.tasks.get(first))?.state?.verification ?? []).map((c) => [c.criterionId, c]),
    );
    expect(v.get('decomposition')?.status).toBe('passed');
    expect([...v.values()].every((c) => c.status === 'passed')).toBe(true);

    const ws = await runtime.workspaces.getByTask(first);
    const facetCharts = Object.values(ws!.components).filter(
      (c) => c.type === 'Chart' && c.props.row,
    );
    expect(facetCharts).toHaveLength(1); // the decomposition view appeared
  }, 900_000);

  it('reuses the enabled capability in a new task without asking or reinstalling', async () => {
    const second = await startTask();
    const spec = (await runtime.tasks.get(second))?.state?.spec;
    expect(spec?.workflow.map((s) => s.id)).not.toContain('acquire');
    expect(spec?.missingCapabilities).toEqual([]);
    await runtime.tasks.decide(second, { approved: true });
    await runtime.tasks.settled(second);
    expect((await runtime.tasks.get(second))?.status).toBe('completed');
    expect((await results(second)).get('decompose')?.status).toBe('done');

    const installs = (await runtime.runs.listForTask(second)).filter((x) =>
      x.kind.startsWith('capability'),
    );
    expect(installs).toEqual([]);
    expect((await runtime.capabilities.get('statsmodels'))?.state).toBe('trusted'); // 4 successful uses
  }, 600_000);
});
