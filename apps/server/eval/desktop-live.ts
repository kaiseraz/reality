/**
 * npm run eval:desktop [pictures folder]: does a lab result reach a real bot desktop and open in
 * the real program? Starts a bot's computer from COMPUTER_IMAGE (default reality-computer:dev,
 * built from sandbox/computer), designs a board with the lab, sends it to the desktop and takes
 * pictures of the screen: first the board as placed (KiCad's ratsnest), then routed. Uses its own
 * scratch database (reality_desktopeval), so your bots and computers are untouched.
 * Needs Docker, Postgres and the computer image.
 */
process.env.TEST_DATABASE_URL ??= 'postgres://reality:reality@localhost:5432/reality_desktopeval';
process.env.COMPUTER_IMAGE ??= 'reality-computer:dev';
const { loadConfig } = await import('../src/config.ts');
const { buildApp } = await import('../src/app.ts');
const { createRuntime } = await import('../src/runtime.ts');
const { LabDesktop } = await import('../src/lab/desktop.ts');
const { LabPresets } = await import('../src/lab/plan.ts');
const { RuleBasedPlanner } = await import('../src/planner/rule-planner.ts');
const { resetTestDatabase, TEST_DATABASE_URL } = await import('../test/db.ts');
const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const pg = (await import('pg')).default;

const out = process.argv[2] ?? join(tmpdir(), 'reality-desktop-pictures');
await mkdir(out, { recursive: true });
await resetTestDatabase();
const dir = await mkdtemp(join(tmpdir(), 'reality-desktop-eval-'));
const cfg = loadConfig({
  ...process.env,
  AUTH: 'off',
  COMPUTERS: 'on',
  DATABASE_URL: TEST_DATABASE_URL,
  ARTIFACT_DIR: dir,
});
const runtime = await createRuntime(cfg, {
  planner: new RuleBasedPlanner(),
  analyst: null,
  synthesizer: null,
  chatModel: null,
  log: { error: console.error },
});
const app = buildApp(cfg, runtime);
const computers = runtime.computers;
if (!computers) throw new Error('Computers are off or Docker is not available.');
const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const picture = async (botId: string, name: string) => {
  const png = await computers.thumbnail(botId);
  if (png) await writeFile(join(out, `${name}.png`), png);
  console.log(`  picture ${name}: ${png ? `${png.length} bytes` : 'none'}`);
};

try {
  const bot = (
    await app.inject({
      method: 'POST',
      url: '/api/bots',
      payload: { name: 'Eddie', role: 'engineer' },
    })
  ).json<{ id: string }>();
  console.log('Starting the bot computer (the first start takes a while) …');
  await computers.ensure(bot.id);
  console.log('Computer is up. Designing a board with the lab …');
  const task = await runtime.tasks.create('Design a board', { start: false, botId: bot.id });
  await new LabPresets(pool).set(
    task.id,
    'pcb_design',
    process.env.BOARD_PRESET ? { preset: process.env.BOARD_PRESET } : {},
  );
  await runtime.tasks.start(task.id);
  await runtime.tasks.settled(task.id);
  await runtime.tasks.decide(task.id, { approved: true, by: 'user' });
  await runtime.tasks.settled(task.id);
  console.log('Board done. Sending it to the desktop …');
  const names = {
    parts: '0-parts-beside-the-board',
    placed: '1-placed-in-kicad',
    routed: '2-routed-in-kicad',
    '3d': '3-kicad-3d-viewer',
  } as const;
  const result = await new LabDesktop({ computers, files: runtime.files }).show(bot.id, task.id, {
    boot: true,
    pauseMs: 4000,
    keepIn: '/home/gem/projects/eval',
    onStep: async (step) => {
      await sleep(2500);
      await picture(bot.id, names[step]);
    },
  });
  console.log(`  opened: ${result?.opened.join(' → ')} (files in ${result?.dir})`);
  console.log(`  kicad: ${result?.kicadCheck}`);
  console.log(`  motor: ${result?.motorSim}`);
  const checks = ((await runtime.tasks.get(task.id))?.state?.verification ?? []) as {
    status: string;
    detail: string;
  }[];
  console.log(
    `  check: ${checks
      .map((c) => `${c.status}: ${c.detail}`)
      .join(' | ')
      .slice(0, 300)}`,
  );
  const report = await computers.exec(
    bot.id,
    `cd ${result?.dir} && sha256sum /output/board.kicad_pcb checked.kicad_pcb; wc -c /output/board.kicad_pcb checked.kicad_pcb; tail -c 200 /tmp/build_board.log; ls kicad_drc.json gerber 2>&1 | head -8; python3 -c "import json;d=json.load(open('kicad_drc.json'));v=d.get('violations',[]);print('kicad drc',len(v),'unconnected',len(d.get('unconnected_items',[])));import collections;print(dict(collections.Counter(x['type'] for x in v)));print([(x['type'],x['items'][0]['description'][:50]) for x in v if not x['type'].startswith('silk')][:12]);print([[(i['description'][:50],i['pos']) for i in x['items']] for x in d.get('unconnected_items',[])])"; tail -3 /tmp/reality_live.log`,
    30,
    false,
  );
  console.log(report.output);
  console.log(`\nPictures are in ${out}`);
} finally {
  await pool.end();
  await computers
    .destroy((await app.inject({ url: '/api/bots' })).json<{ id: string }[]>()[0]?.id ?? '')
    .catch(() => undefined);
  await app.close();
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
}
