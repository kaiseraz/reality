import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskSpec } from '@reality/schemas';
import { buildRecipeCode, getRecipe } from '../src/analysis/recipes.ts';
import type { ArtifactMeta } from '../src/artifacts/artifact-store.ts';
import { loadConfig } from '../src/config.ts';
import type { StepResult } from '../src/orchestrator/graph.ts';
import { FakePlanner } from '../src/planner/fake-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { createVerifier } from '../src/verification/verifier.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

/** Correlation and forecast: the recipe on known data, and checks against false claims. */
let runtime: Runtime;
let dir: string;

beforeAll(async () => {
  await resetTestDatabase();
  dir = await mkdtemp(join(tmpdir(), 'reality-corr-'));
  runtime = await createRuntime(
    loadConfig({ AUTH: 'off', DATABASE_URL: TEST_DATABASE_URL, ARTIFACT_DIR: dir }),
    { planner: new FakePlanner(), log: { error: () => {} } },
  );
}, 60_000);
afterAll(async () => {
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
});

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
}

/** y = 3x + noise; z is unrelated noise; a + b = y exactly (components). */
function correlated(): string {
  const r = rng(5);
  const lines = ['x,z,a,b,y'];
  for (let i = 0; i < 200; i++) {
    const x = r() * 10;
    const y = 3 * x + (r() - 0.5) * 6;
    const a = Math.round(y * 0.4 * 1000) / 1000;
    lines.push(
      `${x.toFixed(4)},${(r() * 10).toFixed(4)},${a},${(y - a).toFixed(6)},${y.toFixed(6)}`,
    );
  }
  return lines.join('\n') + '\n';
}

async function newTask(csv: string) {
  const taskId = (await runtime.tasks.create('t', { start: false })).id;
  const data = await runtime.artifacts.putCsv(taskId, 'data.csv', csv);
  return { taskId, data };
}

async function verify(
  taskId: string,
  resultCsv: string,
  claim: unknown,
  check: { name: string; params: Record<string, unknown> },
) {
  const result: ArtifactMeta = await runtime.artifacts.putCsv(taskId, 'result.csv', resultCsv, {
    kind: 'derived',
    runId: 'seeded',
    inputs: [],
  });
  const steps: StepResult[] = [
    { stepId: 'step', status: 'done', detail: '', artifacts: [result.ref.id], summary: claim },
  ];
  const spec = TaskSpec.parse({
    goal: 'x',
    requiredOutputs: ['x'],
    acceptanceCriteria: [{ id: 'ac', description: 'x', checkType: 'recompute', check }],
    workflow: [{ id: 'step', description: 'x', agent: 'analysis-agent' }],
  });
  const verifier = createVerifier({
    sandbox: runtime.sandbox,
    artifacts: runtime.artifacts,
    events: runtime.events,
  });
  const [r] = await verifier({ taskId, spec, stepResults: steps });
  return r!;
}

describe('correlate recipe and check', () => {
  const candidates = ['x', 'z', 'a', 'b'];
  let taskId = '';
  let resultCsv = '';
  let claim: Record<string, unknown> = {};

  it('finds the true driver, flags components and does not over-claim noise', async () => {
    const t = await newTask(correlated());
    taskId = t.taskId;
    const built = buildRecipeCode(getRecipe('correlate')!, { target: 'y', candidates });
    if (!('code' in built)) throw new Error(built.error);
    const exec = await runtime.sandbox.execute({
      taskId,
      kind: 'analysis',
      label: 'recipe:correlate',
      code: built.code,
      inputs: [{ name: 'data.csv', hostPath: runtime.artifacts.filePath(t.data) }],
    });
    expect(exec.result.status).toBe('succeeded');
    claim = exec.summary as Record<string, unknown>;
    const csvOut = exec.result.outputs.find((o) => o.name.endsWith('.csv'));
    resultCsv = csvOut ? await readFile(csvOut.path, 'utf8') : '';
    await exec.result.cleanup();
    expect(claim.top_variable).toBe('x');
    expect(claim.top_direction).toBe('positive');
    expect(claim.components).toEqual(['a', 'b']);
    expect(claim.significant_variables).toEqual(['x']);
  }, 60_000);

  const check = { name: 'correlation_matches', params: { step: 'step', target: 'y', candidates } };

  it('verifies the honest result', async () => {
    expect((await verify(taskId, resultCsv, claim, check)).status).toBe('passed');
  }, 60_000);

  it('catches a false claim about the strongest variable', async () => {
    const r = await verify(taskId, resultCsv, { ...claim, top_variable: 'z' }, check);
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r.evidence)).toContain('strongest variable');
  }, 60_000);

  it('catches a tampered coefficient', async () => {
    const tampered = resultCsv.replace(/^(x,\d+,)0\.9/m, '$10.5');
    expect(tampered).not.toBe(resultCsv);
    expect((await verify(taskId, tampered, claim, check)).status).toBe('failed');
  }, 60_000);
});

describe('forecast backtest check', () => {
  // 30 months: 2022-11 … 2025-04, value = 100 + month index.
  const months = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.UTC(2024, i, 1));
    return { date: d.toISOString().slice(0, 10), v: 100 + i };
  });
  const raw = 'month,sales\n' + months.map((m) => `${m.date},${m.v}`).join('\n') + '\n';
  const H = 3;
  // Backtest predictions off by +1 each: MAE 1. Naive (last training value, no period): the
  // last 3 actuals are 127, 128, 129 vs naive 126 → MAE 2.
  const rows = [
    'month,kind,sales,lower,upper',
    ...months.map((m) => `${m.date},actual,${m.v},,`),
    ...months.slice(-H).map((m) => `${m.date},backtest,${m.v + 1},,`),
    '2025-04-23,forecast,130,128,132',
    '2025-05-24,forecast,131,129,133',
    '2025-06-24,forecast,132,130,134',
  ];
  const resultCsv = rows.join('\n') + '\n';
  const claim = { backtest_mae: 1, naive_mae: 2, beats_naive: true };
  const check = {
    name: 'forecast_backtest_matches',
    params: { step: 'step', date: 'month', value: 'sales', horizon: H },
  };
  let taskId = '';

  beforeAll(async () => {
    taskId = (await newTask(raw)).taskId;
  });

  it('verifies a correct backtest claim', async () => {
    expect((await verify(taskId, resultCsv, claim, check)).status).toBe('passed');
  }, 60_000);

  it('catches an understated error and a false "beats naive"', async () => {
    const better = await verify(taskId, resultCsv, { ...claim, backtest_mae: 0.5 }, check);
    expect(better.status).toBe('failed');
    const worse = await verify(
      taskId,
      resultCsv,
      { backtest_mae: 1, naive_mae: 0.5, beats_naive: true },
      check,
    );
    expect(worse.status).toBe('failed');
  }, 60_000);

  it('accepts recent history only, but not an older slice passed off as recent', async () => {
    const csv = (keep: (r: string) => boolean) => rows.filter(keep).join('\n') + '\n';
    const recent = csv((r) => !/^2024-0[1-6]-01,actual/.test(r));
    expect((await verify(taskId, recent, claim, check)).status).toBe('passed');
    const older = csv((r) => !/^2025-03-24,actual/.test(r));
    const r = await verify(taskId, older, claim, check);
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r.evidence)).toContain('most recent');
  }, 60_000);

  it('catches altered history', async () => {
    const altered = resultCsv.replace('2022-12-23,actual,102', '2022-12-23,actual,999');
    expect((await verify(taskId, altered, claim, check)).status).toBe('failed');
  }, 60_000);
});
