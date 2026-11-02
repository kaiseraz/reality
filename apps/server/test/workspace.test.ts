import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskSummary, WorkspaceSpec } from '@reality/schemas';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { FakePlanner } from '../src/planner/fake-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

let runtime: Runtime;
let app: FastifyInstance;
let artifactDir: string;

const SALES_CSV = [
  'week,revenue,region',
  '2025-01-06,120.5,North',
  '2025-01-13,98,South',
  '2025-01-20,,North',
  '2025-01-27,143.25,South',
].join('\n');

beforeEach(async () => {
  await resetTestDatabase();
  artifactDir = await mkdtemp(join(tmpdir(), 'reality-artifacts-'));
  const config = loadConfig({
    AUTH: 'off',
    DATABASE_URL: TEST_DATABASE_URL,
    PLANNER: 'fake',
    ARTIFACT_DIR: artifactDir,
  });
  runtime = await createRuntime(config, { planner: new FakePlanner(), log: { error: () => {} } });
  app = buildApp(config, runtime);
});
afterEach(async () => {
  await app.close();
  await runtime.close();
  await rm(artifactDir, { recursive: true, force: true });
});

const post = (url: string, payload?: object) =>
  app.inject({ method: 'POST', url, ...(payload !== undefined ? { payload } : {}) });
const json = <T>(res: LightMyRequestResponse) => res.json<T>();

async function newTask(): Promise<{ task: TaskSummary; ws: WorkspaceSpec }> {
  const task = json<TaskSummary>(await post('/api/tasks', { request: 'analyse sales' }));
  await runtime.tasks.settled(task.id);
  const ws = json<WorkspaceSpec>(await app.inject({ url: `/api/tasks/${task.id}/workspace` }));
  return { task, ws };
}

