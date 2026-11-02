import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Limits {
  cpus: number;
  memoryMb: number;
  pids: number;
  timeoutMs: number;
  /** Combined size cap for files written to /output. */
  maxOutputBytes: number;
  maxOutputFiles: number;
  /** Size of the writable in-memory /tmp. */
  tmpMb: number;
}

export const DEFAULT_LIMITS: Limits = {
  cpus: 1,
  memoryMb: 512,
  pids: 64,
  timeoutMs: 60_000,
  maxOutputBytes: 50 * 1024 * 1024,
  maxOutputFiles: 20,
  tmpMb: 64,
};

const MAX_STREAM_BYTES = 256 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,149}$/;

export interface RunInput {
  /** File name inside /input. */
  name: string;
  hostPath: string;
}

/**
 * A host directory (bind mount) or a Docker volume. Volumes live inside Docker's VM,
 * which on Windows/macOS is far faster for many small files (capability layers).
 */
export type Mount =
  { hostPath: string; containerPath: string } | { volume: string; containerPath: string };

const SAFE_VOLUME = /^reality-[a-z0-9][a-z0-9_.-]{0,100}$/;

const SAFE_RUNTIME = /^[a-z][a-z0-9._-]{0,63}$/;

function mountArg(m: Mount, readonly: boolean): string {
  const ro = readonly ? ',readonly' : '';
  if ('volume' in m) {
    if (!SAFE_VOLUME.test(m.volume)) throw new Error(`Unsafe volume name: ${m.volume}`);
    return `type=volume,source=${m.volume},target=${m.containerPath}${ro}`;
  }
  return `type=bind,source=${m.hostPath},target=${m.containerPath}${ro}`;
}

export interface RunRequest {
  code: string;
  inputs?: RunInput[];
  /** Additional read-only mounts (e.g. tested capability layers in M5). */
  readOnlyMounts?: Mount[];
  /**
   * Writable bind mounts. Only the trusted capability installer uses these (to build a
   * capability layer); analysis code never gets one.
   */
  writableMounts?: Mount[];
  /**
   * 'none' (default) or 'egress'. Egress is used only by the capability engine to
   * download wheels with pip — no package code runs during that step.
   */
  network?: 'none' | 'egress';
  /** Extra environment for the container. Never derived from the host environment. */
  env?: Record<string, string>;
  /**
   * Names of variables the container takes from the docker client's own environment, so a
   * secret's value never appears on a command line or in a process list.
   */
  passEnv?: string[];
  /** Another sandbox image than the default (Node servers). Same lockdown. */
  image?: string;
  /** Join this internal Docker network instead of having none. Its only way out is the gateway. */
  networkName?: string;
  /** Start under this container name (a tool server's name is on the gateway's list beforehand). */
  name?: string;
  limits?: Partial<Limits>;
}

export interface OutputFile {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface RunResult {
  runId: string;
  image: string;
  exitCode: number | null;
  status: 'succeeded' | 'failed' | 'timed_out' | 'killed' | 'output_rejected';
  stdout: string;
  stderr: string;
  durationMs: number;
  outputs: OutputFile[];
  /** Why outputs were rejected, if they were. */
  outputErrors: string[];
  /** Host directory holding outputs; call cleanup() when done with them. */
  workDir: string;
  cleanup: () => Promise<void>;
}

export class SandboxUnavailableError extends Error {}

/** Docker may not be on PATH for processes started before it was installed. */
export function resolveDockerBin(configured?: string): string {
  if (configured) return configured;
  const windowsDefault = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
  if (process.platform === 'win32' && existsSync(windowsDefault)) return windowsDefault;
  return 'docker';
}

function exec(
  bin: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    // No shell: arguments are passed verbatim, nothing is interpreted.
    const child = spawn(bin, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (current: string, chunk: Buffer) => {
      if (current.length >= MAX_STREAM_BYTES) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString('utf8');
      if (next.length > MAX_STREAM_BYTES) truncated = true;
      return next.slice(0, MAX_STREAM_BYTES);
    };
    child.stdout.on('data', (c: Buffer) => (stdout = append(stdout, c)));
    child.stderr.on('data', (c: Buffer) => (stderr = append(stderr, c)));
    // A stalled Docker must not stall everything behind it: nothing here waits without an end.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      setTimeout(
        () =>
          resolve({ code: null, stdout, stderr: `${stderr}\nDocker did not answer.`, truncated }),
        5000,
      ).unref();
    }, opts.timeoutMs ?? 120_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, truncated });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

