import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskSpec } from '@reality/schemas';
import { loadConfig } from '../src/config.ts';
import { labIntent, labPlan } from '../src/lab/plan.ts';
import type { CheckResult, StepResult } from '../src/orchestrator/graph.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { validatePlan } from '../src/planner/semantics.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { checkPrelude, getCheck } from '../src/verification/checks.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

describe('rocket lab planning (pure)', () => {
  it('recognises rocket questions without a model', () => {
    expect(labIntent('Design a methane rocket engine at 300 bar with 2300 kN')).toEqual({
      engine: 'rocket_engine',
      params: { propellant: 'lox_ch4', chamber_pressure_bar: 300, thrust_kN: 2300 },
    });
    expect(labIntent('Entwirf ein Raketentriebwerk mit Wasserstoff')?.params).toEqual({
      propellant: 'lox_lh2',
    });
    expect(labIntent('A rocket that puts 15 t into a 400 km orbit')).toEqual({
      engine: 'launch_vehicle',
      params: { payload_kg: 15_000, orbit_altitude_km: 400 },
    });
    expect(labIntent('Fly the ascent of my rocket to orbit')?.engine).toBe('ascent_trajectory');
    expect(labIntent('Size the tanks of the rocket')?.engine).toBe('rocket_tanks');
    expect(labIntent('3D model of the rocket')?.engine).toBe('rocket_cad');
    // A jet engine stays a jet engine.
    expect(labIntent('Design a turbofan jet engine')?.engine).toBe('turbofan');
  });

  it('plans with defaults filled in, and acquires Cantera for the engine', () => {
    const ctx = { datasets: [], availableCapabilities: [] };
    const engine = TaskSpec.parse(labPlan('rocket_engine', {}, 'q', [], 'test').draft);
    expect(engine.workflow.map((s) => s.agent)).toEqual([
      'capability-agent',
      'lab-agent',
      'verification-agent',
    ]);
    expect(engine.workflow[0]?.capability).toBe('combustion');
    expect(engine.workflow[1]?.recipe?.params).toMatchObject({
      propellant: 'lox_ch4',
      chamber_pressure_bar: 100,
    });
    expect(validatePlan(engine, ctx)).toEqual([]);
    const ascent = TaskSpec.parse(labPlan('ascent_trajectory', {}, 'q', [], 'test').draft);
    expect(ascent.workflow.map((s) => s.agent)).toEqual(['lab-agent', 'verification-agent']);
    // The check sees the same (filled-in) parameters as the simulation.
    expect(ascent.acceptanceCriteria[0]?.check?.params).toMatchObject({
      step: 'simulate',
      diameter_m: 3.7,
    });
  });
});

describe('rocket lab tasks (database, sandbox)', () => {
  let runtime: Runtime;
  let dir: string;

  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-rocket-'));
    runtime = await createRuntime(
      loadConfig({ AUTH: 'off', DATABASE_URL: TEST_DATABASE_URL, ARTIFACT_DIR: dir }),
      {
        planner: new RuleBasedPlanner(),
        analyst: null,
        synthesizer: null,
        chatModel: null,
        log: { error: () => {} },
      },
    );
  }, 60_000);
  afterAll(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (request: string) => {
    const task = await runtime.tasks.create(request, { start: true });
    await runtime.tasks.settled(task.id);
    await runtime.tasks.decide(task.id, { approved: true, by: 'user' });
    await runtime.tasks.settled(task.id);
    return (await runtime.tasks.get(task.id))!;
  };
  const summaryOf = (task: Awaited<ReturnType<typeof run>>) =>
    ((task.state?.stepResults ?? []) as StepResult[]).find((r) => r.stepId === 'simulate')
      ?.summary as Record<string, unknown>;
  const passed = (task: Awaited<ReturnType<typeof run>>) => {
    const checks = (task.state?.verification ?? []) as CheckResult[];
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status, checks[0]?.detail).toBe('passed');
  };

  /** Runs a check on a tampered copy of the step's result. */
  const tamper = async (
    task: Awaited<ReturnType<typeof run>>,
    checkName: string,
    edit: (lines: string[]) => void,
  ) => {
    const step = ((task.state?.stepResults ?? []) as StepResult[]).find(
      (r) => r.stepId === 'simulate',
    );
    const meta = await runtime.artifacts.get(step?.artifacts?.[0] ?? '');
    const lines = (await readFile(runtime.artifacts.filePath(meta!), 'utf8')).trim().split('\n');
    edit(lines);
    const path = join(dir, `tampered-${checkName}.csv`);
    await writeFile(path, `${lines.join('\n')}\n`);
    const spec = task.state?.spec as TaskSpec;
    const exec = await runtime.sandbox.execute({
      taskId: null,
      kind: 'check',
      label: 'tamper',
      code:
        checkPrelude(spec.acceptanceCriteria[0]?.check?.params ?? {}, step?.summary) +
        getCheck(checkName)!.body,
      inputs: [{ name: 'result.csv', hostPath: path }],
    });
    await exec.result.cleanup();
    return (exec.summary as { passed: boolean }).passed;
  };

  it('sizes a launch vehicle and a falsified stage fails its check', async () => {
    const task = await run('A rocket that puts 15 t into a 400 km orbit');
    expect(task.status).toBe('completed');
    passed(task);
    const s = summaryOf(task);
    expect(s.reaches_orbit).toBe(true);
    expect(s.liftoff_mass_kg as number).toBeGreaterThan(200_000);
    expect(
      await tamper(task, 'launch_vehicle_recomputed', (lines) => {
        const cells = lines[1]!.split(',');
        cells[2] = String(Number(cells[2]) + 50); // stage 1 delta-v, 50 m/s too much
        lines[1] = cells.join(',');
      }),
    ).toBe(false);
  }, 180_000);

  it('flies a Falcon-9-class vehicle to orbit and a falsified trajectory fails', async () => {
    const task = await run('Fly the ascent of the rocket to a 300 km orbit');
    expect(task.status).toBe('completed');
    passed(task);
    const s = summaryOf(task);
    expect(s.orbit_reached).toBe(true);
    expect(s.max_q_kPa as number).toBeGreaterThan(15);
    expect(s.max_q_kPa as number).toBeLessThan(60);
    expect(
      await tamper(task, 'ascent_recomputed', (lines) => {
        const header = lines[0]!.split(',');
        const vx = header.indexOf('vx_m_s');
        const cells = lines[60]!.split(',');
        cells[vx] = String(Number(cells[vx]) + 5); // a jump of 5 m/s the forces cannot explain
        lines[60] = cells.join(',');
      }),
    ).toBe(false);
  }, 600_000);

  it('sizes the tanks against pressure and buckling', async () => {
    const task = await run('Size the tanks of the rocket structure');
    expect(task.status).toBe('completed');
    passed(task);
    const s = summaryOf(task);
    expect(s.buckling_ok).toBe(true);
    expect(s.tank_mass_total_kg as number).toBeGreaterThan(1000);
  }, 180_000);
});

