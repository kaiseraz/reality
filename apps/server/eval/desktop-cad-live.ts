/**
 * npm run eval:desktop-cad [pictures folder]: does a jet engine from the lab grow, piece by piece
 * and in colour, in a real FreeCAD on a bot desktop? Starts a bot's computer from COMPUTER_IMAGE
 * (default reality-computer:dev), has the lab build a turbofan (installs the CAD kernel, needs
 * network), sends it to the desktop and takes a picture every few seconds while it builds.
 * Uses its own scratch database (reality_desktopcadeval). Needs Docker, Postgres and the image.
 */
process.env.TEST_DATABASE_URL ??=
  'postgres://reality:reality@localhost:5432/reality_desktopcadeval';
process.env.COMPUTER_IMAGE ??= 'reality-computer:dev';
const { loadConfig } = await import('../src/config.ts');
const { buildApp } = await import('../src/app.ts');
const { createRuntime } = await import('../src/runtime.ts');
const { LabDesktop } = await import('../src/lab/desktop.ts');
const { RuleBasedPlanner } = await import('../src/planner/rule-planner.ts');
const { resetTestDatabase, TEST_DATABASE_URL } = await import('../test/db.ts');
const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const out = process.argv[2] ?? join(tmpdir(), 'reality-desktop-cad-pictures');
const shots = Number(process.argv[3] ?? 30);
await mkdir(out, { recursive: true });
await resetTestDatabase();
const dir = await mkdtemp(join(tmpdir(), 'reality-desktop-cad-eval-'));
const cfg = loadConfig({
  ...process.env,
  AUTH: 'off',
  COMPUTERS: 'on',
  DATABASE_URL: TEST_DATABASE_URL,
  ARTIFACT_DIR: dir,
  CAPABILITY_DIR: dir,
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let botId = '';
try {
  const bot = (
    await app.inject({
      method: 'POST',
      url: '/api/bots',
      payload: { name: 'Eddie', role: 'engineer' },
    })
  ).json<{ id: string }>();
  botId = bot.id;
  console.log('Starting the bot computer (the first start takes a while) …');
  await computers.ensure(bot.id);
  console.log('Computer is up. Designing a turbofan with the lab …');
  const task = await runtime.tasks.create(
    'Design a detailed jet engine (turbofan) with 24 fan blades',
    { start: true, botId: bot.id },
  );
  await runtime.tasks.settled(task.id);
  await runtime.tasks.decide(task.id, { approved: true, by: 'user' });
  await runtime.tasks.settled(task.id);
  await runtime.tasks.decide(task.id, { approved: true, by: 'user' });
  await runtime.tasks.settled(task.id);
  console.log('Engine done. Sending it to the desktop …');
  const result = await new LabDesktop({ computers, files: runtime.files }).show(bot.id, task.id, {
    boot: true,
  });
  for (let i = 1; i <= shots; i++) {
    await sleep(8000);
    const png = await computers.thumbnail(bot.id);
    if (png) await writeFile(join(out, `freecad-${String(i).padStart(2, '0')}.png`), png);
    const log = await computers.exec(bot.id, `tail -1 ${result?.dir}/live.log`, 20);
    console.log(`  picture ${i}: ${log.output.trim()}`);
    if (log.output.trim() === 'done') break;
  }
  console.log(`\nPictures are in ${out}`);
} finally {
  if (botId) await computers.destroy(botId).catch(() => undefined);
  await app.close();
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
}
