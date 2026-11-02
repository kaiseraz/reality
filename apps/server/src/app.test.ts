import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

describe('server', () => {
  it('reports health without leaking secrets', async () => {
    const app = buildApp(loadConfig({ ANTHROPIC_API_KEY: 'sk-test-secret' }));
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      service: 'reality-server',
      configured: { database: false, llm: true },
      planner: 'anthropic',
      sandboxProblem: null,
    });
    expect(res.body).not.toContain('sk-test-secret');
    await app.close();
  });

  it('falls back to the rule-based planner, visibly, when no key is configured', async () => {
    const app = buildApp(loadConfig({}));
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toMatchObject({ planner: 'rules' });
    await app.close();
  });

  it('rejects invalid configuration', () => {
    expect(() => loadConfig({ SERVER_PORT: 'not-a-port' })).toThrow(/Invalid configuration/);
  });
});
