/**
 * Builds the parametric turbofan once in the sandbox image with the dev OCP volume.
 * Usage: npx tsx eval/cad-smoke.ts   (needs the docker volume reality-dev-ocp)
 */
import { execFileSync } from 'node:child_process';
import { CAD_EPILOGUE, CAD_HELPERS, TURBOFAN } from '../src/lab/cad.ts';
import { labPrelude } from '../src/lab/engines.ts';

const params = {
  fan_diameter_mm: 1600,
  fan_blades: 22,
  ogv_vanes: 40,
  booster_stages: 3,
  hpc_stages: 9,
  hpt_stages: 2,
  lpt_stages: 4,
  injectors: 20,
  mesh_mm: 2,
};
const code =
  labPrelude(params, ['/caps/ocp']) +
  CAD_HELPERS +
  TURBOFAN +
  CAD_EPILOGUE +
  '\nimport os\nprint(sorted((f, os.path.getsize("/output/" + f)) for f in os.listdir("/output")))\nprint(open("/output/summary.json").read())\n';
const started = Date.now();
const out = execFileSync(
  'docker',
  [
    'run',
    '--rm',
    '-i',
    '--network',
    'none',
    '--tmpfs',
    '/output:size=512m,uid=10001',
    '-v',
    'reality-dev-ocp:/caps/ocp:ro',
    '--entrypoint',
    'python',
    'reality-sandbox-python:dev',
    '-',
  ],
  { input: code, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
console.log(out.trim());
console.log(`took ${((Date.now() - started) / 1000).toFixed(1)} s`);
