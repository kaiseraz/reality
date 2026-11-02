/**
 * npm run eval:adapt [results file] [minutes per job]: does a bot notice by itself that it lacks
 * something, get the right thing, and end up with a better answer? Ordinary requests, without a
 * word about tools, through the real chat with the configured model. The script plays a cooperative
 * person: it approves installs and domains, and has no API keys to give. Five requests need nothing
 * and must not start a search. Code records what happened; the answers are checked where a fact
 * can be checked, and printed for a person where it cannot.
 * Costs a few dollars of model use and about an hour. Own scratch database (reality_adaptlive).
 * Needs Docker, Postgres, the sandbox and computer images and META_MODEL_API_KEY.
 */
process.env.TEST_DATABASE_URL ??= 'postgres://reality:reality@localhost:5432/reality_adaptlive';
process.env.COMPUTER_IMAGE ??= 'reality-computer:dev';
const { loadConfig, modelConfig } = await import('../src/config.ts');
const { buildApp } = await import('../src/app.ts');
const { createRuntime } = await import('../src/runtime.ts');
const { resetTestDatabase, TEST_DATABASE_URL } = await import('../test/db.ts');
const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { randomUUID } = await import('node:crypto');
const pg = (await import('pg')).default;

interface Job {
  id: string;
  /** Whether something Reality lacks would help (the sandbox has numpy, pandas and pyarrow). */
  needs: boolean;
  text: string;
  /** What a right answer contains; null: a person reads it. */
  check: RegExp | null;
  /** A tool server is the better way here: the job works with a service through its API. */
  serverFits?: boolean;
  /** The person asked for a file to download. */
  wantsFile?: boolean;
  /** What it hands over is an MCP server: started with today's SDK and called, whatever it says. */
  runsAsServer?: boolean;
  /** The person attaches this to the chat first. */
  attach?: { name: string; data: Buffer };
}

