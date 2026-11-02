// Starts the API server and the web UI together: `npm run dev`.
import { spawn } from 'node:child_process';

// Run npm's own CLI with this Node binary: no shell, so nothing is re-parsed.
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('Run this via `npm run dev`.');
  process.exit(1);
}
const children = ['dev:server', 'dev:web'].map((script) =>
  spawn(process.execPath, [npmCli, 'run', script], { stdio: 'inherit' }),
);
const stop = () => children.forEach((c) => c.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
children.forEach((c) => c.on('exit', (code) => code && process.exit(code)));
