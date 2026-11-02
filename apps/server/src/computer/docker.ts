import { spawn } from 'node:child_process';

/** Runs the Docker CLI without a shell: arguments are passed verbatim. */
export function docker(
  bin: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const cap = (s: string, c: Buffer) => (s.length > 200_000 ? s : s + c.toString('utf8'));
    child.stdout.on('data', (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr.on('data', (c: Buffer) => (stderr = cap(stderr, c)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      // A child that will not close must not keep the caller waiting.
      setTimeout(() => resolve({ code: null, stdout, stderr }), 5000).unref();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}
