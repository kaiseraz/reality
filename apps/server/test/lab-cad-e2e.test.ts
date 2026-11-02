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
 * Reality morphs into a CAD system: a jet engine request needs a geometry kernel, the
 * sandbox has none, Reality inspects OpenCascade's wheel, asks, installs it into an
 * isolated layer, tests it, builds a turbofan of ~1,800 named solids, exports STEP and
 * meshes, and an independent check recounts the parts and recomputes the volumes from the
 * meshes. Opt-in (downloads ~70 MB, builds for about a minute): RUN_NETWORK_TESTS=1.
 */
const enabled = process.env.RUN_NETWORK_TESTS === '1';

describe.skipIf(!enabled)('lab acquires a CAD kernel and designs a jet engine (network)', () => {
  let runtime: Runtime;
  let dir: string;
  let taskId: string;

  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-cad-'));
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

  it('plans the CAD kernel acquisition and asks before installing', async () => {
    const task = await runtime.tasks.create(
      'Design a detailed jet engine (turbofan) with 24 fan blades',
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
    expect(spec?.workflow[1]?.recipe).toMatchObject({
      name: 'turbofan',
      params: { fan_blades: 24 },
    });
    await runtime.tasks.decide(taskId, { approved: true });
    await runtime.tasks.settled(taskId);
    const pending = (await runtime.tasks.get(taskId))?.pendingApproval as {
      kind: string;
      proposal: { package: string };
    };
    expect(pending.kind).toBe('capability-approval');
    expect(pending.proposal.package).toBe('cadquery-ocp-novtk');
  }, 900_000);

  it('installs and tests the kernel, builds the engine, exports STEP and verifies it', async () => {
    await runtime.tasks.decide(taskId, { approved: true });
    await runtime.tasks.settled(taskId);
    const detail = await runtime.tasks.get(taskId);
    const results = new Map(
      (detail?.state?.stepResults ?? []).map((r: StepResult) => [r.stepId, r]),
    );
    expect(results.get('acquire')?.status, results.get('acquire')?.detail).toBe('done');
    expect(results.get('simulate')?.status, results.get('simulate')?.detail).toBe('done');
    const summary = results.get('simulate')?.summary as {
      part_count: number;
      blade_count: number;
      invalid_parts: number;
      unique_names: boolean;
    };
    expect(summary.part_count).toBeGreaterThan(1500);
    expect(summary.blade_count).toBeGreaterThan(1400);
    expect(summary).toMatchObject({ invalid_parts: 0, unique_names: true });
    const checks = (detail?.state?.verification ?? []) as CheckResult[];
    expect(checks[0]?.status, checks[0]?.detail).toBe('passed');
    const files = await runtime.files.forStep(taskId, 'simulate');
    expect(files.map((f) => f.name)).toContain('assembly.step');
    expect(files.filter((f) => f.name.endsWith('.stl')).length).toBeGreaterThanOrEqual(8);
    expect((await runtime.capabilities.get('ocp'))?.state).toBe('enabled');
  }, 900_000);
});
