import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateProjectRequest, type ProjectStatus, type TaskSpec } from '@reality/schemas';
import { primaryDataset } from '../src/analysis/executor.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { planPolicy } from '../src/projects/policy.ts';
import {
  ProjectPlanError,
  RuleProjectPlanner,
  validateProjectTasks,
} from '../src/projects/project-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

/** M7: projects run as trees of ordinary tasks, scheduled in the background. */

function weekly(weeks: number, seasonal = false): string {
  const lines = ['week,region,revenue'];
  for (let w = 0; w < weeks; w++) {
    const week = new Date(Date.UTC(2023, 0, 2) + w * 7 * 86_400_000).toISOString().slice(0, 10);
    const s = seasonal ? 200 * Math.sin((2 * Math.PI * w) / 52) : 0;
    lines.push(`${week},North,${(1000 + w + s + ((w * 37) % 11)).toFixed(2)}`);
    lines.push(`${week},South,${(600 + w + ((w * 17) % 7)).toFixed(2)}`);
  }
  return lines.join('\n') + '\n';
}

describe('project planning (no model)', () => {
  const planner = new RuleProjectPlanner();

  it('makes one task per item and chains "then … the result" to the previous one', async () => {
    const tasks = await planner.propose(
      [
        'Sales review:',
        '1. Which regions drive revenue?',
        '2. How does total revenue develop per week?',
        '3. Then, using the result, which region is largest?',
      ].join('\n'),
      { files: [], maxTasks: 10 },
    );
    expect(tasks.map((t) => [t.request, t.dependsOn, t.useResultOf])).toEqual([
      ['Which regions drive revenue?', [], undefined],
      ['How does total revenue develop per week?', [], undefined],
      ['Then, using the result, which region is largest?', [1], 1],
    ]);
  });

  it('keeps a one-line goal as one task and respects the task budget', async () => {
    expect(
      await planner.propose('Which regions drive revenue?', { files: [], maxTasks: 5 }),
    ).toHaveLength(1);
    const many = Array.from({ length: 8 }, (_, i) => `- question ${i}`).join('\n');
    expect(await planner.propose(many, { files: [], maxTasks: 3 })).toHaveLength(3);
  });

  it('rejects cycles and dependencies on tasks that do not exist', () => {
    const t = (dependsOn: number[]) => ({ title: 'x', request: 'x', dependsOn });
    expect(() => validateProjectTasks([t([1]), t([0])], 10)).toThrow(ProjectPlanError);
    expect(() => validateProjectTasks([t([5])], 10)).toThrow(/does not exist/);
    expect(() => validateProjectTasks([t([0])], 10)).toThrow(/does not exist/);
  });
});

describe('project policy', () => {
  const spec = (over: Partial<TaskSpec>): TaskSpec =>
    ({
      goal: 'g',
      constraints: [],
      requiredOutputs: [],
      resources: [],
      risks: [],
      acceptanceCriteria: [
        {
          id: 'rows',
          description: 'd',
          checkType: 'recompute',
          check: { name: 'row_count', params: { expected: 1 } },
        },
      ],
      workflow: [
        {
          id: 'profile',
          description: 'd',
          agent: 'analysis-agent',
          dependsOn: [],
          recipe: { name: 'profile', params: {} },
        },
      ],
      missingCapabilities: [],
      candidateWorkspaces: [],
      ...over,
    }) as TaskSpec;

  it('approves reviewed recipes with machine-checked criteria', () => {
    expect(planPolicy(spec({}), { budgetLeft: true })).toMatchObject({ approve: true });
  });

  it('never approves capability acquisition, AI-written code or unverifiable results', () => {
    const cap = spec({
      missingCapabilities: [{ need: 'x', status: 'open' }] as TaskSpec['missingCapabilities'],
    });
    expect(planPolicy(cap, { budgetLeft: true })).toMatchObject({
      approve: false,
      reason: /capability/,
    });
    const code = spec({
      workflow: [
        { id: 'free', description: 'd', agent: 'analysis-agent', dependsOn: [] },
      ] as unknown as TaskSpec['workflow'],
    });
    expect(planPolicy(code, { budgetLeft: true })).toMatchObject({
      approve: false,
      reason: /AI-written/,
    });
    const human = spec({
      acceptanceCriteria: [
        { id: 'h', description: 'd', checkType: 'human' },
      ] as TaskSpec['acceptanceCriteria'],
    });
    expect(planPolicy(human, { budgetLeft: true })).toMatchObject({
      approve: false,
      reason: /machine check/,
    });
    expect(planPolicy(spec({}), { budgetLeft: false })).toMatchObject({ approve: false });
  });
});

