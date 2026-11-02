import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, expect, it } from 'vitest';
import type { TaskEvent, TaskSummary } from '@reality/schemas';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const PORT = 18787;
const base = `http://127.0.0.1:${PORT}`;
let child: ChildProcess | undefined;

function startServer(): ChildProcess {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      SERVER_PORT: String(PORT),
      PLANNER: 'fake',
      FAKE_STEP_DELAY_MS: '1500',
      AUTH: 'off',
      ANTHROPIC_API_KEY: '',
    },
    stdio: 'ignore',
  });
  child = proc;
  return proc;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value !== undefined) return value;
    } catch {
      // server not up yet
    }
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const events = async (id: string): Promise<TaskEvent[]> =>
  (await (await fetch(`${base}/api/tasks/${id}/history`)).json()) as TaskEvent[];

beforeAll(resetTestDatabase);
afterEach(() => {
  child?.kill('SIGKILL');
});

it('resumes from the last checkpoint after the process is killed mid-execution', async () => {
  startServer();
  await waitFor(async () => ((await fetch(`${base}/api/health`)).ok ? true : undefined));

  const created = (await (
    await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: 'crash me' }),
    })
  ).json()) as TaskSummary;

  await waitFor(async () => {
    const t = (await (await fetch(`${base}/api/tasks/${created.id}`)).json()) as TaskSummary;
    return t.status === 'awaiting_approval' ? t : undefined;
  });
  await fetch(`${base}/api/tasks/${created.id}/approval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved: true }),
  });

  // Kill hard while a step after the first is in progress (earlier steps checkpointed).
  await waitFor(async () => {
    const log = await events(created.id);
    const started = log.filter((e) => e.type === 'step.started').length;
    const completed = log.filter((e) => e.type === 'step.completed').length;
    return started >= 2 && started > completed ? true : undefined;
  });
  child!.kill('SIGKILL');
  await new Promise((r) => child!.once('exit', r));

  startServer();
  const final = await waitFor(async () => {
    const t = (await (await fetch(`${base}/api/tasks/${created.id}`)).json()) as TaskSummary;
    return t.status === 'completed' ? t : undefined;
  }, 90_000);
  expect(final.status).toBe('completed');

  const log = await events(created.id);
  const count = (type: string) => log.filter((e) => e.type === type).length;
  expect(count('plan.created')).toBe(1); // planning was not redone
  expect(count('task.resumed')).toBe(1);
  // Each of the 3 steps completed exactly once; only the interrupted step restarted.
  const completed = log.filter((e) => e.type === 'step.completed');
  expect(completed.map((e) => (e.payload as { stepId: string }).stepId)).toEqual([
    's1',
    's2',
    's3',
  ]);
  // Exactly one step was interrupted and restarted (which one depends on timing).
  expect(count('step.started')).toBe(count('step.completed') + 1);
}, 240_000);
