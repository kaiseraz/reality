import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskSpec } from '@reality/schemas';
import { loadConfig } from '../src/config.ts';
import { getLabEngine } from '../src/lab/engines.ts';
import { partsBeside } from '../src/lab/pcb-live.ts';
import { labPlan, LabPresets } from '../src/lab/plan.ts';
import type { CheckResult, StepResult } from '../src/orchestrator/graph.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { validatePlan } from '../src/planner/semantics.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { checkPrelude, getCheck } from '../src/verification/checks.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

describe('pcb design (pure)', () => {
  it('has a valid built-in example and rejects bad input', () => {
    const engine = getLabEngine('pcb_design')!;
    expect(engine.params.safeParse({}).success).toBe(true);
    const bad = (extra: Record<string, unknown>) => engine.params.safeParse(extra).success;
    expect(
      bad({ parts: [{ ref: 'R1', footprint: 'R0603' }], nets: [{ name: 'A', pins: ['R1.1'] }] }),
    ).toBe(true);
    expect(
      bad({ parts: [{ ref: '1R', footprint: 'R0603' }], nets: [{ name: 'A', pins: ['R1.1'] }] }),
    ).toBe(false);
    expect(
      bad({
        parts: [{ ref: 'R1', footprint: 'R0603', rot: 45 }],
        nets: [{ name: 'A', pins: ['R1.1'] }],
      }),
    ).toBe(false);
    expect(bad({ board: { width_mm: 1, height_mm: 10 } })).toBe(false);
  });

  it('plans one lab step with one independent check, and needs no capability', () => {
    const spec = TaskSpec.parse(labPlan('pcb_design', {}, 'q', [], 'test').draft);
    expect(spec.workflow.map((s) => s.agent)).toEqual(['lab-agent', 'verification-agent']);
    expect(spec.acceptanceCriteria.map((c) => c.check?.name)).toEqual(['pcb_recomputed']);
    expect(validatePlan(spec, { datasets: [], availableCapabilities: [] })).toEqual([]);
  });
});

