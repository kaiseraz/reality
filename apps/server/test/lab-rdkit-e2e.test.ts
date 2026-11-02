import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import type { CheckResult, StepResult } from '../src/orchestrator/graph.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

/**
 * The adaptive lab, end to end with real network and real packages: a chemistry question
 * needs RDKit, the sandbox lacks it, Reality inspects the wheel, asks, installs it into an
 * isolated layer, runs its requirement test and then the simulation, which an independent
 * check verifies. Opt-in (downloads ~40 MB): RUN_NETWORK_TESTS=1.
 */
const enabled = process.env.RUN_NETWORK_TESTS === '1';

describe.skipIf(!enabled)('lab acquires RDKit at runtime (network)', () => {
  let runtime: Runtime;
  let dir: string;
  let taskId: string;

  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-rdkit-'));
    runtime = await createRuntime(
      loadConfig({
        AUTH: 'off',
        DATABASE_URL: TEST_DATABASE_URL,
        ARTIFACT_DIR: dir,
        CAPABILITY_DIR: dir,
      }),
      { planner: new RuleBasedPlanner(), analyst: null, chatModel: null, log: { error: () => {} } },
    );
  }, 60_000);
  afterAll(async () => {
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('plans the acquisition and asks before installing', async () => {
    const task = await runtime.tasks.create(
      '3D structure and descriptors of the caffeine molecule',
      {
        start: true,
      },
    );
    taskId = task.id;
    await runtime.tasks.settled(taskId);
    const spec = (await runtime.tasks.get(taskId))?.state?.spec;
    expect(spec?.workflow.map((s) => s.agent)).toEqual([
      'capability-agent',
      'lab-agent',
      'verification-agent',
    ]);
    await runtime.tasks.decide(taskId, { approved: true });
    await runtime.tasks.settled(taskId);
    const detail = await runtime.tasks.get(taskId);
    const pending = detail?.pendingApproval as {
      kind: string;
      proposal: { package: string; license: string };
    };
    expect(pending.kind).toBe('capability-approval');
    expect(pending.proposal.package).toBe('rdkit');
  }, 900_000);

  it('installs and tests RDKit, then simulates caffeine and verifies it', async () => {
    await runtime.tasks.decide(taskId, { approved: true });
    await runtime.tasks.settled(taskId);
    const detail = await runtime.tasks.get(taskId);
    const results = new Map(
      (detail?.state?.stepResults ?? []).map((r: StepResult) => [r.stepId, r]),
    );
    expect(results.get('acquire')?.status, results.get('acquire')?.detail).toBe('done');
    expect(results.get('simulate')?.status, results.get('simulate')?.detail).toBe('done');
    const summary = results.get('simulate')?.summary as { formula: string; mol_weight: number };
    expect(summary.formula).toBe('C8H10N4O2');
    expect(summary.mol_weight).toBeCloseTo(194.19, 1);
    const checks = (detail?.state?.verification ?? []) as CheckResult[];
    expect(checks[0]?.status, checks[0]?.detail).toBe('passed');
    expect((await runtime.capabilities.get('rdkit'))?.state).toBe('enabled');
  }, 900_000);
});
