// Reality as a desktop app. One window, one entry: what Start.bat does — checking
// Node and Docker, starting Docker Desktop, the first-run installs, the database and
// the images for the sandboxes and the bots' computers — this main process does now,
// with every step shown in the window. The page itself stays the web app, isolated as
// in a browser; the system's own file explorer hands over only the chosen path.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');

// In development Reality runs on its own ports; a packaging later serves the built UI itself.
const UI = process.env.REALITY_URL ?? 'http://localhost:5173';
const API = process.env.REALITY_API ?? 'http://127.0.0.1:8787';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ok = async (url) => {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
};

let win = null;
/** The server this app started itself (not one that ran before); it ends with the app. */
let ownServer = null;

/** One line of progress in the window (the start itself can take minutes). */
function bootLog(line) {
  win?.webContents.send('desktop:boot', line);
}

/** A command on the PATH: true when it ends cleanly. `node` also means it is installed. */
const runCmd = (file, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true, cwd: root, ...opts });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });

/** True when the endpoint answers until the time runs out. */
async function untilReady(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok(url)) return true;
    await wait(500);
  }
  return false;
}

// IPC from the page: the folder explorer of the operating system. Only the chosen path
// crosses the bridge, as text; the web app then writes it on the chat as before.
ipcMain.handle('desktop:choose-folder', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender) ?? win, {
    title: 'Where should this work be saved?',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle('desktop:open-path', (_event, target) =>
  typeof target === 'string' && target ? shell.openPath(target) : null,
);

// A small page of this shell itself, shown while Reality comes up or when it cannot.
function pageHtml(title, lines, note) {
  const rows = [`<div style="font-size:26px;font-weight:600">${title}</div>`]
    .concat(
      lines.map(
        (l) => `<div style="font-size:15px;color:#e2dfd8;-webkit-margin-before:10px">${l}</div>`,
      ),
    )
    .concat(
      note
        ? [`<div style="font-size:13px;color:#6f6c66;-webkit-margin-before:14px">${note}</div>`]
        : [],
    )
    .join('');
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#101014;color:#8b8880;font-family:system-ui;display:grid;place-items:center;height:100vh;text-align:center"><div style="display:flex;flex-direction:column;gap:6px;max-width:640px;line-height:1.5">${rows}<div id="log" style="font-size:14px;color:#6f6c66;min-height:20px"></div><script>
  if (window.desktop) window.desktop.onBootLog(function (line) { var el = document.getElementById('log'); if (el) el.textContent = line; });
  </script></div></body>`;
}

async function showPage(title, lines, note) {
  if (!win) return;
  await win
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageHtml(title, lines, note))}`)
    .catch(() => undefined);
}

