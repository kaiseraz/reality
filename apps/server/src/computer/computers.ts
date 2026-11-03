import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import type pg from 'pg';
import { docker } from './docker.ts';

/**
 * Bot computers: every bot gets its own Linux computer (an open-source sandbox image, see
 * the README) with a browser, a terminal and a home folder that persists in its own Docker volume.
 *
 * Isolation: the computers sit on an internal Docker network without internet. Reality's
 * gateway container is the only way in or out: it relays Reality's connection to each
 * computer (bound to 127.0.0.1) and lets the computer reach only the domains a person
 * allowed for that bot. Every command, file and network decision is logged.
 */

export const COMPUTER_NETWORK = 'reality-bots';
/**
 * Where tool servers that need the internet run: internal like the computers' network, but
 * separate from it, so third-party code cannot talk to a bot's computer. The gateway is the only
 * way out, and it lets each server reach only the domains a person approved for it.
 */
export const TOOL_NETWORK = 'reality-tools';
const CONTROL_PORT = 47090;
const FIRST_SLOT = 47100;
const SLOTS = 16;
/** Four hours: a person watching a design demo must never lose the open desktop. */
const IDLE_MS = 4 * 60 * 60_000;
/** A computer used this recently is in use. */
const IN_USE_MS = 2 * 60_000;
/** How many computers a machine holds: 6 GB for itself and Docker, about 2 GB each. */
export const maxComputers = (totalBytes: number) =>
  Math.max(2, Math.floor((totalBytes / 1024 ** 3 - 6) / 2));
/** The bot's home folder, kept in its own volume. */
export const WORKSPACE = '/home/gem/workspace';
/** Where a chat's bots share their work; one volume per owner, one folder per chat. */
export const PROJECTS = '/home/gem/projects';
export const projectFolder = (chatId: string) => `${PROJECTS}/${chatId.slice(0, 8)}`;
/** Commands up to this long run in one request; longer ones in the background (see execDetached). */
const DIRECT_EXEC_S = 45;
/** The bot's home on its computer, where its shell's ~ points. */
export const HOME = '/home/gem';

/**
 * A path a bot gives, as the computer sees it: ~ is the home as in the bot's shell, a bare
 * name lies in the workspace. "~/workspace/x" must not become "workspace/~/workspace/x".
 */
export function computerPath(p: string): string {
  const clean = p.trim();
  if (!clean) throw new ComputerError('A path is required.');
  if (clean === '~') return HOME;
  if (clean.startsWith('~/')) return `${HOME}/${clean.slice(2)}`;
  return clean.startsWith('/') ? clean : `${WORKSPACE}/${clean}`;
}

/**
 * Copies what changed in a project folder out of the shared volume, for the server to place. It
 * never follows a link, and it runs without network, so the person's own folder stays out of reach.
 */
const EXPORT_SCRIPT = `
import hashlib, json, os, shutil, sys
os.umask(0)
root = os.path.join('/from', sys.argv[1])
known = json.load(open('/to/known.json'))
SKIP = {'node_modules', '.git', '__pycache__', '.venv', 'venv', '.cache', '.reality'}
MAX = 200 * 1024 * 1024
out, n, total = [], 0, 0
for d, dirs, files in os.walk(root, followlinks=False):
    dirs[:] = [x for x in dirs if x not in SKIP and not os.path.islink(os.path.join(d, x))]
    for f in files:
        p = os.path.join(d, f)
        if os.path.islink(p) or not os.path.isfile(p) or f.endswith('.reality-tmp'):
            continue
        st = os.lstat(p)
        rel = os.path.relpath(p, root)
        if st.st_size > MAX:
            out.append({'path': rel, 'size': st.st_size, 'tooBig': True})
            continue
        stamp = '%d:%d' % (st.st_size, st.st_mtime_ns)
        if known.get(rel) == stamp or total > 2 * 1024 * 1024 * 1024:
            out.append({'path': rel, 'size': st.st_size})
            continue
        to = '/to/files/%d' % n
        shutil.copyfile(p, to)
        h = hashlib.sha256()
        with open(to, 'rb') as c:
            for b in iter(lambda: c.read(1 << 20), b''):
                h.update(b)
        out.append({'path': rel, 'size': st.st_size, 'stamp': stamp, 'sha': h.hexdigest(), 'file': n})
        n += 1
        total += st.st_size
json.dump(out, open('/to/out.json', 'w'))
`;

/**
 * Hosts the browser contacts on its own (sign-in checks, updates, safe browsing). They stay
 * blocked unless allowed, but are not reported: the bot did not ask for them.
 */
const BACKGROUND =
  /(^|\.)(google\.com|googleapis\.com|gstatic\.com|gvt1\.com|gvt2\.com|googleusercontent\.com|doubleclick\.net)$/;
export const isBackgroundHost = (host: string) => BACKGROUND.test(host.toLowerCase());

export interface ComputerConfig {
  /**
   * Separates Reality instances on one Docker host (e.g. the app and its tests): names,
   * labels and clean-up stay within the namespace. Derived from the database.
   */
  namespace: string;
  dockerBin: string;
  image: string;
  /** Image with python3 for the gateway (Reality's sandbox image). */
  gatewayImage: string;
}

export interface ComputerInfo {
  botId: string;
  running: boolean;
  /** Relay port on 127.0.0.1 while running. */
  port?: number;
  allowed: string[];
}

export interface LogEntry {
  id: number;
  kind: string;
  summary: string;
  detail: Record<string, unknown>;
  at: string;
}

interface Live {
  container: string;
  /** The gateway's port for this computer (inside the gateway). */
  slot: number;
  /** Where that port is published on 127.0.0.1. */
  port: number;
  key: string;
  lastUsed: number;
  /** Last time the entry was proven alive (health ping). */
  checked?: number;
}

