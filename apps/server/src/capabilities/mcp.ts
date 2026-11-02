import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { DockerRunner, RunInput } from '../sandbox/docker-runner.ts';

/** How an MCP server is started or reached. Reviewed in the catalog, or derived from its files. */
export interface McpLaunch {
  /** Python entry point "module:function" (the package's console script). Empty for the others. */
  entry: string;
  /** Command-line arguments. */
  args: string[];
  /** The only tools Reality will call, whatever else the server offers. */
  allowedTools: string[];
  /** How it runs. Default: a Python package in the sandbox. */
  runtime?: 'python' | 'node' | 'remote';
  /** Node: the script to start, as a path inside the capability layer. */
  script?: string;
  /** Hosted: where it is. Nothing of it runs here; what a bot sends goes there. */
  url?: string;
  remoteType?: 'streamable-http' | 'sse';
  /** Domains a person allowed it to reach. Without any it has no network at all. */
  domains?: string[];
  /** Secrets it takes: as an environment variable, or as an HTTP header of a hosted server. */
  secrets?: { name: string; description?: string; header?: string; prefix?: string }[];
}

export interface McpToolInfo {
  name: string;
  /** Untrusted text from the server: shown to users as data, never used as instructions. */
  description: string;
}

export interface McpSession {
  tools: McpToolInfo[];
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string; blobs?: McpBlob[] }>;
  /** On this machine, what the server sees as /output. A hosted server has none. */
  outputDir?: string;
}

/** A file a tool returned in its answer rather than wrote: an image, an embedded resource. */
export interface McpBlob {
  name: string;
  data: Buffer;
}

export class McpPolicyError extends Error {}

/** The marker a found MCP server carries until its start-up is read from its own files. */
export const DYNAMIC_ENTRY = 'resolved:at_inspection';

const normalizePkg = (n: string) =>
  n
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-');

/**
 * How to start an MCP server nobody reviewed, read from the console scripts its own wheel
 * declares ("name = module:function"): the script named like the package, else one that says
 * mcp or server, else the first. Returns null when there is none that fits the one way Reality
 * starts a server (a Python entry point). `allowedTools` stays empty: the tools are listed by the
 * server itself after it is installed, and only those can be called.
 */
export function launchFromScripts(
  pkg: string,
  scripts: readonly string[],
  args: readonly string[],
): McpLaunch | null {
  const parsed = scripts.flatMap((line) => {
    const m = /^\s*([\w.-]+)\s*=\s*([\w.]+):(\w+)/.exec(line);
    return m ? [{ name: m[1] as string, entry: `${m[2]}:${m[3]}` }] : [];
  });
  const pick =
    parsed.find((s) => normalizePkg(s.name) === normalizePkg(pkg)) ??
    parsed.find((s) => /mcp|server/i.test(s.name)) ??
    parsed[0];
  if (!pick) return null;
  return { entry: pick.entry, args: [...args], allowedTools: [] };
}

/**
 * The script a Node package starts with, from its package.json `bin`: a plain relative path, or
 * the entry named like the package, else one that says mcp or server, else the first.
 */
export function scriptFromBin(pkg: string, bin: unknown): string | null {
  const short = pkg.split('/').pop() ?? pkg;
  let path: unknown;
  if (typeof bin === 'string') path = bin;
  else if (bin && typeof bin === 'object') {
    const entries = Object.entries(bin as Record<string, unknown>);
    path = (entries.find(([k]) => k === short) ??
      entries.find(([k]) => /mcp|server/i.test(k)) ??
      entries[0])?.[1];
  }
  if (typeof path !== 'string') return null;
  const clean = path.replace(/^\.\//, '');
  if (!/^[\w@./-]{1,200}$/.test(clean) || clean.startsWith('/') || clean.includes('..')) {
    return null;
  }
  return clean;
}

/** Whether an address is out on the internet, not this machine or a local network. */
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0, c = 0] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return false;
    if (/^(fc|fd|fe[89ab]|ff)/.test(v)) return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped?.[1] ? isPublicAddress(mapped[1]) : true;
  }
  return false;
}

/**
 * A hosted server's address must be https and lead out to the internet, checked each time it
 * is called, so a name that later points at this machine or a local network is refused.
 */