describe('projects end to end (sandbox, rule-based planner)', () => {
  let runtime: Runtime;
  let config: Config;
  let dir: string;

  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-projects-'));
    config = loadConfig({
      AUTH: 'off',
      DATABASE_URL: TEST_DATABASE_URL,
      ARTIFACT_DIR: join(dir, 'artifacts'),
      CAPABILITY_DIR: join(dir, 'capabilities'),
    });
    runtime = await createRuntime(config, {
      planner: new RuleBasedPlanner(),
      analyst: null,
      log: { error: () => {} },
    });
  }, 60_000);
  afterAll(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Runs the scheduler until a full pass changes nothing (the project finished or waits for a
   * person); records the most tasks that were running at once.
   */
  async function drive(rt: Runtime, id: string, rounds = 40) {
    let peak = 0;
    let previous = '';
    for (let i = 0; i < rounds; i++) {
      await rt.projects.tick();
      const d = await rt.projects.detail(id);
      peak = Math.max(peak, d.tasks.filter((t) => t.board === 'running').length);
      await rt.tasks.settleAll();
      const after = await rt.projects.detail(id);
      const state = `${after.status} ${after.tasks.map((t) => t.status).join(',')}`;
      if (state === previous) return { detail: after, peak };
      previous = state;
    }
    return { detail: await rt.projects.detail(id), peak };
  }

  async function project(body: Partial<CreateProjectRequest>, csv: string) {
    const created = await runtime.projects.create(
      CreateProjectRequest.parse({ goal: 'Sales review', start: false, ...body }),
      null,
    );
    await runtime.projects.addFile(created.id, 'sales.csv', csv);
    await runtime.projects.setPaused(created.id, false);
    return created.id;
  }

  it('runs independent tasks in parallel up to the limit, hands results over, and approves by policy', async () => {
    const id = await project(
      {
        autonomy: 'ask-critical',
        maxParallel: 2,
        tasks: [
          { title: 'Drivers', request: 'Which regions drive revenue?', dependsOn: [] },
          { title: 'Trend', request: 'Total revenue per week over time', dependsOn: [] },
          { title: 'Largest', request: 'Which region is largest?', dependsOn: [0], useResultOf: 0 },
        ],
      },
      weekly(30),
    );
    // First tick: two tasks start (limit 2); the third waits for the first.
    await runtime.projects.tick();
    const first = await runtime.projects.detail(id);
    expect(first.tasks.map((t) => t.startedAt !== null)).toEqual([true, true, false]);
    expect(first.tasks[2]?.board).toBe('waiting');

    const { detail, peak } = await drive(runtime, id);
    expect(peak).toBeLessThanOrEqual(2);
    expect(detail.status as ProjectStatus).toBe('completed');
    expect(detail.counts).toMatchObject({ total: 3, done: 3 });

    // Every plan was approved by the policy, and recorded as such.
    expect(detail.events.filter((e) => e.type === 'policy.approved')).toHaveLength(3);
    for (const t of detail.tasks) {
      const log = await runtime.events.list(t.taskId);
      const granted = log.find((e) => e.type === 'approval.granted');
      expect(granted?.actor).toBe('policy');
    }

    // The third task worked on the first task's result table.
    const third = detail.tasks[2]!;
    const data = await primaryDataset(runtime.artifacts, third.taskId);
    expect(data?.provenance).toMatchObject({ kind: 'handoff', fromTask: detail.tasks[0]!.taskId });
    expect(data?.filename).toBe('revenue_by_region.csv');
    expect(detail.events.some((e) => e.type === 'handoff')).toBe(true);
  }, 300_000);

  it('asks for every plan by default and lists the decisions in the inbox', async () => {
    const id = await project(
      { tasks: [{ title: 'Drivers', request: 'Which regions drive revenue?', dependsOn: [] }] },
      weekly(30),
    );
    const { detail } = await drive(runtime, id);
    expect(detail.tasks[0]?.board).toBe('needs_you');
    expect(detail.events.some((e) => e.type === 'policy.approved')).toBe(false);

    const app = buildApp(config, runtime);
    const inbox = (await app.inject({ url: '/api/inbox' })).json<
      { taskId: string; kind: string; project: { id: string } | null }[]
    >();
    expect(inbox.find((i) => i.taskId === detail.tasks[0]!.taskId)).toMatchObject({
      kind: 'plan-approval',
      project: { id },
    });
    // The API never lets a caller act as the policy.
    await app.inject({
      method: 'POST',
      url: `/api/tasks/${detail.tasks[0]!.taskId}/approval`,
      payload: { approved: true, by: 'policy' },
    });
    await runtime.tasks.settleAll();
    const log = await runtime.events.list(detail.tasks[0]!.taskId);
    expect(log.find((e) => e.type === 'approval.granted')?.actor).toBe('user');
    expect((await drive(runtime, id)).detail.status).toBe('completed');
    await app.close();
  }, 300_000);

  it('leaves capability installations to a person, even with ask-critical', async () => {
    const id = await project(
      {
        autonomy: 'ask-critical',
        tasks: [
          {
            title: 'Season',
            request: 'Is there a seasonal pattern in weekly revenue?',
            dependsOn: [],
          },
        ],
      },
      weekly(156, true),
    );
    const { detail } = await drive(runtime, id);
    expect(detail.tasks[0]?.board).toBe('needs_you');
    const deferred = detail.events.find((e) => e.type === 'policy.deferred');
    expect(JSON.stringify(deferred?.payload)).toMatch(/capability/);
    // Reported once, also across further passes and a restart.
    const again = await createRuntime(config, {
      planner: new RuleBasedPlanner(),
      analyst: null,
      log: { error: () => {} },
    });
    try {
      for (let i = 0; i < 3; i++) await again.projects.tick();
    } finally {
      await again.close();
    }
    await runtime.projects.tick();
    const after = await runtime.projects.detail(id);
    expect(after.events.filter((e) => e.type === 'policy.deferred')).toHaveLength(1);
    await runtime.projects.setPaused(id, true);
  }, 300_000);

  it('stops starting work when the task budget is used up', async () => {
    const id = await project(
      {
        autonomy: 'ask-critical',
        maxParallel: 1,
        budget: { maxTasks: 1, maxSandboxMinutes: 60 },
        tasks: [{ title: 'A', request: 'Which regions drive revenue?', dependsOn: [] }],
      },
      weekly(30),
    );
    // A second task is refused when added beyond the budget.
    await expect(
      runtime.projects.addTask(
        id,
        { title: 'B', request: 'Total revenue per week', dependsOn: [] },
        null,
      ),
    ).rejects.toThrow(/budget allows 1/);
    const { detail } = await drive(runtime, id);
    expect(detail.status).toBe('completed');
    expect(detail.usage.tasksStarted).toBe(1);
  }, 300_000);

  it('marks a project failed when the remaining work depends on a rejected task', async () => {
    const id = await project(
      {
        tasks: [
          { title: 'A', request: 'Which regions drive revenue?', dependsOn: [] },
          { title: 'B', request: 'Total revenue per week', dependsOn: [0] },
        ],
      },
      weekly(30),
    );
    await drive(runtime, id);
    const a = (await runtime.projects.detail(id)).tasks[0]!;
    await runtime.tasks.decide(a.taskId, { approved: false, by: 'user', note: 'not needed' });
    await runtime.tasks.settleAll();
    const { detail } = await drive(runtime, id);
    expect(detail.status).toBe('failed');
    expect(detail.tasks[1]?.board).toBe('blocked');
    expect(detail.events.some((e) => e.type === 'project.blocked')).toBe(true);
  }, 300_000);

  it('continues after a server restart', async () => {
    const id = await project(
      {
        autonomy: 'ask-critical',
        tasks: [
          { title: 'A', request: 'Which regions drive revenue?', dependsOn: [] },
          { title: 'B', request: 'Total revenue per week', dependsOn: [0] },
        ],
      },
      weekly(30),
    );
    // Run until the first task is done, then "restart": a new runtime on the same database.
    for (let i = 0; i < 10; i++) {
      await runtime.projects.tick();
      await runtime.tasks.settleAll();
      if ((await runtime.projects.detail(id)).tasks[0]?.board === 'done') break;
    }
    const restarted = await createRuntime(config, {
      planner: new RuleBasedPlanner(),
      analyst: null,
      log: { error: () => {} },
    });
    try {
      await restarted.tasks.recover();
      const { detail } = await drive(restarted, id);
      expect(detail.status).toBe('completed');
    } finally {
      await restarted.close();
    }
  }, 300_000);

  it('shows a project only to its owner', async () => {
    const authApp = buildApp({ ...config, AUTH: 'on' }, runtime);
    const a = await runtime.auth.createUser('a@example.test', 'owner-a-test-password', 'admin');
    const b = await runtime.auth.createUser('b@example.test', 'owner-b-test-password', 'member');
    const cookie = async (userId: string) =>
      `reality_session=${await runtime.auth.createSession(userId)}`;
    const created = await authApp.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: await cookie(a.id) },
      payload: { goal: 'Which regions drive revenue?', start: false },
    });
    expect(created.statusCode).toBe(201);
    const pid = created.json<{ id: string }>().id;
    const asB = { cookie: await cookie(b.id) };
    expect((await authApp.inject({ url: `/api/projects/${pid}`, headers: asB })).statusCode).toBe(
      404,
    );
    expect((await authApp.inject({ url: '/api/projects', headers: asB })).json()).toEqual([]);
    expect(
      (
        await authApp.inject({
          url: `/api/projects/${pid}`,
          headers: { cookie: await cookie(a.id) },
        })
      ).statusCode,
    ).toBe(200);
    await authApp.close();
  }, 60_000);
});
