import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskSummary } from '@reality/schemas';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { StepResult } from '../src/orchestrator/graph.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import {
  checkCriterion,
  Criterion,
  evidenceFrom,
  unbackedNumbers,
  verdictOf,
} from '../src/verification/criteria.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

const results: StepResult[] = [
  { stepId: 'profile', status: 'done', detail: '', summary: { rows: 731 } },
  {
    stepId: 'aggregate',
    status: 'done',
    detail: '',
    summary: { trend_per_year: 1.671, total: 297464.38 },
  },
  { stepId: 'skipped', status: 'skipped', detail: '', summary: { trend_per_year: 99 } },
  {
    stepId: 'decompose',
    status: 'done',
    detail: '',
    summary: { peak_month: 'May', significant: true, p_value: 0.001, nested: { x: 1 } },
  },
];

describe('evidence and criteria (pure)', () => {
  const evidence = evidenceFrom(results);

  it('numbers evidence from completed steps only, keeping scalar values', () => {
    expect(evidence.map((e) => [e.id, e.stepId])).toEqual([
      ['B1', 'profile'],
      ['B2', 'aggregate'],
      ['B3', 'decompose'],
    ]);
    expect(evidence[2]?.values).toEqual({ peak_month: 'May', significant: true, p_value: 0.001 });
  });

  it('checks ranges, targets with tolerance, and text', () => {
    const c = (raw: unknown) => checkCriterion(Criterion.parse(raw), 'K1', evidence);
    expect(c({ field: 'trend_per_year', min: 1.4, max: 2 })).toMatchObject({
      status: 'met',
      actual: 1.671,
      evidenceId: 'B2',
    });
    expect(c({ field: 'trend_per_year', target: 1.6, tolerancePercent: 5 })).toMatchObject({
      status: 'met',
    });
    expect(c({ field: 'trend_per_year', target: 1.6, tolerance: 0.05 })).toMatchObject({
      status: 'missed',
    });
    expect(c({ field: 'peak_month', equals: 'may' })).toMatchObject({ status: 'met' });
    expect(c({ field: 'significant', equals: 'true' })).toMatchObject({ status: 'met' });
    expect(c({ field: 'p_value', max: 0.05 })).toMatchObject({ status: 'met' });
    expect(c({ field: 'peak_month', min: 3 })).toMatchObject({ status: 'not_checkable' });
    expect(c({ field: 'forecast_end', min: 1 })).toMatchObject({
      status: 'open',
      evidenceId: null,
    });
    expect(c({ field: 'trend_per_year', step: 'decompose', min: 0 })).toMatchObject({
      status: 'open',
    });
  });

  it('rejects criteria that cannot be checked', () => {
    expect(Criterion.safeParse({ field: 'x' }).success).toBe(false);
    expect(Criterion.safeParse({ field: 'x', min: 2, max: 1 }).success).toBe(false);
    expect(Criterion.safeParse({ field: 'x', min: 1, extra: true }).success).toBe(false);
  });

  it('gives a verdict: one miss refutes, all met verifies', () => {
    const r = (status: string) => ({ status }) as never;
    expect(verdictOf([])).toBe('no_criteria');
    expect(verdictOf([r('met'), r('met')])).toBe('verified');
    expect(verdictOf([r('met'), r('open')])).toBe('partial');
    expect(verdictOf([r('open')])).toBe('not_verified');
    expect(verdictOf([r('met'), r('missed')])).toBe('refuted');
  });

  it('flags numbers without evidence, accepting percentages, the request and small counts', () => {
    const text =
      'Trend is 1.67 per year, total 297464.38, significant at 0.1%. Growth will reach 523.4 ppm in 2030 across 3 regions.';
    expect(unbackedNumbers(text, evidence, 'What happens by 2030?')).toEqual(['523.4']);
  });

  it('counts the hour in an ISO timestamp from a tool as backed', () => {
    const tool = [
      { id: 'E1', stepId: 'chat', values: { t: '{"datetime": "2025-08-23T17:00:00+09:00"}' } },
    ];
    expect(unbackedNumbers("It's 17:00 in Tokyo.", tool)).toEqual([]);
    expect(unbackedNumbers("It's 18:00 in Tokyo.", tool)).toEqual(['18']);
    // Thousands are one number, and match a source that writes them the same way.
    const plan = [{ id: 'K', stepId: 'chat', values: { t: 'Budget per tree: 1,200 euros' } }];
    expect(unbackedNumbers('That is 1,200 euros each.', plan)).toEqual([]);
    expect(unbackedNumbers('That is 2,400,000 euros a year.', plan)).toEqual(['2,400,000']);
    expect(unbackedNumbers('It rose by 1,5 percent.', [])).toEqual(['1,5']);
  });
});