const compact = (botId: string) =>
  botId
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 24)
    .toLowerCase();
/** The home folder outlives the computer; bot ids are unique, so no namespace is needed. */
const volumeOf = (botId: string) => `reality-bot-${compact(botId)}-home`;

/** A domain a person can allow: host names only, no schemes, paths or wildcards. */
export function normalizeDomain(input: string): string | null {
  let d = input.trim().toLowerCase();
  d =
    d
      .replace(/^[a-z]+:\/\//, '')
      .split('/')[0]
      ?.split(':')[0] ?? '';
  d = d.replace(/^\*\./, '').replace(/^www\./, '');
  if (!/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(d)) return null;
  // Names that lead into this machine or the local network are never allowed.
  if (/\.(internal|local|localhost|lan|home|arpa|test|invalid)$/.test(d)) return null;
  return d;
}

export class ComputerError extends Error {}

export class BotComputers {
  /** Short-lived tool containers and the domains each may reach while it runs. */
  private toolAllow = new Map<string, string[]>();
  private live = new Map<string, Live>();
  /** The last frame a computer showed: tiles keep the picture after it went off. */
  private lastFrame = new Map<string, Buffer>();
  private gatewayToken = '';
  private gatewayReady: Promise<void> | null = null;
  private starting = new Map<string, Promise<Live>>();
  /** Slots taken by computers still starting: two starting at once must not share a port. */
  private reserved = new Set<number>();
  private lastEvent = 0;
  private timer: NodeJS.Timeout | null = null;
  private reported = new Map<string, number>();
  private controlPort = 0;
  /** Gateway port inside → published port on 127.0.0.1. */
  private slotPorts = new Map<number, number>();
  private readonly gateway: string;

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: ComputerConfig,
  ) {
    this.gateway = `reality-gateway-${config.namespace}`;
  }

  private containerOf(botId: string) {
    return `reality-bot-${this.config.namespace}-${compact(botId)}`;
  }

  private run(args: string[], timeoutMs?: number) {
    return docker(this.config.dockerBin, args, timeoutMs);
  }

  /** Whether the computer image is present (it is large, so it is pulled on purpose). */
  async imageReady(): Promise<boolean> {
    const r = await this.run(['image', 'inspect', this.config.image], 20_000).catch(() => null);
    return r?.code === 0;
  }

  /* ---------- Gateway ---------- */

  private async ensureGateway(): Promise<void> {
    this.gatewayReady ??= this.startGateway().catch((err: unknown) => {
      this.gatewayReady = null;
      throw err;
    });
    return this.gatewayReady;
  }

  private async startGateway(): Promise<void> {
    const net = await this.run(['network', 'inspect', COMPUTER_NETWORK], 20_000);
    if (net.code !== 0) {
      const made = await this.run(['network', 'create', '--internal', COMPUTER_NETWORK]);
      if (made.code !== 0) throw new ComputerError(`Network: ${made.stderr.trim()}`);
    }
    // A fresh start: the old gateway goes (its token died with that process), but
    // computers left over from a crash or restart of this instance are ADOPTED below,
    // not deleted — a server restart must not wipe work a bot is in the middle of.
    // Their home folders live in volumes either way; adoption also keeps the session.
    const adopt = await this.sweepGateway();
    this.gatewayToken = randomBytes(24).toString('hex');
    const script = await readFile(new URL('./gateway.py', import.meta.url), 'utf8');
    const started = await this.run([
      'run',
      '-d',
      '--name',
      this.gateway,
      '--network',
      'bridge',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      '256m',
      '--pids-limit',
      '256',
      // Docker picks free host ports, so instances never collide.
      '-p',
      `127.0.0.1::${CONTROL_PORT}`,
      '-p',
      `127.0.0.1::${FIRST_SLOT}-${FIRST_SLOT + SLOTS - 1}`,
      '-e',
      `GATEWAY_TOKEN=${this.gatewayToken}`,
      '--label',
      'reality.role=gateway',
      '--label',
      `reality.ns=${this.config.namespace}`,
      this.config.gatewayImage,
      'python3',
      '-u',
      '-c',
      script,
    ]);
    if (started.code !== 0) throw new ComputerError(`Gateway: ${started.stderr.trim()}`);
    const linked = await this.run(['network', 'connect', COMPUTER_NETWORK, this.gateway]);
    if (linked.code !== 0) throw new ComputerError(`Gateway network: ${linked.stderr.trim()}`);
    const ports = await this.run(['port', this.gateway]);
    for (const line of ports.stdout.split('\n')) {
      const m = /^(\d+)\/tcp -> 127\.0\.0\.1:(\d+)/.exec(line.trim());
      if (!m) continue;
      const inner = Number(m[1]);
      if (inner === CONTROL_PORT) this.controlPort = Number(m[2]);
      else this.slotPorts.set(inner, Number(m[2]));
    }
    if (!this.controlPort) throw new ComputerError('Gateway ports were not published.');
    for (let i = 0; i < 50; i++) {
      const ok = await this.control('GET', '/events?after=0').catch(() => null);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // Adopt the computers that survived: same container, same API key, a fresh slot
    // on the new gateway. From here they are indistinguishable from fresh starts.
    let slot = FIRST_SLOT;
    for (const a of adopt) {
      if (slot >= FIRST_SLOT + SLOTS) break;
      const port = this.slotPorts.get(slot) ?? 0;
      if (!port) break;
      const live = {
        container: a.container,
        slot,
        port,
        key: a.key,
        lastUsed: Date.now(),
      } as Live;
      this.live.set(a.botId, live);
      // Ensure adopted machines also get the apt proxy, otherwise apt stays broken after a server restart.
      void this.api(
        live,
        'POST',
        '/v1/shell/exec',
        {
          command: `sudo bash -c 'printf "Acquire::http::Proxy \\"http://${this.gateway}:3128\\";\\nAcquire::https::Proxy \\"http://${this.gateway}:3128\\";\\n" > /etc/apt/apt.conf.d/99reality'`,
          timeout: 10,
        },
        15_000,
      ).catch(() => undefined);
      slot++;
    }
    if (this.live.size) await this.pushConfig().catch(() => undefined);
    this.timer ??= setInterval(() => void this.housekeeping(), 5_000);
  }

  private async control(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${this.controlPort}${path}`, {
      method,
      headers: { 'x-token': this.gatewayToken, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new ComputerError(`Gateway control ${res.status}`);
    return res.json();
  }

  /** Tells the gateway which port leads to which computer and what each may reach. */
  private async pushConfig(): Promise<void> {
    const slots: Record<string, string> = {};
    const allow: Record<string, string[]> = {};
    for (const [botId, l] of this.live) {
      slots[String(l.slot)] = l.container;
      allow[l.container] = await this.allowed(botId);
    }
    for (const [name, domains] of this.toolAllow) allow[name] = domains;
    await this.control('POST', '/config', { slots, allow });
  }

  /**
   * Opens the way out for one tool container, by the name it is about to start under: only these
   * domains, only through the gateway. A server that ignores the proxy simply has no network.
   */
  async openToolAccess(
    container: string,
    domains: readonly string[],
  ): Promise<{ network: string; proxy: string; mark: number }> {
    await this.ensureGateway();
    const net = await this.run(['network', 'inspect', TOOL_NETWORK], 20_000);
    if (net.code !== 0) {
      const made = await this.run(['network', 'create', '--internal', TOOL_NETWORK]);
      if (made.code !== 0) throw new ComputerError(`Network: ${made.stderr.trim()}`);
    }
    // Already connected is fine; a fresh gateway is not connected yet.
    await this.run(['network', 'connect', TOOL_NETWORK, this.gateway]);
    const clean = domains.flatMap((d) => normalizeDomain(d) ?? []);
    this.toolAllow.set(container, clean);
    await this.pushConfig();
    return {
      network: TOOL_NETWORK,
      proxy: `http://${this.gateway}:3128`,
      mark: await this.cursor(),
    };
  }

  /** Closes it again, and says which hosts the server tried and was refused. */
  async closeToolAccess(container: string, mark: number): Promise<string[]> {
    const denied = await this.deniedSince(container, mark).catch(() => [] as string[]);
    this.toolAllow.delete(container);
    await this.pushConfig().catch(() => undefined);
    return denied;
  }

  /**
   * Removes this instance's old gateway and any computers that are not running, and
   * returns the running computers for adoption (bot id, container, their API key from
   * the container's environment). Home folders (volumes) are never touched here.
   */
  private async sweepGateway(): Promise<{ botId: string; container: string; key: string }[]> {
    const r = await this.run([
      'ps',
      '-aq',
      '--filter',
      `label=reality.ns=${this.config.namespace}`,
    ]);
    const ids = r.stdout
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    this.live.clear();
    if (!ids.length) return [];
    const insp = await this.run(['inspect', ...ids], 30_000).catch(() => null);
    let parsed: {
      Name?: string;
      State?: { Running?: boolean };
      Config?: { Labels?: Record<string, string>; Env?: string[] };
    }[] = [];
    try {
      parsed = JSON.parse(insp?.stdout ?? '[]') as typeof parsed;
    } catch {
      parsed = [];
    }
    const adopt: { botId: string; container: string; key: string }[] = [];
    const remove: string[] = [];
    for (const c of parsed) {
      const labels = c.Config?.Labels ?? {};
      const botId = labels['reality.bot'];
      const key = (c.Config?.Env ?? []).find((e) => e.startsWith('SANDBOX_API_KEY='))?.slice(16);
      // A computer from before shared project folders has no such folder: it starts anew.
      if (
        labels['reality.role'] === 'computer' &&
        labels['reality.shared'] === '1' &&
        c.State?.Running &&
        botId &&
        key
      ) {
        adopt.push({ botId, container: (c.Name ?? '').replace(/^\//, ''), key });
      } else {
        remove.push((c.Name ?? '').replace(/^\//, ''));
      }
    }
    const stale = remove.filter(Boolean);
    if (stale.length) await this.run(['rm', '-f', ...stale], 60_000);
    return adopt;
  }

  /** Stops idle computers and records the gateway's network decisions. */
  private async housekeeping(): Promise<void> {
    const now = Date.now();
    for (const [botId, l] of this.live) {
      if (now - l.lastUsed > IDLE_MS) await this.stop(botId).catch(() => undefined);
    }
    const out = (await this.control('GET', `/events?after=${this.lastEvent}`).catch(
      () => null,
    )) as { events?: { seq: number; bot: string; kind: string; host: string }[] } | null;
    for (const e of out?.events ?? []) {
      this.lastEvent = Math.max(this.lastEvent, e.seq);
      const botId = [...this.live].find(([, l]) => l.container === e.bot)?.[0];
      if (!botId || e.kind !== 'denied' || isBackgroundHost(e.host)) continue;
      // One log line per host and minute, not one per retry.
      const key = `${botId}|${e.host}`;
      if ((this.reported.get(key) ?? 0) > Date.now() - 60_000) continue;
      this.reported.set(key, Date.now());
      await this.log(botId, 'network', `Blocked ${e.host}`, { host: e.host, allowed: false });
      this.onBlocked?.(botId, e.host);
    }
  }

  /** Called when a computer tried to reach a domain that is not allowed. */
  onBlocked: ((botId: string, host: string) => void) | null = null;

  /* ---------- Lifecycle ---------- */

  /** Starts the bot's computer if needed and returns how to reach it. */
  async ensure(botId: string): Promise<Live> {
    const l = this.live.get(botId);
    if (l) {
      l.lastUsed = Date.now();
      // A dead container used to stay "live" forever: after a Docker or gateway
      // hiccup every operation failed while the cache still said connected. Prove
      // the computer still answers (cheap ping, at most every few seconds); when
      // it does not, drop the entry so the next call re-adopts or restarts it.
      if (Date.now() - (l.checked ?? 0) > 5000) {
        l.checked = Date.now();
        const alive = await this.api(l, 'GET', '/v1/sandbox', undefined, 3000)
          .then(() => true)
          .catch(() => false);
        if (!alive) {
          this.live.delete(botId);
          return this.ensure(botId);
        }
      }
      return l;
    }
    let p = this.starting.get(botId);
    if (!p) {
      p = this.start(botId).finally(() => this.starting.delete(botId));
      this.starting.set(botId, p);
    }
    return p;
  }

  /** Starts the gateway (adopting surviving computers) without starting any computer. */
  async warmUp(): Promise<void> {
    await this.ensureGateway();
  }

  /**
   * Desktop defaults that make live CAD work readable: FreeCAD imports STEP assemblies
   * as a tree of named parts instead of merging them into one compound. The file ships
   * in the warm computer image; images without it simply skip this.
   */
  private async seedHome(live: Live): Promise<void> {
    await this.api(
      live,
      'POST',
      '/v1/shell/exec',
      {
        // Restore the desktop settings saved before the last stop, then make sure
        // the FreeCAD import preference is the canonical one.
        command:
          // A new volume belongs to root; the bots' shared folder must be theirs.
          `sudo chown gem:gem ${PROJECTS} 2>/dev/null; ` +
          '[ -f ~/workspace/.reality/home.tgz ] && tar xzf ~/workspace/.reality/home.tgz -C ~ 2>/dev/null; ' +
          // FreeCAD 0.19 reads ~/.FreeCAD, 0.20 and later ~/.config/FreeCAD.
          'mkdir -p ~/.FreeCAD ~/.config/FreeCAD && cp /opt/reality/freecad-user.cfg ~/.FreeCAD/user.cfg 2>/dev/null; ' +
          'cp /opt/reality/freecad-user.cfg ~/.config/FreeCAD/user.cfg 2>/dev/null; ' +
          // KiCad asks how to configure itself, and for a footprint library table, on its first start.
          'mkdir -p ~/.config/kicad/8.0 && cp -n /opt/reality/kicad/* ~/.config/kicad/8.0/ 2>/dev/null || true',
        timeout: 20,
      },
      25_000,
    ).catch(() => null);
  }

  /** Saves desktop settings into the persistent workspace before the container goes. */
  private async snapshotHome(live: Live): Promise<void> {
    await this.api(
      live,
      'POST',
      '/v1/shell/exec',
      {
        command:
          'mkdir -p ~/workspace/.reality && tar czf ~/workspace/.reality/home.tgz -C ~ .FreeCAD .config 2>/dev/null || true',
        timeout: 30,
      },
      35_000,
    ).catch(() => null);
  }

  /**
   * Too many computers on one machine stop Docker itself, and with it everything. Before another
   * starts, the longest unused ones go; their files stay, and they start again when needed. One in
   * use is never stopped for this.
   */
  private async makeRoom(): Promise<void> {
    const idle = [...this.live.entries()]
      .filter(([, l]) => Date.now() - l.lastUsed > IN_USE_MS)
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    let over = this.live.size + 1 - maxComputers(totalmem());
    for (const [botId] of idle) {
      if (over <= 0) break;
      await this.stop(botId).catch(() => undefined);
      over--;
    }
  }

  private async start(botId: string): Promise<Live> {
    if (!(await this.imageReady())) {
      throw new ComputerError(
        `The computer image ${this.config.image} is not installed yet. Pull it with: docker pull ${this.config.image}`,
      );
    }
    await this.ensureGateway();
    // The gateway start may just have adopted this bot's surviving computer.
    const adopted = this.live.get(botId);
    if (adopted) {
      adopted.lastUsed = Date.now();
      await this.seedHome(adopted);
      return adopted;
    }
    await this.makeRoom();
    // Picked and reserved in one step, with no await between: a second computer starting
    // meanwhile would otherwise take the same slot, and each bot's commands would reach the
    // other's computer, which refuses its key (401).
    const used = new Set([...this.live.values()].map((x) => x.slot));
    let slot = 0;
    for (let i = 0; i < SLOTS; i++) {
      if (!used.has(FIRST_SLOT + i) && !this.reserved.has(FIRST_SLOT + i)) {
        slot = FIRST_SLOT + i;
        break;
      }
    }
    const port = this.slotPorts.get(slot) ?? 0;
    if (!slot || !port) {
      throw new ComputerError('All computer slots are in use; stop an idle one first.');
    }
    this.reserved.add(slot);
    try {
      return await this.startIn(botId, slot, port);
    } finally {
      this.reserved.delete(slot);
    }
  }

  private async startIn(botId: string, slot: number, port: number): Promise<Live> {
    const container = this.containerOf(botId);
    const key = randomBytes(24).toString('hex');
    await this.run(['rm', '-f', container], 30_000);
    const proxy = `http://${this.gateway}:3128`;
    const started = await this.run([
      'run',
      '-d',
      '--name',
      container,
      '--hostname',
      'computer',
      '--network',
      COMPUTER_NETWORK,
      // The browser's sandbox needs this (as the project documents); the computer is still
      // cut off by the network, without host mounts and with limits.
      '--security-opt',
      'seccomp=unconfined',
      '--shm-size',
      '1g',
      '--memory',
      '3g',
      '--cpus',
      '2',
      '--pids-limit',
      '1024',
      '-v',
      `${volumeOf(botId)}:/home/gem/workspace`,
      '-v',
      `${this.sharedVolume(await this.ownerOf(botId))}:${PROJECTS}`,
      '-e',
      `SANDBOX_API_KEY=${key}`,
      '-e',
      `PROXY_SERVER=${proxy}`,
      '-e',
      `HTTP_PROXY=${proxy}`,
      '-e',
      `HTTPS_PROXY=${proxy}`,
      '-e',
      `http_proxy=${proxy}`,
      '-e',
      `https_proxy=${proxy}`,
      '-e',
      'NO_PROXY=localhost,127.0.0.1',
      '-e',
      'no_proxy=localhost,127.0.0.1',
      '-e',
      `WORKSPACE=${WORKSPACE}`,
      '-e',
      'TZ=Europe/Berlin',
      '--label',
      'reality.role=computer',
      '--label',
      `reality.ns=${this.config.namespace}`,
      '--label',
      `reality.bot=${botId}`,
      '--label',
      'reality.shared=1',
      this.config.image,
    ]);
    if (started.code !== 0) throw new ComputerError(`Computer: ${started.stderr.trim()}`);
    const live: Live = { container, slot, port, key, lastUsed: Date.now() };
    this.live.set(botId, live);
    await this.pushConfig();
    // Wait until the computer answers.
    for (let i = 0; i < 120; i++) {
      const ok = await this.api(live, 'GET', '/v1/sandbox').catch(() => null);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Make apt use our filtered gateway proxy so a bot can sudo apt-get install kicad/freecad itself.
    // Without this, apt tries to resolve archive.ubuntu.com directly and fails (no internet).
    try {
      await this.api(
        live,
        'POST',
        '/v1/shell/exec',
        {
          command: `sudo bash -c 'printf "Acquire::http::Proxy \\"http://${this.gateway}:3128\\";\\nAcquire::https::Proxy \\"http://${this.gateway}:3128\\";\\n" > /etc/apt/apt.conf.d/99reality'`,
          timeout: 10,
        },
        15_000,
      ).catch(() => null);
    } catch {
      // Non-fatal: pip still works, apt will be fixed on next boot.
    }
    await this.seedHome(live);
    await this.log(botId, 'power', 'Computer started', {});
    return live;
  }

  private async ownerOf(botId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ owner_id: string | null }>(
      'SELECT owner_id FROM bots WHERE id = $1',
      [botId],
    );
    return rows[0]?.owner_id ?? null;
  }

  /** Everyone's bots keep to their own owner's projects. */
  private sharedVolume(ownerId: string | null): string {
    const owner = createHash('sha256')
      .update(ownerId ?? 'local')
      .digest('hex')
      .slice(0, 12);
    return `reality-${this.config.namespace}-projects-${owner}`;
  }

  /**
   * Copies what changed in a chat's project folder to `dir` (known.json in, files/ and out.json
   * out). The container sees the shared volume read-only and `dir`, nothing else.
   */
  async exportProject(ownerId: string | null, chatId: string, dir: string): Promise<void> {
    const r = await this.run(
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--user',
        '0',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'DAC_READ_SEARCH',
        '--memory',
        '512m',
        '--label',
        `reality.ns=${this.config.namespace}`,
        '-v',
        `${this.sharedVolume(ownerId)}:/from:ro`,
        '-v',
        `${dir}:/to`,
        this.config.gatewayImage,
        'python3',
        '-c',
        EXPORT_SCRIPT,
        projectFolder(chatId).split('/').pop() ?? '',
      ],
      300_000,
    );
    if (r.code !== 0) throw new ComputerError(`Project copy: ${r.stderr.trim().slice(0, 300)}`);
  }

  async stop(botId: string): Promise<void> {
    const l = this.live.get(botId);
    this.live.delete(botId);
    // Keep the desktop's settings for the next start; only ~/workspace survives
    // the container, so the settings travel inside it.
    if (l) await this.snapshotHome(l);
    await this.run(['rm', '-f', l?.container ?? this.containerOf(botId)], 60_000);
    if (l) await this.pushConfig().catch(() => undefined);
    await this.log(botId, 'power', 'Computer stopped', {});
  }

  /** Removes the computer and its home folder for good (when a bot is deleted). */
  async destroy(botId: string): Promise<void> {
    await this.stop(botId).catch(() => undefined);
    await this.run(['volume', 'rm', '-f', volumeOf(botId)], 60_000);
  }

  async info(botId: string): Promise<ComputerInfo> {
    const l = this.live.get(botId);
    return {
      botId,
      running: Boolean(l),
      ...(l ? { port: l.port } : {}),
      allowed: await this.allowed(botId),
    };
  }

  /** The relay address and key, for Reality's own proxy to the live screen. */
  endpoint(botId: string, touch = true): { port: number; key: string } | null {
    const l = this.live.get(botId);
    if (!l) return null;
    if (touch) l.lastUsed = Date.now();
    return { port: l.port, key: l.key };
  }

  /** Bots whose computer is on right now. */
  running(): string[] {
    return [...this.live.keys()];
  }

  /**
   * A small picture of the computer's screen, for the overview. Does not count as use, so
   * an open overview does not keep idle computers running. While the computer is off,
   * the last frame stays cached, so the tile shows where it left off instead of going dark.
   */
  async thumbnail(botId: string): Promise<Buffer | null> {
    const end = this.endpoint(botId, false);
    if (!end) return this.lastFrame.get(botId) ?? null;
    const res = await fetch(
      `http://127.0.0.1:${end.port}/v1/browser/screenshot?format=jpeg&quality=55`,
      { headers: { 'x-aio-api-key': end.key }, signal: AbortSignal.timeout(8_000) },
    ).catch(() => null);
    if (!res?.ok) return this.lastFrame.get(botId) ?? null;
    const frame = Buffer.from(await res.arrayBuffer());
    this.lastFrame.set(botId, frame);
    return frame;
  }

  /* ---------- Talking to a computer ---------- */

  async api(l: Live, method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 30_000) {
    const res = await fetch(`http://127.0.0.1:${l.port}${path}`, {
      method,
      headers: { 'x-aio-api-key': l.key, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new ComputerError(`${path}: ${res.status} ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { raw: text };
    }
  }

  /** Hosts the gateway refused for this computer since a given event. */
  private async deniedSince(container: string, after: number): Promise<string[]> {
    const out = (await this.control('GET', `/events?after=${after}`).catch(() => null)) as {
      events?: { bot: string; kind: string; host: string }[];
    } | null;
    return [
      ...new Set(
        (out?.events ?? [])
          .filter((e) => e.bot === container && e.kind === 'denied' && !isBackgroundHost(e.host))
          .map((e) => e.host),
      ),
    ];
  }

  private async cursor(): Promise<number> {
    const out = (await this.control('GET', `/events?after=${this.lastEvent}`).catch(
      () => null,
    )) as { events?: { seq: number }[] } | null;
    return Math.max(this.lastEvent, ...(out?.events ?? []).map((e) => e.seq));
  }

  /** Runs a shell command in the bot's home folder. */
  async exec(
    botId: string,
    command: string,
    timeoutS = 120,
    /** What the activity list says instead of the command; false leaves it out (plumbing). */
    show?: string | false,
  ): Promise<{ output: string; exitCode: number; blocked: string[] }> {
    const l = await this.ensure(botId);
    const mark = await this.cursor();
    const { output, exitCode } =
      timeoutS > DIRECT_EXEC_S
        ? await this.execDetached(l, command, timeoutS)
        : await this.execDirect(l, command, timeoutS);
    const blocked = await this.deniedSince(l.container, mark);
    if (show !== false) {
      await this.log(botId, 'command', (show ?? command).slice(0, 300), {
        exitCode,
        output: output.slice(-4000),
        blocked,
      });
    }
    return { output, exitCode, blocked };
  }

  private async execDirect(l: Live, command: string, timeoutS: number) {
    const res = await this.api(
      l,
      'POST',
      '/v1/shell/exec',
      { command, exec_dir: WORKSPACE, timeout: timeoutS, hard_timeout: timeoutS },
      (timeoutS + 15) * 1000,
    );
    const data = (res.data ?? {}) as { output?: string; exit_code?: number | null };
    return {
      output: String(data.output ?? ''),
      exitCode: typeof data.exit_code === 'number' ? data.exit_code : 1,
    };
  }

  /**
   * A long command (an install, a build) runs in the background and is asked after: the
   * computer's web server cuts every request after about a minute (504), however long the
   * command may take. Exit code 124 when it ran out of time, as with timeout(1).
   */
  private async execDetached(l: Live, command: string, timeoutS: number) {
    const base = `/tmp/reality-run-${randomBytes(6).toString('hex')}`;
    const script = Buffer.from(command, 'utf8').toString('base64');
    await this.execDirect(
      l,
      `printf %s ${script} | base64 -d > ${base}.sh && ` +
        `(setsid bash -c 'cd ${WORKSPACE}; bash ${base}.sh > ${base}.out 2>&1; echo $? > ${base}.code' ` +
        `>/dev/null 2>&1 & echo $! > ${base}.pid)`,
      20,
    );
    const deadline = Date.now() + timeoutS * 1000;
    let code: number | null = null;
    while (code === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const seen = await this.execDirect(l, `cat ${base}.code 2>/dev/null`, 15).catch(() => null);
      const n = Number.parseInt(seen?.output.trim() ?? '', 10);
      if (Number.isInteger(n)) code = n;
    }
    if (code === null) {
      await this.execDirect(l, `kill -- -$(cat ${base}.pid) 2>/dev/null; true`, 15).catch(
        () => null,
      );
    }
    const out = await this.execDirect(l, `tail -c 200000 ${base}.out; rm -f ${base}.*`, 20);
    return code === null
      ? { output: `${out.output}\n(stopped after ${timeoutS} s)`, exitCode: 124 }
      : { output: out.output, exitCode: code };
  }

  private path(p: string): string {
    return computerPath(p);
  }

  async readFile(botId: string, path: string): Promise<string> {
    const l = await this.ensure(botId);
    try {
      const res = await this.api(l, 'POST', '/v1/file/read', { file: this.path(path) });
      return String((res.data as { content?: string } | undefined)?.content ?? '');
    } catch {
      // Same 401 state as writes: the file endpoint refuses while the shell works.
      // Read through the shell (base64, single line) instead of failing the turn.
      const file = this.path(path);
      const res = await this.api(l, 'POST', '/v1/shell/exec', {
        command: `base64 -w0 '${file.replace(/'/g, `'"'"'`)}'`,
      });
      const data = (res.data ?? {}) as { output?: string; exit_code?: number | null };
      if (typeof data.exit_code === 'number' && data.exit_code !== 0) {
        throw new ComputerError(`${path}: read failed on its computer`);
      }
      return Buffer.from(String(data.output ?? '').trim(), 'base64').toString('utf8');
    }
  }

  /** A file's exact bytes, for handing it to the person; a cut-off transfer is an error. */
  async readBytes(botId: string, path: string, maxBytes: number): Promise<Buffer> {
    const l = await this.ensure(botId);
    const file = this.path(path).replace(/'/g, `'"'"'`);
    const info = await this.api(l, 'POST', '/v1/shell/exec', {
      command: `stat -c %s '${file}' && sha256sum '${file}'`,
    });
    const [size, sum] = String((info.data as { output?: string } | undefined)?.output ?? '')
      .trim()
      .split(/\s+/);
    if (!size || !/^\d+$/.test(size) || !sum) throw new ComputerError(`${path}: no such file.`);
    if (Number(size) > maxBytes) {
      throw new ComputerError(`${path} is ${size} bytes; the limit is ${maxBytes}.`);
    }
    // In pieces: the shell's answer has a size limit, and a screenshot is already over it.
    const PIECE = 9_000;
    const starts: number[] = [];
    for (let at = 0; at < Number(size); at += PIECE) starts.push(at);
    const parts: Buffer[] = new Array<Buffer>(starts.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (next < starts.length) {
          const i = next++;
          const res = await this.api(l, 'POST', '/v1/shell/exec', {
            command: `tail -c +${(starts[i] ?? 0) + 1} '${file}' | head -c ${PIECE} | base64 -w0`,
          });
          parts[i] = Buffer.from(
            String((res.data as { output?: string } | undefined)?.output ?? '').trim(),
            'base64',
          );
        }
      }),
    );
    const data = Buffer.concat(parts);
    if (createHash('sha256').update(data).digest('hex') !== sum) {
      throw new ComputerError(`${path} did not arrive whole.`);
    }
    return data;
  }

  /** Puts exact bytes on the computer, in pieces, and checks they arrived whole. */
  async writeBytes(botId: string, path: string, data: Buffer): Promise<void> {
    const l = await this.ensure(botId);
    const file = this.path(path).replace(/'/g, `'"'"'`);
    const dir = file.slice(0, file.lastIndexOf('/')) || '/';
    await this.api(l, 'POST', '/v1/shell/exec', { command: `mkdir -p '${dir}' && : > '${file}'` });
    const PIECE = 30_000;
    for (let at = 0; at < data.length; at += PIECE) {
      const b64 = data.subarray(at, at + PIECE).toString('base64');
      await this.api(l, 'POST', '/v1/shell/exec', {
        command: `printf %s '${b64}' | base64 -d >> '${file}'`,
      });
    }
    const check = await this.api(l, 'POST', '/v1/shell/exec', { command: `sha256sum '${file}'` });
    const sum = createHash('sha256').update(data).digest('hex');
    if (!String((check.data as { output?: string } | undefined)?.output ?? '').includes(sum)) {
      throw new ComputerError(`${path} did not arrive whole.`);
    }
  }

  async writeFile(botId: string, path: string, content: string): Promise<void> {
    const l = await this.ensure(botId);
    const file = this.path(path);
    const dir = file.slice(0, file.lastIndexOf('/')) || '/';
    // Single-quoted for the shell; a quote inside becomes '"'"'.
    await this.api(l, 'POST', '/v1/shell/exec', {
      command: `mkdir -p '${dir.replace(/'/g, `'"'"'`)}'`,
    });
    try {
      await this.api(l, 'POST', '/v1/file/write', { file, content });
    } catch {
      // The sandbox's file endpoint refuses in some states (401 after a container or
      // gateway restart) while the shell keeps working — bots writing through the shell
      // proved that. Land the file in base64 chunks through the shell instead of
      // failing the bot's whole turn.
      const b64 = Buffer.from(content, 'utf8').toString('base64');
      const chunks: string[] = [];
      for (let i = 0; i < b64.length; i += 24_000) chunks.push(b64.slice(i, i + 24_000));
      if (chunks.length === 0) chunks.push('');
      for (const [i, chunk] of chunks.entries()) {
        await this.api(l, 'POST', '/v1/shell/exec', {
          command: `printf %s '${chunk}' | base64 -d ${i === 0 ? '>' : '>>'} '${file.replace(/'/g, `'"'"'`)}'`,
        });
      }
    }
    await this.log(botId, 'file', `Wrote ${file}`, { bytes: content.length });
  }

  /** The files in the home folder, for the computer view. */
  async listFiles(botId: string): Promise<{ path: string; size: number; dir: boolean }[]> {
    const l = this.live.get(botId);
    if (!l) return [];
    try {
      const res = await this.api(l, 'POST', '/v1/file/list', {
        path: WORKSPACE,
        recursive: true,
        max_depth: 3,
        include_size: true,
        sort_by: 'name',
      });
      const files = ((res.data as { files?: unknown[] } | undefined)?.files ?? []) as {
        path?: string;
        size?: number;
        is_directory?: boolean;
      }[];
      return files.slice(0, 500).map((x) => ({
        path: String(x.path ?? '').replace(`${WORKSPACE}/`, ''),
        size: Number(x.size ?? 0),
        dir: Boolean(x.is_directory),
      }));
    } catch {
      // Same 401 state: list through the shell instead of showing an empty folder.
      const res = await this.api(l, 'POST', '/v1/shell/exec', {
        command: `find '${WORKSPACE}' -mindepth 1 -maxdepth 3 -printf '%y|%s|%p\\n'`,
      }).catch(() => null);
      const data = (res?.data ?? {}) as { output?: string };
      return String(data.output ?? '')
        .split('\n')
        .map((line) => line.trim().split('|'))
        .filter((p) => p.length === 3 && p[2])
        .slice(0, 500)
        .map(([t, s, p]) => ({
          path: String(p).replace(`${WORKSPACE}/`, ''),
          size: Number(s ?? 0),
          dir: t === 'd',
        }));
    }
  }

  /** Opens a page in the computer's browser and returns its title and text. */
  async browse(
    botId: string,
    url: string,
  ): Promise<{ title: string; url: string; text: string; blocked?: string }> {
    if (!/^https?:\/\//i.test(url)) throw new ComputerError('Give a full http(s) URL.');
    const l = await this.ensure(botId);
    const mark = await this.cursor();
    let failed = '';
    await this.api(l, 'POST', '/v1/browser/page/navigate', { url, timeout: 30 }, 45_000).catch(
      (err: unknown) => {
        failed = err instanceof Error ? err.message : String(err);
      },
    );
    const denied = await this.deniedSince(l.container, mark);
    const host = new URL(url).hostname.toLowerCase();
    const blocked =
      denied.find((d) => d === host || host.endsWith(`.${d}`) || d.endsWith(`.${host}`)) ??
      denied[0];
    if (failed && !blocked) throw new ComputerError(`Could not open ${url}: ${failed}`);
    const md = await this.api(l, 'GET', '/v1/browser/page/markdown').catch(() => null);
    const data = (md?.data ?? {}) as {
      title?: string;
      url?: string;
      markdown?: string;
      content?: string;
    };
    const text = String(data.markdown ?? data.content ?? '');
    await this.log(botId, 'browse', url, { blocked: blocked ?? null });
    return {
      title: String(data.title ?? ''),
      url: String(data.url ?? url),
      text,
      ...(blocked ? { blocked } : {}),
    };
  }

  /* ---------- Access and log ---------- */

  /**
   * Baseline internet every computer gets: package registries and code hosts so
   * a bot can fetch its own tools (pip, npm, apt, git) without asking for each
   * registry. People still grant the job-specific sites (e.g. a data source).
   */
  static readonly DEFAULT_ALLOWED = [
    'pypi.org',
    'files.pythonhosted.org',
    'pypi.python.org',
    'pythonhosted.org',
    'github.com',
    'raw.githubusercontent.com',
    'api.github.com',
    'objects.githubusercontent.com',
    'codeload.github.com',
    'registry.npmjs.org',
    'registry.yarnpkg.com',
    'nodejs.org',
    'archive.ubuntu.com',
    'security.ubuntu.com',
    'ppa.launchpad.net',
    // Where Launchpad serves PPA files today; apt-get update warns on every run without it.
    'ppa.launchpadcontent.net',
    'keyserver.ubuntu.com',
    'deb.debian.org',
    'storage.googleapis.com',
    // The registries other fields install from: conda-forge and bioconda, R, Rust, Go, Java.
    'conda.anaconda.org',
    'cloud.r-project.org',
    'bioconductor.org',
    'crates.io',
    'static.crates.io',
    'index.crates.io',
    'proxy.golang.org',
    'repo1.maven.org',
  ] as const;

  async allowed(botId: string): Promise<string[]> {
    const r = await this.pool.query<{ domain: string }>(
      'SELECT domain FROM bot_computer_access WHERE bot_id = $1 ORDER BY domain',
      [botId],
    );
    const fromDb = r.rows.map((x) => x.domain);
    const merged = new Set<string>([
      ...fromDb,
      ...BotComputers.DEFAULT_ALLOWED.map((d) => d.toLowerCase()),
    ]);
    return [...merged].sort();
  }

  async allow(botId: string, domain: string, by: string | null): Promise<string> {
    const d = normalizeDomain(domain);
    if (!d) throw new ComputerError(`"${domain}" is not a domain name.`);
    await this.pool.query(
      `INSERT INTO bot_computer_access (bot_id, domain, granted_by) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [botId, d, by],
    );
    await this.log(botId, 'access', `Allowed ${d}`, { domain: d, by });
    if (this.live.has(botId)) await this.pushConfig();
    return d;
  }

  async revoke(botId: string, domain: string, by: string | null): Promise<void> {
    await this.pool.query('DELETE FROM bot_computer_access WHERE bot_id = $1 AND domain = $2', [
      botId,
      domain,
    ]);
    await this.log(botId, 'access', `Revoked ${domain}`, { domain, by });
    if (this.live.has(botId)) await this.pushConfig();
  }

  async log(
    botId: string,
    kind: string,
    summary: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.pool
      .query(
        'INSERT INTO bot_computer_log (bot_id, kind, summary, detail) VALUES ($1, $2, $3, $4)',
        [botId, kind, summary.slice(0, 500), JSON.stringify(detail)],
      )
      .catch(() => undefined);
  }

  async history(botId: string, limit = 100): Promise<LogEntry[]> {
    const r = await this.pool.query<{
      id: string;
      kind: string;
      summary: string;
      detail: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id, kind, summary, detail, created_at FROM bot_computer_log
       WHERE bot_id = $1 ORDER BY id DESC LIMIT $2`,
      [botId, limit],
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      kind: x.kind,
      summary: x.summary,
      detail: x.detail,
      at: x.created_at.toISOString(),
    }));
  }

  /**
   * On shutdown the computers stop (their home folders stay in the volumes) and the gateway
   * goes, so nothing keeps running on this machine without Reality.
   */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.gatewayToken) return;
    for (const botId of [...this.live.keys()]) await this.stop(botId).catch(() => undefined);
    await this.run(['rm', '-f', this.gateway], 30_000).catch(() => undefined);
  }
}