/**
 * Runs untrusted Python in a locked-down container (see ADR 0004):
 * no network, read-only root filesystem, non-root user, all capabilities dropped,
 * no privilege escalation, CPU/memory/PID/time limits, and an empty environment.
 * Inputs are copied into a per-run directory mounted read-only; only /output and a
 * small /tmp are writable. Code arrives on stdin, never as a shell string.
 */
export class DockerRunner {
  readonly bin: string;

  constructor(
    readonly image: string,
    opts: { dockerBin?: string; workRoot?: string; runtime?: string } = {},
  ) {
    this.bin = resolveDockerBin(opts.dockerBin);
    this.workRoot = opts.workRoot ?? join(tmpdir(), 'reality-runs');
    if (opts.runtime !== undefined && !SAFE_RUNTIME.test(opts.runtime)) {
      throw new Error(`Unsafe container runtime name: ${opts.runtime}`);
    }
    this.runtime = opts.runtime;
  }

  private readonly workRoot: string;
  /** OCI runtime for sandboxes, e.g. "runsc" (gVisor): a user-space kernel between code and host. */
  readonly runtime: string | undefined;

  /** Throws SandboxUnavailableError if Docker or the image is missing. */
  async check(): Promise<void> {
    let result;
    try {
      result = await exec(this.bin, ['image', 'inspect', '--format', '{{.Id}}', this.image]);
    } catch (err) {
      throw new SandboxUnavailableError(`Docker is not available: ${(err as Error).message}`);
    }
    if (result.code !== 0) {
      throw new SandboxUnavailableError(
        `Sandbox image ${this.image} not found or Docker not running. Run: npm run sandbox:build`,
      );
    }
    if (this.runtime) {
      // A configured runtime that is missing must stop runs, not silently weaken isolation.
      const info = await exec(this.bin, ['info', '--format', '{{json .Runtimes}}']);
      const runtimes = info.code === 0 ? Object.keys(JSON.parse(info.stdout || '{}')) : [];
      if (!runtimes.includes(this.runtime)) {
        throw new SandboxUnavailableError(
          `Container runtime "${this.runtime}" is not installed in Docker (available: ${runtimes.join(', ') || 'none'}).`,
        );
      }
    }
  }

  /** Whether an image is there (the Node image is built on purpose, like the others). */
  async imageExists(name: string): Promise<boolean> {
    try {
      await exec(this.bin, ['image', 'inspect', name]);
      return true;
    } catch {
      return false;
    }
  }

  async volumeExists(name: string): Promise<boolean> {
    if (!SAFE_VOLUME.test(name)) return false;
    const r = await exec(this.bin, ['volume', 'inspect', '--format', '{{.Name}}', name]);
    return r.code === 0;
  }

  async removeVolume(name: string): Promise<void> {
    if (!SAFE_VOLUME.test(name)) throw new Error(`Unsafe volume name: ${name}`);
    await exec(this.bin, ['volume', 'rm', '-f', name]);
  }

  /**
   * A long-lived, interactive sandbox process (e.g. an MCP server speaking over stdio).
   * Same isolation as run(); the caller spawns `command args` and talks to its stdio.
   * `argv` is the program inside the container; code never passes through a shell.
   */
  async session(req: Omit<RunRequest, 'code'> & { argv: string[] }) {
    const prepared = await this.prepare({ ...req, code: '' });
    return {
      command: this.bin,
      args: [...prepared.args, ...req.argv],
      name: prepared.name,
      outputDir: prepared.outputDir,
      kill: () =>
        exec(this.bin, ['kill', prepared.name]).then(
          () => undefined,
          () => undefined,
        ),
      cleanup: () => rm(prepared.workDir, { recursive: true, force: true }),
    };
  }

  async run(req: RunRequest): Promise<RunResult> {
    const limits = { ...DEFAULT_LIMITS, ...req.limits };
    const { runId, workDir, outputDir, name, args: prefix } = await this.prepare(req);
    const args = [
      ...prefix,
      'python',
      '-I', // isolated mode: ignore PYTHON* env vars and the user site directory
      '-',
    ];
    return this.execute(req, limits, { runId, workDir, outputDir, name, args });
  }

