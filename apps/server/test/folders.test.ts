import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileStore, StoredFile } from '../src/artifacts/file-store.ts';
import type { Chat, ChatStore } from '../src/chat/store.ts';
import { maxComputers, type BotComputers } from '../src/computer/computers.ts';
import { folderName, folderProblem, ProjectFolders, targetIn } from '../src/projects/folders.ts';

describe('computers on one machine', () => {
  it('leaves room for the machine itself', () => {
    expect(maxComputers(8 * 1024 ** 3)).toBe(2);
    expect(maxComputers(15.8 * 1024 ** 3)).toBe(6);
    expect(maxComputers(32 * 1024 ** 3)).toBe(16);
  });
});

describe('names and places', () => {
  it('refuses drives and system folders', () => {
    expect(folderProblem('relative/path')).toBeTruthy();
    expect(folderProblem(resolve('/'))).toBeTruthy();
    expect(folderProblem(process.platform === 'win32' ? 'C:\\Windows\\x' : '/etc/x')).toBeTruthy();
    expect(folderProblem(resolve('/some/own/folder'))).toBeNull();
  });

  it('makes a folder name of anything', () => {
    expect(folderName('Board: 5/5 "final"?')).toBe('Board 5 5 final');
    expect(folderName('...')).toBe('Project');
    expect(folderName('a'.repeat(100)).length).toBeLessThanOrEqual(48);
  });

  it('keeps every file inside the folder, whatever a bot names it', () => {
    const root = resolve('/project');
    expect(targetIn(root, 'a/b.txt')).toBe(resolve(root, 'a', 'b.txt'));
    expect(targetIn(root, '../evil.txt')).toBeNull();
    expect(targetIn(root, 'a/../../evil.txt')).toBeNull();
    expect(targetIn(root, 'x<y>.txt')).toBe(resolve(root, 'x_y_.txt'));
    expect(targetIn(root, 'CON.txt')).toBe(resolve(root, '_CON.txt'));
  });
});

describe('copying to the person', () => {
  let base = '';
  let folders: ProjectFolders;
  let chat: Chat;
  let stored: StoredFile[] = [];

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'reality-folders-'));
    chat = {
      id: '11111111-aaaa',
      ownerId: null,
      kind: 'group',
      title: 'My timer',
      botIds: [],
      hostFolder: null,
      updatedAt: '',
    };
    folders = new ProjectFolders({
      pool: { query: () => Promise.resolve({ rows: [] }) } as unknown as pg.Pool,
      store: {
        get: () => Promise.resolve(chat),
        subject: () => Promise.resolve(chat.title),
        setHostFolder: (_: string, path: string) => {
          chat = { ...chat, hostFolder: path };
          return Promise.resolve();
        },
      } as unknown as ChatStore,
      computers: {} as BotComputers,
      files: {
        forStep: () => Promise.resolve(stored),
        filePath: (f: StoredFile) => join(base, 'store', f.name),
      } as unknown as FileStore,
      dataDir: join(base, 'data'),
      root: join(base, 'Reality'),
    });
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const deliver = async (text: string) => {
    await rm(join(base, 'store'), { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(base, 'store'), { recursive: true });
    await writeFile(join(base, 'store', 'board.kicad_pcb'), text);
    await writeFile(join(base, 'store', 'build.json'), '{}');
    stored = [
      { name: 'board.kicad_pcb', sizeBytes: text.length },
      { name: 'build.json', sizeBytes: 2 },
    ] as StoredFile[];
    await folders.deliverResult(chat.id, 'task', 'results/task');
  };

  it('creates the folder when there is something to show, without working files', async () => {
    stored = [{ name: 'notes.txt', sizeBytes: 1 }] as StoredFile[];
    await folders.deliverResult(chat.id, 'task', 'results/task');
    expect(chat.hostFolder).toBeNull();

    await deliver('one');
    expect(chat.hostFolder).toBe(join(base, 'Reality', 'My timer'));
    const dir = join(chat.hostFolder ?? '', 'results', 'task');
    expect(await readdir(dir)).toEqual(['board.kicad_pcb']);
  });

  it("replaces Reality's own version, but never a file the person changed", async () => {
    const dir = join(chat.hostFolder ?? '', 'results', 'task');
    const file = join(dir, 'board.kicad_pcb');
    await deliver('two');
    expect(await readFile(file, 'utf8')).toBe('two');

    await writeFile(file, 'mine');
    await deliver('three');
    expect(await readFile(file, 'utf8')).toBe('mine');
    expect(await readFile(join(dir, 'board (Reality).kicad_pcb'), 'utf8')).toBe('three');

    await deliver('four');
    expect(await readFile(file, 'utf8')).toBe('mine');
    expect(await readFile(join(dir, 'board (Reality).kicad_pcb'), 'utf8')).toBe('four');
    expect((await folders.status(chat)).files[0]).toMatchObject({
      path: 'results/task/board (Reality).kicad_pcb',
      state: 'beside-yours',
    });
  });

  it('gives no one a folder on this machine unless they run it', async () => {
    const before = chat;
    chat = { ...chat, ownerId: 'someone', hostFolder: null };
    await deliver('five');
    expect(chat.hostFolder).toBeNull();
    chat = before;
    expect(existsSync(before.hostFolder ?? '')).toBe(true);
  });
});
