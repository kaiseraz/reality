import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type pg from 'pg';
import type { FileStore } from '../artifacts/file-store.ts';
import type { Chat, ChatStore } from '../chat/store.ts';
import type { BotComputers } from '../computer/computers.ts';

/**
 * A chat's work on the person's own computer. The bots share a folder inside the sandbox; only
 * this server copies from there to the real folder, which no bot computer ever has mounted. What
 * Reality copies it remembers by checksum: a file the person changed is never overwritten, the new
 * version lands beside it, and nothing in their folder is ever deleted.
 */

const THROTTLE_MS = 8_000;
/** Folders that hold programs or the system: no project belongs there. */
const SYSTEM =
  /^([a-z]:[\\/](windows|program files( \(x86\))?|programdata)|\/(bin|boot|dev|etc|lib|lib64|proc|sbin|sys|usr|var))([\\/]|$)/i;

interface Remembered {
  /** Size and time on the sandbox side: unchanged there means nothing to do. */
  stamp?: string;
  /** Checksum of what Reality last wrote to the person's folder. */
  written?: string;
  size: number;
  /** Where it is in the person's folder, relative to it. */
  as: string;
  state: FileState;
}
type FileState = 'copied' | 'beside-yours' | 'too-big' | 'waiting';

interface Exported {
  path: string;
  size: number;
  stamp?: string;
  sha?: string;
  file?: number;
  tooBig?: boolean;
}

export interface FolderStatus {
  path: string | null;
  files: { path: string; size: number; state: FileState }[];
}

export interface FolderListing {
  path: string;
  parent: string | null;
  dirs: string[];
  roots: { name: string; path: string }[];
}

export class FolderError extends Error {}

/** Why a folder cannot hold a project, or null. */
export function folderProblem(path: string): string | null {
  if (!isAbsolute(path)) return 'Give a full path.';
  const clean = resolve(path);
  if (clean === parse(clean).root) return 'Choose a folder, not a whole drive.';
  if (SYSTEM.test(clean)) return 'That folder belongs to the system.';
  return null;
}