  /** Per-run directories, copied inputs, and the locked-down `docker run` arguments. */
  private async prepare(req: RunRequest) {
    const limits = { ...DEFAULT_LIMITS, ...req.limits };
    const runId = randomUUID();
    const workDir = join(this.workRoot, runId);
    const inputDir = join(workDir, 'input');
    const outputDir = join(workDir, 'output');
    await mkdir(inputDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    // The container runs as uid 10001; on Linux hosts the bind mount must be writable by it.
    await chmod(outputDir, 0o777);

    for (const input of req.inputs ?? []) {
      if (!SAFE_NAME.test(input.name)) throw new Error(`Unsafe input name: ${input.name}`);
      await copyFile(input.hostPath, join(inputDir, input.name));
    }

    const name = req.name ?? `reality-run-${runId}`;
    const args = [
      'run',
      '--rm',
      '-i',
      '--name',
      name,
      ...(this.runtime ? ['--runtime', this.runtime] : []),
      '--network',
      req.networkName ?? (req.network === 'egress' ? 'bridge' : 'none'),
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '10001:10001',
      '--pids-limit',
      String(limits.pids),
      '--memory',
      `${limits.memoryMb}m`,
      '--memory-swap',
      `${limits.memoryMb}m`,
      '--cpus',
      String(limits.cpus),
      '--tmpfs',
      `/tmp:rw,nosuid,nodev,size=${limits.tmpMb}m`,
      '--mount',
      `type=bind,source=${inputDir},target=/input,readonly`,
      '--mount',
      `type=bind,source=${outputDir},target=/output`,
      ...(req.writableMounts ?? []).flatMap((m) => ['--mount', mountArg(m, false)]),
      ...(req.readOnlyMounts ?? []).flatMap((m) => ['--mount', mountArg(m, true)]),
      '--workdir',
      '/tmp',
      // Explicit, minimal environment; nothing from the host is inherited.
      '--env',
      'HOME=/tmp',
      '--env',
      'MPLCONFIGDIR=/tmp',
      ...Object.entries(req.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
      ...(req.passEnv ?? []).flatMap((k) => ['--env', k]),
      req.image ?? this.image,
    ];
    return { runId, workDir, outputDir, name, args };
  }

  private async execute(
    req: RunRequest,
    limits: Limits,
    p: { runId: string; workDir: string; outputDir: string; name: string; args: string[] },
  ): Promise<RunResult> {
    const { runId, workDir, outputDir, name, args } = p;
    const started = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void exec(this.bin, ['kill', name]).catch(() => undefined);
    }, limits.timeoutMs);
    let result;
    try {
      // The container is killed at its limit; this is for a Docker that no longer answers at all.
      result = await exec(this.bin, args, {
        stdin: req.code,
        timeoutMs: limits.timeoutMs + 120_000,
      });
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Date.now() - started;

    const { outputs, errors } = await this.collectOutputs(outputDir, limits);
    const status: RunResult['status'] = timedOut
      ? 'timed_out'
      : result.code === 137
        ? 'killed' // SIGKILL: memory limit (OOM) or external kill
        : result.code !== 0
          ? 'failed'
          : errors.length > 0
            ? 'output_rejected'
            : 'succeeded';

    return {
      runId,
      image: this.image,
      exitCode: result.code,
      status,
      stdout: result.stdout,
      stderr: result.stderr + (result.truncated ? '\n[output truncated]' : ''),
      durationMs,
      outputs: errors.length > 0 ? [] : outputs,
      outputErrors: errors,
      workDir,
      cleanup: () => rm(workDir, { recursive: true, force: true }),
    };
  }

  /** Accepts only regular files with safe names, within count and size limits. */
  private async collectOutputs(dir: string, limits: Limits) {
    const outputs: OutputFile[] = [];
    const errors: string[] = [];
    let total = 0;
    const entries = await readdir(dir);
    if (entries.length > limits.maxOutputFiles) {
      errors.push(`Too many output files (${entries.length} > ${limits.maxOutputFiles}).`);
      return { outputs, errors };
    }
    for (const entry of entries.sort()) {
      const path = join(dir, entry);
      const info = await lstat(path);
      if (!info.isFile()) {
        errors.push(`Output "${entry}" is not a regular file.`);
        continue;
      }
      if (!SAFE_NAME.test(entry)) {
        errors.push(`Output name "${entry}" is not allowed.`);
        continue;
      }
      total += info.size;
      outputs.push({ name: entry, path, sizeBytes: info.size });
    }
    if (total > limits.maxOutputBytes) {
      errors.push(`Outputs exceed ${limits.maxOutputBytes} bytes.`);
    }
    return { outputs, errors };
  }
}