function upload(taskId: string, csv: string, filename = 'sales.csv') {
  return app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/artifacts?filename=${filename}`,
    headers: { 'content-type': 'text/csv' },
    payload: csv,
  });
}

const getWs = async (id: string) =>
  json<WorkspaceSpec>(await app.inject({ url: `/api/workspaces/${id}` }));

describe('workspaces', () => {
  it('every task gets a template workspace bound to live task state', async () => {
    const { ws } = await newTask();
    expect(ws.version).toBe(0);
    expect(
      Object.values(ws.components)
        .map((c) => c.type)
        .sort(),
    ).toEqual(['AgentActivity', 'ApprovalQueue', 'EvidencePanel', 'PlanView', 'RunLog']);
  });

  it('attaching a CSV stores typed data and adds a table and a chart', async () => {
    const { task, ws } = await newTask();
    const res = await upload(task.id, SALES_CSV);
    expect(res.statusCode).toBe(201);
    const meta = res.json<{ ref: { id: string }; columns: unknown; rowCount: number }>();
    expect(meta.rowCount).toBe(4);
    expect(meta.columns).toEqual([
      { name: 'week', type: 'date', distinct: 4, minDate: '2025-01-06', maxDate: '2025-01-27' },
      { name: 'revenue', type: 'number', distinct: 3, integer: false, min: 98, max: 143.25 },
      { name: 'region', type: 'string', distinct: 2 },
    ]);

    const after = await getWs(ws.id);
    expect(after.version).toBe(1);
    const types = Object.values(after.components).map((c) => c.type);
    expect(types).toContain('DataTable');
    expect(types).toContain('Chart');

    const rows = json<{ total: number; rows: Record<string, unknown>[] }>(
      await app.inject({
        url: `/api/artifacts/${meta.ref.id}/rows?sort=revenue&desc=true&limit=2`,
      }),
    );
    expect(rows.total).toBe(4);
    expect(rows.rows.map((r) => r.revenue)).toEqual([143.25, 120.5]); // numbers, not strings
  });

  it('rejects malformed CSVs', async () => {
    const { task } = await newTask();
    expect((await upload(task.id, 'a,a\n1,2')).statusCode).toBe(422);
    expect((await upload(task.id, 'a,b\n')).statusCode).toBe(422);
  });

  it('returns every validation error for an invalid patch and changes nothing', async () => {
    const { ws } = await newTask();
    const res = await post(`/api/workspaces/${ws.id}/patches`, {
      baseVersion: 0,
      ops: [
        {
          op: 'addComponent',
          instanceId: 'x',
          component: {
            type: 'DataTable',
            typeVersion: '1.0.0',
            props: { title: 'x', script: '<script>' },
            bindings: {},
            actions: ['nuke'],
            provenance: { proposedBy: 'workspace-agent' },
          },
        },
      ],
    });
    expect(res.statusCode).toBe(422);
    const errors = res.json<{ errors: string[] }>().errors.join('\n');
    expect(errors).toMatch(/props/);
    expect(errors).toMatch(/no action "nuke"/);
    expect(errors).toMatch(/required input "rows"/);
    expect((await getWs(ws.id)).version).toBe(0);
  });

  it('cannot bind another task’s data', async () => {
    const a = await newTask();
    const b = await newTask();
    const meta = (await upload(a.task.id, SALES_CSV)).json<{ ref: unknown }>();
    const res = await post(`/api/workspaces/${b.ws.id}/patches`, {
      baseVersion: 0,
      ops: [
        {
          op: 'addComponent',
          instanceId: 't',
          component: {
            type: 'DataTable',
            typeVersion: '1.0.0',
            props: { title: 'stolen' },
            bindings: { rows: { kind: 'artifact', artifact: meta.ref } },
            provenance: { proposedBy: 'user' },
          },
        },
      ],
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/does not exist/);
  });

  it('serializes concurrent patches: exactly one of two same-version patches wins', async () => {
    const { ws } = await newTask();
    const patch = (title: string) =>
      post(`/api/workspaces/${ws.id}/patches`, {
        baseVersion: 0,
        ops: [{ op: 'updateProps', instanceId: 'plan', props: { title } }],
      });
    const [r1, r2] = await Promise.all([patch('A'), patch('B')]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 422]);
    expect((await getWs(ws.id)).version).toBe(1);
  });

  it('undo reverts content patches in order, skips layout moves, and stops at the start', async () => {
    const { ws } = await newTask();
    const original = await getWs(ws.id);

    let v = 0;
    const apply = async (ops: unknown[]) => {
      const r = await post(`/api/workspaces/${ws.id}/patches`, { baseVersion: v, ops });
      expect(r.statusCode, r.body).toBe(200);
      v += 1;
    };
    await apply([{ op: 'updateProps', instanceId: 'plan', props: { title: 'Renamed' } }]);
    await apply([{ op: 'removeComponent', instanceId: 'activity' }]);
    await apply([{ op: 'setLayout', layout: { user: 'arrangement' } }]);

    await post(`/api/workspaces/${ws.id}/undo`); // restores activity
    let now = await getWs(ws.id);
    expect(now.components.activity).toEqual(original.components.activity);
    expect(now.layout).toEqual({ user: 'arrangement' }); // layout untouched by undo

    await post(`/api/workspaces/${ws.id}/undo`); // restores title
    now = await getWs(ws.id);
    expect(now.components).toEqual(original.components);
    expect(now.version).toBe(5);

    expect((await post(`/api/workspaces/${ws.id}/undo`)).statusCode).toBe(409);
  });

  it('can undo a template patch (removing the dataset views)', async () => {
    const { task, ws } = await newTask();
    await upload(task.id, SALES_CSV);
    await post(`/api/workspaces/${ws.id}/undo`);
    const now = await getWs(ws.id);
    expect(Object.keys(now.components).sort()).toEqual([
      'activity',
      'approvals',
      'evidence',
      'plan',
      'runs',
    ]);
  });
});

describe('action router', () => {
  it('routes ApprovalQueue.approve to the orchestrator', async () => {
    const { task, ws } = await newTask();
    const res = await post(`/api/workspaces/${ws.id}/actions`, {
      instanceId: 'approvals',
      actionId: 'approve',
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    await runtime.tasks.settled(task.id);
    expect((await runtime.tasks.get(task.id))?.status).toBe('completed');
    const types = (await runtime.events.list(task.id)).map((e) => e.type);
    expect(types).toContain('workspace.action');
    expect(types).toContain('approval.granted');
  });

  it.each([
    ['unknown instance', { instanceId: 'ghost', actionId: 'approve', payload: {} }, 422],
    [
      'action the instance does not expose',
      { instanceId: 'plan', actionId: 'approve', payload: {} },
      422,
    ],
    ['undeclared action', { instanceId: 'approvals', actionId: 'escalate', payload: {} }, 422],
    ['invalid payload', { instanceId: 'approvals', actionId: 'deny', payload: { reason: 1 } }, 422],
  ])('rejects %s', async (_name, body, status) => {
    const { task, ws } = await newTask();
    const res = await post(`/api/workspaces/${ws.id}/actions`, body);
    expect(res.statusCode).toBe(status);
    expect((await runtime.tasks.get(task.id))?.status).toBe('awaiting_approval');
  });

  it('returns 409 when approving twice', async () => {
    const { task, ws } = await newTask();
    const approve = () =>
      post(`/api/workspaces/${ws.id}/actions`, { instanceId: 'approvals', actionId: 'approve' });
    expect((await approve()).statusCode).toBe(202);
    await runtime.tasks.settled(task.id);
    expect((await approve()).statusCode).toBe(409);
  });
});

describe('follow-up questions', () => {
  it('start a new task on the same data, re-preparing the original file', async () => {
    const { task } = await newTask();
    // A file that needs preparation: the follow-up must get the original, prepared again.
    const csv = '# source: test\nyear,month,value\n2024,1,5\n2024,2,6\n';
    expect((await upload(task.id, csv, 'raw.csv')).statusCode).toBe(201);
    const res = await post(`/api/tasks/${task.id}/follow-up`, { request: 'And the trend?' });
    expect(res.statusCode).toBe(201);
    const next = json<TaskSummary>(res);
    expect(next.id).not.toBe(task.id);
    expect(next.request).toBe('And the trend?');
    await runtime.tasks.settled(next.id);
    const artifacts = await runtime.artifacts.listForTask(next.id);
    expect(artifacts.map((a) => [a.filename, a.provenance.kind])).toEqual([
      ['raw.csv', 'upload'],
      ['raw (prepared).csv', 'prepared'],
    ]);
  });

  it('answer 404 for an unknown task', async () => {
    const res = await post('/api/tasks/00000000-0000-4000-8000-000000000000/follow-up', {
      request: 'x',
    });
    expect(res.statusCode).toBe(404);
  });
});