function miniPdf(lines: string[]): Buffer {
  const text = lines.map((l, i) => `BT /F1 14 Tf 60 ${700 - i * 24} Td (${l}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const at: number[] = [];
  objects.forEach((o, i) => {
    at.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const a of at) out += `${String(a).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

const JOBS: Job[] = [
  {
    id: 'molecule',
    needs: true,
    text: 'What is the molecular weight of the molecule with the SMILES Cn1cnc2c1c(=O)n(C)c(=O)n2C, and how many rotatable bonds does it have? I need computed values.',
    check: /194\.1\d/,
  },
  {
    id: 'integral',
    needs: true,
    text: 'Integrate x^2 * e^x symbolically and check the result by differentiating it by computer.',
    check: /x\s*(\*\*\s*2|\^\s*2|²)\s*[-−]\s*2\s*[*·]?\s*x\s*\+\s*2/,
  },
  {
    id: 'phone',
    needs: true,
    text: 'Which region does the phone number +49 30 901820 belong to, and is it a valid number according to the numbering plan?',
    check: /Berlin/,
  },
  {
    id: 'iban',
    needs: true,
    text: 'Is DE89370400440532013000 a valid IBAN, and which bank does it belong to according to the bank code register?',
    check: /Commerzbank/i,
  },
  {
    id: 'sunrise',
    needs: true,
    text: 'Wann geht am 21. Juni 2027 in Berlin die Sonne auf? Bitte auf die Minute, Ortszeit, berechnet und nicht geschätzt.',
    check: /\b0?4[:.]4\d\b/,
  },
  {
    id: 'holidays',
    needs: true,
    text: 'Welche gesetzlichen Feiertage hat Bayern 2027, und welche davon fallen auf ein Wochenende? Bitte aus einer verlässlichen Quelle, nicht aus dem Kopf.',
    check: /Mari(ä|ae) Himmelfahrt|Allerheiligen/,
  },
  {
    id: 'yaml',
    needs: true,
    text: 'Convert this YAML to JSON with a real parser and tell me what type "version" has: \nversion: 1.10\nname: &n reality\nalias: *n\nitems: [a, {b: 2}]',
    check: /float|number/i,
  },
  {
    id: 'weather',
    needs: true,
    text: 'Wie wird das Wetter morgen in Berlin? Ich brauche die konkrete Höchsttemperatur.',
    check: /-?\d+([.,]\d+)?\s*(°|grad)/i,
  },
  {
    id: 'rfc',
    needs: true,
    text: 'Summarise what the document at https://www.rfc-editor.org/rfc/rfc2119 actually says.',
    check: /MUST/,
  },
  {
    id: 'stars',
    needs: true,
    text: 'How many stars does the GitHub repository modelcontextprotocol/servers have right now?',
    check: /\d[\d.,]*\s*(k\b|stars)/i,
  },
  {
    id: 'exchange',
    needs: true,
    text: 'Wie steht der Euro heute zum US-Dollar? Bitte der heutige Kurs mit Quelle.',
    check: /[01][.,]\d{2}/,
  },
  {
    id: 'wikipedia',
    needs: true,
    text: 'What does the English Wikipedia article on the Model Context Protocol say about who created it and when?',
    check: /Anthropic/,
  },
  {
    id: 'qr',
    needs: true,
    text: 'Make me a QR code for https://example.com as a PNG file I can download.',
    check: null,
    wantsFile: true,
  },
  {
    id: 'pdf',
    needs: true,
    text: 'Erstelle mir ein einseitiges PDF mit dem Titel "Quartalsbericht" und einer kleinen Tabelle aus drei erfundenen Zahlen, zum Herunterladen.',
    check: null,
    wantsFile: true,
  },
  {
    id: 'xlsx',
    needs: true,
    text: 'Make me an Excel file (.xlsx) with the months January to March and a sum formula below them, for download.',
    check: null,
    wantsFile: true,
  },
  {
    id: 'commits',
    needs: true,
    serverFits: true,
    text: 'What are the last three commits on the main branch of the GitHub repository modelcontextprotocol/servers, with author and message?',
    check: /\b[0-9a-f]{7,40}\b/,
  },
  {
    id: 'issues',
    needs: true,
    serverFits: true,
    text: 'What are the titles of the three most recently opened issues in the GitHub repository modelcontextprotocol/servers?',
    check: /\w+\s+\w+\s+\w+/,
  },
  {
    id: 'arxiv',
    needs: true,
    serverFits: true,
    text: 'Find the three most recent arXiv papers about security of the Model Context Protocol, with their arXiv ids.',
    check: /\b\d{4}\.\d{4,5}\b/,
  },
  {
    id: 'wikidata',
    needs: true,
    serverFits: true,
    text: 'Query Wikidata: what is the item id of Berlin, and which population value and date does it state?',
    check: /Q64\b/,
  },
  {
    id: 'npm',
    needs: true,
    serverFits: true,
    text: 'What is the latest version of the npm package zod, and which versions fix the advisory GHSA-mrhx-c7xc-m3w5?',
    check: /4\.6\.6/,
  },
  {
    id: 'sqlite',
    needs: true,
    serverFits: true,
    text: 'Set up a SQLite database with customers (Ana, Ben, Cem) and orders (Ana 10, Ben 25, Ana 40, Cem 5, Ben 5), then tell me with SQL who spent the most.',
    check: /Ana/,
  },
  {
    id: 'osv',
    needs: true,
    serverFits: true,
    text: 'Does the Python package requests in version 2.25.0 have known vulnerabilities according to the OSV database? Name them.',
    check: /CVE-\d|GHSA-/,
  },
  {
    id: 'landing',
    needs: true,
    text: 'Design a distinctive landing page for a small independent coffee roaster in Hamburg, as a single HTML file I can download. It should not look like a template.',
    check: null,
    wantsFile: true,
  },
  {
    id: 'webtest',
    needs: true,
    text: 'Write and run an automated browser test that checks that https://example.com shows its heading and that its link works. Tell me what it found.',
    check: /Example Domain/,
  },
  {
    id: 'buildserver',
    needs: true,
    text: 'Build a small MCP server in Python with one tool that converts Celsius to Fahrenheit, following good practice, and hand me the file.',
    check: null,
    wantsFile: true,
    runsAsServer: true,
  },
  {
    id: 'genart',
    needs: true,
    text: 'Make me a piece of generative art as a single HTML file with p5.js that I can download: something with real character, seeded so that it can be reproduced.',
    check: null,
    wantsFile: true,
  },
  {
    id: 'readpdf',
    needs: true,
    text: 'I attached our supplier report. What is the invoice number and the total it states?',
    attach: {
      name: 'supplier-report.pdf',
      data: miniPdf(['Supplier report 2030', 'Invoice number RX-4471', 'Total due 1893 EUR']),
    },
    check: /RX-4471[\s\S]*1[.,]?893|1[.,]?893[\s\S]*RX-4471/,
  },
  {
    id: 'csvresult',
    needs: true,
    text: 'I attached our sales. Total the revenue per region, highest first, and give me the result as a CSV file to download.',
    attach: {
      name: 'sales.csv',
      data: Buffer.from('region,revenue\nNorth,10\nSouth,4\nNorth,20\nEast,17\n'),
    },
    check: /North[^\n]{0,30}30/,
    wantsFile: true,
  },
  { id: 'multiply', needs: false, text: 'What is 17 times 23?', check: /391/ },
  {
    id: 'haiku',
    needs: false,
    text: 'Write me a haiku about autumn rain.',
    check: null,
  },
  {
    id: 'timezone',
    needs: false,
    text: 'Wenn es am 15. Januar 2027 in Berlin 9:00 Uhr ist, wie spät ist es dann in Tokio?',
    check: /17[:.]00|17 Uhr/,
  },
  {
    id: 'mean',
    needs: false,
    text: 'What are the mean and the standard deviation of 3, 5, 10, 22?',
    check: /\b10\b/,
  },
  {
    id: 'tcp',
    needs: false,
    text: 'Explain the difference between TCP and UDP in three sentences.',
    check: /connection/i,
  },
];

interface Msg {
  id: number;
  role: string;
  text?: string;
  botId?: string | null;
  card?: {
    kind: string;
    status?: string;
    taskId?: string;
    package?: string;
    version?: string;
    secrets?: { name: string }[];
    domain?: string;
    server?: string;
    runtime?: string;
    hostedAt?: string;
    question?: string;
    code?: string;
    flags?: string[];
    fileId?: string;
    fromPerson?: boolean;
    name?: string;
    repo?: string;
  };
}

const file = process.argv[2] ?? join(tmpdir(), 'reality-adapt-live.json');
const minutes = Number(process.argv[3] ?? 8);
const only = process.argv[4]?.split(',');
const config = loadConfig(process.env);
if (!modelConfig(config)) {
  console.log('No model configured: put META_MODEL_API_KEY into .env first.');
  process.exit(2);
}
await resetTestDatabase();
const dir = await mkdtemp(join(tmpdir(), 'reality-adapt-'));
const cfg = loadConfig({
  ...process.env,
  AUTH: 'off',
  COMPUTERS: 'on',
  DATABASE_URL: TEST_DATABASE_URL,
  ARTIFACT_DIR: dir,
  CAPABILITY_DIR: dir,
});
const runtime = await createRuntime(cfg, {
  log: { error: (obj: unknown, msg?: string) => console.log('  [error]', msg ?? '', obj) },
});
const app = buildApp(cfg, runtime);
runtime.chats.engine.start();
const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Speaks the protocol to the file itself, in a sandbox with the newest SDK, so that it does not
 * depend on any SDK's own API: initialize, list the tools, call the first with 100.
 */
const SERVER_PROBE = `
import json, os, subprocess, sys, threading
target = "/layer"
pip = subprocess.run([sys.executable, "-m", "pip", "-q", "--disable-pip-version-check", "install", "--target", target, "mcp", "pydantic"], capture_output=True, text=True)
if pip.returncode: print("pip failed", pip.stderr[-300:]); sys.exit(1)
env = dict(os.environ, PYTHONPATH=target)
ver = subprocess.run([sys.executable, "-c", "import importlib.metadata as m; print(m.version('mcp'))"], env=env, capture_output=True, text=True).stdout.strip()
p = subprocess.Popen([sys.executable, "/input/server.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
threading.Timer(60, p.kill).start()
def rpc(i, method, params):
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}) + "\\n"); p.stdin.flush()
    while True:
        line = p.stdout.readline()
        if not line: raise SystemExit("server ended: " + p.stderr.read()[-400:])
        m = json.loads(line)
        if m.get("id") == i: return m
rpc(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "probe", "version": "1"}})
p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\\n"); p.stdin.flush()
tool = rpc(2, "tools/list", {})["result"]["tools"][0]
props = tool["inputSchema"].get("properties", {})
key = next(iter(props))
sub = props[key]
ref = sub.get("$ref", "").split("/")[-1]
inner = tool["inputSchema"].get("$defs", {}).get(ref, {}).get("properties", {})
args = {key: {next(iter(inner)): 100}} if inner else {key: 100}
out = rpc(3, "tools/call", {"name": tool["name"], "arguments": args})
text = json.dumps(out.get("result", out))
print("mcp", ver, tool["name"], "212" in text, text[:160])
p.kill()
sys.exit(0 if "212" in text else 1)
`;

async function runsAsServer(code: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'reality-server-probe-'));
  const volume = `reality-probe-${randomUUID()}`;
  try {
    await writeFile(join(tmp, 'server.py'), code);
    const run = await runtime.sandbox.execute({
      taskId: null,
      kind: 'analysis',
      label: 'run the delivered MCP server',
      code: SERVER_PROBE,
      network: 'egress',
      inputs: [{ name: 'server.py', hostPath: join(tmp, 'server.py') }],
      // /tmp cannot hold compiled packages (it is mounted noexec); a volume can.
      writableMounts: [{ volume, containerPath: '/layer' }],
      limits: { timeoutMs: 240_000, memoryMb: 1024, tmpMb: 512, pids: 128 },
    });
    await run.result.cleanup();
    return `${run.result.status === 'succeeded' ? 'RUNS' : 'FAILS'}: ${(run.result.stdout + run.result.stderr).trim().slice(-400)}`;
  } finally {
    await runtime.sandbox.runner.removeVolume(volume).catch(() => undefined);
    await rm(tmp, { recursive: true, force: true });
  }
}

const results: Record<string, unknown>[] = [];
const main = (await app.inject({ url: '/api/bots' }))
  .json<{ id: string; isMain: boolean }[]>()
  .find((b) => b.isMain);
if (!main) throw new Error('No main bot.');

try {
  for (const job of JOBS.filter((j) => !only || only.includes(j.id))) {
    console.log(`\n=== ${job.id}: ${job.text.slice(0, 90)}`);
    const started = Date.now();
    const chat = (
      await app.inject({
        method: 'POST',
        url: '/api/chats',
        payload: { title: job.id, kind: 'dm', botIds: [main.id] },
      })
    ).json<{ id: string }>();
    if (job.attach) {
      await app.inject({
        method: 'POST',
        url: `/api/chats/${chat.id}/files?name=${encodeURIComponent(job.attach.name)}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: job.attach.data,
      });
    }
    await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: { text: job.text },
    });
    const handled = new Set<number>();
    const person: string[] = [];
    const until = started + minutes * 60_000;
    let last = Date.now();
    let seen = 0;
    let msgs: Msg[] = [];
    while (Date.now() < until) {
      await sleep(3000);
      const state = (await app.inject({ url: `/api/chats/${chat.id}` })).json<{
        messages: Msg[];
        running: boolean;
      }>();
      msgs = state.messages;
      if (msgs.length !== seen) last = Date.now();
      for (const m of msgs.slice(seen)) {
        if (m.role === 'action' || m.role === 'bot') {
          console.log(`  [${m.role}] ${(m.text ?? '').slice(0, 200)}`);
        }
      }
      seen = msgs.length;
      // A cooperative person with no API keys.
      for (const m of msgs) {
        const c = m.card;
        if (!c || handled.has(m.id)) continue;
        const decide = (taskId: string, approved: boolean) =>
          app.inject({
            method: 'POST',
            url: `/api/chats/${chat.id}/plans/${taskId}`,
            payload: { approved },
          });
        const answer = (text: string) =>
          app.inject({
            method: 'POST',
            url: `/api/chats/${chat.id}/answers/${m.id}`,
            payload: { answer: text },
          });
        if (c.kind === 'install' && c.status === 'waiting' && c.taskId) {
          handled.add(m.id);
          const needsKey = (c.secrets?.length ?? 0) > 0;
          person.push(
            `${needsKey ? 'denied (no key to give)' : 'approved'} ${c.package} ${c.version ?? ''}`,
          );
          console.log(`  (person) ${person.at(-1)}`);
          await decide(c.taskId, !needsKey);
        } else if (c.kind === 'skill' && c.status === 'open') {
          handled.add(m.id);
          const denySkills = process.env.DENY_SKILLS === '1';
          person.push(
            `${denySkills ? 'denied' : 'approved'} skill ${c.name}${c.repo ? ' from ' + c.repo : ''}`,
          );
          console.log(`  (person) ${person.at(-1)}`);
          await answer(denySkills ? 'Deny' : 'Approve');
        } else if (c.kind === 'plan' && c.status === 'waiting' && c.taskId) {
          handled.add(m.id);
          person.push('approved a plan');
          await decide(c.taskId, true);
        } else if (c.kind === 'access' && c.status === 'open') {
          handled.add(m.id);
          person.push(`allowed ${c.domain}${c.server ? ` for ${c.server}` : ''}`);
          console.log(`  (person) ${person.at(-1)}`);
          await answer('Allow');
        } else if (c.kind === 'team' && c.status === 'open') {
          handled.add(m.id);
          person.push('declined a team');
          await answer('Decline');
        } else if (c.kind === 'question' && c.status === 'open') {
          handled.add(m.id);
          person.push(`answered: ${c.question?.slice(0, 120)}`);
          await answer('Your call. Use the sensible default.');
        }
      }
      const running = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM tasks t JOIN chat_runs r ON r.task_id = t.id
         WHERE r.chat_id = $1 AND t.status NOT IN ('completed', 'failed', 'cancelled', 'denied')`,
        [chat.id],
      );
      // A search that ended wakes the bot a little later: its "I'll post it when ready" is not the end.
      const lastWords = [...msgs].reverse().find((m) => m.role === 'bot');
      const searched = msgs.some((m) => m.card?.kind === 'result') && msgs.at(-1) !== lastWords;
      // Done when the engine says no bot is working, no task runs, and it stays that way a moment.
      if (
        Number(running.rows[0]?.n ?? 0) === 0 &&
        !state.running &&
        Date.now() - last > (msgs.at(-1)?.role === 'bot' && !searched ? 15_000 : 90_000)
      ) {
        break;
      }
    }
    await app.inject({ method: 'POST', url: `/api/chats/${chat.id}/stop` });

    const answer = msgs
      .filter((m) => m.role === 'bot')
      .map((m) => m.text ?? '')
      .join('\n');
    const tasks = await pool.query<{ request: string; status: string }>(
      `SELECT t.request, t.status FROM tasks t JOIN chat_runs r ON r.task_id = t.id
       WHERE r.chat_id = $1 ORDER BY t.created_at`,
      [chat.id],
    );
    const searches = tasks.rows.filter((t) => /^Get (an MCP server|a library):/.test(t.request));
    const failedSteps = msgs
      .filter((m) => m.card?.kind === 'result')
      .flatMap((m) => (m.card as { lines?: string[] }).lines ?? [])
      .filter((l) => /fail|reject|nothing found|no eligible/i.test(l));
    const actions = [
      ...new Set(msgs.filter((m) => m.role === 'action').map((m) => (m.text ?? '').slice(0, 60))),
    ];
    let ranAsServer: string | null = null;
    // What it handed over, for a person to look at.
    for (const m of msgs) {
      const c = m.card as { kind?: string; fileId?: string; name?: string } | undefined;
      if (c?.kind !== 'file' || !c.fileId) continue;
      const got = await app.inject({ url: `/api/files/${c.fileId}?download=1` });
      await writeFile(`${file}.${job.id}.${c.name}`, got.rawPayload);
      if (job.runsAsServer && c.name?.endsWith('.py')) {
        ranAsServer = await runsAsServer(got.rawPayload.toString('utf8'));
        console.log(`  [${ranAsServer}]`);
      }
    }
    const result = {
      id: job.id,
      needs: job.needs,
      seconds: Math.round((Date.now() - started) / 1000),
      finished: Date.now() < until,
      searches: searches.map((s) => `${s.request} [${s.status}]`),
      person,
      failedSteps,
      actions,
      ranCode: msgs.some((m) => m.card?.kind === 'code'),
      serverFits: job.serverFits === true,
      usedServer: msgs.some((m) => m.role === 'action' && /calls a tool/.test(m.text ?? '')),
      usedSkill: msgs.some((m) => m.role === 'action' && /reads a skill/.test(m.text ?? '')),
      fileShared: job.wantsFile
        ? msgs.some((m) => m.card?.kind === 'file' && !m.card.fromPerson)
        : null,
      silent: answer.trim() === '',
      ranAsServer,
      answerChecked: job.runsAsServer
        ? (ranAsServer?.startsWith('RUNS') ?? false)
        : job.check
          ? job.check.test(answer)
          : null,
      answer: answer.slice(0, 1500),
    };
    results.push(result);
    console.log(
      `  -> searched ${searches.length}, right answer: ${String(result.answerChecked)}, ${result.seconds}s`,
    );
    await writeFile(file, JSON.stringify(results, null, 2));
  }

  const caps = await runtime.capabilities.list();
  const needing = results.filter((r) => r.needs);
  const controls = results.filter((r) => !r.needs);
  const reached = needing.filter(
    (r) => (r.searches as string[]).length > 0 || (r.person as string[]).length > 0,
  );
  const fitting = results.filter((r) => r.serverFits);
  const right = results.filter((r) => r.answerChecked === true);
  const checked = results.filter((r) => r.answerChecked !== null);
  const summary = {
    needing: needing.length,
    reachedForATool: reached.length,
    jobsWhereAServerFits: fitting.length,
    ofThoseUsedAServer: fitting.filter((r) => r.usedServer).length,
    usedASkill: results.filter((r) => r.usedSkill).length,
    silentEnds: results.filter((r) => r.silent).length,
    filesAskedFor: results.filter((r) => r.fileShared !== null).length,
    filesShared: results.filter((r) => r.fileShared === true).length,
    controls: controls.length,
    controlsThatSearched: controls.filter((r) => (r.searches as string[]).length > 0).length,
    answersRight: `${right.length} of ${checked.length} checkable`,
    unfinished: results.filter((r) => !r.finished).length,
    capabilities: caps.map((c) => `${c.id} ${c.state} (${c.uses} uses)`),
  };
  console.log('\nSUMMARY', JSON.stringify(summary, null, 2));
  await writeFile(file, JSON.stringify({ summary, results }, null, 2));
} finally {
  await pool.end();
  await runtime.computers?.destroy(main.id).catch(() => undefined);
  await app.close();
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
}
process.exit(0);
