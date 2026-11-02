import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskSpec, type BotView, type ChatState, type TaskSummary } from '@reality/schemas';
import { buildApp } from '../src/app.ts';
import type { AgentModel, Block, TurnResult } from '../src/chat/model.ts';
import { loadConfig } from '../src/config.ts';
import { labIntent, labPlan } from '../src/lab/plan.ts';
import type { CheckResult } from '../src/orchestrator/graph.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { validatePlan } from '../src/planner/semantics.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { checkPrelude, getCheck } from '../src/verification/checks.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

describe('lab planning (pure)', () => {
  it('recognises lab questions without a model', () => {
    expect(labIntent('Simulate a Bragg mirror with 10 pairs at 1310 nm')).toEqual({
      engine: 'thin_film',
      params: { bragg: { pairs: 10, center_nm: 1310 }, start_nm: 786, stop_nm: 1900 },
    });
    expect(labIntent('Prepare a Bell state')).toEqual({
      engine: 'quantum_circuit',
      params: { preset: 'bell' },
    });
    expect(labIntent('GHZ state on 5 qubits')).toEqual({
      engine: 'quantum_circuit',
      params: { preset: 'ghz', qubits: 5 },
    });
    expect(labIntent('Was ist die Gitterkonstante von Kupfer? copper lattice')?.engine).toBe(
      'fcc_crystal',
    );
    expect(labIntent('lattice constant of Cu')).toEqual({
      engine: 'fcc_crystal',
      params: { element: 'Cu' },
    });
    expect(labIntent('3D structure of caffeine molecule')).toEqual({
      engine: 'molecule',
      params: { name: 'caffeine' },
    });
    expect(labIntent('ring resonator with 50 um radius')).toEqual({
      engine: 'ring_resonator',
      params: { radius_um: 50 },
    });
    expect(labIntent('Monte Carlo tolerance of a Bragg mirror, 5 nm sigma')?.engine).toBe(
      'stack_tolerance',
    );
    expect(labIntent('Which regions drive revenue?')).toBeUndefined();
  });

  it('builds valid plans, with a capability step when the engine needs one', () => {
    const ctx = (caps: string[]) => ({ datasets: [], availableCapabilities: caps });
    const plan = (engine: string, params: Record<string, unknown>, caps: string[]) =>
      TaskSpec.parse(labPlan(engine, params, 'q', caps, 'test').draft);
    expect(validatePlan(plan('thin_film', { bragg: { pairs: 4 } }, []), ctx([]))).toEqual([]);
    const mol = plan('molecule', { name: 'caffeine' }, []);
    expect(mol.workflow.map((s) => s.agent)).toEqual([
      'capability-agent',
      'lab-agent',
      'verification-agent',
    ]);
    expect(validatePlan(mol, ctx([]))).toEqual([]);
    const ready = plan('molecule', { name: 'caffeine' }, ['rdkit']);
    expect(ready.workflow.map((s) => s.agent)).toEqual(['lab-agent', 'verification-agent']);
    // A lab step needing a capability that nothing provides is refused.
    const broken = TaskSpec.parse({
      ...plan('molecule', { name: 'caffeine' }, ['rdkit']),
    });
    expect(validatePlan(broken, ctx([])).join()).toMatch(/needs capability "rdkit"/);
    expect(validatePlan(plan('fcc_crystal', { element: 'Xx' }, []), ctx([])).join()).toMatch(
      /invalid params/,
    );
  });
});

