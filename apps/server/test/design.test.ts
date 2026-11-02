import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskSpec } from '@reality/schemas';
import { loadConfig } from '../src/config.ts';
import { getLabEngine } from '../src/lab/engines.ts';
import { labPlan, LabPresets } from '../src/lab/plan.ts';
import type { CheckResult, StepResult } from '../src/orchestrator/graph.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { validatePlan } from '../src/planner/semantics.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

describe('assembly design (pure)', () => {
  it('validates specs and rejects malformed ones', () => {
    const engine = getLabEngine('design_assembly')!;
    // The built-in example is a valid spec.
    expect(engine.params.safeParse({}).success).toBe(true);
    const bad = (parts: unknown) => engine.params.safeParse({ parts }).success;
    expect(bad([{ name: 'A', kind: 'box', dims: { dx: 1, dy: 1, dz: 1 } }])).toBe(true);
    expect(bad([{ name: 'A', kind: 'teapot', dims: {} }])).toBe(false);
    expect(bad([{ name: 'has space', kind: 'box', dims: {} }])).toBe(false);
    expect(bad([])).toBe(false);
    expect(bad([{ name: 'A', kind: 'box', dims: {}, pattern: { type: 'polar', count: 1 } }])).toBe(
      false,
    );
  });

  it('plans two independent checks: the geometry and the design', () => {
    const spec = TaskSpec.parse(labPlan('design_assembly', {}, 'q', ['ocp'], 'test').draft);
    expect(spec.workflow.map((s) => s.agent)).toEqual(['lab-agent', 'verification-agent']);
    expect(spec.acceptanceCriteria.map((c) => c.check?.name)).toEqual([
      'cad_assembly_recomputed',
      'assembly_design_recomputed',
    ]);
    expect(validatePlan(spec, { datasets: [], availableCapabilities: ['ocp'] })).toEqual([]);
  });
});

/**
 * Builds assemblies on the CAD kernel (acquired after approval, ~70 MB).
 * Opt-in: RUN_NETWORK_TESTS=1.
 */
describe.skipIf(process.env.RUN_NETWORK_TESTS !== '1')('assembly design (network)', () => {
  let runtime: Runtime;
  let presets: LabPresets;
  let pool: pg.Pool;
  let dir: string;
  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-design-'));
    runtime = await createRuntime(
      loadConfig({
        AUTH: 'off',
        DATABASE_URL: TEST_DATABASE_URL,
        ARTIFACT_DIR: dir,
        CAPABILITY_DIR: dir,
      }),
      { planner: new RuleBasedPlanner(), analyst: null, chatModel: null, log: { error: () => {} } },
    );
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    presets = new LabPresets(pool);
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const design = async (params: Record<string, unknown>) => {
    const task = await runtime.tasks.create('Design an assembly', { start: false });
    await presets.set(task.id, 'design_assembly', params);
    await runtime.tasks.start(task.id);
    await runtime.tasks.settled(task.id);
    for (let i = 0; i < 3; i++) {
      const t = await runtime.tasks.get(task.id);
      if (t?.status !== 'awaiting_approval') break;
      await runtime.tasks.decide(task.id, { approved: true });
      await runtime.tasks.settled(task.id);
    }
    const detail = (await runtime.tasks.get(task.id))!;
    const sim = ((detail.state?.stepResults ?? []) as StepResult[]).find(
      (r) => r.stepId === 'simulate',
    );
    return { detail, sim, checks: (detail.state?.verification ?? []) as CheckResult[] };
  };

  it('builds the example, measures it and verifies it twice over', async () => {
    const { sim, checks } = await design({});
    expect(sim?.status, sim?.detail).toBe('done');
    const s = sim?.summary as Record<string, unknown>;
    expect(s.part_count).toBe(9);
    expect(s.interference_count).toBe(0);
    expect(s.constraints_met).toBe(2);
    expect(s.design_ok).toBe(true);
    // 9 parts, hand-checked: plate 120x60x12 minus four 9 mm holes in steel is 0.654 kg.
    expect(s.total_mass_kg as number).toBeGreaterThan(1.2);
    expect(s.total_mass_kg as number).toBeLessThan(1.35);
    expect(checks).toHaveLength(2);
    for (const c of checks) expect(c.status, c.detail).toBe('passed');
  }, 900_000);

  it('finds a part that pierces another, and a requirement that is missed', async () => {
    const { sim, checks } = await design({
      requirements: { max_mass_kg: 0.1 },
      assemblies: [],
      constraints: [],
      parts: [
        { name: 'Block', kind: 'box', dims: { dx: 50, dy: 50, dz: 10 }, material: 'aluminium' },
        {
          name: 'Pin',
          kind: 'cylinder',
          dims: { r: 5, h: 30 },
          at: [0, 0, 8],
          material: 'steel',
        },
      ],
    });
    expect(sim?.status, sim?.detail).toBe('done');
    const s = sim?.summary as Record<string, unknown>;
    // The pin crosses the 10 mm thick block: pi * 5^2 * 10 mm3.
    expect(s.interference_count).toBe(1);
    expect((s.interferences as [string, string, number][])[0]?.[2]).toBeCloseTo(785.398, 2);
    expect(s.design_ok).toBe(false);
    // The checks verify that the report is true, not that the design is good.
    for (const c of checks) expect(c.status, c.detail).toBe('passed');
  }, 900_000);
});
