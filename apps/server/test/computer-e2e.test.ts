import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

/**
 * A bot's own computer, for real: starts the sandbox image behind Reality's gateway, runs
 * commands, keeps files across a restart, and reaches only allowed domains. Opt-in (needs
 * the 3.6 GB image and network): RUN_COMPUTER_TESTS=1.
 */
const enabled = process.env.RUN_COMPUTER_TESTS === '1';

describe.skipIf(!enabled)('bot computer (docker, network)', () => {
  let rt: Runtime;
  let botId: string;

  beforeAll(async () => {
    await resetTestDatabase();
    rt = await createRuntime(loadConfig({ AUTH: 'off', DATABASE_URL: TEST_DATABASE_URL }), {
      planner: new RuleBasedPlanner(),
      analyst: null,
      chatModel: null,
      log: { error: () => {} },
    });
    botId = (await rt.bots.create({ name: 'Volt', role: 'engineer' }, null)).id;
  }, 120_000);
  afterAll(async () => {
    await rt?.computers?.destroy(botId);
    await rt?.close();
  }, 120_000);

  it('runs commands in a home folder that survives a restart', async () => {
    const pc = rt.computers;
    if (!pc) throw new Error('computers are off');
    const out = await pc.exec(botId, 'echo kept > note.txt && whoami');
    expect(out).toMatchObject({ exitCode: 0 });
    expect(out.output).toContain('gem');
    await pc.writeFile(botId, 'project/plan.md', '# Plan');
    await pc.stop(botId);
    const again = await pc.exec(botId, 'cat note.txt project/plan.md');
    expect(again.output).toContain('kept');
    expect(again.output).toContain('# Plan');
  }, 300_000);

  it('reaches the internet only for allowed domains', async () => {
    const pc = rt.computers;
    if (!pc) throw new Error('computers are off');
    const blocked = await pc.exec(
      botId,
      'curl -sS -m 10 -o /dev/null https://example.com; echo code=$?',
    );
    expect(blocked.output).toMatch(/403/);
    expect(blocked.blocked).toContain('example.com');
    const direct = await pc.exec(
      botId,
      'env -u https_proxy -u HTTPS_PROXY curl -sS -m 8 -o /dev/null https://example.com; echo code=$?',
    );
    expect(direct.output).not.toMatch(/code=0/);
    await pc.allow(botId, 'example.com', null);
    const allowed = await pc.exec(botId, 'curl -sS -m 15 https://example.com | head -c 200');
    expect(allowed.output).toMatch(/Example Domain/);
    const page = await pc.browse(botId, 'https://example.com');
    expect(page.title).toMatch(/Example Domain/);
  }, 300_000);
});