/** Scripted bot: starts a simulation, then reports after the result arrives. */
class LabBotModel implements AgentModel {
  readonly name = 'scripted-lab';
  private step = 0;
  async turn(): Promise<TurnResult> {
    this.step += 1;
    const content: Block[] =
      this.step === 1
        ? [
            {
              type: 'tool_use',
              id: 't1',
              name: 'run_simulation',
              input: {
                engine: 'fcc_crystal',
                params: { element: 'Cu' },
                question: 'Lattice constant of copper?',
              },
            },
          ]
        : this.step === 2
          ? [{ type: 'text', text: 'Started the copper simulation, the plan is above.' }]
          : [{ type: 'text', text: 'Copper: see the checked result above.' }];
    return {
      content,
      stop: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end',
      model: this.name,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

describe('lab tasks (database, sandbox)', () => {
  let runtime: Runtime;
  let app: FastifyInstance;
  let dir: string;

  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-lab-'));
    const config = loadConfig({ AUTH: 'off', DATABASE_URL: TEST_DATABASE_URL, ARTIFACT_DIR: dir });
    runtime = await createRuntime(config, {
      planner: new RuleBasedPlanner(),
      analyst: null,
      synthesizer: null,
      chatModel: new LabBotModel(),
      log: { error: () => {} },
    });
    app = buildApp(config, runtime);
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (request: string) => {
    const task = (
      await app.inject({ method: 'POST', url: '/api/tasks', payload: { request } })
    ).json<TaskSummary>();
    await runtime.tasks.settled(task.id);
    await runtime.tasks.decide(task.id, { approved: true, by: 'user' });
    await runtime.tasks.settled(task.id);
    return (await runtime.tasks.get(task.id))!;
  };

  it.each([
    ['Simulate a Bragg mirror with 8 pairs at 1550 nm', 'thin_film', 'peak_reflectance'],
    ['Ring resonator with 20 um radius', 'ring_resonator', 'fsr_nm'],
    ['Monte Carlo tolerance of a Bragg mirror with 6 pairs', 'stack_tolerance', 'yield'],
    ['GHZ state on 4 qubits', 'quantum_circuit', 'top_probability'],
    ['Lattice constant of copper', 'fcc_crystal', 'a0_angstrom'],
  ])(
    'runs "%s" with %s and verifies it independently',
    async (request, engine, field) => {
      const task = await run(request);
      expect(task.status).toBe('completed');
      const spec = task.state?.spec as TaskSpec;
      expect(spec.workflow.find((s) => s.agent === 'lab-agent')?.recipe?.name).toBe(engine);
      const checks = (task.state?.verification ?? []) as CheckResult[];
      expect(checks).toHaveLength(1);
      expect(checks[0]?.status, checks[0]?.detail).toBe('passed');
      const summary = (task.state?.stepResults ?? []).find((r) => r.stepId === 'simulate')
        ?.summary as Record<string, unknown>;
      expect(typeof summary[field]).toBe('number');
    },
    120_000,
  );

  it('a falsified result fails its check', async () => {
    const task = await run('Simulate a Bragg mirror with 6 pairs at 1550 nm');
    const step = (task.state?.stepResults ?? []).find((r) => r.stepId === 'simulate');
    const meta = await runtime.artifacts.get(step?.artifacts?.[0] ?? '');
    const csv = (await import('node:fs/promises')).readFile(
      runtime.artifacts.filePath(meta!),
      'utf8',
    );
    const lines = (await csv).trim().split('\n');
    // Raise one reflectance value by 0.01, as a buggy or lying engine might.
    const cells = lines[100]!.split(',');
    cells[1] = String(Number(cells[1]) + 0.01);
    lines[100] = cells.join(',');
    const tampered = join(dir, 'tampered.csv');
    await writeFile(tampered, `${lines.join('\n')}\n`);
    const check = getCheck('thin_film_recomputed')!;
    const spec = task.state?.spec as TaskSpec;
    const exec = await runtime.sandbox.execute({
      taskId: null,
      kind: 'check',
      label: 'tamper',
      code:
        checkPrelude(spec.acceptanceCriteria[0]?.check?.params ?? {}, step?.summary) + check.body,
      inputs: [{ name: 'result.csv', hostPath: tampered }],
    });
    await exec.result.cleanup();
    expect((exec.summary as { passed: boolean }).passed).toBe(false);
  }, 120_000);

  it('a bot starts a simulation from the chat and reports the checked result', async () => {
    const bot = (
      await app.inject({
        method: 'POST',
        url: '/api/bots',
        payload: { name: 'Curie', role: 'researcher' },
      })
    ).json<BotView>();
    const chat = (await app.inject({ url: `/api/bots/${bot.id}/chat` })).json<ChatState>();
    await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: { text: 'What is the lattice constant of copper?' },
    });
    const settle = async () => {
      for (let i = 0; i < 6; i++) {
        await runtime.chats.engine.idle(chat.id);
        await runtime.tasks.settleAll();
        await runtime.chats.engine.tick();
      }
      await runtime.chats.engine.idle(chat.id);
    };
    await settle();
    let state = (await app.inject({ url: `/api/chats/${chat.id}` })).json<ChatState>();
    const plan = state.messages.find((m) => m.card?.kind === 'plan')?.card as {
      taskId: string;
      steps: string[];
    };
    expect(plan.steps[0]).toContain('Crystal (fcc metal): Cu');
    await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/plans/${plan.taskId}`,
      payload: { approved: true },
    });
    await settle();
    state = (await app.inject({ url: `/api/chats/${chat.id}` })).json<ChatState>();
    const result = state.messages.find((m) => m.card?.kind === 'result')?.card as {
      status: string;
      lines: string[];
      verified: { passed: number; total: number };
    };
    expect(result.status).toBe('completed');
    expect(result.lines.join(' ')).toMatch(/a0 = 3\.60\d+ A/);
    expect(result.verified).toMatchObject({ passed: 1, total: 1 });
    expect(state.messages.at(-1)).toMatchObject({
      role: 'bot',
      text: 'Copper: see the checked result above.',
    });
  }, 120_000);
});