describe('criteria through the API (sandbox, rule-based planner)', () => {
  let runtime: Runtime;
  let app: FastifyInstance;
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
    dir = await mkdtemp(join(tmpdir(), 'reality-criteria-'));
    const config = loadConfig({ AUTH: 'off', DATABASE_URL: TEST_DATABASE_URL, ARTIFACT_DIR: dir });
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

  it('accepts criteria before the run, verifies them from evidence, and locks them after', async () => {
    const task = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { request: 'Which regions drive revenue?', start: false },
      })
    ).json<TaskSummary>();
    await runtime.artifacts.putUpload(task.id, 'sales.csv', csv);
    await runtime.tasks.start(task.id);
    await runtime.tasks.settled(task.id);

    const url = `/api/tasks/${task.id}/criteria`;
    const before = (await app.inject({ url })).json<{
      locked: boolean;
      fields: { field: string }[];
    }>();
    expect(before.locked).toBe(false);
    expect(before.fields.map((f) => f.field)).toContain('top_group');

    expect(
      (await app.inject({ method: 'POST', url, payload: { field: 'top_group', equals: 'North' } }))
        .statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { field: 'top_share', min: 0.5, max: 0.9 },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await app.inject({ method: 'POST', url, payload: { field: 'top_share' } })).statusCode,
    ).toBe(400);

    await runtime.tasks.decide(task.id, { approved: true, by: 'user' });
    await runtime.tasks.settled(task.id);

    const after = (await app.inject({ url })).json<{
      locked: boolean;
      verdict: string;
      criteria: { id: string; status: string; evidenceId: string | null; actual: unknown }[];
    }>();
    expect(after.locked).toBe(true);
    expect(after.verdict).toBe('verified');
    expect(after.criteria.map((c) => [c.id, c.status])).toEqual([
      ['K1', 'met'],
      ['K2', 'met'],
    ]);
    expect(after.criteria[0]?.evidenceId).toMatch(/^B\d+$/);

    // Locked: the goal cannot move to fit the result.
    expect(
      (await app.inject({ method: 'POST', url, payload: { field: 'top_share', max: 1 } }))
        .statusCode,
    ).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `${url}/K1` })).statusCode).toBe(409);
  }, 120_000);

  it('refutes a result that misses a criterion', async () => {
    const task = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { request: 'Which regions drive revenue?', start: false },
      })
    ).json<TaskSummary>();
    await runtime.artifacts.putUpload(task.id, 'sales.csv', csv);
    await runtime.tasks.start(task.id);
    await runtime.tasks.settled(task.id);
    const url = `/api/tasks/${task.id}/criteria`;
    await app.inject({ method: 'POST', url, payload: { field: 'top_group', equals: 'South' } });
    await runtime.tasks.decide(task.id, { approved: true, by: 'user' });
    await runtime.tasks.settled(task.id);
    const after = (await app.inject({ url })).json<{
      verdict: string;
      criteria: { actual: unknown }[];
    }>();
    expect(after.verdict).toBe('refuted');
    expect(after.criteria[0]?.actual).toBe('North');
  }, 120_000);
});
