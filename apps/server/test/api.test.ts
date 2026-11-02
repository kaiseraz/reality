import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskEvent, TaskSummary } from '@reality/schemas';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { FakePlanner } from '../src/planner/fake-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

const config = loadConfig({ AUTH: 'off', DATABASE_URL: TEST_DATABASE_URL, PLANNER: 'fake' });
let runtime: Runtime;
let app: FastifyInstance;

beforeEach(async () => {
  await resetTestDatabase();
  runtime = await createRuntime(config, { planner: new FakePlanner(), log: { error: () => {} } });
  app = buildApp(config, runtime);
  await app.listen({ port: 0, host: '127.0.0.1' });
});
afterEach(async () => {
  await app.close();
  await runtime.close();
});

const url = (path: string) => {
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return `http://127.0.0.1:${addr.port}${path}`;
};

describe('task API', () => {
  it('validates input', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/tasks', payload: { request: '' } });
    expect(res.statusCode).toBe(400);
    const bad = await app.inject({ method: 'GET', url: '/api/tasks/not-a-uuid' });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'GET',
      url: '/api/tasks/00000000-0000-4000-8000-000000000000',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('returns 409 when approving a task that is not waiting', async () => {
    const task = (
      await app.inject({ method: 'POST', url: '/api/tasks', payload: { request: 'x' } })
    ).json<TaskSummary>();
    await runtime.tasks.settled(task.id);
    await runtime.tasks.decide(task.id, { approved: true });
    await runtime.tasks.settled(task.id);
    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/approval`,
      payload: { approved: true },
    });
    expect(res.statusCode).toBe(409);
  });

  it('streams events over SSE, replaying history and then live events', async () => {
    const task = (
      await app.inject({ method: 'POST', url: '/api/tasks', payload: { request: 'x' } })
    ).json<TaskSummary>();
    await runtime.tasks.settled(task.id); // now awaiting approval

    const ctrl = new AbortController();
    const res = await fetch(url(`/api/tasks/${task.id}/events`), { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const received: TaskEvent[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (type: string) => {
      while (!received.some((e) => e.type === type)) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (data) received.push(JSON.parse(data) as TaskEvent);
        }
      }
    };

    await readUntil('approval.requested'); // replayed history
    await runtime.tasks.decide(task.id, { approved: true });
    await readUntil('task.completed'); // live events
    ctrl.abort();

    const ids = received.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect([...ids].sort((a, b) => a - b)).toEqual(ids); // in order
    expect(received[0]?.type).toBe('task.created');
  });
});