/**
 * The engine needs chemical equilibrium (Cantera, ~30 MB) and the vehicle model the CAD
 * kernel; both are acquired after approval. Opt-in: RUN_NETWORK_TESTS=1.
 */
describe.skipIf(process.env.RUN_NETWORK_TESTS !== '1')(
  'rocket engine from chemical equilibrium (network)',
  () => {
    let runtime: Runtime;
    let dir: string;
    beforeAll(async () => {
      await resetTestDatabase();
      dir = await mkdtemp(join(tmpdir(), 'reality-rocket-net-'));
      runtime = await createRuntime(
        loadConfig({
          AUTH: 'off',
          DATABASE_URL: TEST_DATABASE_URL,
          ARTIFACT_DIR: dir,
          CAPABILITY_DIR: dir,
        }),
        {
          planner: new RuleBasedPlanner(),
          analyst: null,
          chatModel: null,
          log: { error: () => {} },
        },
      );
    }, 60_000);
    afterAll(async () => {
      await runtime?.close();
      await rm(dir, { recursive: true, force: true });
    });

    it('acquires Cantera, designs a Raptor-class engine and verifies it', async () => {
      const task = await runtime.tasks.create(
        'Design a methane rocket engine at 300 bar with 2300 kN',
        { start: true },
      );
      await runtime.tasks.settled(task.id);
      await runtime.tasks.decide(task.id, { approved: true });
      await runtime.tasks.settled(task.id);
      const pending = (await runtime.tasks.get(task.id))?.pendingApproval as {
        proposal: { package: string };
      };
      const acq = ((await runtime.tasks.get(task.id))?.state?.stepResults ?? []) as StepResult[];
      expect(pending?.proposal.package, JSON.stringify(acq)).toBe('cantera');
      await runtime.tasks.decide(task.id, { approved: true });
      await runtime.tasks.settled(task.id);
      const detail = (await runtime.tasks.get(task.id))!;
      const results = (detail.state?.stepResults ?? []) as StepResult[];
      const sim = results.find((r) => r.stepId === 'simulate');
      expect(sim?.status, sim?.detail).toBe('done');
      const s = sim?.summary as Record<string, number>;
      // NASA CEA gives about 371 s in vacuum for these conditions (expansion ratio 40).
      expect(s.isp_vac_s).toBeGreaterThan(360);
      expect(s.isp_vac_s).toBeLessThan(380);
      const checks = (detail.state?.verification ?? []) as CheckResult[];
      expect(checks[0]?.status, checks[0]?.detail).toBe('passed');
    }, 900_000);

    it('builds the whole vehicle as a CAD assembly and verifies it', async () => {
      const task = await runtime.tasks.create('3D model of the rocket', { start: true });
      await runtime.tasks.settled(task.id);
      await runtime.tasks.decide(task.id, { approved: true });
      await runtime.tasks.settled(task.id);
      await runtime.tasks.decide(task.id, { approved: true }); // the CAD kernel
      await runtime.tasks.settled(task.id);
      const detail = (await runtime.tasks.get(task.id))!;
      const sim = ((detail.state?.stepResults ?? []) as StepResult[]).find(
        (r) => r.stepId === 'simulate',
      );
      expect(sim?.status, sim?.detail).toBe('done');
      const s = sim?.summary as Record<string, number>;
      expect(s.part_count).toBeGreaterThan(50);
      expect(s.invalid_parts).toBe(0);
      const checks = (detail.state?.verification ?? []) as CheckResult[];
      expect(checks[0]?.status, checks[0]?.detail).toBe('passed');
    }, 900_000);
  },
);
