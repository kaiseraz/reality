import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateProjectRequest, type BotView, type TaskSummary } from '@reality/schemas';
import { buildApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

/** Bots: persistent team members whose status follows from their tasks. */
let runtime: Runtime;
let app: FastifyInstance;
let config: Config;
let dir: string;

const csv =
  ['week,region,revenue']
    .concat(
      Array.from({ length: 20 }, (_, w) => {
        const d = new Date(Date.UTC(2025, 0, 6) + w * 7 * 86_400_000).toISOString().slice(0, 10);
        return `${d},North,${1000 + w}\n${d},South,${500 + w}`;
      }),
    )
    .join('\n') + '\n';

beforeAll(async () => {
  await resetTestDatabase();
  dir = await mkdtemp(join(tmpdir(), 'reality-bots-'));
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
  app = buildApp(config, runtime);
}, 60_000);
afterAll(async () => {
  await app.close();
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
});

const newBot = async (name: string, role = 'analyst') =>
  (await app.inject({ method: 'POST', url: '/api/bots', payload: { name, role } })).json<BotView>();
const bot = async (id: string) =>
  (await app.inject({ url: `/api/bots/${id}` })).json<BotView & { tasks: TaskSummary[] }>();

describe('bots', () => {
  it('are created with a colour and start idle', async () => {
    const mila = await newBot('Mila');
    expect(mila).toMatchObject({
      name: 'Mila',
      role: 'analyst',
      status: 'idle',
      current: null,
      done: 0,
    });
    expect(mila.color).toMatch(/^#[0-9a-f]{6}$/i);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/bots',
      payload: { name: 'X', role: 'wizard' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('take a direct assignment and show what they are doing', async () => {
    const jonas = await newBot('Jonas');
    const task = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { request: 'Which regions drive revenue?', start: false, botId: jonas.id },
      })
    ).json<TaskSummary>();
    expect(task.botId).toBe(jonas.id);
    await runtime.artifacts.putUpload(task.id, 'sales.csv', csv);
    await runtime.tasks.start(task.id);
    await runtime.tasks.settled(task.id);
    expect(await bot(jonas.id)).toMatchObject({
      status: 'waiting',
      current: { taskId: task.id, status: 'awaiting_approval' },
    });
    await runtime.tasks.decide(task.id, { approved: true, by: 'user' });
    await runtime.tasks.settled(task.id);
    const after = await bot(jonas.id);
    expect(after).toMatchObject({ status: 'idle', done: 1 });
    expect(after.tasks.map((t) => t.id)).toEqual([task.id]);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { request: 'x', botId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(unknown.statusCode).toBe(404);
  }, 120_000);

  it('share a project: each free bot takes one task at a time', async () => {
    const a = await newBot('Ada', 'analyst');
    const b = await newBot('Theo', 'reviewer');
    const project = await runtime.projects.create(
      CreateProjectRequest.parse({
        goal: 'Sales review',
        start: false,
        autonomy: 'ask-critical',
        maxParallel: 4,
        team: [a.id, b.id],
        tasks: [
          { title: 'One', request: 'Which regions drive revenue?', dependsOn: [] },
          { title: 'Two', request: 'Total revenue per week over time', dependsOn: [] },
          { title: 'Three', request: 'Which regions drive revenue?', dependsOn: [] },
        ],
      }),
      null,
    );
    await runtime.projects.addFile(project.id, 'sales.csv', csv);
    await runtime.projects.setPaused(project.id, false);
    await runtime.projects.tick();
    const first = await runtime.projects.detail(project.id);
    // Two bots, so only two tasks started although parallelism allows four.
    expect(first.tasks.filter((t) => t.startedAt !== null)).toHaveLength(2);
    expect(new Set(first.tasks.map((t) => t.botId).filter(Boolean))).toEqual(new Set([a.id, b.id]));
    expect(first.team).toEqual([a.id, b.id]);

    let previous = '';
    for (let i = 0; i < 30; i++) {
      await runtime.projects.tick();
      await runtime.tasks.settleAll();
      const d = await runtime.projects.detail(project.id);
      const state = `${d.status} ${d.tasks.map((t) => t.status).join(',')}`;
      if (state === previous) break;
      previous = state;
    }
    const done = await runtime.projects.detail(project.id);
    expect(done.status).toBe('completed');
    expect(done.tasks.every((t) => t.botId === a.id || t.botId === b.id)).toBe(true);
    const started = done.events.filter((e) => e.type === 'task.started');
    expect(started.every((e) => typeof (e.payload as { bot?: string }).bot === 'string')).toBe(
      true,
    );
  }, 300_000);

  it('keep a bot on its task while the plan waits for approval', async () => {
    const solo = await newBot('Solo', 'analyst');
    const project = await runtime.projects.create(
      CreateProjectRequest.parse({
        goal: 'Approval queue',
        start: false,
        autonomy: 'ask-every-plan',
        maxParallel: 4,
        team: [solo.id],
        tasks: [
          { title: 'One', request: 'Which regions drive revenue?', dependsOn: [] },
          { title: 'Two', request: 'Total revenue per week over time', dependsOn: [] },
        ],
      }),
      null,
    );
    await runtime.projects.addFile(project.id, 'sales.csv', csv);
    await runtime.projects.setPaused(project.id, false);
    for (let i = 0; i < 3; i++) {
      await runtime.projects.tick();
      await runtime.tasks.settleAll();
    }
    const d = await runtime.projects.detail(project.id);
    expect(d.tasks.filter((t) => t.startedAt !== null)).toHaveLength(1);
    expect(await bot(solo.id)).toMatchObject({ status: 'waiting' });
  }, 120_000);

  it('belong to their owner', async () => {
    const authApp = buildApp({ ...config, AUTH: 'on' }, runtime);
    const owner = await runtime.auth.createUser(
      'owner@example.test',
      'owner-test-password',
      'admin',
    );
    const other = await runtime.auth.createUser(
      'other@example.test',
      'other-test-password',
      'member',
    );
    const cookie = async (id: string) => `reality_session=${await runtime.auth.createSession(id)}`;
    const mine = (
      await authApp.inject({
        method: 'POST',
        url: '/api/bots',
        headers: { cookie: await cookie(owner.id) },
        payload: { name: 'Noor', role: 'researcher' },
      })
    ).json<BotView>();
    const asOther = { cookie: await cookie(other.id) };
    expect(
      (await authApp.inject({ url: `/api/bots/${mine.id}`, headers: asOther })).statusCode,
    ).toBe(404);
    // The other person sees only their own lead, never someone else's bots.
    const theirs = (await authApp.inject({ url: '/api/bots', headers: asOther })).json<BotView[]>();
    expect(theirs.map((b) => [b.name, b.isMain])).toEqual([['Reality', true]]);
    const steal = await authApp.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: asOther,
      payload: { request: 'x', botId: mine.id },
    });
    expect(steal.statusCode).toBe(404);
    await authApp.close();
  }, 60_000);
});
