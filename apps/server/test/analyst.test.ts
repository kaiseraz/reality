import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Analyst } from '../src/analysis/executor.ts';
import { loadConfig } from '../src/config.ts';
import type { StepResult } from '../src/orchestrator/graph.ts';
import { FakePlanner } from '../src/planner/fake-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

const plan = {
  goal: 'Median revenue per region',
  requiredOutputs: ['median per region'],
  acceptanceCriteria: [{ id: 'h', description: 'Looks right', checkType: 'human' }],
  workflow: [
    {
      id: 'median',
      description: 'Median revenue per region, written to median.csv',
      agent: 'analysis-agent',
    },
  ],
};

const prompts: Parameters<Analyst['writeCode']>[0][] = [];
const analyst: Analyst = {
  name: 'scripted',
  async writeCode(input) {
    prompts.push(input);
    return input.previousError
      ? 'import pandas as pd\ndf = pd.read_csv("/input/data.csv")\ndf.groupby("region")["revenue"].median().reset_index().to_csv("/output/median.csv", index=False)\nprint("ok")'
      : 'import pandas as pd\ndf = pd.read_csv("/input/data.csv")\nprint(df["revnue"].median())'; // typo: KeyError
  },
};

let runtime: Runtime;
let dir: string;
let taskId: string;

beforeAll(async () => {
  await resetTestDatabase();
  dir = await mkdtemp(join(tmpdir(), 'reality-analyst-'));
  runtime = await createRuntime(
    loadConfig({ AUTH: 'off', DATABASE_URL: TEST_DATABASE_URL, ARTIFACT_DIR: dir }),
    {
      planner: new FakePlanner([plan]),
      analyst,
      log: { error: () => {} },
    },
  );
  taskId = (await runtime.tasks.create('Median revenue per region', { start: false })).id;
  await runtime.artifacts.putCsv(
    taskId,
    'sales.csv',
    'week,region,revenue\n2025-01-06,North,10\n2025-01-06,South,4\n2025-01-13,North,20\n2025-01-13,South,6\n',
  );
  await runtime.tasks.start(taskId);
  await runtime.tasks.settled(taskId);
  await runtime.tasks.decide(taskId, { approved: true });
  await runtime.tasks.settled(taskId);
}, 120_000);
afterAll(async () => {
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
});

it('retries AI-written code once with the error, then stores the result', async () => {
  const results = (await runtime.tasks.get(taskId))?.state?.stepResults ?? [];
  const step = results.find((r: StepResult) => r.stepId === 'median');
  expect(step?.status, step?.detail).toBe('done');
  expect(prompts).toHaveLength(2);
  expect(prompts[1]?.previousError).toMatch(/KeyError/);
  expect(prompts[0]?.dataset.columns.map((c) => c.name)).toEqual(['week', 'region', 'revenue']);

  const runs = (await runtime.runs.listForTask(taskId)).filter((r) => r.kind === 'analysis');
  expect(runs.map((r) => [r.label, r.status])).toEqual([
    ['analyst:scripted', 'failed'],
    ['analyst:scripted (retry)', 'succeeded'],
  ]);
  const derived = (await runtime.artifacts.listForTask(taskId)).find(
    (a) => a.filename === 'median.csv',
  );
  const rows = await runtime.artifacts.rows(derived!, { offset: 0, limit: 10 });
  expect(rows.rows).toEqual([
    { region: 'North', revenue: 15 },
    { region: 'South', revenue: 5 },
  ]);
});
