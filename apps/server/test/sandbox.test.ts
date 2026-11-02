import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerRunner } from '../src/sandbox/docker-runner.ts';

/**
 * T6 security suite: the sandbox must contain hostile code. These tests run real
 * containers; they require Docker and the sandbox image (npm run sandbox:build).
 */
const runner = new DockerRunner(process.env.SANDBOX_IMAGE ?? 'reality-sandbox-python:dev');
let scratch: string;
let csv: string;

beforeAll(async () => {
  await runner.check();
  scratch = await mkdtemp(join(tmpdir(), 'reality-sandbox-test-'));
  csv = join(scratch, 'data.csv');
  await writeFile(csv, 'a,b\n1,2\n3,4\n');
}, 60_000);
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function run(
  code: string,
  extra: Parameters<DockerRunner['run']>[0] extends infer R ? Partial<R> : never = {},
) {
  const r = await runner.run({ code, inputs: [{ name: 'data.csv', hostPath: csv }], ...extra });
  await r.cleanup();
  return r;
}

describe('sandbox', () => {
  it('runs pandas on mounted input and captures stdout and output files', async () => {
    const r = await runner.run({
      code: [
        'import pandas as pd',
        'df = pd.read_csv("/input/data.csv")',
        'print(int(df["a"].sum()))',
        'df.assign(c=df.a + df.b).to_csv("/output/result.csv", index=False)',
      ].join('\n'),
      inputs: [{ name: 'data.csv', hostPath: csv }],
    });
    try {
      expect(r.status, r.stderr).toBe('succeeded');
      expect(r.stdout.trim()).toBe('4');
      expect(r.outputs.map((o) => o.name)).toEqual(['result.csv']);
      expect(await readFile(r.outputs[0]!.path, 'utf8')).toBe('a,b,c\n1,2,3\n3,4,7\n');
    } finally {
      await r.cleanup();
    }
  });

  it('is deterministic for fixed code and input', async () => {
    const code = 'import pandas as pd; print(pd.read_csv("/input/data.csv").describe().to_json())';
    const [a, b] = [await run(code), await run(code)];
    expect(a.stdout).toBe(b.stdout);
  });

  it('has no network', async () => {
    const r = await run(
      'import socket\ntry:\n  socket.create_connection(("1.1.1.1", 53), timeout=3); print("OPEN")\nexcept OSError as e: print("BLOCKED", e.errno)',
    );
    expect(r.stdout).toMatch(/BLOCKED/);
  });

  it('has a read-only root filesystem and read-only inputs', async () => {
    const r = await run(
      [
        'for p in ["/etc/x", "/usr/lib/x", "/input/data.csv", "/input/new"]:',
        '    try:',
        '        open(p, "w").write("x"); print("WROTE", p)',
        '    except OSError as e: print("DENIED", p)',
      ].join('\n'),
    );
    expect(r.stdout).not.toMatch(/WROTE/);
    expect(r.stdout.match(/DENIED/g)).toHaveLength(4);
  });

  it('exposes no host secrets in the environment', async () => {
    const planted = {
      REALITY_TEST_SECRET: 'planted-secret-1',
      ANTHROPIC_API_KEY: 'sk-ant-planted-2',
      DATABASE_URL: 'postgres://user:planted-3@host/db',
    };
    const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
    Object.assign(process.env, planted);
    let r;
    try {
      r = await run('import os, json; print(json.dumps(dict(os.environ)))');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
    }
    const env = JSON.parse(r.stdout) as Record<string, string>;
    for (const [key, value] of Object.entries(planted)) {
      expect(env).not.toHaveProperty(key);
      expect(r.stdout).not.toContain(value);
    }
  });

  it('runs as an unprivileged user without capabilities', async () => {
    const r = await run(
      'import os\nprint(os.getuid())\nprint(open("/proc/self/status").read().split("CapEff:")[1].split()[0])',
    );
    const [uid, capEff] = r.stdout.trim().split('\n');
    expect(uid).toBe('10001');
    expect(capEff).toBe('0000000000000000');
  });

  it('kills code that exceeds the time limit', async () => {
    const r = await run('import time; time.sleep(30)', { limits: { timeoutMs: 3000 } });
    expect(r.status).toBe('timed_out');
    expect(r.durationMs).toBeLessThan(20_000);
  }, 40_000);

  it('kills code that exceeds the memory limit', async () => {
    const r = await run('x = bytearray(1024 * 1024 * 1024); print("allocated")', {
      limits: { memoryMb: 128 },
    });
    expect(r.stdout).not.toMatch(/allocated/);
    expect(['killed', 'failed']).toContain(r.status);
  }, 40_000);

  it('contains a fork bomb with the PID limit', async () => {
    const r = await run(
      [
        'import os',
        'n = 0',
        'try:',
        '    for _ in range(500):',
        '        if os.fork() == 0:',
        '            import time; time.sleep(5); os._exit(0)',
        '        n += 1',
        'except OSError: pass',
        'print(n)',
      ].join('\n'),
      { limits: { pids: 32, timeoutMs: 20_000 } },
    );
    expect(Number(r.stdout.trim().split('\n').at(-1))).toBeLessThan(32);
  }, 40_000);

  it('rejects symlinks and unsafe names in outputs', async () => {
    const r = await run('import os; os.symlink("/etc/passwd", "/output/leak.csv")');
    expect(r.status).toBe('output_rejected');
    expect(r.outputs).toEqual([]);
    expect(r.outputErrors.join()).toMatch(/not a regular file/);
  });
});

describe('sandbox runtime selection', () => {
  const image = process.env.SANDBOX_IMAGE ?? 'reality-sandbox-python:dev';

  it('runs under an explicitly configured runtime', async () => {
    const explicit = new DockerRunner(image, { runtime: 'runc' });
    await explicit.check();
    const r = await explicit.run({ code: 'print("ok")' });
    await r.cleanup();
    expect(r.status).toBe('succeeded');
    expect(r.stdout.trim()).toBe('ok');
  }, 60_000);

  it('refuses to run when the configured runtime is not installed', async () => {
    const missing = new DockerRunner(image, { runtime: 'runsc' });
    await expect(missing.check()).rejects.toThrow(/runtime "runsc" is not installed/);
  });

  it('rejects runtime names that are not plain identifiers', () => {
    expect(() => new DockerRunner(image, { runtime: 'runc --privileged' })).toThrow(/Unsafe/);
  });
});