export async function assertPublicUrl(
  url: string,
  resolve: (host: string) => Promise<string[]> = async (host) =>
    (await lookup(host, { all: true })).map((a) => a.address),
): Promise<URL> {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new McpPolicyError('A hosted server must use https.');
  if (u.username || u.password) throw new McpPolicyError('A hosted URL cannot carry a login.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new McpPolicyError(`${host} does not lead to a public address.`);
  }
  return u;
}

/** Connects a client over a transport, lists the tools, runs `fn`, always closes. */
async function overTransport<T>(
  transport: Transport,
  launch: McpLaunch,
  capabilityId: string,
  describeFailure: () => string,
  fn: (session: McpSession) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: 'reality', version: '0.0.0' });
  try {
    try {
      await client.connect(transport, { timeout: 60_000 });
    } catch (err) {
      throw new Error(`MCP server did not start: ${(err as Error).message}\n${describeFailure()}`, {
        cause: err,
      });
    }
    const listed = await client.listTools(undefined, { timeout: 60_000 }).catch((err: unknown) => {
      throw new Error(`MCP tools/list failed: ${(err as Error).message}\n${describeFailure()}`, {
        cause: err,
      });
    });
    const tools = listed.tools.map((t) => ({ name: t.name, description: t.description ?? '' }));
    const session: McpSession = {
      tools,
      async call(name, args) {
        if (!launch.allowedTools.includes(name)) {
          throw new McpPolicyError(`Tool "${name}" is not approved for ${capabilityId}`);
        }
        if (!tools.some((t) => t.name === name)) {
          throw new McpPolicyError(`Server does not offer tool "${name}"`);
        }
        const result = await client.callTool({ name, arguments: args }, undefined, {
          timeout: 60_000,
        });
        const content = (result.content ?? []) as {
          type: string;
          text?: string;
          data?: string;
          mimeType?: string;
          resource?: { blob?: string; uri?: string; mimeType?: string };
        }[];
        const blobs: McpBlob[] = [];
        for (const [i, c] of content.entries()) {
          const b64 = c.type === 'resource' ? c.resource?.blob : c.data;
          if (!b64) continue;
          const type = (c.mimeType ?? c.resource?.mimeType ?? '').split('/').pop() ?? '';
          const named = c.resource?.uri?.split('/').pop();
          blobs.push({
            name: named || `${name}-${i + 1}.${/^[a-z0-9]{1,8}$/.test(type) ? type : 'bin'}`,
            data: Buffer.from(b64, 'base64'),
          });
        }
        return {
          isError: result.isError === true,
          text: content
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('\n'),
          ...(blobs.length ? { blobs } : {}),
        };
      },
    };
    return await fn(session);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** A way out for a server: the internal network it joins and the proxy it must use. */
export interface McpEgress {
  network: string;
  proxy: string;
}

/**
 * Starts an MCP server from a capability layer inside the sandbox (read-only root, non-root,
 * limits; no network unless `egress` gives it the gateway) and connects to it over stdio as an
 * MCP client. The session is torn down (container killed) when `fn` settles or the deadline
 * passes. Secrets go through the docker client's environment, never onto a command line.
 */
export async function withMcpSession<T>(
  runner: DockerRunner,
  opts: {
    capabilityId: string;
    /** The capability layer: a Docker volume (preferred) or a host directory. */
    layer: { volume: string } | { hostPath: string };
    launch: McpLaunch;
    inputs?: RunInput[];
    timeoutMs?: number;
    image?: string;
    egress?: McpEgress;
    /** The container's name, when the gateway was told it beforehand. */
    name?: string;
    secrets?: Record<string, string>;
  },
  fn: (session: McpSession) => Promise<T>,
): Promise<T> {
  const capPath = `/caps/${opts.capabilityId}`;
  let argv: string[];
  if (opts.launch.runtime === 'node') {
    const script = opts.launch.script ?? '';
    if (!/^[\w@./-]{1,300}$/.test(script) || script.includes('..')) {
      throw new McpPolicyError(`Invalid start script "${script}"`);
    }
    argv = ['node', `${capPath}/${script}`, ...opts.launch.args];
  } else {
    const [module, fnName] = opts.launch.entry.split(':');
    if (!module || !fnName || !/^[\w.]+$/.test(module) || !/^\w+$/.test(fnName)) {
      throw new McpPolicyError(`Invalid MCP entry point "${opts.launch.entry}"`);
    }
    // Values reach Python as JSON literals, never interpolated as code.
    const launcher = [
      'import json, sys',
      `sys.path[:0] = [${JSON.stringify(capPath)}]`,
      `sys.argv = json.loads(${JSON.stringify(JSON.stringify([opts.capabilityId, ...opts.launch.args]))})`,
      `from ${module} import ${fnName} as _entry`,
      '_entry()',
    ].join('\n');
    argv = ['python', '-I', '-c', launcher];
  }
  const secrets = opts.secrets ?? {};
  const proxyEnv: Record<string, string> = opts.egress
    ? {
        HTTP_PROXY: opts.egress.proxy,
        HTTPS_PROXY: opts.egress.proxy,
        http_proxy: opts.egress.proxy,
        https_proxy: opts.egress.proxy,
        // Node's own fetch honours these only when told to.
        NODE_USE_ENV_PROXY: '1',
      }
    : {};
  const sandbox = await runner.session({
    argv,
    inputs: opts.inputs ?? [],
    readOnlyMounts: [{ ...opts.layer, containerPath: capPath }],
    limits: { memoryMb: 1024, pids: 128, timeoutMs: opts.timeoutMs ?? 120_000 },
    env: proxyEnv,
    passEnv: Object.keys(secrets),
    ...(opts.image ? { image: opts.image } : {}),
    ...(opts.egress ? { networkName: opts.egress.network } : {}),
    ...(opts.name ? { name: opts.name } : {}),
  });
  const transport = new StdioClientTransport({
    command: sandbox.command,
    args: sandbox.args,
    stderr: 'pipe',
    env: { ...getDefaultEnvironment(), ...secrets },
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
  });
  const deadline = setTimeout(() => void sandbox.kill(), opts.timeoutMs ?? 120_000);
  try {
    return await overTransport(
      transport,
      opts.launch,
      opts.capabilityId,
      () => stderr.trim(),
      (s) => fn({ ...s, outputDir: sandbox.outputDir }),
    );
  } finally {
    clearTimeout(deadline);
    await sandbox.kill();
    await sandbox.cleanup();
  }
}

/**
 * Talks to a hosted MCP server. Nothing of it runs here; what a bot sends goes to whoever hosts
 * it, which the approval card said. Redirects are refused, so a public address cannot hand the
 * connection on to this machine or a local network.
 */
export async function withRemoteSession<T>(
  opts: {
    capabilityId: string;
    launch: McpLaunch;
    secrets?: Record<string, string>;
    timeoutMs?: number;
  },
  fn: (session: McpSession) => Promise<T>,
): Promise<T> {
  const url = await assertPublicUrl(opts.launch.url ?? '');
  const headers: Record<string, string> = {};
  for (const s of opts.launch.secrets ?? []) {
    const value = opts.secrets?.[s.name];
    if (s.header && value) headers[s.header] = `${s.prefix ?? ''}${value}`;
  }
  const guardedFetch: typeof fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.host !== url.host) {
      throw new McpPolicyError(`The server tried to send this to another host (${target.host}).`);
    }
    await assertPublicUrl(target.href);
    return fetch(input, { ...init, redirect: 'error' });
  };
  const transport = (
    opts.launch.remoteType === 'sse'
      ? new SSEClientTransport(url, { requestInit: { headers }, fetch: guardedFetch })
      : new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: guardedFetch })
  ) as Transport;
  const timer = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error('The hosted server did not answer in time.')),
      opts.timeoutMs ?? 120_000,
    ).unref();
  });
  return Promise.race([
    overTransport(transport, opts.launch, opts.capabilityId, () => '', fn),
    timer,
  ]);
}

/**
 * Defence in depth for SQL tools: only a single read-only statement (SELECT / WITH).
 * The server already runs read-only on in-sandbox data; this keeps intent explicit.
 */
export function checkReadOnlySql(sql: string): string | null {
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;\s*$/, '');
  if (!stripped) return 'Empty query.';
  if (stripped.includes(';')) return 'Only a single statement is allowed.';
  if (!/^(select|with)\b/i.test(stripped))
    return 'Only SELECT (or WITH … SELECT) queries are allowed.';
  if (
    /\b(copy|attach|install|load|pragma|export|import|insert|update|delete|create|drop|alter|set)\b/i.test(
      stripped.replace(/'(?:[^']|'')*'/g, "''"),
    )
  ) {
    return 'The query contains a statement keyword that is not allowed in a read-only query.';
  }
  return null;
}
