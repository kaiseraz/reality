/**
 * npm run eval:design: does the configured model (Meta Muse Spark, or Claude) design things
 * with Reality's bots? Three missions, each judged by code against checked results:
 *   1. a 555 timer board  (pcb_design: every net routed, no design-rule violations)
 *   2. a bearing assembly (design_assembly: no clashes, under a mass limit)
 *   3. a two-stage rocket (rocket_engine, launch_vehicle, ascent_trajectory: reaches orbit)
 * Reads .env; never prints the key. Uses its own scratch database (reality_designeval), so
 * nothing of yours is touched. Prints what the bot wrote, what failed and how it fixed it.
 * Usage: npm run eval:design [pcb|assembly|rocket] [minutes per mission, default 20]
 */
process.env.TEST_DATABASE_URL ??= 'postgres://reality:reality@localhost:5432/reality_designeval';
const { loadConfig, modelConfig } = await import('../src/config.ts');
const { buildApp } = await import('../src/app.ts');
const { createRuntime } = await import('../src/runtime.ts');
const { resetTestDatabase, TEST_DATABASE_URL } = await import('../test/db.ts');
const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const GOALS: Record<
  string,
  { goal: string; criteria: Record<string, unknown>[]; maxTasks: number }
> = {
  pcb: {
    goal: 'Design a 50 x 35 mm two-layer board for an NE555 astable timer: the 555 in SOIC8, two resistors and two capacitors (0603) for the timing, a 470 ohm resistor and a red LED (0603) on the output, a 2-pin power header at the left edge. Route everything with no design-rule violations.',
    criteria: [
      { field: 'design_ok', equals: 'true' },
      { field: 'drc_violations', max: 0 },
    ],
    maxTasks: 8,
  },
  assembly: {
    goal: 'Design a pillow-block bearing assembly: a steel base plate (120 x 60 x 12 mm) with four 9 mm mounting holes, an aluminium housing on it with a 28 mm bore along x, a 20 mm steel shaft 140 mm long, two bearings (20 mm bore, 28 mm outside, 12 mm wide) pressed into the bore, and four M8 bolts in the plate holes. Nothing may intersect and the total mass must stay under 3 kg.',
    criteria: [
      { field: 'interference_count', max: 0 },
      { field: 'total_mass_kg', max: 3 },
    ],
    maxTasks: 8,
  },
  rocket: {
    goal: 'Design a two-stage rocket on methane and liquid oxygen that puts 5 tonnes into a 400 km orbit from 28.5 degrees latitude. Size the engine (rocket_engine) first, use its Isp for the staging (launch_vehicle), then fly it (ascent_trajectory) and make sure it reaches the orbit with propellant to spare.',
    criteria: [
      { field: 'orbit_reached', equals: 'true' },
      { field: 'propellant_margin_kg', min: 0 },
    ],
    maxTasks: 12,
  },
};

const config = loadConfig(process.env);
if (!modelConfig(config)) {
  console.log(
    '\n  No model configured: put META_MODEL_API_KEY into .env first (npm run check:model).\n',
  );
  process.exit(2);
}
const which = process.argv[2] && GOALS[process.argv[2]] ? [process.argv[2]] : Object.keys(GOALS);
const minutes = Number(process.argv[3] ?? 20);

await resetTestDatabase();
const dir = await mkdtemp(join(tmpdir(), 'reality-design-eval-'));
const cfg = loadConfig({
  ...process.env,
  AUTH: 'off',
  DATABASE_URL: TEST_DATABASE_URL,
  ARTIFACT_DIR: dir,
  CAPABILITY_DIR: dir,
});
const runtime = await createRuntime(cfg);
const app = buildApp(cfg, runtime);
runtime.chats.engine.start();
runtime.projects.start();

let failed = 0;
for (const name of which) {
  const g = GOALS[name];
  if (!g) continue;
  const bot = (
    await app.inject({
      method: 'POST',
      url: '/api/bots',
      payload: { name: `Designer-${name}`, role: 'engineer' },
    })
  ).json<{ id: string }>();
  console.log(`\n== ${name}: ${g.goal}\n`);
  const started = await app.inject({
    method: 'POST',
    url: '/api/missions',
    payload: {
      goal: g.goal,
      botIds: [bot.id],
      criteria: g.criteria,
      maxTasks: g.maxTasks,
      allowInstalls: ['cantera', 'cadquery-ocp-novtk'],
      hours: 1,
    },
  });
  const mission = started.json<{ id: string }>();
  const until = Date.now() + minutes * 60_000;
  let m: Record<string, unknown> = {};
  let seen = 0;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5000));
    m = (await app.inject({ url: `/api/missions/${mission.id}` })).json();
    const journal = (m.journal as { text: string }[] | undefined) ?? [];
    for (const j of journal.slice(seen)) console.log(`  ${j.text}`);
    seen = journal.length;
    if (m.status !== 'running') break;
  }
  const criteria =
    (m.criteria as { field: string; expected: string; status: string; actual: unknown }[]) ?? [];
  const ok = m.verdict === 'verified';
  if (!ok) failed++;
  console.log(
    `\n  ${ok ? 'PASS' : 'FAIL'}  ${name}: status ${String(m.status)}, verdict ${String(m.verdict)}, ${String(m.tasksUsed)} tasks, ${String(m.rounds)} rounds`,
  );
  for (const c of criteria)
    console.log(`        ${c.field} ${c.expected}: ${c.status} (actual ${String(c.actual)})`);
}
console.log(
  failed
    ? `\n  ${failed} of ${which.length} designs not verified. Read the journal above: it says what the bot saw and changed.\n`
    : '\n  Every design was verified by code against checked results.\n',
);
await app.close();
await runtime.close();
await rm(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
