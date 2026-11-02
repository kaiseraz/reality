import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { LabPresets } from '../src/lab/plan.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

/**
 * Open-ended capability search, end to end with the real network and Docker: a need the reviewed
 * catalog does not know ("turn text into ASCII art banners"), a model's guesses (here fixed, so
 * the test does not depend on a model), real PyPI lookups, real inspection, approval, installation
 * into an isolated layer and the generic test, and then the library used from a sandbox.
 * Opt-in (small download): RUN_NETWORK_TESTS=1.
 */
const enabled = process.env.RUN_NETWORK_TESTS === '1';

describe.skipIf(!enabled)('a library found by search (network)', () => {
  let runtime: Runtime;
  let pool: pg.Pool;
  let dir: string;
  let taskId: string;

  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-search-e2e-'));
    runtime = await createRuntime(
      loadConfig({
        AUTH: 'off',
        DATABASE_URL: TEST_DATABASE_URL,
        ARTIFACT_DIR: dir,
        CAPABILITY_DIR: dir,
      }),
      { planner: new RuleBasedPlanner(), log: { error: () => {} } },
    );
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('finds, verifies and inspects a library, then asks before installing', async () => {
    const task = await runtime.tasks.create('Get a library: ASCII art banners', { start: false });
    taskId = task.id;
    await new LabPresets(pool).set(taskId, 'acquire_library', {
      need: 'turn text into ASCII art banners',
      package: 'pyfiglet',
    });
    await runtime.tasks.start(taskId);
    await runtime.tasks.settled(taskId);
    await runtime.tasks.decide(taskId, { approved: true, by: 'user' }); // the plan
    await runtime.tasks.settled(taskId);
    const detail = await runtime.tasks.get(taskId);
    expect(detail?.status).toBe('awaiting_approval');
    const pending = detail?.pendingApproval as { kind: string; proposal: Record<string, unknown> };
    expect(pending.kind).toBe('capability-approval');
    expect(pending.proposal).toMatchObject({
      package: 'pyfiglet',
      source: 'search',
      blocking: [],
      capabilityId: 'pyfiglet',
    });
    expect(pending.proposal.test).toMatchObject({ name: 'loads-from-layer' });
    expect((await runtime.capabilities.get('pyfiglet'))?.state).toBe('inspected');
    const events = await runtime.events.list(taskId);
    expect(events.map((e) => e.type)).toContain('capability.searched');
  }, 900_000);

  it('installs it into an isolated layer, and a sandbox can use it', async () => {
    await runtime.tasks.decide(taskId, { approved: true, by: 'user' });
    await runtime.tasks.settled(taskId);
    const detail = await runtime.tasks.get(taskId);
    const step = (detail?.state?.stepResults ?? []).find(
      (r: { stepId: string }) => r.stepId === 'acquire',
    );
    expect(step?.status, step?.detail).toBe('done');
    expect(step?.detail).toMatch(/libraries \["pyfiglet"\]/);
    const record = await runtime.capabilities.get('pyfiglet');
    expect(record?.state).toBe('enabled');

    // The way a bot uses it: mounted read-only, on the path, no network.
    const mounts = await runtime.capabilityEngine.mountsFor(['pyfiglet']);
    expect(mounts.ok).toBe(true);
    if (!mounts.ok) return;
    const run = await runtime.sandbox.execute({
      taskId: null,
      kind: 'analysis',
      label: 'use pyfiglet',
      code:
        `import sys; sys.path[:0] = ${JSON.stringify(mounts.paths)}\n` +
        'import pyfiglet\nprint(pyfiglet.figlet_format("OK", font="standard"))\n' +
        'import pyfiglet as p; print("LAYER", p.__file__)\n',
      readOnlyMounts: mounts.mounts,
      limits: { timeoutMs: 60_000 },
    });
    await run.result.cleanup();
    expect(run.result.status, run.result.stderr).toBe('succeeded');
    expect(run.result.stdout).toContain('LAYER /caps/pyfiglet/');
    expect(run.result.stdout).toMatch(/\|/); // a rendered banner

    const info = await runtime.capabilityEngine.info?.('pyfiglet');
    expect(info?.modules).toContain('pyfiglet');
  }, 900_000);

  it('refuses a package nobody uses, even when it is named', async () => {
    const task = await runtime.tasks.create('Get a library: ghost', { start: false });
    await new LabPresets(pool).set(task.id, 'acquire_library', {
      need: 'turn text into ASCII art banners',
      package: 'ascii-banners-supreme-xyz',
    });
    await runtime.tasks.start(task.id);
    await runtime.tasks.settled(task.id);
    await runtime.tasks.decide(task.id, { approved: true, by: 'user' });
    await runtime.tasks.settled(task.id);
    const detail = await runtime.tasks.get(task.id);
    // Not an approval waiting: nothing eligible was found (the model-free search still sees
    // pyfiglet through keywords at best, but never the invented name).
    const pending = detail?.pendingApproval as { proposal?: { package?: string } } | null;
    expect(pending?.proposal?.package).not.toBe('ascii-banners-supreme-xyz');
  }, 900_000);

  describe('an MCP server found by search', () => {
    let mcpTask: string;

    it('reads how to start it from its own files and asks before installing', async () => {
      const task = await runtime.tasks.create('Get an MCP server: time zones', { start: false });
      mcpTask = task.id;
      await new LabPresets(pool).set(mcpTask, 'acquire_library', {
        need: 'convert between time zones and read the current time',
        mcp: true,
        package: 'mcp-server-time',
      });
      await runtime.tasks.start(mcpTask);
      await runtime.tasks.settled(mcpTask);
      await runtime.tasks.decide(mcpTask, { approved: true, by: 'user' }); // the plan
      await runtime.tasks.settled(mcpTask);
      const detail = await runtime.tasks.get(mcpTask);
      expect(detail?.status).toBe('awaiting_approval');
      const pending = detail?.pendingApproval as { proposal: Record<string, unknown> };
      expect(pending.proposal).toMatchObject({
        package: 'mcp-server-time',
        kind: 'mcp-server',
        source: 'search',
        blocking: [],
      });
      expect((pending.proposal.mcp as { launch: string }).launch).toMatch(/^mcp_server_time:/);
      expect(pending.proposal.test).toMatchObject({ name: 'real-call' });
    }, 900_000);

    it('installs it, lists the tools the server itself offers, and a tool call works', async () => {
      await runtime.tasks.decide(mcpTask, { approved: true, by: 'user' });
      await runtime.tasks.settled(mcpTask);
      const detail = await runtime.tasks.get(mcpTask);
      const step = (detail?.state?.stepResults ?? []).find(
        (r: { stepId: string }) => r.stepId === 'acquire',
      );
      expect(step?.status, step?.detail).toBe('done');
      expect(step?.detail).toMatch(/mcp_call server "mcp-server-time"; tools: .*get_current_time/);
      expect((await runtime.capabilities.get('mcp-server-time'))?.state).toBe('enabled');

      const listed = await runtime.capabilityEngine.listTools?.('mcp-server-time');
      expect(listed?.ok).toBe(true);
      expect(listed?.ok && listed.tools.map((t) => t.name)).toContain('get_current_time');

      const called = await runtime.capabilityEngine.callTool?.(
        'mcp-server-time',
        'get_current_time',
        { timezone: 'Europe/Berlin' },
        [],
      );
      expect(called?.ok, JSON.stringify(called)).toBe(true);
      expect(called?.ok && called.text).toContain('Europe/Berlin');

      // Only what the server listed can be called.
      const other = await runtime.capabilityEngine.callTool?.(
        'mcp-server-time',
        'format_c_drive',
        {},
        [],
      );
      expect(other?.ok).toBe(false);
      const info = await runtime.capabilityEngine.info?.('mcp-server-time');
      expect(info).toMatchObject({ kind: 'mcp-server' });
      expect(info?.tools).toContain('convert_time');
    }, 900_000);
  });
});
