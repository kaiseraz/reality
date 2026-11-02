import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assess, classifyLicense, type PackageFacts } from '../src/capabilities/catalog.ts';
import { CapabilityEngine, evaluatePolicy, REQUIREMENT_TESTS } from '../src/capabilities/engine.ts';
import type { WheelInfo } from '../src/capabilities/store.ts';
import { loadConfig } from '../src/config.ts';
import { FakePlanner } from '../src/planner/fake-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

const facts = (over: Partial<PackageFacts> = {}): PackageFacts => ({
  package: 'p',
  version: '1.0',
  license: 'BSD-3-Clause',
  released: new Date().toISOString(),
  hasCompatibleWheel: true,
  dependencies: 3,
  requiresPython: '>=3.9',
  summary: '',
  ...over,
});
const candidate = { package: 'p', provides: 'p', fit: 1, fitNote: '' };

describe('candidate assessment', () => {
  it('requires a compatible wheel (no install-time build scripts)', () => {
    const a = assess(candidate, facts({ hasCompatibleWheel: false }));
    expect(a.eligible).toBe(false);
    expect(a.reasons.join()).toMatch(/wheel/);
  });
  it('flags copyleft licenses as ineligible without review', () => {
    expect(assess(candidate, facts({ license: 'GPL-3.0-only' })).eligible).toBe(false);
    expect(classifyLicense('BSD License')).toBe('permissive');
    expect(classifyLicense('')).toBe('unknown');
  });
  it('prefers better fit and recent maintenance', () => {
    const fresh = assess(candidate, facts());
    const stale = assess(candidate, facts({ released: '2019-01-01T00:00:00Z' }));
    const weakFit = assess({ ...candidate, fit: 0.4 }, facts());
    expect(fresh.score).toBeGreaterThan(stale.score);
    expect(fresh.score).toBeGreaterThan(weakFit.score);
  });
  it('is ineligible when metadata is unavailable (offline)', () => {
    expect(assess(candidate, null).eligible).toBe(false);
  });
});

const wheel = (over: Partial<WheelInfo> = {}): WheelInfo => ({
  file: 'p-1.0-py3-none-any.whl',
  name: 'p',
  version: '1.0',
  license: 'MIT',
  sha256: 'x',
  size: 1000,
  pth_files: [],
  console_scripts: 0,
  native_libs: 0,
  files: 3,
  in_base: false,
  requires: 0,
  ...over,
});

describe('inspection policy', () => {
  it('blocks .pth files, known vulnerabilities and non-wheels', () => {
    expect(evaluatePolicy([wheel({ pth_files: ['evil.pth'] })], []).blocking.join()).toMatch(
      /\.pth/,
    );
    expect(
      evaluatePolicy(
        [wheel()],
        [{ package: 'p', version: '1.0', ids: ['GHSA-1'] }],
      ).blocking.join(),
    ).toMatch(/GHSA-1/);
    expect(evaluatePolicy([wheel({ error: 'not a wheel' })], []).blocking).toHaveLength(1);
  });
  it('flags, but does not block, native code, scripts, unclear licenses and an unreachable OSV', () => {
    const r = evaluatePolicy(
      [wheel({ native_libs: 2, console_scripts: 1, license: 'Custom' })],
      null,
    );
    expect(r.blocking).toEqual([]);
    expect(r.flags.join('\n')).toMatch(/native/);
    expect(r.flags.join('\n')).toMatch(/OSV/);
    expect(r.flags.join('\n')).toMatch(/license/);
  });
  it('ignores packages already in the base image when judging new code', () => {
    expect(evaluatePolicy([wheel({ in_base: true, license: '' })], []).flags).toEqual([]);
  });
});

