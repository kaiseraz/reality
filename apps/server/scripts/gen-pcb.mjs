// Embeds the PCB engine's Python (src/lab/py) into src/lab/pcb.ts. Run: npm run gen:pcb --workspace @reality/server
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'src', 'lab', 'py');
const repo = path.join(here, '..', '..', '..');
const lit = (f) =>
  '`' +
  fs
    .readFileSync(`${dir}/${f}`, 'utf8')
    .replace(/\r/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${') +
  '`';
const spec = JSON.parse(fs.readFileSync(`${dir}/example.json`, 'utf8'));
const example = JSON.stringify({ parts: spec.parts, nets: spec.nets, board: spec.board });

const out = `import { z } from 'zod';
import type { LabEngine } from './engines.ts';
import type { Check } from '../verification/checks.ts';

/**
 * Printed circuit boards: a bot gives parts (footprints), nets and rules; the lab places the
 * parts (simulated annealing on wire length, edges respected), routes both copper layers
 * (A* on a grid, 45-degree tracks, vias, wide power nets that neck down at tight pads) and
 * writes a KiCad 8 board file, Gerber copper and outline layers and an Excellon drill file.
 * An independent check re-measures every clearance with signed distance functions, rebuilds
 * the connectivity and compares the exported board file with the verified table.
 */

const PCB = ${lit('pcb.py')};
const PCB_OUT = ${lit('pcb_out.py')};
const PCB_SCENE = ${lit('pcb_scene.py')};
const PCB_CHECK = ${lit('pcb_check.py')};
const PCB_DRC = ${lit('pcb_drc.py')};
const PCB_RECHECK = ${lit('pcb_recheck.py')};

const mm = z.number().min(-1000).max(1000);
const ref = z.string().min(1).max(12).regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const part = z
  .object({
    ref,
    footprint: z.string().min(2).max(24),
    value: z.string().max(40).optional(),
    at: z.tuple([mm, mm]).optional(),
    rot: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
    rot_locked: z.boolean().optional(),
    edge: z.enum(['left', 'right', 'top', 'bottom']).optional(),
    pads: z
      .array(
        z
          .object({
            num: z.union([z.string().max(8), z.number()]),
            shape: z.enum(['rect', 'roundrect', 'circle']).default('rect'),
            x: mm,
            y: mm,
            w: z.number().positive().max(50),
            h: z.number().positive().max(50),
            drill: z.number().min(0).max(10).optional(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
  })
  .strict();
const net = z
  .object({
    name: z.string().min(1).max(30).regex(/^[A-Za-z0-9_+.-]+$/),
    pins: z.array(z.string().min(3).max(24)).min(1).max(300),
    class: z.enum(['signal', 'power']).optional(),
    width_mm: z.number().min(0.1).max(5).optional(),
  })
  .strict();
const EXAMPLE = ${example};

export const PCB_ENGINE: LabEngine = {
  name: 'pcb_design',
  domain: 'electronics',
  title: 'Printed circuit board',
  description:
    'Designs a two-layer printed circuit board: places the parts, routes the nets, and writes a KiCad 8 board file (board.kicad_pcb), Gerber copper and outline layers, an Excellon drill file and a bill of materials. Give board {width_mm, height_mm}, parts [{ref, footprint, value, at, rot, edge}] and nets [{name, pins:["U1.8","R1.1"], class:"power"|"signal", width_mm}]. Footprints: R/C/L/LED/D with 0402, 0603, 0805 or 1206 (e.g. R0603), SOIC8/14/16, TSSOP14/16/20, SOT23, SOT23_5, DIP8/14/16/20/28, HEADER<n> or HEADER<rows>x<n> (2.54 mm), HOLE<diameter> (mounting hole), TESTPOINT, or CUSTOM with pads [{num, shape, x, y, w, h, drill}]. Pad numbers follow the usual datasheet order (DIP and SOIC: down the left side, up the right). Parts without "at" are placed automatically; "edge" pins a part to a board edge (connectors). Rules: clearance_mm, track_mm, power_track_mm, via_dia_mm, via_drill_mm, edge_clearance_mm, grid_mm. Reports routed nets, track length, vias and design-rule violations. Not covered: pours and planes, impedance control, parts on the bottom side, schematics.',
  params: z
    .object({
      board: z
        .object({ width_mm: z.number().min(5).max(200), height_mm: z.number().min(5).max(200) })
        .strict()
        .default(EXAMPLE.board),
      rules: z
        .object({
          clearance_mm: z.number().min(0.05).max(2).default(0.2),
          track_mm: z.number().min(0.05).max(2).default(0.25),
          power_track_mm: z.number().min(0.05).max(5).default(0.4),
          via_dia_mm: z.number().min(0.2).max(3).default(0.6),
          via_drill_mm: z.number().min(0.1).max(2).default(0.3),
          edge_clearance_mm: z.number().min(0).max(5).default(0.3),
          grid_mm: z.number().min(0.05).max(1).default(0.2),
          via_cost: z.number().min(1).max(100).default(12),
        })
        .strict()
        .default({
          clearance_mm: 0.2,
          track_mm: 0.25,
          power_track_mm: 0.4,
          via_dia_mm: 0.6,
          via_drill_mm: 0.3,
          edge_clearance_mm: 0.3,
          grid_mm: 0.2,
          via_cost: 12,
        }),
      parts: z.array(part).min(1).max(150).default(EXAMPLE.parts as never),
      nets: z.array(net).min(1).max(300).default(EXAMPLE.nets as never),
      seed: z.number().int().min(0).max(1e9).default(1),
      placement_iterations: z.number().int().min(1000).max(200_000).default(30_000),
      spread: z.number().min(0).max(20).default(6),
      routing_seconds: z.number().min(5).max(480).default(240),
    })
    .strict(),
  requires: [],
  check: 'pcb_recomputed',
  checkDescription:
    'Every clearance is re-measured with signed distance functions (not the router grid), connectivity is rebuilt per net from touching copper, widths, vias, annular rings, board edge and part overlaps are re-judged, and the exported KiCad board file is parsed and compared with the verified table',
  body: PCB + PCB_SCENE + PCB_DRC + PCB_OUT,
  limits: {
    timeoutMs: 600_000,
    memoryMb: 1536,
    maxOutputBytes: 60 * 1024 * 1024,
    maxOutputFiles: 40,
    tmpMb: 128,
  },
};

/** The board again after someone changed it by hand in KiCad: the same independent check. */
export const PCB_RECHECK_ENGINE: LabEngine = {
  name: 'pcb_recheck',
  domain: 'electronics',
  title: 'Board re-checked after a hand edit',
  description:
    'Reads a KiCad board file as it was saved after a hand edit and measures it again: clearances, board edge, connectivity per net, and against the original design whether any pad moved to another net. The tool recheck_board fills this in from the bot computer; use that tool. Not covered: copper zones and arcs (reported, and the board does not pass).',
  params: z
    .object({
      board_kicad: z.string().min(10).max(4_000_000),
      original_kicad: z.string().max(4_000_000).optional(),
      rules: z
        .object({
          clearance_mm: z.number().min(0.05).max(2).default(0.2),
          track_mm: z.number().min(0.05).max(2).default(0.25),
          via_dia_mm: z.number().min(0.2).max(3).default(0.6),
          via_drill_mm: z.number().min(0.1).max(2).default(0.3),
          edge_clearance_mm: z.number().min(0).max(5).default(0.3),
        })
        .strict()
        .default({
          clearance_mm: 0.2,
          track_mm: 0.25,
          via_dia_mm: 0.6,
          via_drill_mm: 0.3,
          edge_clearance_mm: 0.3,
        }),
    })
    .strict(),
  requires: [],
  check: 'pcb_recomputed',
  checkDescription:
    'Every clearance is re-measured with signed distance functions, connectivity is rebuilt per net from touching copper, widths, vias, annular rings and the board edge are re-judged, the saved KiCad file is compared with the table, and every pad is compared with the original design',
  body: 'import re\\n' + PCB_DRC + PCB_RECHECK,
  limits: { timeoutMs: 300_000, memoryMb: 1024, maxOutputBytes: 30 * 1024 * 1024, tmpMb: 64 },
};

export const PCB_CHECK_DEF: Check = {
  name: 'pcb_recomputed',
  description:
    'Re-measures every copper clearance with signed distance functions, rebuilds connectivity from touching copper, re-judges widths, vias, annular rings and the board edge, and compares the exported KiCad board file with the verified table.',
  params: z.object({ step: z.string() }).passthrough() as unknown as z.ZodType<
    Record<string, unknown>
  >,
  needsResult: true,
  needsData: false,
  needsFiles: true,
  body: PCB_CHECK,
};
`;
fs.writeFileSync(`${repo}/apps/server/src/lab/pcb.ts`, out);
