import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

let root: string;
let app: FastifyInstance;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'reality-static-'));
  const dist = join(root, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Reality</title>');
  await writeFile(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  await writeFile(join(root, 'secret.txt'), 'do not serve');
  app = buildApp(loadConfig({ AUTH: 'off', WEB_DIST: dist }));
});
afterAll(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

describe('serving the built web app', () => {
  it('serves index.html with a content security policy', async () => {
    const res = await app.inject({ url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('caches fingerprinted assets for good', async () => {
    const res = await app.inject({ url: '/assets/app-abc123.js' });
    expect(res.body).toBe('console.log(1)');
    expect(res.headers['cache-control']).toMatch(/immutable/);
  });

  it('answers client-side routes with index.html', async () => {
    const res = await app.inject({ url: '/some/client/route' });
    expect(res.body).toMatch(/<title>Reality/);
  });

  it('never serves files outside the web directory', async () => {
    for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const res = await app.inject({ url });
      expect(res.body).not.toContain('do not serve');
    }
  });

  it('leaves unknown API paths as API 404s', async () => {
    const res = await app.inject({ url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toMatch(/<title>/);
  });
});
