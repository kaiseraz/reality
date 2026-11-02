/**
 * npm run eval:servers [names]: does every server on the reviewed list still work? Each is found,
 * inspected, installed and called against its real service, the way a bot gets it. Run it now and
 * then: services change, and a server on this list is promised to work. No model is needed.
 * About ten minutes. Own scratch database (reality_adaptlive).
 * Needs Docker, Postgres, the sandbox images and the computer image (for the gateway).
 */
import type { CapabilityEngine } from '../src/capabilities/engine.ts';

process.env.TEST_DATABASE_URL ??= 'postgres://reality:reality@localhost:5432/reality_adaptlive';
const { loadConfig } = await import('../src/config.ts');
const { createRuntime } = await import('../src/runtime.ts');
const { REVIEWED_SERVERS, reviewedId } = await import('../src/capabilities/servers.ts');
const { RuleBasedPlanner } = await import('../src/planner/rule-planner.ts');
const { resetTestDatabase, TEST_DATABASE_URL } = await import('../test/db.ts');
const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

await resetTestDatabase();
const dir = await mkdtemp(join(tmpdir(), 'reality-servers-'));
const runtime = await createRuntime(
  loadConfig({
    ...process.env,
    AUTH: 'off',
    COMPUTERS: 'on',
    DATABASE_URL: TEST_DATABASE_URL,
    ARTIFACT_DIR: dir,
    CAPABILITY_DIR: dir,
  }),
  { planner: new RuleBasedPlanner(), log: { error: () => {} } },
);
const engine = runtime.capabilityEngine as CapabilityEngine;
const only = process.argv[2]?.split(',');
let failed = 0;
for (const s of REVIEWED_SERVERS.filter((x) => !only || only.some((o) => x.package.includes(o)))) {
  const id = reviewedId(s);
  const task = await runtime.tasks.create(`Check ${s.package}`, { start: false });
  try {
    const prepared = await engine.prepare(`${s.job} [mcp]`, task.id);
    if (prepared.kind !== 'proposal') throw new Error(`not proposed: ${JSON.stringify(prepared)}`);
    if ((prepared.proposal as unknown as { package: string }).package !== s.package) {
      throw new Error(
        `the need brought ${(prepared.proposal as unknown as { package: string }).package}`,
      );
    }
    for (const secret of s.secrets ?? []) {
      await engine.setSecrets(id, { [secret.name]: 'made-up-value-for-the-check' }, null);
    }
    const installed = await engine.install(prepared.proposal, task.id);
    if (!installed.ok) throw new Error(installed.detail);
    const warned = (prepared.proposal as unknown as { warnings?: string[] }).warnings ?? [];
    console.log(
      `ok    ${s.package}${s.test ? '' : ' (started only: needs a key)'}${warned.length ? `; ${warned.length} known vulnerabilities` : ''}`,
    );
  } catch (err) {
    failed++;
    console.log(`FAIL  ${s.package}: ${(err as Error).message.slice(0, 700)}`);
  }
}
await runtime.close();
await rm(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nAll work');
process.exit(failed ? 1 : 0);