/** Offline integration: crafted fixtures through the real sandbox. */
describe('engine (offline, real sandbox)', () => {
  let runtime: Runtime;
  let dir: string;
  let engine: CapabilityEngine;
  let taskId: string;

  /** Builds wheel/sdist fixtures inside the sandbox (Python zipfile) and returns their dir. */
  async function fixtures(spec: { name: string; pth?: boolean; sdist?: boolean }[]) {
    const code = [
      'import zipfile, tarfile, io, json',
      `S = json.loads(${JSON.stringify(JSON.stringify(spec))})`,
      'for s in S:',
      '    if s.get("sdist"):',
      '        with tarfile.open(f"/output/{s[\'name\']}-1.0.tar.gz", "w:gz") as t:',
      '            data = b"print(1)"; info = tarfile.TarInfo("setup.py"); info.size = len(data); t.addfile(info, io.BytesIO(data))',
      '        continue',
      '    n = s["name"]',
      '    with zipfile.ZipFile(f"/output/{n}-1.0-py3-none-any.whl", "w") as z:',
      '        z.writestr(f"{n}/__init__.py", "VALUE = 41\\n")',
      '        z.writestr(f"{n}-1.0.dist-info/METADATA", f"Metadata-Version: 2.1\\nName: {n}\\nVersion: 1.0\\nLicense: MIT\\n\\n")',
      '        z.writestr(f"{n}-1.0.dist-info/WHEEL", "Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")',
      '        z.writestr(f"{n}-1.0.dist-info/RECORD", "")',
      '        if s.get("pth"): z.writestr("zz_evil.pth", "import os; os.system(\'echo pwned\')\\n")',
    ].join('\n');
    const run = await runtime.sandbox.runner.run({ code });
    const target = join(dir, `fixtures-${Date.now()}`);
    const { mkdir, copyFile } = await import('node:fs/promises');
    await mkdir(target, { recursive: true });
    for (const o of run.outputs) await copyFile(o.path, join(target, o.name));
    await run.cleanup();
    return target;
  }

  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-caps-'));
    runtime = await createRuntime(
      loadConfig({
        AUTH: 'off',
        DATABASE_URL: TEST_DATABASE_URL,
        ARTIFACT_DIR: dir,
        CAPABILITY_DIR: dir,
      }),
      { planner: new FakePlanner(), log: { error: () => {} } },
    );
    engine = new CapabilityEngine({
      store: runtime.capabilities,
      sandbox: runtime.sandbox,
      events: runtime.events,
      runs: runtime.runs,
      dir,
      queryOsv: async () => [],
    });
    taskId = (await runtime.tasks.create('caps', { start: false })).id;
  }, 60_000);
  afterAll(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  const discover = (id: string) =>
    runtime.capabilities.discover({
      id,
      need: 'test',
      package: id,
      version: '1.0',
      license: 'MIT',
      reason: 'test',
    });

  it('T4: rejects a wheel that ships a .pth start-up hook, before anything is installed', async () => {
    await discover('evilpkg');
    const staged = await fixtures([{ name: 'evilpkg', pth: true }]);
    const r = await engine.inspectStaging('evilpkg', staged, taskId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/\.pth/);
    expect((await runtime.capabilities.get('evilpkg'))?.state).toBe('rejected');
    expect((await engine.mountsFor(['evilpkg'])).ok).toBe(false);
  }, 60_000);

  it('T4: rejects source distributions (they run build scripts on install)', async () => {
    await discover('sdistpkg');
    const staged = await fixtures([{ name: 'sdistpkg', sdist: true }]);
    const r = await engine.inspectStaging('sdistpkg', staged, taskId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/not a wheel/);
  }, 60_000);

  it('T5: a capability that fails its requirement test is never enabled', async () => {
    REQUIREMENT_TESTS.goodpkg = {
      name: 'value-is-42',
      description: 'goodpkg.VALUE must equal 42',
      code: [
        'import json, sys',
        'sys.path[:0] = ["/caps/goodpkg"]',
        'import goodpkg',
        'ok = goodpkg.VALUE == 42',
        'json.dump({"passed": ok, "value": goodpkg.VALUE}, open("/output/summary.json", "w"))',
      ].join('\n'),
    };
    await discover('goodpkg');
    const staged = await fixtures([{ name: 'goodpkg' }]);
    const inspected = await engine.inspectStaging('goodpkg', staged, taskId);
    expect(inspected.ok).toBe(true);
    const r = await engine.install({ capabilityId: 'goodpkg', need: 'test' }, taskId);
    expect(r.ok).toBe(false); // the fixture has VALUE = 41
    expect((await runtime.capabilities.get('goodpkg'))?.state).toBe('rejected');
    expect((await engine.mountsFor(['goodpkg'])).ok).toBe(false);
    delete REQUIREMENT_TESTS.goodpkg;
  }, 120_000);

  it('refuses to install files that changed after inspection', async () => {
    REQUIREMENT_TESTS.swappkg = { name: 't', description: 't', code: 'print(1)' };
    await discover('swappkg');
    const staged = await fixtures([{ name: 'swappkg' }]);
    expect((await engine.inspectStaging('swappkg', staged, taskId)).ok).toBe(true);
    const { writeFile } = await import('node:fs/promises');
    const [file] = (await readdir(staged)).filter((f) => f.endsWith('.whl'));
    await writeFile(join(staged, file!), 'tampered');
    const r = await engine.install({ capabilityId: 'swappkg', need: 'test' }, taskId);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/Integrity/);
    delete REQUIREMENT_TESTS.swappkg;
  }, 60_000);

  it('cannot skip lifecycle states', async () => {
    await discover('jumpy');
    await expect(runtime.capabilities.transition('jumpy', 'trusted', 'skip')).rejects.toThrow(
      /not allowed/,
    );
  });
});