/** Docker may need bringing up first; returns false if it never answers. */
async function ensureDocker() {
  if (await runCmd('docker', ['info'])) return true;
  bootLog('Docker Desktop starts; this can take a minute…');
  const desktop = String(process.env.ProgramFiles ?? 'C:\\Program Files');
  const exe = path.join(desktop, 'Docker', 'Docker', 'Docker Desktop.exe');
  if (existsSync(exe)) {
    const child = spawn(exe, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
  for (let tries = 0; tries < 60; tries++) {
    await wait(3_000);
    if (await runCmd('docker', ['info'])) return true;
  }
  return false;
}

/** Which image carries the bots' computers, as .env says it (Start.bat reads the same). */
function computerImage() {
  try {
    const line = readFileSync(path.join(root, '.env'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('COMPUTER_IMAGE='));
    const value = line?.slice('COMPUTER_IMAGE='.length).trim();
    return value ? value : 'ghcr.io/agent-infra/sandbox:1.11.0';
  } catch {
    return 'ghcr.io/agent-infra/sandbox:1.11.0';
  }
}

function fail(title, note) {
  void showPage('Reality did not start.', [title], note);
  return true;
}

/** Everything Start.bat checked and built, before the server may start. */
async function prepareEnvironment() {
  if (!(await runCmd('node', ['-v']))) {
    return fail('Node.js is missing.', 'Please install Node 24: https://nodejs.org');
  }
  if (!(await runCmd('docker', ['info']))) {
    const up = await ensureDocker();
    if (!up) {
      return fail(
        'Docker does not answer.',
        'Please start Docker Desktop by hand and open Reality again.',
      );
    }
  } else if (!(await ensureDocker())) {
    return fail(
      'Docker does not answer.',
      'Please start Docker Desktop by hand and open Reality again.',
    );
  }
  bootLog('Docker is up.');

  // First start: packages and settings.
  if (!existsSync(path.join(root, 'node_modules'))) {
    bootLog('First start: installing the packages, a few minutes…');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    if (!(await runCmd(npm, ['install', '--no-audit', '--no-fund']))) {
      return fail(
        'The packages could not be installed.',
        'Run `npm install` in the Reality folder and read what it says.',
      );
    }
  }
  if (!existsSync(path.join(root, '.env'))) {
    copyFileSync(path.join(root, '.env.example'), path.join(root, '.env'));
    bootLog('Settings created as .env — put META_MODEL_API_KEY in it for Muse Spark.');
  }

  // The database.
  bootLog('Starting the database…');
  if (!(await runCmd('docker', ['compose', 'up', '-d', '--wait', 'postgres']))) {
    return fail(
      'Postgres could not be started.',
      'Run `docker compose up -d --wait postgres` and read what it says.',
    );
  }
  bootLog('The database is up.');

  // The sandbox images for analyses, built once.
  for (const [image, dir, note] of [
    [
      'reality-sandbox-python:dev',
      'sandbox/python',
      'First start: building the analysis sandbox, a few minutes…',
    ],
    ['reality-sandbox-node:dev', 'sandbox/node', 'First start: building the Node-tools sandbox…'],
  ]) {
    if (await runCmd('docker', ['image', 'inspect', image])) continue;
    bootLog(note);
    if (!(await runCmd('docker', ['build', '-t', image, dir]))) {
      return fail(
        `The image ${image} could not be built.`,
        'Check Docker and the files under sandbox/.',
      );
    }
  }
  bootLog('The sandbox is ready.');

  // The bots' computers, built once (about 12 GB). If it fails, Reality still runs.
  const image = computerImage();
  if (image === 'reality-computer:dev' && (await runCmd('docker', ['image', 'inspect', image]))) {
    // A built image gets changes to its build plan, without a change this takes seconds.
    await runCmd('docker', ['build', '-q', '-t', 'reality-computer:dev', 'sandbox/computer']);
  }
  if (!(await runCmd('docker', ['image', 'inspect', image]))) {
    bootLog('First start: building the bots’ computers with KiCad and FreeCAD, about 12 GB…');
    const built =
      image === 'reality-computer:dev'
        ? await runCmd('docker', ['build', '-t', image, 'sandbox/computer'])
        : await runCmd('docker', ['pull', image]);
    if (!built) {
      bootLog(
        `The computer image ${image} is missing; Reality runs without bot computers for now.`,
      );
      return null;
    }
  }
  bootLog('The bots’ computers are ready.');
  return null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Reality',
    backgroundColor: '#101014',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.on('closed', () => {
    win = null;
  });
  return win;
}

// The startup chain of the only window this app has.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    if (app.isPackaged) Menu.setApplicationMenu(null);
    createWindow();
    await showPage('Reality', ['Starts…']);

    const problem = await prepareEnvironment();
    if (problem) return;
    // The server may already run (a terminal with `npm run dev`); if not, this app starts it.
    if (!(await ok(`${API}/api/health`))) {
      bootLog('Starting Reality…');
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      ownServer = spawn(npm, ['run', 'dev'], {
        cwd: root,
        stdio: 'ignore',
        windowsHide: true,
      });
      ownServer.on('error', () => undefined);
    }
    const up = (await untilReady(`${API}/api/health`, 120_000)) && (await untilReady(UI, 120_000));
    if (up) await win.loadURL(UI).catch(() => undefined);
    else
      await fail(
        'Reality did not come up.',
        'Start it by hand with `npm run dev` and read what it says.',
      );
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    // A server this app started itself ends with it; one that ran before is kept.
    ownServer?.kill();
  });
}
