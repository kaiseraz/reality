import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskSummary } from '@reality/schemas';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { StepResult } from '../src/orchestrator/graph.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

const SAMPLE = new URL('../../../samples/sales_weekly.csv', import.meta.url);

let runtime: Runtime;
let app: ReturnType<typeof buildApp>;
let artifactDir: string;
let taskId: string;

beforeAll(async () => {
  await resetTestDatabase();
  artifactDir = await mkdtemp(join(tmpdir(), 'reality-analysis-'));
  const config = loadConfig({
    AUTH: 'off',
    DATABASE_URL: TEST_DATABASE_URL,
    PLANNER: 'rules',
    ARTIFACT_DIR: artifactDir,
  });
  // Hermetic: no capability sources (the real acquisition is covered by capability-e2e).
  runtime = await createRuntime(config, {
    planner: new RuleBasedPlanner(),
    log: { error: () => {} },
    capabilities: () => ({
      prepare: async () => ({
        kind: 'unavailable' as const,
        detail: 'Offline test: no capability sources.',
      }),
      install: async () => ({ ok: false as const, detail: 'unused' }),
      reject: async () => undefined,
      mountsFor: async (ids) => ({ ok: false as const, missing: [...ids] }),
    }),
  });
  expect(runtime.sandboxProblem).toBeNull();
  app = buildApp(config, runtime);

  const task = (
    await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        request: 'Is there a seasonal pattern in weekly revenue, and which regions drive it?',
        start: false,
      },
    })
  ).json<TaskSummary>();
  taskId = task.id;
  expect(task.status).toBe('draft');
  const upload = await app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/artifacts?filename=sales_weekly.csv`,
    headers: { 'content-type': 'text/csv' },
    payload: await readFile(SAMPLE, 'utf8'),
  });
  expect(upload.statusCode).toBe(201);
  expect((await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/start` })).statusCode).toBe(
    202,
  );
  await runtime.tasks.settled(taskId);
  await runtime.tasks.decide(taskId, { approved: true });
  await runtime.tasks.settled(taskId);
}, 180_000);

afterAll(async () => {
  await app.close();
  await runtime.close();
  await rm(artifactDir, { recursive: true, force: true });
});

const results = async () =>
  new Map(
    ((await runtime.tasks.get(taskId))?.state?.stepResults ?? []).map((r: StepResult) => [
      r.stepId,
      r,
    ]),
  );

describe('rule-based plan from the real schema', () => {
  it('plans profile, aggregation, decomposition (with a capability gap) and a regional breakdown', async () => {
    const spec = (await runtime.tasks.get(taskId))?.state?.spec;
    expect(spec?.workflow.map((s) => s.id)).toEqual([
      'profile',
      'aggregate',
      'acquire',
      'decompose',
      'breakdown',
      'season_by_group',
      'verify',
    ]);
    expect(spec?.missingCapabilities.map((m) => m.need)).toEqual(['time-series decomposition']);
    expect(spec?.workflow.find((s) => s.id === 'aggregate')?.recipe).toEqual({
      name: 'aggregate_time',
      params: { date: 'week', value: 'revenue' },
    });
    expect(spec?.risks.join(' ')).toMatch(/period 52 \(yearly cycle of weekly data\)/);
  });
});

describe('sandboxed execution', () => {
  it('runs recipes and produces correct, typed results', async () => {
    const r = await results();
    expect(r.get('profile')?.status).toBe('done');
    expect(r.get('aggregate')?.status).toBe('done');
    expect(r.get('breakdown')?.status).toBe('done');

    const totals = (r.get('aggregate')?.summary ?? {}) as { periods: number; total: number };
    const breakdown = (r.get('breakdown')?.summary ?? {}) as { top_group: string; total: number };
    expect(totals.periods).toBe(156);
    expect(breakdown.top_group).toBe('North'); // ground truth: North base 1000 vs South 800
    expect(Math.abs(totals.total - breakdown.total)).toBeLessThan(1e-6);
  });

  it('reports the missing capability honestly and skips what depends on it', async () => {
    const r = await results();
    expect(r.get('acquire')?.status).not.toBe('done');
    expect(r.get('decompose')?.status).toBe('skipped');
    expect(r.get('decompose')?.detail).toMatch(/depends on "acquire"/);
    expect(r.get('season_by_group')?.status).toBe('skipped');
  });

  it('records every run with its exact code and stores outputs with provenance', async () => {
    const runs = (await runtime.runs.listForTask(taskId)).filter((x) => x.kind === 'analysis');
    expect(runs.map((x) => x.label)).toEqual([
      'recipe:profile',
      'recipe:aggregate_time',
      'recipe:breakdown',
    ]);
    expect(runs.every((x) => x.status === 'succeeded' && x.code.includes('json.loads'))).toBe(true);

    const artifacts = await runtime.artifacts.listForTask(taskId);
    const derived = artifacts.filter((a) => a.provenance.kind === 'derived');
    expect(derived.map((a) => a.filename).sort()).toEqual([
      'profile.csv',
      'revenue_by_region.csv',
      'revenue_total_by_week.csv',
    ]);
    for (const a of derived) {
      expect(a.provenance).toMatchObject({ kind: 'derived', inputs: [artifacts[0]!.ref.id] });
    }
  });

  it('adds result views to the workspace: line chart for totals, bars for regions, no chart for the profile', async () => {
    const ws = await runtime.workspaces.getByTask(taskId);
    const charts = Object.values(ws!.components).filter((c) => c.type === 'Chart');
    const marks = charts.map((c) => `${c.props.mark}:${c.props.title}`).sort();
    expect(marks).toEqual([
      'bar:revenue by region',
      // The per-week totals chart would repeat the upload's chart title; it is not added twice.
      'line:revenue over week',
    ]);
    const tables = Object.values(ws!.components).filter((c) => c.type === 'DataTable');
    expect(tables.map((t) => t.props.title).sort()).toEqual([
      'profile.csv',
      'revenue_by_region.csv',
      'revenue_total_by_week.csv',
      'sales_weekly.csv',
    ]);
  });
});

describe('verification', () => {
  it('independently verifies completed results and marks the rest as not verified', async () => {
    const detail = await runtime.tasks.get(taskId);
    const v = new Map((detail?.state?.verification ?? []).map((c) => [c.criterionId, c]));
    expect(v.get('rows')?.status).toBe('passed');
    expect(v.get('totals')?.status).toBe('passed');
    expect(v.get('groups')?.status).toBe('passed');
    expect(v.get('decomposition')?.status).toBe('unverified');
    expect(v.get('decomposition')?.detail).toMatch(/did not complete/);
    expect(v.get('totals')?.evidence).toMatchObject({ passed: true, checked: 156 });
    const checkRuns = (await runtime.runs.listForTask(taskId)).filter((r) => r.kind === 'check');
    expect(checkRuns.map((r) => r.label).sort()).toEqual([
      'check:breakdown_sums',
      'check:row_count',
      'check:totals_match',
    ]);
  });
});
