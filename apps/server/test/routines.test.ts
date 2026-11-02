import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { PageConflictError, type PageDetail } from '../src/pages/pages.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { nextRun, type RoutineView } from '../src/routines/routines.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

describe('routine schedules (pure)', () => {
  // Thursday 2025-08-14, 10:30 local time.
  const from = new Date(2025, 7, 14, 10, 30);

  it('daily: later today, else tomorrow', () => {
    expect(nextRun({ type: 'daily', time: '12:00' }, from)).toEqual(new Date(2025, 7, 14, 12, 0));
    expect(nextRun({ type: 'daily', time: '08:00' }, from)).toEqual(new Date(2025, 7, 15, 8, 0));
  });

  it('weekdays skip the weekend, weekly hits its day', () => {
    const friday = new Date(2025, 7, 15, 9, 0);
    expect(nextRun({ type: 'weekdays', time: '08:00' }, friday)).toEqual(
      new Date(2025, 7, 18, 8, 0),
    );
    expect(nextRun({ type: 'weekly', time: '07:15', day: 1 }, from)).toEqual(
      new Date(2025, 7, 18, 7, 15),
    );
  });

  it('interval: minutes from now', () => {
    expect(nextRun({ type: 'interval', minutes: 90 }, from)).toEqual(new Date(2025, 7, 14, 12, 0));
  });
});

describe('pages and routines (database, sandbox)', () => {
  let runtime: Runtime;
  let app: FastifyInstance;
  let dir: string;

  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-routines-'));
    const config = loadConfig({ AUTH: 'off', DATABASE_URL: TEST_DATABASE_URL, ARTIFACT_DIR: dir });
    runtime = await createRuntime(config, {
      planner: new RuleBasedPlanner(),
      analyst: null,
      synthesizer: null,
      log: { error: () => {} },
    });
    app = buildApp(config, runtime);
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps every version of a page and refuses conflicting saves', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: { title: 'Weekly report', content: 'First draft.' },
    });
    expect(created.statusCode).toBe(201);
    const page = created.json<PageDetail>();
    expect(page).toMatchObject({ version: 1, author: 'You', content: 'First draft.' });

    const save = (content: string, baseVersion: number) =>
      app.inject({
        method: 'PUT',
        url: `/api/pages/${page.id}`,
        payload: { content, baseVersion, change: 'Rewrote it' },
      });
    expect((await save('Second draft.', 1)).json<PageDetail>().version).toBe(2);
    // A save based on version 1 after version 2 exists would silently drop version 2.
    const stale = await save('Stale edit.', 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ current: 2 });
    // Saving the same text again creates no version.
    expect((await save('Second draft.', 2)).json<PageDetail>().version).toBe(2);

    const restored = await app.inject({
      method: 'POST',
      url: `/api/pages/${page.id}/restore`,
      payload: { version: 1 },
    });
    expect(restored.json<PageDetail>()).toMatchObject({
      version: 3,
      content: 'First draft.',
      change: 'Restored version 1',
    });
    const v2 = await app.inject({ url: `/api/pages/${page.id}/versions/2` });
    expect(v2.json()).toMatchObject({ content: 'Second draft.', change: 'Rewrote it' });
    expect(restored.json<PageDetail>().versions.map((v) => v.version)).toEqual([3, 2, 1]);

    await expect(
      runtime.pages.write(page.id, null, {
        content: 'x',
        author: 'a',
        change: 'c',
        baseVersion: 2,
      }),
    ).rejects.toThrow(PageConflictError);
    // Other owners do not see the page.
    expect(await runtime.pages.get(page.id, 'someone-else')).toBeUndefined();
  });

  it('validates routines: schedule, page and dataset', async () => {
    const bad = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/routines', payload });
    const base = { name: 'Digest', request: 'Which regions drive revenue?' };
    expect((await bad({ ...base, schedule: { type: 'daily', time: '25:00' } })).statusCode).toBe(
      400,
    );
    expect((await bad({ ...base, schedule: { type: 'interval', minutes: 1 } })).statusCode).toBe(
      400,
    );
    expect(
      (
        await bad({
          ...base,
          schedule: { type: 'daily', time: '08:00' },
          pageId: '00000000-0000-4000-8000-000000000000',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await bad({ ...base, schedule: { type: 'daily', time: '08:00' }, sample: 'nope' }))
        .statusCode,
    ).toBe(404);
  });

  it('runs on schedule, approves by policy, and appends the verified result to a page', async () => {
    const page = await runtime.pages.create(null, {
      title: 'Bike digest',
      content: '# Bike digest',
      author: 'You',
    });
    const routine = (
      await app.inject({
        method: 'POST',
        url: '/api/routines',
        payload: {
          name: 'Weather check',
          request: 'Which weather situation (weathersit) drives bike rentals (cnt)?',
          schedule: { type: 'weekly', time: '07:00', day: 1 },
          sample: 'bike',
          pageId: page.id,
          autoApprove: true,
        },
      })
    ).json<RoutineView>();
    expect(routine.nextRun).not.toBeNull();

    // Not due yet: nothing starts.
    await runtime.routines.tick();
    expect((await runtime.routines.get(routine.id, null))?.runs).toHaveLength(0);

    // Make it due.
    const db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    await db.query("UPDATE routines SET next_run = now() - interval '1 minute' WHERE id = $1", [
      routine.id,
    ]);
    await db.end();
    let view: RoutineView | undefined;
    for (let i = 0; i < 20; i++) {
      await runtime.routines.tick();
      await runtime.tasks.settleAll();
      view = await runtime.routines.get(routine.id, null);
      if (view?.runs[0]?.handled === 'finished') break;
    }
    expect(view?.runs).toHaveLength(1);
    expect(view?.runs[0]).toMatchObject({ status: 'completed', handled: 'finished' });
    expect(view?.runs[0]?.note).toContain('version 2');
    expect(new Date(view?.nextRun ?? 0).getTime()).toBeGreaterThan(Date.now());

    const after = await runtime.pages.get(page.id, null);
    expect(after?.version).toBe(2);
    expect(after?.content).toContain('# Bike digest');
    expect(after?.content).toContain('## Which weather situation');
    expect(after?.content).toMatch(/### Verification: (\d+) of \1 passed/);
    expect(after?.versions[0]).toMatchObject({
      author: 'Routine: Weather check',
      taskId: view?.runs[0]?.taskId,
    });
  }, 300_000);

  it('without auto-approval, a run waits in the inbox', async () => {
    const routine = (
      await app.inject({
        method: 'POST',
        url: '/api/routines',
        payload: {
          name: 'Manual',
          request: 'Which regions drive revenue?',
          schedule: { type: 'daily', time: '06:00' },
          sample: 'sales',
        },
      })
    ).json<RoutineView>();
    const run = await app.inject({ method: 'POST', url: `/api/routines/${routine.id}/run` });
    expect(run.statusCode).toBe(201);
    await runtime.tasks.settleAll();
    await runtime.routines.tick();
    const view = await runtime.routines.get(routine.id, null);
    expect(view?.runs[0]).toMatchObject({ status: 'awaiting_approval', handled: 'deferred' });
    const inbox = (await app.inject({ url: '/api/inbox' })).json<{ taskId?: string }[]>();
    expect(JSON.stringify(inbox)).toContain(view?.runs[0]?.taskId ?? 'missing');
  }, 120_000);
});
