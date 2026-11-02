import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskEvent } from '@reality/schemas';
import { loadConfig } from '../src/config.ts';
import { defaultDraft, FakePlanner } from '../src/planner/fake-planner.ts';
import { PlannerError, type Planner } from '../src/planner/planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

const config = loadConfig({ AUTH: 'off', DATABASE_URL: TEST_DATABASE_URL, PLANNER: 'fake' });
const silent = { error: () => undefined };
const runtimes: Runtime[] = [];

async function start(planner: Planner = new FakePlanner()) {
  const rt = await createRuntime(config, { planner, log: silent });
  runtimes.push(rt);
  return rt;
}

const types = (events: TaskEvent[]) => events.map((e) => e.type);

beforeEach(resetTestDatabase);
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((rt) => rt.close()));
});

describe('orchestrator', () => {
  it('plans, waits for approval, then executes and verifies honestly', async () => {
    const rt = await start();
    const task = await rt.tasks.create('Find weekly seasonality');
    await rt.tasks.settled(task.id);

    const waiting = await rt.tasks.get(task.id);
    expect(waiting?.status).toBe('awaiting_approval');
    expect(waiting?.pendingApproval).toMatchObject({ kind: 'plan-approval' });

    await rt.tasks.decide(task.id, { approved: true });
    await rt.tasks.settled(task.id);

    const done = await rt.tasks.get(task.id);
    expect(done?.status).toBe('completed');
    // Without data the analysis steps fail (or are skipped) and say why; nothing claims success.
    const results = done?.state?.stepResults ?? [];
    expect(results.map((r) => r.status)).toEqual(['failed', 'skipped', 'skipped']);
    expect(results[0]?.detail).toMatch(/No dataset attached/);
    expect(done?.state?.verification?.every((v) => v.status === 'unverified')).toBe(true);

    expect(types(await rt.events.list(task.id))).toEqual([
      'task.created',
      'workspace.created',
      'plan.created',
      'approval.requested',
      'approval.granted',
      'step.started',
      'step.completed',
      'step.started',
      'step.completed',
      'step.started',
      'step.completed',
      'check.completed',
      'verification.completed',
      'task.completed',
    ]);
  });

  it('stops without executing when the plan is denied', async () => {
    const rt = await start();
    const task = await rt.tasks.create('Delete everything');
    await rt.tasks.settled(task.id);
    await rt.tasks.decide(task.id, { approved: false, note: 'no' });
    await rt.tasks.settled(task.id);

    expect((await rt.tasks.get(task.id))?.status).toBe('rejected');
    const seen = types(await rt.events.list(task.id));
    expect(seen).toContain('approval.denied');
    expect(seen).not.toContain('step.started');
  });

  it('rejects approval for a task that is not waiting for one', async () => {
    const rt = await start();
    const task = await rt.tasks.create('x');
    await rt.tasks.settled(task.id);
    await rt.tasks.decide(task.id, { approved: true });
    await rt.tasks.settled(task.id);
    await expect(rt.tasks.decide(task.id, { approved: true })).rejects.toThrow(/not awaiting/);
  });

  it('feeds validation errors back to the planner and recovers', async () => {
    const bad = {
      ...defaultDraft('x'),
      workflow: [{ id: 's1', description: 'x', agent: 'analysis-agent', dependsOn: ['ghost'] }],
    };
    const planner = new FakePlanner([bad]);
    const rt = await start(planner);
    const task = await rt.tasks.create('x');
    await rt.tasks.settled(task.id);

    expect((await rt.tasks.get(task.id))?.status).toBe('awaiting_approval');
    expect(planner.calls).toHaveLength(2);
    expect(planner.calls[1]?.feedback).toMatch(/ghost/);
    expect(types(await rt.events.list(task.id))).toContain('plan.invalid');
  });

  it('stops at the model-call budget instead of retrying forever', async () => {
    const planner = new FakePlanner([{ nonsense: true }, { nonsense: true }, { nonsense: true }]);
    const rt = await start(planner);
    const task = await rt.tasks.create('x');
    await rt.tasks.settled(task.id);

    expect((await rt.tasks.get(task.id))?.status).toBe('budget_exceeded');
    expect(planner.calls).toHaveLength(3);
  });

  it('fails the task on a non-retryable planner error', async () => {
    const planner: Planner = {
      name: 'refusing',
      propose: async () => {
        throw new PlannerError('declined', false);
      },
    };
    const rt = await start(planner);
    const task = await rt.tasks.create('x');
    await rt.tasks.settled(task.id);
    expect((await rt.tasks.get(task.id))?.status).toBe('failed');
  });

  it('survives a restart while awaiting approval (state lives in Postgres)', async () => {
    const planner = new FakePlanner();
    const first = await start(planner);
    const task = await first.tasks.create('x');
    await first.tasks.settled(task.id);
    await first.close();
    runtimes.splice(runtimes.indexOf(first), 1);

    const second = await start(new FakePlanner());
    await second.tasks.decide(task.id, { approved: true });
    await second.tasks.settled(task.id);

    expect((await second.tasks.get(task.id))?.status).toBe('completed');
    expect(planner.calls).toHaveLength(1); // the plan was not redone
  });
});