describe('pcb design (database, sandbox)', () => {
  let runtime: Runtime;
  let presets: LabPresets;
  let pool: pg.Pool;
  let dir: string;
  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-pcb-'));
    runtime = await createRuntime(
      loadConfig({ AUTH: 'off', DATABASE_URL: TEST_DATABASE_URL, ARTIFACT_DIR: dir }),
      { planner: new RuleBasedPlanner(), analyst: null, chatModel: null, log: { error: () => {} } },
    );
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    presets = new LabPresets(pool);
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const design = async (params: Record<string, unknown>) => {
    const task = await runtime.tasks.create('Design a board', { start: false });
    await presets.set(task.id, 'pcb_design', params);
    await runtime.tasks.start(task.id);
    await runtime.tasks.settled(task.id);
    await runtime.tasks.decide(task.id, { approved: true, by: 'user' });
    await runtime.tasks.settled(task.id);
    const detail = (await runtime.tasks.get(task.id))!;
    const sim = ((detail.state?.stepResults ?? []) as StepResult[]).find(
      (r) => r.stepId === 'simulate',
    );
    return { task, detail, sim, checks: (detail.state?.verification ?? []) as CheckResult[] };
  };

  it('places and routes a 555 timer board, and the check re-measures it', async () => {
    const { sim, checks, detail } = await design({});
    expect(sim?.status, sim?.detail).toBe('done');
    const s = sim?.summary as Record<string, unknown>;
    expect(s.parts).toBe(8);
    expect(s.nets_routed).toBe(s.nets);
    expect(s.unrouted).toEqual([]);
    expect(s.drc_violations).toBe(0);
    expect(s.design_ok).toBe(true);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status, checks[0]?.detail).toBe('passed');
    const files = await runtime.files.forStep(detail.id, 'simulate');
    const names = files.map((f) => f.name).sort();
    expect(names.filter((n) => !n.startsWith('model_'))).toEqual(
      [
        'board.kicad_pcb',
        'electrical_check.txt',
        'copper_bottom.gbl',
        'copper_top.gtl',
        'design.json',
        'drill.drl',
        'outline.gko',
        'scene.json',
        'stage_1_placed.kicad_pcb',
      ].sort(),
    );
    // One 3D model per distinct part, referenced from the board file.
    const models = names.filter((n) => n.startsWith('model_') && n.endsWith('.wrl'));
    expect(models.length).toBeGreaterThanOrEqual(5);
    const board = await readFile(
      runtime.files.filePath(files.find((f) => f.name === 'board.kicad_pcb')!),
      'utf8',
    );
    expect(board).toMatch(/^\(kicad_pcb/);
    expect(board).toContain('(footprint "SOIC8"');
    for (const m of models) expect(board).toContain('$' + '{KIPRJMOD}/' + m);
    const scene = JSON.parse(
      await readFile(runtime.files.filePath(files.find((f) => f.name === 'scene.json')!), 'utf8'),
    ) as { parts: { ref: string; bodies: unknown[] }[] };
    expect(scene.parts).toHaveLength(8);
    expect(scene.parts.find((p) => p.ref === 'U1')?.bodies.length).toBeGreaterThan(3);
  }, 600_000);

  it('fails a board whose circuit is wrong, however well it is routed', async () => {
    const { task, sim, checks } = await design({
      board: { width_mm: 40, height_mm: 30 },
      rails: { VCC: 24 },
      parts: [
        { ref: 'U1', footprint: 'SOT223', value: 'AMS1117-3.3' },
        { ref: 'C1', footprint: 'C0805', value: '10u' },
        { ref: 'C2', footprint: 'C0805', value: '10u' },
        { ref: 'D1', footprint: 'LED0603', value: 'red' },
        { ref: 'R1', footprint: 'R0603', value: '10' },
      ],
      nets: [
        { name: 'VCC', pins: ['U1.3', 'C1.1'] },
        { name: 'OUT', pins: ['U1.2', 'C2.1', 'R1.1'] },
        { name: 'LED', pins: ['R1.2', 'D1.1'] },
        { name: 'GND', pins: ['U1.1', 'C1.2', 'C2.2', 'D1.2'] },
      ],
    });
    expect(sim?.status, sim?.detail).toBe('done');
    const failed = (sim?.summary as { electrical: { failed: { detail: string }[] } }).electrical
      .failed;
    const said = failed.map((f) => f.detail).join(' ');
    // 24 V on a regulator rated for 15 V, and an LED the wrong way round.
    expect(said).toContain('outside');
    expect(said).toContain('pad 1 is the cathode');
    expect(checks[0]?.status).not.toBe('passed');
    expect(checks[0]?.detail).toContain('electrical');
    const files = await runtime.files.forStep(task.id, 'simulate');
    expect(files.map((f) => f.name)).toContain('electrical_check.txt');
  }, 600_000);

  it('makes a board larger when the parts do not fit, and the check still passes', async () => {
    const { sim, checks } = await design({ board: { width_mm: 6, height_mm: 5 } });
    expect(sim?.status, sim?.detail).toBe('done');
    const s = sim?.summary as Record<string, number>;
    expect(s.board_width_mm).toBeGreaterThan(6);
    expect(sim?.detail).toContain('enlarged from 6 x 5');
    expect(checks[0]?.status, checks[0]?.detail).toBe('passed');
  }, 600_000);

  it('reports honestly when a net cannot be routed, and the check still passes', async () => {
    // A wall of mounting holes across the whole board, between the two resistors.
    const wall = [3.5, 10, 16.5].map((y, i) => ({
      ref: `H${i + 1}`,
      footprint: 'HOLE6',
      at: [20, y],
    }));
    const { sim, checks } = await design({
      board: { width_mm: 40, height_mm: 20 },
      parts: [
        { ref: 'R1', footprint: 'R0603', at: [6, 10] },
        { ref: 'R2', footprint: 'R0603', at: [34, 10] },
        ...wall,
      ],
      nets: [{ name: 'A', pins: ['R1.2', 'R2.1'] }],
      routing_seconds: 10,
    });
    expect(sim?.status, sim?.detail).toBe('done');
    const s = sim?.summary as Record<string, unknown>;
    expect(s.unrouted).toEqual(['A']);
    expect(s.design_ok).toBe(false);
    for (const c of checks) expect(c.status, c.detail).toBe('passed');
  }, 600_000);

  it('a falsified board fails its check', async () => {
    const { task, sim } = await design({});
    const step = sim!;
    const files = await runtime.files.forStep(task.id, 'simulate');
    const meta = await runtime.artifacts.get(step.artifacts?.[0] ?? '');
    const lines = (await readFile(runtime.artifacts.filePath(meta!), 'utf8')).trim().split('\n');
    // Bend the first track of a net onto a pad of another net: a short circuit.
    const ti = lines.findIndex((l) => l.startsWith('track,'));
    const t = lines[ti]!.split(',');
    const pad = lines
      .map((l) => l.split(','))
      .find((c) => c[0] === 'pad' && c[2] !== t[2] && c[2] !== '')!;
    t[6] = pad[4]!;
    t[7] = pad[5]!;
    lines[ti] = t.join(',');
    const tampered = join(dir, 'tampered-board.csv');
    await writeFile(tampered, `${lines.join('\n')}\n`);
    const spec = (await runtime.tasks.get(task.id))!.state?.spec as TaskSpec;
    const exec = await runtime.sandbox.execute({
      taskId: null,
      kind: 'check',
      label: 'tamper',
      code:
        checkPrelude(spec.acceptanceCriteria[0]?.check?.params ?? {}, step.summary) +
        getCheck('pcb_recomputed')!.body,
      inputs: [
        { name: 'result.csv', hostPath: tampered },
        ...files.map((f) => ({ name: f.name, hostPath: runtime.files.filePath(f) })),
      ],
    });
    await exec.result.cleanup();
    expect((exec.summary as { passed: boolean }).passed).toBe(false);
  }, 600_000);

  describe('a board changed by hand', () => {
    let original = '';
    const RULES = {
      clearance_mm: 0.2,
      track_mm: 0.25,
      via_dia_mm: 0.6,
      via_drill_mm: 0.3,
      edge_clearance_mm: 0.3,
    };
    /** KiCad writes each item over many lines when it saves; the check must read that too. */
    const asKiCadSaves = (text: string) => text.replace(/\) \(/g, ')\n\t\t(');
    const recheck = async (board: string) => {
      const task = await runtime.tasks.create('Check the board again', { start: false });
      await presets.set(task.id, 'pcb_recheck', {
        board_kicad: board,
        original_kicad: original,
        rules: RULES,
      });
      await runtime.tasks.start(task.id);
      await runtime.tasks.settled(task.id);
      await runtime.tasks.decide(task.id, { approved: true, by: 'user' });
      await runtime.tasks.settled(task.id);
      const detail = (await runtime.tasks.get(task.id))!;
      const sim = ((detail.state?.stepResults ?? []) as StepResult[]).find(
        (r) => r.stepId === 'simulate',
      );
      return {
        sim,
        summary: sim?.summary as Record<string, unknown>,
        check: ((detail.state?.verification ?? []) as CheckResult[])[0],
      };
    };

    beforeAll(async () => {
      const { detail } = await design({});
      const files = await runtime.files.forStep(detail.id, 'simulate');
      original = await readFile(
        runtime.files.filePath(files.find((f) => f.name === 'board.kicad_pcb')!),
        'utf8',
      );
    }, 600_000);

    it('passes when nothing is wrong, also in the form KiCad saves', async () => {
      const { sim, summary, check } = await recheck(asKiCadSaves(original));
      expect(sim?.status, sim?.detail).toBe('done');
      expect(summary.design_ok).toBe(true);
      expect(summary.unrouted).toEqual([]);
      expect(summary.drc_violations).toBe(0);
      expect(check?.status, check?.detail).toBe('passed');
    }, 600_000);

    it('finds a net that a deleted track left open', async () => {
      // All tracks of one net: a single short one may be bridged by its wide neighbours.
      const lines = original.split('\n');
      const first = lines.find((l) => l.startsWith('  (segment '))!;
      const tag = /\(net \d+\)/.exec(first)![0];
      const left = lines.filter(
        (l) => !((l.startsWith('  (segment ') || l.startsWith('  (via ')) && l.includes(tag)),
      );
      const { summary, check } = await recheck(asKiCadSaves(left.join('\n')));
      expect((summary.unrouted as string[]).length).toBeGreaterThan(0);
      expect(summary.design_ok).toBe(false);
      expect((summary.changes as { tracks_removed: number }).tracks_removed).toBeGreaterThan(0);
      // The two measurements agree on what is open, which is what the check confirms.
      expect(check?.status, check?.detail).toBe('passed');
    }, 600_000);

    it('fails a track run into copper of another net', async () => {
      const lines = original.split('\n');
      const at = lines.findIndex((l) => l.startsWith('  (segment '));
      const net = /\(net (\d+)\)/.exec(lines[at]!)![1];
      // A second track of another net exactly over the first.
      const other = net === '1' ? '2' : '1';
      lines.splice(at, 0, lines[at]!.replace(`(net ${net})`, `(net ${other})`));
      const { summary, check } = await recheck(lines.join('\n'));
      expect(summary.drc_violations as number).toBeGreaterThan(0);
      expect(summary.design_ok).toBe(false);
      expect(check?.status).toBe('failed');
      expect(check?.detail).toMatch(/clearance|violation/i);
    }, 600_000);

    it('fails a pad moved to another net, and a copper zone it cannot judge', async () => {
      const moved = original.replace(/\(net (\d+) "([^"]+)"\)\)/, (_, __, name: string) =>
        name === 'GND' ? '(net 1 "OTHER"))' : '(net 1 "GND"))',
      );
      const a = await recheck(moved);
      expect((a.summary.pads_with_changed_net as string[]).length).toBeGreaterThan(0);
      expect(a.summary.design_ok).toBe(false);
      expect(a.check?.status).toBe('failed');
      const zoned = original.replace(/\)\s*$/, '  (zone (net 1) (layer "F.Cu"))\n)\n');
      const b = await recheck(zoned);
      expect(b.summary.unsupported_items).toEqual(['1 zone item(s)']);
      expect(b.summary.design_ok).toBe(false);
      expect(b.check?.status).toBe('failed');
    }, 600_000);

    it('reads a file KiCad 8 really saved, and finds a net deleted from it', async () => {
      const saved = await readFile(
        new URL('./fixtures/board-saved-by-kicad8.kicad_pcb', import.meta.url),
        'utf8',
      );
      expect(saved).toContain('(generator "pcbnew")');
      original = saved;
      const clean = await recheck(saved);
      expect(clean.sim?.status, clean.sim?.detail).toBe('done');
      expect(clean.summary.design_ok).toBe(true);
      expect(clean.check?.status, clean.check?.detail).toBe('passed');
      const segment = /\(segment\s[\s\S]*?\(net (\d+)\)[\s\S]*?\n\t\)\n/g;
      const net = segment.exec(saved)?.[1];
      const cut = saved.replace(segment, (m: string, n: string) => (n === net ? '' : m));
      const broken = await recheck(cut);
      expect((broken.summary.unrouted as string[]).length).toBeGreaterThan(0);
      expect(broken.summary.design_ok).toBe(false);
    }, 600_000);

    it('refuses a file that is not a board', async () => {
      const { sim } = await recheck('(not_a_board (version 1))');
      expect(sim?.status).toBe('failed');
    }, 600_000);
  });

  it('gives a part of the bot own a body, pins and a pin-1 mark in 3D', async () => {
    const { sim, detail } = await design({
      board: { width_mm: 40, height_mm: 30 },
      parts: [
        {
          ref: 'J1',
          footprint: 'CUSTOM',
          value: 'sensor',
          at: [12, 15],
          pads: [
            { num: 1, x: -2, y: 0, w: 1.6, h: 1.6, drill: 0.9 },
            { num: 2, x: 2, y: 0, w: 1.6, h: 1.6, drill: 0.9 },
          ],
        },
        {
          ref: 'U1',
          footprint: 'CUSTOM',
          at: [28, 15],
          pads: [
            { num: 1, x: -2, y: 0, w: 1, h: 0.6 },
            { num: 2, x: 2, y: 0, w: 1, h: 0.6 },
          ],
        },
      ],
      nets: [
        { name: 'A', pins: ['J1.1', 'U1.1'] },
        { name: 'B', pins: ['J1.2', 'U1.2'] },
      ],
    });
    expect(sim?.status, sim?.detail).toBe('done');
    const files = await runtime.files.forStep(detail.id, 'simulate');
    const models = files.filter((f) => /^model_custom_.*\.wrl$/.test(f.name));
    expect(models).toHaveLength(2);
    const scene = JSON.parse(
      await readFile(runtime.files.filePath(files.find((f) => f.name === 'scene.json')!), 'utf8'),
    ) as { parts: { ref: string; bodies: { col: string; m: number; c: number[] }[] }[] };
    const j1 = scene.parts.find((p) => p.ref === 'J1')!;
    // Body, top, two gold pins through the board, pin-1 mark.
    expect(j1.bodies.filter((b) => b.col === '#d9b24c')).toHaveLength(2);
    expect(j1.bodies.some((b) => (b.c[2] ?? 0) < 0)).toBe(true);
    const u1 = scene.parts.find((p) => p.ref === 'U1')!;
    expect(u1.bodies.filter((b) => b.col === '#c9ccd2' && b.m === 1)).toHaveLength(2);
  }, 600_000);
});