/** A name for a folder, on any system. */
export function folderName(title: string): string {
  const clean = title
    .replace(/[<>:"/\\|?*]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = clean.length > 48 ? clean.slice(0, 48).replace(/\s+\S*$/, '') : clean;
  return cut.replace(/[.,;!\- ]+$/, '') || 'Project';
}

/**
 * Where a file from the sandbox goes in the person's folder. Names come from the bots: anything a
 * system would refuse is replaced, and nothing may lead out of the folder.
 */
export function targetIn(root: string, rel: string): string | null {
  const parts = rel.split('/').map((p) =>
    p
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"\\|?*\u0000-\u001f\ud800-\udfff]/g, '_')
      .replace(/[. ]+$/, '')
      .replace(/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i, '_$1$2'),
  );
  if (parts.some((p) => !p || p === '..')) return null;
  const target = resolve(root, ...parts);
  const within = relative(resolve(root), target);
  return within && !within.startsWith('..') && !isAbsolute(within) ? target : null;
}

const sha256 = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

export class ProjectFolders {
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      pool: pg.Pool;
      store: ChatStore;
      computers: BotComputers;
      files: FileStore;
      /** Where Reality keeps what it knows about each folder. */
      dataDir: string;
      /** Where a new project's folder goes; by default the person's documents. */
      root?: string;
      log?: { error: (o: object, m: string) => void };
    },
  ) {}

  private get root(): string {
    if (this.deps.root) return this.deps.root;
    const home = homedir();
    const documents = ['Documents', 'Dokumente', 'OneDrive/Documents', 'OneDrive/Dokumente']
      .map((d) => join(home, d))
      .find((d) => existsSync(d));
    return join(documents ?? home, 'Reality');
  }

  /** Something may have changed in the sandbox: copy soon, however often this is called. */
  touch(chat: Chat): void {
    if (this.timers.has(chat.id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(chat.id);
      void this.sync(chat.id).catch((err: unknown) => {
        this.deps.log?.error({ err, chatId: chat.id }, 'project folder sync');
      });
    }, THROTTLE_MS);
    timer.unref();
    this.timers.set(chat.id, timer);
  }

  /** One copy at a time per chat. */
  sync(chatId: string): Promise<void> {
    const before = this.running.get(chatId) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(() => this.syncNow(chatId));
    this.running.set(chatId, run);
    return run.finally(() => {
      if (this.running.get(chatId) === run) this.running.delete(chatId);
    });
  }

  private async syncNow(chatId: string): Promise<void> {
    const chat = await this.deps.store.get(chatId);
    if (!chat) return;
    const known = await this.remembered(chat.id);
    const stamps = Object.fromEntries(
      Object.entries(known).flatMap(([path, r]) =>
        r.stamp && r.state !== 'waiting' ? [[path, r.stamp]] : [],
      ),
    );
    const temp = await mkdtemp(join(tmpdir(), 'reality-export-'));
    try {
      await chmod(temp, 0o777);
      await mkdir(join(temp, 'files'));
      await chmod(join(temp, 'files'), 0o777);
      await writeFile(join(temp, 'known.json'), JSON.stringify(stamps));
      await this.deps.computers.exportProject(chat.ownerId, chat.id, temp);
      const list = JSON.parse(await readFile(join(temp, 'out.json'), 'utf8')) as Exported[];
      const fresh = list.filter((e) => e.tooBig || e.file !== undefined);
      if (fresh.length === 0) return;
      const host = await this.folderFor(chat);
      if (!host) return;
      for (const e of fresh) {
        if (e.tooBig) {
          known[e.path] = { size: e.size, as: e.path, state: 'too-big' };
        } else if (e.file !== undefined && e.sha && e.stamp) {
          const placed = await this.place(
            host,
            e.path,
            join(temp, 'files', String(e.file)),
            e.sha,
            known[e.path],
          );
          known[e.path] = { ...placed, stamp: e.stamp, size: e.size };
        }
      }
      await this.remember(chat.id, known);
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Puts one file into the person's folder by the rule: a new file is copied, Reality's own earlier
   * version is replaced, and a file the person changed stays; the new version goes beside it.
   */
  private async place(
    host: string,
    rel: string,
    source: string,
    sha: string,
    was: Remembered | undefined,
  ): Promise<Omit<Remembered, 'stamp' | 'size'>> {
    const target = targetIn(host, rel);
    if (!target) return { as: rel, state: 'waiting' };
    const written = (to: string, state: FileState) => ({
      written: sha,
      as: relative(host, to).split(sep).join('/'),
      state,
    });
    try {
      await mkdir(dirname(target), { recursive: true });
      const current = existsSync(target) ? await sha256(target) : null;
      if (current === sha) return written(target, 'copied');
      if (current === null || current === was?.written) {
        await this.write(source, target);
        return written(target, 'copied');
      }
      const { dir, name, ext } = parse(target);
      const beside = join(dir, `${name} (Reality)${ext}`);
      await this.write(source, beside);
      return { ...written(beside, 'beside-yours'), written: was?.written ?? '' };
    } catch {
      // Open in another program, or the disk says no: the next copy tries again.
      return { ...(was?.written ? { written: was.written } : {}), as: rel, state: 'waiting' };
    }
  }

  private async write(source: string, target: string): Promise<void> {
    const tmp = `${target}.reality-tmp`;
    await copyFile(source, tmp);
    await rename(tmp, target).catch(async (err: unknown) => {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    });
  }

  /** The chat's folder; a project that has something to show gets one by itself, for its owner. */
  private async folderFor(chat: Chat): Promise<string | null> {
    if (chat.hostFolder) return chat.hostFolder;
    if (chat.ownerId) {
      const { rows } = await this.deps.pool.query<{ role: string }>(
        'SELECT role FROM users WHERE id = $1',
        [chat.ownerId],
      );
      if (rows[0]?.role !== 'admin') return null;
    }
    const name = folderName(await this.deps.store.subject(chat));
    let path = join(this.root, name);
    for (let i = 2; existsSync(path); i++) path = join(this.root, `${name} ${i}`);
    await mkdir(path, { recursive: true });
    await this.deps.store.setHostFolder(chat.id, path);
    return path;
  }

  /**
   * A checked board or assembly from the lab goes to the person's folder in full, directly from
   * Reality's file store. The bots' copy leaves out big files, and a computer may be off.
   */
  async deliverResult(chatId: string, taskId: string, folder: string): Promise<void> {
    const chat = await this.deps.store.get(chatId);
    if (!chat) return;
    const stored = await this.deps.files.forStep(taskId, 'simulate');
    if (!stored.some((f) => /\.(kicad_pcb|step)$/i.test(f.name))) return;
    const host = await this.folderFor(chat);
    if (!host) return;
    const known = await this.remembered(chat.id);
    const design = stored.find((f) => f.name === 'design.json');
    // A plane is KiCad's to fill: its files come with the board it saved, not these.
    const poured =
      design &&
      /"pours"\s*:\s*\[\s*\{/.test(await readFile(this.deps.files.filePath(design), 'utf8'));
    for (const f of stored) {
      if (poured && /\.(gtl|gbl|gko|drl)$/.test(f.name)) continue;
      // Working files of the lab and the viewer, no use to a person.
      if (
        /^(build\.json|design\.json|scene\.json|parts\.brep|original\.kicad_pcb|stage_.*)$/.test(
          f.name,
        )
      ) {
        continue;
      }
      const rel = `${folder}/${f.name}`;
      const placed = await this.place(
        host,
        rel,
        this.deps.files.filePath(f),
        await sha256(this.deps.files.filePath(f)),
        known[rel],
      );
      known[rel] = { ...placed, size: f.sizeBytes };
    }
    await this.remember(chat.id, known);
  }

  /** A folder the person chose. Everything is copied there on the next round. */
  async choose(chat: Chat, path: string): Promise<string> {
    const problem = folderProblem(path);
    if (problem) throw new FolderError(problem);
    const clean = resolve(path);
    await mkdir(clean, { recursive: true }).catch(() => {
      throw new FolderError('That folder could not be created.');
    });
    await this.deps.store.setHostFolder(chat.id, clean);
    await this.remember(chat.id, {});
    void this.sync(chat.id).catch((err: unknown) => {
      this.deps.log?.error({ err, chatId: chat.id }, 'project folder sync');
    });
    return clean;
  }

  async status(chat: Chat): Promise<FolderStatus> {
    const known = await this.remembered(chat.id);
    return {
      path: chat.hostFolder,
      files: Object.values(known)
        .map((r) => ({ path: r.as, size: r.size, state: r.state }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  /** Subfolders to choose from, for the picker in the browser. */
  async browse(path?: string): Promise<FolderListing> {
    const at = resolve(path || this.root);
    const seen = existsSync(at) ? at : homedir();
    const entries = await readdir(seen, { withFileTypes: true }).catch(() => {
      throw new FolderError('That folder cannot be read.');
    });
    const home = homedir();
    const drives =
      process.platform === 'win32'
        ? 'CDEFGH'
            .split('')
            .map((d) => `${d}:\\`)
            .filter((d) => existsSync(d))
        : [];
    const parent = dirname(seen);
    return {
      path: seen,
      parent: parent === seen ? null : parent,
      dirs: entries
        .filter((e) => e.isDirectory() && !/^[.$]|^node_modules$/.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 300),
      roots: [
        { name: 'Home', path: home },
        ...['Documents', 'Dokumente', 'Desktop', 'OneDrive/Desktop']
          .map((d) => ({ name: d.replace('OneDrive/', 'OneDrive '), path: join(home, d) }))
          .filter((r) => existsSync(r.path)),
        ...drives.map((d) => ({ name: d, path: d })),
      ],
    };
  }

  /** Shows the folder in the system's file manager. */
  open(path: string): void {
    const command =
      process.platform === 'win32'
        ? 'explorer'
        : process.platform === 'darwin'
          ? 'open'
          : 'xdg-open';
    spawn(command, [path], { detached: true, stdio: 'ignore', windowsHide: false })
      .on('error', () => undefined)
      .unref();
  }

  private memoryOf(chatId: string) {
    return join(this.deps.dataDir, 'project-folders', `${chatId}.json`);
  }

  private async remembered(chatId: string): Promise<Record<string, Remembered>> {
    return readFile(this.memoryOf(chatId), 'utf8')
      .then((s) => JSON.parse(s) as Record<string, Remembered>)
      .catch(() => ({}));
  }

  private async remember(chatId: string, known: Record<string, Remembered>): Promise<void> {
    await mkdir(dirname(this.memoryOf(chatId)), { recursive: true });
    await writeFile(this.memoryOf(chatId), JSON.stringify(known));
  }
}
