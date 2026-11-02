import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredFile } from '../src/artifacts/file-store.ts';
import { LabDesktop } from '../src/lab/desktop.ts';

/** A computer that records what it is told, and a file store over a temporary folder. */
describe('lab results on the bot desktop', () => {
  let dir: string;
  const stored = (name: string, size = 10): StoredFile => ({
    ownerId: null,
    id: name,
    taskId: 'a1b2c3d4-0000-0000-0000-000000000000',
    stepId: 'simulate',
    name,
    mediaType: 'text/plain',
    sizeBytes: size,
    sha256: name,
    createdAt: '',
  });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reality-desktop-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const setup = async (names: string[], running: string[]) => {
    const list = names.map((n) => stored(n));
    for (const f of list) {
      await writeFile(
        join(dir, f.sha256),
        f.name === 'design.json' ? '{}' : `content of ${f.name}`,
      );
    }
    const calls: string[] = [];
    const desktop = new LabDesktop({
      files: {
        forStep: async () => list,
        filePath: (f) => join(dir, f.sha256),
      },
      computers: {
        running: () => running,
        writeFile: async (_bot, path, content) => {
          calls.push(`write ${path} ${content}`);
        },
        exec: async (_bot, command) => {
          calls.push(`exec ${command}`);
          return { exitCode: 0, output: '', blocked: [] };
        },
        log: async (_bot, _kind, text) => {
          calls.push(`log ${text}`);
        },
      },
    });
    return { desktop, calls };
  };

  it('builds a board live: plugin and start first, then the build, then the checked file', async () => {
    const { desktop, calls } = await setup(
      [
        'board.kicad_pcb',
        'stage_1_placed.kicad_pcb',
        'design.json',
        'model_r0603_1.wrl',
        'scene.json',
        'copper_top.gtl',
      ],
      ['bot-1'],
    );
    const shown = await desktop.show('bot-1', 'a1b2c3d4-0000-0000-0000-000000000000', {
      pauseMs: 1,
      view3dAfterMs: 1,
      raytraceMs: 1,
      firstRunAfterMs: 1,
      loadMs: 1,
      loadSeconds: 1,
    });
    expect(shown?.dir).toBe('/home/gem/workspace/lab-a1b2c3d4');
    // This computer answers nothing here, so its build counts as different: the checked board opens.
    expect(shown?.opened).toEqual(['board.kicad_pcb', '3D viewer', 'board.kicad_pcb']);
    const at = (needle: string) => calls.findIndex((c) => c.includes(needle));
    const plugin = at('write /home/gem/.local/share/kicad/8.0/scripting/plugins/reality_live.py');
    const opened = at("pcbnew '/home/gem/workspace/lab-a1b2c3d4/board.kicad_pcb'");
    const build = at('REALITY_LIVE=');
    const restored = calls.findIndex(
      (c, i) => i > build && c.includes('checked.kicad_pcb') && c.includes('exec cp'),
    );
    expect(plugin).toBeGreaterThanOrEqual(0);
    expect(opened).toBeGreaterThan(plugin);
    expect(build).toBeGreaterThan(opened);
    expect(restored).toBeGreaterThan(build);
    expect(calls.some((c) => c.includes('xdotool') && c.includes('alt+3'))).toBe(true);
  });

  it('opens a board as it is when it has no design to build from', async () => {
    const { desktop } = await setup(['board.kicad_pcb'], ['bot-1']);
    const shown = await desktop.show('bot-1', 'a1b2c3d4-0000-0000-0000-000000000000', {
      view3dAfterMs: 1,
      raytraceMs: 1,
      firstRunAfterMs: 1,
      loadMs: 1,
      loadSeconds: 1,
    });
    expect(shown?.opened).toEqual(['board.kicad_pcb', '3D viewer']);
  });

  it('opens an assembly in FreeCAD', async () => {
    const { desktop, calls } = await setup(['assembly.step', 'mesh_stage_1.stl'], ['bot-1']);
    const shown = await desktop.show('bot-1', 'a1b2c3d4-0000-0000-0000-000000000000');
    expect(shown?.opened).toEqual(['assembly.step']);
    expect(
      calls.some((c) => c.includes("freecad '/home/gem/workspace/lab-a1b2c3d4/assembly.step'")),
    ).toBe(true);
  });

  it('builds an assembly in one FreeCAD window part by part', async () => {
    const { desktop, calls } = await setup(
      ['assembly.step', 'build.json', 'parts.brep'],
      ['bot-1'],
    );
    const shown = await desktop.show('bot-1', 'a1b2c3d4-0000-0000-0000-000000000000');
    // The parts file carries the same parts as the STEP file, so the big one stays behind.
    expect(shown?.copied.sort()).toEqual(['build.json', 'parts.brep']);
    expect(shown?.opened).toEqual(['build_live.py']);
    const script = calls.find((c) =>
      c.startsWith('write /home/gem/workspace/lab-a1b2c3d4/build_live.py'),
    );
    expect(script).toContain('whole.importBrep(base + "/" + build["file"])');
    expect(script).toContain('o.Shape = shapes[i]');
    expect(script).toContain('vo.ShapeColor = rgb');
    expect(script).toContain('"/home/gem/workspace/lab-a1b2c3d4"');
    // A line break in the log text stays an escape in the Python, not a broken string.
    expect(script).toContain('log.write("done\\n")');
    expect(
      calls.some((c) => c.includes("freecad '/home/gem/workspace/lab-a1b2c3d4/build_live.py'")),
    ).toBe(true);
  });

  it('compresses big files on the way and unpacks them on the computer', async () => {
    const big = 'ISO-10303-21;\n' + 'ENDSEC; part data line\n'.repeat(20_000);
    const list = [{ ...stored('board.kicad_pcb'), sizeBytes: big.length }];
    await writeFile(join(dir, 'board.kicad_pcb'), big);
    const calls: string[] = [];
    const desktop = new LabDesktop({
      files: { forStep: async () => list, filePath: () => join(dir, 'board.kicad_pcb') },
      computers: {
        running: () => ['bot-1'],
        writeFile: async (_b, path) => {
          calls.push(`write ${path}`);
        },
        exec: async (_b, command) => {
          calls.push(`exec ${command.slice(0, 30)} … ${command.slice(-140)}`);
          return { exitCode: 0, output: '', blocked: [] };
        },
        log: async () => undefined,
      },
    });
    await desktop.show('bot-1', 'a1b2c3d4-0000-0000-0000-000000000000', {
      view3dAfterMs: 1,
      raytraceMs: 1,
      firstRunAfterMs: 1,
      loadMs: 1,
      loadSeconds: 1,
    });
    // Not written as plain text; packed, appended in pieces, then unpacked.
    expect(
      calls.some((c) => c.startsWith('write /home/gem/workspace/lab-a1b2c3d4/board.kicad_pcb')),
    ).toBe(false);
    expect(calls.some((c) => c.includes('base64 -d >>'))).toBe(true);
    expect(calls.some((c) => c.includes('gunzip -f'))).toBe(true);
  });

  it('does not wake a computer nobody is using, unless asked to', async () => {
    const off = await setup(['board.kicad_pcb'], []);
    expect(await off.desktop.show('bot-1', 'a1b2c3d4-0000-0000-0000-000000000000')).toBeNull();
    expect(off.calls).toEqual([]);
    const woken = await setup(['board.kicad_pcb'], []);
    const shown = await woken.desktop.show('bot-1', 'a1b2c3d4-0000-0000-0000-000000000000', {
      boot: true,
      view3dAfterMs: 1,
      raytraceMs: 1,
      firstRunAfterMs: 1,
      loadMs: 1,
      loadSeconds: 1,
    });
    expect(shown?.opened).toEqual(['board.kicad_pcb', '3D viewer']);
  });

  it('leaves the open board alone after a re-check', async () => {
    const { desktop, calls } = await setup(['board.kicad_pcb', 'original.kicad_pcb'], ['bot-1']);
    expect(await desktop.show('bot-1', 'a1b2c3d4-0000-0000-0000-000000000000')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('has nothing to show for results without a board or assembly', async () => {
    const { desktop, calls } = await setup(['scene.json', 'drill.drl'], ['bot-1']);
    expect(await desktop.show('bot-1', 'a1b2c3d4-0000-0000-0000-000000000000')).toBeNull();
    expect(calls).toEqual([]);
  });
});
