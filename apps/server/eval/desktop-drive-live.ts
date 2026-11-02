/**
 * npm run eval:desktop-drive [pictures folder]: does a bot really operate KiCad itself? With the
 * configured model (Meta Muse Spark) a bot designs a board in the lab, opens it on its own desktop,
 * then uses its eyes and hands (computer_screen, computer_input): it runs KiCad's Design Rules
 * Checker from the menu, saves the board with its own keystrokes and has it re-checked
 * (recheck_board), which also proves the check reads the file KiCad itself wrote.
 * Costs a few cents to a few dollars of model use. Own scratch database (reality_desktopdrive).
 * Needs Docker, Postgres, the computer image and META_MODEL_API_KEY.
 */
process.env.TEST_DATABASE_URL ??= 'postgres://reality:reality@localhost:5432/reality_desktopdrive';
process.env.COMPUTER_IMAGE ??= 'reality-computer:dev';
const { loadConfig, modelConfig } = await import('../src/config.ts');
const { buildApp } = await import('../src/app.ts');
const { createRuntime } = await import('../src/runtime.ts');
const { resetTestDatabase, TEST_DATABASE_URL } = await import('../test/db.ts');
const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const pg = (await import('pg')).default;

const out = process.argv[2] ?? join(tmpdir(), 'reality-desktop-drive-pictures');
const minutes = Number(process.argv[3] ?? 25);
const config = loadConfig(process.env);
if (!modelConfig(config)) {
  console.log('No model configured: put META_MODEL_API_KEY into .env first.');
  process.exit(2);
}
await mkdir(out, { recursive: true });
await resetTestDatabase();
const dir = await mkdtemp(join(tmpdir(), 'reality-desktop-drive-'));
const cfg = loadConfig({
  ...process.env,
  AUTH: 'off',
  COMPUTERS: 'on',
  DATABASE_URL: TEST_DATABASE_URL,
  ARTIFACT_DIR: dir,
  CAPABILITY_DIR: dir,
});
const runtime = await createRuntime(cfg);
const app = buildApp(cfg, runtime);
runtime.chats.engine.start();
const computers = runtime.computers;
if (!computers) throw new Error('Computers are off or Docker is not available.');
const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const GOAL = `Do this step by step on your own computer, and do not stop until all of it is done:
1. Design a small board with run_simulation, engine pcb_design, with the default parameters ({}). Wait for the checked result.
2. Show it with open_lab_result.
3. Use computer_screen to look at your desktop. Close KiCad's 3D Viewer window if it is in front, so the PCB Editor is in front.
4. With computer_input (click_text) open the Inspect menu of the PCB Editor, choose Design Rules Checker, and press Run DRC in the dialog. Wait until it has finished, look at the screen, and note how many violations and how many unconnected items its tabs show. Then close the dialog.
5. Press ctrl+s in the PCB Editor to save the board.
6. Call recheck_board with the task id of the design.
7. When the re-check result is in the chat, say DONE and report: what KiCad's checker showed, and what the re-check said.`;

interface Msg {
  role: string;
  text?: string;
  card?: { kind: string; verified?: boolean; engine?: string; summary?: Record<string, unknown> };
}

let botId = '';
const result = { code: 1 };
try {
  const bot = (
    await app.inject({
      method: 'POST',
      url: '/api/bots',
      payload: { name: 'Eddie', role: 'engineer' },
    })
  ).json<{ id: string }>();
  botId = bot.id;
  console.log('Starting the bot computer …');
  await computers.ensure(bot.id);
  const chat = (await app.inject({ url: `/api/bots/${bot.id}/chat` })).json<{ id: string }>();
  await app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/messages`,
    payload: { text: GOAL },
  });
  const until = Date.now() + minutes * 60_000;
  let seen = 0;
  let shot = 0;
  let last = Date.now();
  let finished = false;
  let nudges = 0;
  let recheckIn = false;
  while (Date.now() < until && !finished) {
    await sleep(4000);
    const msgs = (await app.inject({ url: `/api/chats/${chat.id}` })).json<{ messages: Msg[] }>()
      .messages;
    for (const m of msgs.slice(seen)) {
      if (m.role === 'action' || m.role === 'bot') {
        console.log(`  [${m.role}] ${(m.text ?? '').slice(0, 400)}`);
        if (/on its desktop|looks at its screen/.test(m.text ?? '')) {
          const png = await computers.thumbnail(bot.id);
          if (png) await writeFile(join(out, `step-${String(++shot).padStart(3, '0')}.png`), png);
        }
      }
      // Its last word, after the re-check is back: "waiting to report DONE" is not done.
      if (m.role === 'card' && m.card?.engine === 'pcb_recheck') recheckIn = true;
      if (m.role === 'bot' && recheckIn && /^\W*done\b/i.test(m.text ?? '')) finished = true;
      last = Date.now();
    }
    seen = msgs.length;
    // A person would say "go on" when the bot stops halfway. Counted and printed: it is a weakness.
    if (Date.now() - last > 300_000 && nudges < 4) {
      nudges++;
      console.log(`  (nudge ${nudges}: the bot stopped before the end)`);
      await app.inject({
        method: 'POST',
        url: `/api/chats/${chat.id}/messages`,
        payload: { text: 'Go on with the next step of the list now.' },
      });
      last = Date.now();
    }
    if (Date.now() - last > 6 * 60_000) {
      console.log('  no activity for six minutes');
      break;
    }
  }
  const png = await computers.thumbnail(bot.id);
  if (png) await writeFile(join(out, 'final.png'), png);
  console.log(
    `\n${finished ? 'The bot says it is done' : 'The bot did not finish in time'}; nudges: ${nudges}.`,
  );

  // What code says, not the bot: tasks of this bot, and the checks on them.
  const tasks = await pool.query<{ id: string; title: string }>(
    `SELECT id, request AS title FROM tasks ORDER BY created_at`,
  );
  let design = '';
  let saved = false;
  for (const t of tasks.rows) {
    const d = await runtime.tasks.get(t.id);
    const checks = (d?.state?.verification ?? []) as { status: string; detail: string }[];
    console.log(
      `  task "${t.title}": ${checks.map((c) => `${c.status}: ${c.detail}`).join(' | ')}`,
    );
    if (t.title.startsWith('Check the board again')) saved = checks[0]?.status === 'passed';
    else design ||= t.id;
  }
  // KiCad wrote the file: its own save puts a generator mark and line breaks in.
  const dirOnDesk = `/home/gem/workspace/lab-${design.slice(0, 8)}`;
  const file = await computers.readFile(bot.id, `${dirOnDesk}/board.kicad_pcb`);
  const byKiCad = /\(generator "pcbnew"\)/.test(file);
  console.log(`  board file saved by KiCad itself: ${byKiCad}; re-check passed: ${saved}`);
  await writeFile(join(out, 'board-saved-by-kicad.kicad_pcb'), file);
  result.code = finished && saved && byKiCad ? 0 : 1;
} finally {
  await pool.end();
  if (botId) await computers.destroy(botId).catch(() => undefined);
  await app.close();
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
}
console.log(result.code === 0 ? '\nPASS' : '\nFAIL');
process.exit(result.code);
