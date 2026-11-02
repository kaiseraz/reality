/**
 * Runs each built-in lab engine once in the sandbox image and prints its summary.
 * Usage: npx tsx eval/lab-smoke.ts [engine]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLabCode, getLabEngine } from '../src/lab/engines.ts';

const CASES: [string, Record<string, unknown>][] = [
  ['thin_film', { bragg: { pairs: 8 } }],
  ['ring_resonator', {}],
  ['stack_tolerance', { bragg: { pairs: 6 }, runs: 50 }],
  ['quantum_circuit', { preset: 'ghz', qubits: 3 }],
  ['fcc_crystal', { element: 'Cu' }],
];

for (const [name, params] of CASES.filter(([n]) => !process.argv[2] || n === process.argv[2])) {
  const engine = getLabEngine(name);
  if (!engine) throw new Error(name);
  const built = buildLabCode(engine, params);
  if ('error' in built) throw new Error(built.error);
  const out = mkdtempSync(join(tmpdir(), 'lab-'));
  try {
    const stdout = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '-v',
        `${out}:/output`,
        '--entrypoint',
        'python',
        'reality-sandbox-python:dev',
        '-',
      ],
      { input: built.code, encoding: 'utf8' },
    );
    console.log(`== ${name}: ${stdout.trim()}`);
    console.log(readFileSync(join(out, 'summary.json'), 'utf8'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
