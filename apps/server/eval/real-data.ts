/**
 * Runs realistic questions on real public datasets through the whole system and prints
 * what a user would see: plan, step results, verification, workspace views.
 *   npx tsx eval/real-data.ts [data dir, default samples/real] [case ids…]
 * Datasets: real public data (sources and licenses in samples/real/README.md).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../src/config.ts';
import type { StepResult } from '../src/orchestrator/graph.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { createRuntime } from '../src/runtime.ts';

const dir = process.argv[2] || fileURLToPath(new URL('../../../samples/real/', import.meta.url));

const only = process.argv.slice(3);

const CASES = [
  {
    id: 'co2-season',
    file: 'co2_mm_mlo.csv',
    request: 'Is there a seasonal cycle in monthly CO2 at Mauna Loa, and how strong is it?',
  },
  {
    id: 'co2-trend',
    file: 'co2_mm_mlo.csv',
    request: 'How has the average CO2 concentration changed over time?',
  },
  {
    id: 'bike-season',
    file: 'bike_day.csv',
    request: 'Is there a seasonal pattern in daily bike rentals (cnt)?',
  },
  {
    id: 'bike-weather',
    file: 'bike_day.csv',
    request: 'Which weather situation (weathersit) drives bike rentals (cnt)?',
  },
  {
    id: 'co2-forecast',
    file: 'co2_mm_mlo.csv',
    request: 'Forecast the monthly CO2 average at Mauna Loa for the next 24 months.',
  },
  {
    id: 'bike-factors',
    file: 'bike_day.csv',
    request: 'Which factors influence daily bike rentals (cnt)?',
  },
  {
    id: 'bike-forecast',
    file: 'bike_day.csv',
    request: 'Forecast daily bike rentals (cnt) for the next 3 months.',
  },
  {
    id: 'bike-sql',
    file: 'bike_day.csv',
    request:
      'Run SELECT weathersit, AVG(cnt) AS avg_rentals, COUNT(*) AS days FROM data GROUP BY weathersit ORDER BY weathersit',
  },
];

const admin = new pg.Client({
  connectionString: 'postgres://reality:reality@localhost:5432/reality',
});
await admin.connect();
await admin.query('DROP DATABASE IF EXISTS reality_real WITH (FORCE)');
await admin.query('CREATE DATABASE reality_real');
await admin.end();
const data = fileURLToPath(new URL('../../../.data/real/', import.meta.url));
const rt = await createRuntime(
  loadConfig({
    ...process.env,
    DATABASE_URL: 'postgres://reality:reality@localhost:5432/reality_real',
    ARTIFACT_DIR: `${data}artifacts`,
    CAPABILITY_DIR: `${data}capabilities`,
  }),
  { planner: new RuleBasedPlanner(), analyst: null, log: { error: (e) => console.error(e) } },
);

for (const c of CASES.filter((x) => only.length === 0 || only.includes(x.id))) {
  console.log(`\n=== ${c.id}: ${c.request}`);
  const t0 = Date.now();
  const task = await rt.tasks.create(c.request, { start: false });
  try {
    const { original, prepared } = await rt.artifacts.putUpload(
      task.id,
      c.file,
      await readFile(join(dir, c.file), 'utf8'),
    );
    const meta = prepared ?? original;
    if (prepared && prepared.provenance.kind === 'prepared')
      for (const n of prepared.provenance.notes) console.log(`prepared: ${n}`);
    console.log(
      `upload: ${meta.rowCount} rows; columns ${meta.columns.map((k) => `${k.name}:${k.type}(${k.distinct})`).join(', ')}`,
    );
    await rt.workspaces.onDatasetAdded(task.id, meta);
  } catch (err) {
    console.log(`UPLOAD REJECTED: ${(err as Error).message}`);
    continue;
  }
  await rt.tasks.start(task.id);
  for (let i = 0; i < 6; i++) {
    await rt.tasks.settled(task.id);
    const d = await rt.tasks.get(task.id);
    if (d?.status !== 'awaiting_approval') break;
    await rt.tasks.decide(task.id, { approved: true, note: 'real-data probe' });
  }
  await rt.tasks.settled(task.id);
  const d = await rt.tasks.get(task.id);
  console.log(
    `status: ${d?.status}${d?.state?.error ? ` (${d.state.error})` : ''} in ${((Date.now() - t0) / 1000).toFixed(0)} s`,
  );
  for (const r of d?.state?.spec?.risks ?? []) console.log(`  risk: ${r}`);
  for (const s of d?.state?.spec?.workflow ?? []) {
    const r = (d?.state?.stepResults ?? []).find((x: StepResult) => x.stepId === s.id);
    console.log(
      `  step ${s.id} [${r?.status ?? '-'}] ${s.recipe ? `${s.recipe.name} ${JSON.stringify(s.recipe.params)}` : s.tool ? 'tool' : ''}`,
    );
    if (r?.detail) console.log(`      ${r.detail.split('\n').slice(0, 4).join('\n      ')}`);
  }
  for (const v of d?.state?.verification ?? [])
    console.log(`  check ${v.criterionId} [${v.status}] ${v.detail}`);
  const ws = await rt.workspaces.getByTask(task.id);
  console.log(
    `  views: ${Object.values(ws?.components ?? {})
      .filter((k) => k.type === 'Chart' || k.type === 'DataTable')
      .map((k) => `${k.type}:${String(k.props.title)}`)
      .join(' | ')}`,
  );
}
await rt.close();
