import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskSpec } from '@reality/schemas';
import { loadConfig } from '../src/config.ts';
import type { StepResult } from '../src/orchestrator/graph.ts';
import { FakePlanner } from '../src/planner/fake-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { createVerifier } from '../src/verification/verifier.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

/** M4: seeded wrong answers must be detected by the independent checks. */
const RAW = [
  'week,region,revenue',
  '2025-01-06,North,100',
  '2025-01-06,South,50',
  '2025-01-13,North,120',
  '2025-01-13,South,30',
].join('\n');

let runtime: Runtime;
let dir: string;
let taskId: string;

beforeAll(async () => {
  await resetTestDatabase();
  dir = await mkdtemp(join(tmpdir(), 'reality-verify-'));
  runtime = await createRuntime(
    loadConfig({ AUTH: 'off', DATABASE_URL: TEST_DATABASE_URL, ARTIFACT_DIR: dir }),
    {
      planner: new FakePlanner(),
      log: { error: () => {} },
    },
  );
  taskId = (await runtime.tasks.create('verify', { start: false })).id;
  await runtime.artifacts.putCsv(taskId, 'raw.csv', RAW);
}, 60_000);
afterAll(async () => {
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
});

const spec = (check: { name: string; params: Record<string, unknown> }) =>
  TaskSpec.parse({
    goal: 'x',
    requiredOutputs: ['x'],
    acceptanceCriteria: [{ id: 'ac', description: 'x', checkType: 'recompute', check }],
    workflow: [{ id: 'step', description: 'x', agent: 'analysis-agent' }],
  });

async function verify(resultCsv: string, check: { name: string; params: Record<string, unknown> }) {
  const result = await runtime.artifacts.putCsv(taskId, 'result.csv', resultCsv, {
    kind: 'derived',
    runId: 'seeded',
    inputs: [],
  });
  const steps: StepResult[] = [
    { stepId: 'step', status: 'done', detail: '', artifacts: [result.ref.id] },
  ];
  const verifier = createVerifier({
    sandbox: runtime.sandbox,
    artifacts: runtime.artifacts,
    events: runtime.events,
  });
  const [r] = await verifier({ taskId, spec: spec(check), stepResults: steps });
  return r!;
}

const totals = { name: 'totals_match', params: { step: 'step', date: 'week', value: 'revenue' } };
const groups = {
  name: 'breakdown_sums',
  params: { step: 'step', group: 'region', value: 'revenue' },
};

describe('independent checks', () => {
  it('pass correct totals', async () => {
    const r = await verify('week,revenue\n2025-01-06,150\n2025-01-13,150', totals);
    expect(r.status).toBe('passed');
  });

  it('catch a single wrong weekly total and name it', async () => {
    const r = await verify('week,revenue\n2025-01-06,150\n2025-01-13,151', totals);
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r.evidence)).toContain('2025-01-13');
  });

  it('catch a missing date', async () => {
    const r = await verify('week,revenue\n2025-01-06,150', totals);
    expect(r.status).toBe('failed');
  });

  it('pass a correct breakdown and catch shares that do not sum to 1', async () => {
    const ok = await verify(
      'region,revenue,share\nNorth,220,0.733333333333333333\nSouth,80,0.266666666666666667',
      groups,
    );
    expect(ok.status).toBe('passed');
    const bad = await verify('region,revenue,share\nNorth,220,0.7\nSouth,80,0.2', groups);
    expect(bad.status).toBe('failed');
  });

  it('reports unverified, not passed, when the step did not complete', async () => {
    const verifier = createVerifier({
      sandbox: runtime.sandbox,
      artifacts: runtime.artifacts,
      events: runtime.events,
    });
    const [r] = await verifier({
      taskId,
      spec: spec(totals),
      stepResults: [{ stepId: 'step', status: 'failed', detail: 'boom' }],
    });
    expect(r?.status).toBe('unverified');
  });

  it('never runs the check code outside the sandbox (recorded as a check run)', async () => {
    const runs = await runtime.runs.listForTask(taskId);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.kind === 'check' && r.code.includes('import csv'))).toBe(true);
    expect(
      await readFile(new URL('../src/verification/checks.ts', import.meta.url), 'utf8'),
    ).not.toMatch(/import pandas/);
  });
});
