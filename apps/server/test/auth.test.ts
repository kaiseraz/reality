import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskSummary } from '@reality/schemas';
import { buildApp } from '../src/app.ts';
import { hashPassword, LoginLimiter, verifyPassword } from '../src/auth/auth-service.ts';
import { loadConfig } from '../src/config.ts';
import { FakePlanner } from '../src/planner/fake-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

// Test-only credentials for a throwaway database.
const ADMIN = { email: 'admin@example.test', password: 'admin-test-password' };
const MEMBER = { email: 'member@example.test', password: 'member-test-password' };

let runtime: Runtime;
let app: FastifyInstance;

beforeAll(async () => {
  await resetTestDatabase();
  const config = loadConfig({ AUTH: 'on', DATABASE_URL: TEST_DATABASE_URL, PLANNER: 'fake' });
  runtime = await createRuntime(config, { planner: new FakePlanner(), log: { error: () => {} } });
  app = buildApp(config, runtime);
});
afterAll(async () => {
  await app.close();
  await runtime.close();
});

const cookieOf = (res: LightMyRequestResponse) =>
  String(res.headers['set-cookie'] ?? '').split(';')[0] ?? '';
const as = (cookie: string) => ({ cookie });

describe('passwords', () => {
  it('hashes with a salt and verifies only the right password', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('wrong horse battery', a)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('limits failed logins per key within a window', () => {
    const l = new LoginLimiter(3, 1000);
    for (let i = 0; i < 3; i++) l.fail('k', 0);
    expect(l.blocked('k', 10)).toBe(true);
    expect(l.blocked('other', 10)).toBe(false);
    expect(l.blocked('k', 2000)).toBe(false);
  });
});

describe('accounts and access control', () => {
  let adminCookie = '';
  let memberCookie = '';
  let adminTask: TaskSummary;

  it('requires a session for the API, but health and sign-in stay public', async () => {
    expect((await app.inject({ url: '/api/tasks' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
    const me = (await app.inject({ url: '/api/auth/me' })).json();
    expect(me).toEqual({ authEnabled: true, setupRequired: true, user: null });
  });

  it('creates the first account as admin, only once', async () => {
    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: ADMIN.email, password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: ADMIN });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ email: ADMIN.email, role: 'admin' });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    adminCookie = cookieOf(res);
    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: 'x@example.test', password: 'another-long-password' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('lets the admin add members; members cannot add accounts', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/users',
      headers: as(adminCookie),
      payload: MEMBER,
    });
    expect(res.statusCode).toBe(201);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: MEMBER });
    expect(login.statusCode).toBe(200);
    memberCookie = cookieOf(login);
    const denied = await app.inject({
      method: 'POST',
      url: '/api/auth/users',
      headers: as(memberCookie),
      payload: { email: 'z@example.test', password: 'yet-another-password' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('rejects a wrong password with the same message as an unknown account', async () => {
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN.email, password: 'not-the-password' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.test', password: 'not-the-password' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().message).toBe(unknown.json().message);
  });

  it('shows each account only its own tasks, workspaces and artifacts', async () => {
    adminTask = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: as(adminCookie),
        payload: { request: 'admin task', start: false },
      })
    ).json<TaskSummary>();
    await app.inject({
      method: 'POST',
      url: `/api/tasks/${adminTask.id}/artifacts?filename=a.csv`,
      headers: { ...as(adminCookie), 'content-type': 'text/csv' },
      payload: 'a,b\n1,2\n',
    });
    const mine = (await app.inject({ url: '/api/tasks', headers: as(memberCookie) })).json<
      TaskSummary[]
    >();
    expect(mine).toEqual([]);
    const theirs = (await app.inject({ url: '/api/tasks', headers: as(adminCookie) })).json<
      TaskSummary[]
    >();
    expect(theirs.map((t) => t.id)).toEqual([adminTask.id]);

    // Every route behind the task answers 404 to another account.
    expect(
      (await app.inject({ url: `/api/tasks/${adminTask.id}`, headers: as(memberCookie) }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: `/api/tasks/${adminTask.id}/workspace`,
          headers: as(memberCookie),
        })
      ).statusCode,
    ).toBe(404);
    const ws = (
      await app.inject({ url: `/api/tasks/${adminTask.id}/workspace`, headers: as(adminCookie) })
    ).json<{ id: string }>();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/workspaces/${ws.id}/undo`,
          headers: as(memberCookie),
        })
      ).statusCode,
    ).toBe(404);
    const artifacts = (
      await app.inject({ url: `/api/tasks/${adminTask.id}/artifacts`, headers: as(adminCookie) })
    ).json<{ ref: { id: string } }[]>();
    const artifactId = artifacts[0]?.ref.id ?? '';
    expect(
      (await app.inject({ url: `/api/artifacts/${artifactId}/rows`, headers: as(memberCookie) }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: `/api/artifacts/${artifactId}/rows`, headers: as(adminCookie) }))
        .statusCode,
    ).toBe(200);
  });

  it('serves a chat file and a visual to their owner only, the visual in a closed frame', async () => {
    const me = await app.inject({ url: '/api/auth/me', headers: as(adminCookie) });
    const dir = await mkdtemp(join(tmpdir(), 'reality-auth-'));
    await writeFile(join(dir, 'file'), '<p>drawn</p>');
    const file = await runtime.files.put(
      null,
      null,
      'visual.html',
      join(dir, 'file'),
      me.json<{ user: { id: string } }>().user.id,
    );
    await rm(dir, { recursive: true, force: true });
    for (const url of [`/api/files/${file.id}`, `/api/files/${file.id}/visual`]) {
      expect((await app.inject({ url, headers: as(adminCookie) })).statusCode).toBe(200);
      expect((await app.inject({ url, headers: as(memberCookie) })).statusCode).toBe(404);
    }
    const visual = await app.inject({
      url: `/api/files/${file.id}/visual`,
      headers: as(adminCookie),
    });
    expect(visual.body).toContain('<p>drawn</p>');
    expect(visual.headers['content-security-policy']).toContain('sandbox allow-scripts;');
    expect(visual.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('refuses state changes from another origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { ...as(adminCookie), origin: 'https://evil.example', host: 'localhost:8787' },
      payload: { request: 'csrf' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('ends the session on logout', async () => {
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: as(memberCookie),
    });
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect((await app.inject({ url: '/api/tasks', headers: as(memberCookie) })).statusCode).toBe(
      401,
    );
  });
});