/**
 * KiCad itself as a third opinion: the exported board is loaded by kicad-cli (the official
 * KiCad 8 image) and its design-rule check must report no errors and nothing unconnected.
 * Opt-in: RUN_KICAD_TESTS=1 (needs Docker and `docker pull kicad/kicad:8.0`, about 1.6 GB).
 */
describe.skipIf(process.env.RUN_KICAD_TESTS !== '1')('pcb design in KiCad (docker)', () => {
  let runtime: Runtime;
  let presets: LabPresets;
  let pool: pg.Pool;
  let dir: string;
  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-kicad-'));
    runtime = await createRuntime(
      loadConfig({ AUTH: 'off', DATABASE_URL: TEST_DATABASE_URL, ARTIFACT_DIR: dir }),
      { planner: new RuleBasedPlanner(), analyst: null, chatModel: null, log: { error: () => {} } },
    );
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    presets = new LabPresets(pool);
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('loads the exported board and finds no errors and no unconnected nets', async () => {
    const task = await runtime.tasks.create('Design a board', { start: false });
    await presets.set(task.id, 'pcb_design', {});
    await runtime.tasks.start(task.id);
    await runtime.tasks.settled(task.id);
    await runtime.tasks.decide(task.id, { approved: true, by: 'user' });
    await runtime.tasks.settled(task.id);
    const files = await runtime.files.forStep(task.id, 'simulate');
    const work = await mkdtemp(join(tmpdir(), 'reality-kicad-work-'));
    try {
      for (const f of files) await copyFile(runtime.files.filePath(f), join(work, f.name));
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${work}:/work`,
          '-e',
          'HOME=/tmp',
          '--user',
          '0',
          '--entrypoint',
          'kicad-cli',
          'kicad/kicad:8.0',
          'pcb',
          'drc',
          '--format',
          'json',
          '--severity-all',
          '--units',
          'mm',
          '--output',
          '/work/drc.json',
          '/work/board.kicad_pcb',
        ],
        { stdio: 'pipe' },
      );
      const report = JSON.parse(await readFile(join(work, 'drc.json'), 'utf8')) as {
        violations: { severity: string; type: string }[];
        unconnected_items: unknown[];
      };
      expect(report.violations.filter((v) => v.severity === 'error')).toEqual([]);
      expect(report.unconnected_items).toEqual([]);
      // The board as it stood after placement: KiCad shows every connection still to make.
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${work}:/work`,
          '-e',
          'HOME=/tmp',
          '--user',
          '0',
          '--entrypoint',
          'kicad-cli',
          'kicad/kicad:8.0',
          'pcb',
          'drc',
          '--format',
          'json',
          '--output',
          '/work/drc-placed.json',
          '/work/stage_1_placed.kicad_pcb',
        ],
        { stdio: 'pipe' },
      );
      const placed = JSON.parse(await readFile(join(work, 'drc-placed.json'), 'utf8')) as {
        unconnected_items: unknown[];
      };
      expect(placed.unconnected_items.length).toBeGreaterThan(5);
      // KiCad loads our 3D models and scales them right: the pin of a header is 0.64 mm square.
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${work}:/work`,
          '-e',
          'HOME=/tmp',
          '--user',
          '0',
          '--entrypoint',
          'kicad-cli',
          'kicad/kicad:8.0',
          'pcb',
          'export',
          'vrml',
          '--units',
          'mm',
          '-f',
          '-D',
          'KIPRJMOD=/work',
          '-o',
          '/work/export.wrl',
          '/work/board.kicad_pcb',
        ],
        { stdio: 'pipe' },
      );
      const vrml = await readFile(join(work, 'export.wrl'), 'utf8');
      expect(vrml).toContain('diffuseColor 0.078000002'); // the black plastic of our chips
      expect(vrml).toMatch(/scale 0.3937008 0.3937008 0.3937008/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 600_000);
});

describe('a board on the bot desktop', () => {
  const board = [
    '(kicad_pcb',
    '  (footprint "R0603" (layer "F.Cu") (at 10 10 90)',
    '    (fp_rect (start -1.5 -1) (end 1.5 1) (layer "F.CrtYd"))',
    '  )',
    '  (segment (start 1 1) (end 2 2) (width 0.25) (layer "F.Cu") (net 1))',
    '  (via (at 2 2) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))',
    '  (gr_line (start 50 0) (end 50 35) (layer "Edge.Cuts"))',
    ')',
  ].join('\n');

  it('starts with the parts beside the board and no copper', () => {
    const start = partsBeside(board);
    expect(start).not.toMatch(/\(segment |\(via /);
    const at = /\(at (\S+) (\S+) 90\)/.exec(start);
    expect(Number(at?.[1])).toBeGreaterThan(50);
    expect(start).toContain('(layer "Cmts.User")');
    expect(start.trim().endsWith(')')).toBe(true);
  });
});
