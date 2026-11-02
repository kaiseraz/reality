import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import type { FileStore, StoredFile } from '../artifacts/file-store.ts';
import type { BotComputers } from '../computer/computers.ts';
import { buildLabCode, getLabEngine } from './engines.ts';
import { LIVE_EVENTS, LIVE_PLUGIN, LIVE_THEME, partsBeside, USE_LIVE_THEME } from './pcb-live.ts';
import { describeMotorSim, MOTOR_SIM } from './pcb-sim.ts';

/**
 * Lab results on the bot's own desktop. The lab runs in a sandbox and keeps its files in
 * Reality's file store; a bot's computer is a separate machine the user watches live. This
 * carries a result across and opens it in the real program: a board in KiCad (first as it
 * stood after placement, with the ratsnest showing what is still to connect, then routed), an
 * assembly in FreeCAD (part by part into one open window, so it grows on screen). Only text
 * files travel (board, 3D models, Gerber, drill, STEP, BREP); big ones are compressed on the way.
 */

const TEXT_FILE = /\.(kicad_pcb|wrl|gtl|gbl|gko|drl|step|stp|brep)$|^electrical_check\.txt$/i;
const MAX_BYTES = 80 * 1024 * 1024;
const PLAIN_BELOW = 150_000;
const CHUNK = 40_000;
const HOME = '/home/gem/workspace';

type Desk = Pick<BotComputers, 'running' | 'writeFile' | 'exec' | 'log'>;
type Files = Pick<FileStore, 'forStep' | 'filePath'>;

const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ShowOptions {
  boot?: boolean;
  pauseMs?: number;
  view3dAfterMs?: number;
  firstRunAfterMs?: number;
  loadMs?: number;
  raytraceMs?: number;
  /** Longest wait for a window to load, in seconds. */
  loadSeconds?: number;
  /** Also leaves the result here, where the whole team and the person's folder get it. */
  keepIn?: string;
  /** Called when a stage is on the screen. */
  onStep?: (step: 'parts' | 'placed' | 'routed' | '3d') => Promise<void>;
}

export interface DesktopResult {
  /** The folder on the computer holding the files. */
  dir: string;
  /** What was opened, in order. */
  opened: string[];
  /** Files copied over. */
  copied: string[];
  /** What KiCad's own rule check said about a board with copper planes. */
  kicadCheck?: string;
  /** What the SPICE run of the board's own netlist found, for a board with a bench. */
  motorSim?: string;
}

/**
 * A FreeCAD script that builds the assembly on screen one part at a time: the whole thing is read
 * once from the BREP file, then each part becomes its own object, coloured by group, the inside
 * first and the shell last and see-through. The screen repaints as often as it can keep up (at
 * most ten times a second); on a desktop without a graphics card a repaint takes longer as the
 * scene grows, so late in the build several parts can arrive in one repaint.
 */
export function buildLiveScript(dir: string): string {
  return [
    `base = ${JSON.stringify(dir)}`,
    '# Builds the assembly in FreeCAD part by part, coloured by group, so it grows on screen.',
    'import json, time',
    'import FreeCAD, FreeCADGui, Part',
    'build = json.load(open(base + "/build.json"))',
    'log = open(base + "/live.log", "w")',
    'prefs = FreeCAD.ParamGet("User parameter:BaseApp/Preferences/View")',
    'prefs.SetBool("Simple", False)',
    'prefs.SetBool("Gradient", True)',
    'prefs.SetUnsigned("BackgroundColor2", 0x1a2233ff)',
    'prefs.SetUnsigned("BackgroundColor3", 0x0b0e14ff)',
    'doc = FreeCAD.newDocument("Assembly")',
    'FreeCADGui.updateGui()',
    'whole = Part.Shape()',
    'whole.importBrep(base + "/" + build["file"])',
    'shapes = whole.childShapes()',
    'if len(shapes) != len(build["parts"]):',
    '    log.write("parts do not match: %d shapes, %d names\\n" % (len(shapes), len(build["parts"]))); log.close()',
    '    raise SystemExit("The parts file and its list differ.")',
    '# The inside first, the shell last and see-through.',
    'SHELL = ("casing", "nacelle", "fairing", "shell", "housing")',
    'ORDER = ["shafts", "fan", "compressor", "combustor", "turbine", "exhaust", "accessories", "casing", "nacelle"]',
    'def rank(g):',
    '    if g in ORDER: return ORDER.index(g)',
    '    return len(ORDER) if g in SHELL else -1',
    'todo = sorted(range(len(shapes)), key=lambda i: rank(build["parts"][i]["group"]))',
    '# The camera looks at the finished size from the start, so the machine grows in place.',
    'view = FreeCADGui.activeDocument().activeView()',
    'bb = whole.BoundBox',
    'frame = doc.addObject("Part::Feature", "Frame")',
    'frame.Shape = Part.makeBox(bb.XLength, bb.YLength, bb.ZLength, FreeCAD.Vector(bb.XMin, bb.YMin, bb.ZMin))',
    'view.viewIsometric()',
    'view.fitAll()',
    'doc.removeObject("Frame")',
    'FreeCADGui.updateGui()',
    'folders = {}',
    'last_paint = 0.0',
    'pause = 0.1',
    'for done, i in enumerate(todo, 1):',
    '    info = build["parts"][i]',
    '    g = info["group"]',
    '    if g not in folders:',
    '        folders[g] = doc.addObject("App::DocumentObjectGroup", "".join(c if c.isalnum() else "_" for c in g) or "group")',
    '        folders[g].Label = g',
    '    o = doc.addObject("Part::Feature", "".join(c if c.isalnum() else "_" for c in info["name"]) or "part")',
    '    o.Label = info["name"]',
    '    o.Shape = shapes[i]',
    '    folders[g].addObject(o)',
    '    rgb = tuple(build["colors"].get(g) or (0.7, 0.7, 0.7))',
    '    vo = o.ViewObject',
    '    vo.ShapeColor = rgb',
    '    try:',
    '        vo.ShapeMaterial = FreeCAD.Material(DiffuseColor=rgb, AmbientColor=tuple(c * 0.35 for c in rgb), SpecularColor=(0.55, 0.55, 0.55), Shininess=0.45)',
    '    except Exception:',
    '        pass',
    '    vo.DisplayMode = "Shaded"',
    '    if g in SHELL:',
    '        vo.Transparency = 72',
    '    now = time.time()',
    '    if now - last_paint >= pause:',
    '        FreeCADGui.updateGui()',
    '        pause = max(0.1, (time.time() - now) * 1.5)',
    '        last_paint = time.time()',
    '        log.write("part %d of %d: %s\\n" % (done, len(todo), info["name"])); log.flush()',
    'view.viewIsometric()',
    'view.fitAll()',
    'FreeCADGui.updateGui()',
    'log.write("done\\n"); log.close()',
    '',
  ].join('\n');
}

/** What each bot's desktop is busy showing: one thing at a time, and nobody operates it meanwhile. */
const showing = new Map<string, Promise<unknown>>();

/** The task each bot's desktop last showed, so asking again does not start over. */
const lastShown = new Map<string, string>();

/** Whether this task is the one already brought onto this bot's desktop. */
export function alreadyShown(botId: string, taskId: string): boolean {
  return lastShown.get(botId) === taskId;
}

/**
 * The finished board stays clean on the screen until someone goes to work there: then KiCad's menus
 * come back where a bot expects them, and its window gets the whole screen again.
 */
export const KICAD_MENUS_BACK = `[ -f ${LIVE_EVENTS} ] && echo '{"kind": "chrome", "show": true}' >> ${LIVE_EVENTS}; true`;

/** Resolves when no result is being brought onto this bot's desktop any more. */
export async function desktopReady(botId: string): Promise<void> {
  await showing.get(botId)?.catch(() => undefined);
}

export class LabDesktop {
  constructor(private readonly deps: { computers: Desk; files: Files }) {}

  /**
   * Copies the files of a lab task to the bot's computer and opens the main one. Without
   * `boot` it only does so when the computer is already running (a finished simulation does
   * not wake a machine nobody watches). Returns null when there is nothing to show.
   */
  async show(botId: string, taskId: string, opts: ShowOptions = {}): Promise<DesktopResult | null> {
    const before = showing.get(botId) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(() => this.showNow(botId, taskId, opts));
    showing.set(botId, run);
    try {
      const shown = await run;
      if (shown) lastShown.set(botId, taskId);
      return shown;
    } finally {
      if (showing.get(botId) === run) showing.delete(botId);
    }
  }

  private async showNow(
    botId: string,
    taskId: string,
    opts: ShowOptions,
  ): Promise<DesktopResult | null> {
    const { computers, files } = this.deps;
    if (!opts.boot && !computers.running().includes(botId)) return null;
    const all = await files.forStep(taskId, 'simulate');
    const usable = all.filter(
      (f) => (TEXT_FILE.test(f.name) || f.name === 'build.json') && f.sizeBytes <= MAX_BYTES,
    );
    const byName = new Map(usable.map((f) => [f.name, f] as const));
    // A re-check after a hand edit: the board is already open on the desktop, leave it alone.
    if (byName.has('original.kicad_pcb')) return null;
    const staged = byName.has('build.json') && byName.has('parts.brep');
    // With the parts file, the big STEP file stays behind: it carries the same parts.
    const wanted = staged ? usable.filter((f) => f.name !== 'assembly.step') : usable;
    const main = byName.get('board.kicad_pcb') ?? byName.get('assembly.step');
    if (!main) return null;

    const dir = `${HOME}/lab-${taskId.slice(0, 8)}`;
    const copied: string[] = [];
    for (const f of wanted) {
      await this.push(botId, `${dir}/${f.name}`, await this.read(f));
      copied.push(f.name);
    }
    if (opts.keepIn) {
      const keep = copied.filter(
        (n) =>
          n !== 'build.json' &&
          n !== 'parts.brep' &&
          !n.startsWith('stage_') &&
          !/\.(gtl|gbl|gko|drl)$/.test(n),
      );
      await computers.exec(
        botId,
        `mkdir -p ${quote(opts.keepIn)} && cp ${keep.map((n) => quote(`${dir}/${n}`)).join(' ')} ${quote(opts.keepIn)}`,
        60,
        false,
      );
    }

    const opened: string[] = [];
    let kicadCheck: string | undefined;
    let motorSim: string | undefined;
    const keys = (title: string, keysToPress: string) =>
      computers.exec(
        botId,
        `DISPLAY=:99 xdotool search --name ${quote(title)} windowactivate --sync key --clearmodifiers ${keysToPress} || true`,
        30,
        false,
      );
    /** Waits until a window whose title matches exists: KiCad shows the file name once it has loaded. */
    const waitForWindow = (title: string, seconds: number) =>
      computers.exec(
        botId,
        `DISPLAY=:99 sh -c 'for i in $(seq 1 ${seconds}); do xdotool search --name ${JSON.stringify(title)} >/dev/null 2>&1 && break; sleep 1; done; true'`,
        seconds + 20,
        false,
      );
    const launch = async (command: string, label: string, path: string) => {
      await computers.exec(
        botId,
        `DISPLAY=:99 nohup ${command} >/tmp/open.log 2>&1 & echo opened`,
        30,
        false,
      );
      await computers.log(botId, 'command', `Opened ${path} on the desktop`, { file: path });
      opened.push(label);
    };
    /** Opens a board in the PCB editor, waits for it to load and fits it to the window. */
    const openBoard = async (name: string) => {
      // One board at a time; a killed KiCad leaves a lock file that would ask a question later.
      await computers.exec(
        botId,
        `pkill -x pcbnew; sleep 1; rm -f ${quote(dir)}/~*.lck; true`,
        15,
        false,
      );
      await launch(`pcbnew ${quote(`${dir}/${name}`)}`, name, `${dir}/${name}`);
      // A very first start can still ask how to configure KiCad: answer with the default (Enter).
      await sleep(opts.firstRunAfterMs ?? 6000);
      await keys('Configure KiCad Settings Path', 'Return');
      await waitForWindow(
        `^${name.replace(/.kicad_pcb$/, '')}.*PCB Editor`,
        opts.loadSeconds ?? 120,
      );
      await sleep(opts.loadMs ?? 1500);
      await keys('PCB Editor', 'Home');
    };

    if (main.name === 'board.kicad_pcb') {
      const design = all.find((f) => f.name === 'design.json');
      const engine = getLabEngine('pcb_design');
      const designed = (design ? JSON.parse(await this.read(design)) : {}) as {
        route_attempts?: number;
        route_order?: string[];
      };
      const attempts = designed.route_attempts ?? 0;
      delete designed.route_attempts;
      delete designed.route_order;
      const code = design && engine ? buildLabCode(engine, designed) : { error: '' };
      const checked = await this.read(main);
      if ('error' in code) {
        await openBoard(main.name);
        await sleep(opts.view3dAfterMs ?? 5000);
        await keys('PCB Editor', 'alt+3');
        await waitForWindow('3D Viewer', 60);
        await computers.exec(
          botId,
          `DISPLAY=:99 sh -c 'W=$(xdotool search --name "3D Viewer" | head -1); [ -n "$W" ] && xdotool windowmove $W 0 0 windowsize $W 1280 1000' || true`,
          30,
        );
        opened.push('3D viewer');
      } else {
        // KiCad gets its plugin and colours before it starts, and opens the board with nothing done
        // yet. The 3D viewer sits beside it, as the second half of the screen.
        const live = `${dir}/build_board.py`;
        await computers.exec(
          botId,
          `mkdir -p ~/.local/share/kicad/8.0/scripting/plugins ~/.config/kicad/8.0/colors $(dirname ${LIVE_EVENTS}); : > ${LIVE_EVENTS}; rm -f ${LIVE_EVENTS}.saved; sudo mkdir -p /output && sudo chown gem /output && rm -rf /output/*; cp ${quote(`${dir}/${main.name}`)} ${quote(`${dir}/checked.kicad_pcb`)}`,
          30,
          false,
        );
        await computers.writeFile(
          botId,
          '/home/gem/.local/share/kicad/8.0/scripting/plugins/reality_live.py',
          LIVE_PLUGIN,
        );
        await computers.writeFile(
          botId,
          '/home/gem/.config/kicad/8.0/colors/reality.json',
          LIVE_THEME,
        );
        // KiCad's 3D viewer takes its colours from the theme named "user".
        await computers.writeFile(
          botId,
          '/home/gem/.config/kicad/8.0/colors/user.json',
          LIVE_THEME,
        );
        await computers.writeFile(botId, `${dir}/use_theme.py`, USE_LIVE_THEME);
        await computers.exec(botId, `python3 ${quote(`${dir}/use_theme.py`)}`, 20, false);
        await computers.writeFile(botId, live, code.code);
        await computers.writeFile(botId, `${dir}/${main.name}`, partsBeside(checked));
        await openBoard(main.name);
        const tile = (title: string, x: number, y: number, width: number, height: number) =>
          computers.exec(
            botId,
            `DISPLAY=:99 sh -c 'for W in $(xdotool search --onlyvisible --name ${JSON.stringify(title)}); do xdotool windowstate --remove MAXIMIZED_VERT --remove MAXIMIZED_HORZ $W; xdotool windowmove $W ${x} ${y} windowsize $W ${width} ${height}; done' || true`,
            30,
            false,
          );
        await keys('PCB Editor', 'alt+3');
        await waitForWindow('3D Viewer', 60);
        // Just the two pictures: KiCad's menus and toolbars go while it builds, its counters stay at
        // the bottom. They come back when it is done.
        await computers.exec(
          botId,
          `echo '{"kind": "chrome", "show": false}' >> ${LIVE_EVENTS}`,
          20,
          false,
        );
        await sleep(opts.loadMs ?? 1500);
        await tile('PCB Editor', 0, 0, 1280, 1000);
        await tile('3D Viewer', 660, 0, 620, 1000);
        // Stays in front when KiCad gets a key press, or the picture would flicker.
        await computers.exec(
          botId,
          `DISPLAY=:99 sh -c 'for W in $(xdotool search --onlyvisible --name "3D Viewer"); do xdotool windowstate --add ABOVE $W; done' || true`,
          20,
          false,
        );
        await sleep(opts.loadMs ?? 1500);
        // Fits what is there, the parts beside the board included.
        await keys('PCB Editor', 'ctrl+Home');
        await keys('PCB Editor', 'alt+3');
        // The viewer opens too close: a few turns of the wheel show the whole board.
        await computers.exec(
          botId,
          `DISPLAY=:99 sh -c 'W=$(xdotool search --name "3D Viewer" | head -1); [ -n "$W" ] && { xdotool mousemove --window $W 300 500; for i in 1 2 3 4 5 6; do xdotool click 5; sleep 0.3; done; }' || true`,
          30,
          false,
        );
        opened.push('3D viewer');
        await opts.onStep?.('parts');

        // The build itself: the same program that made the checked board, now on this computer.
        await computers.exec(
          botId,
          `pkill -f build_board.py; cd /output && REALITY_ATTEMPTS=${attempts} REALITY_LIVE=${LIVE_EVENTS} nohup python3 ${quote(live)} >/tmp/build_board.log 2>&1 & echo started`,
          30,
          false,
        );
        // Escape brings KiCad's own counters up to date, Alt+3 reloads the 3D view and raises it.
        const reload3d = async () => {
          await keys('PCB Editor', 'Escape');
          await keys('PCB Editor', 'alt+3');
        };
        let shownPlaced = false;
        let finished = false;
        for (let i = 0; i < 240 && !finished; i++) {
          await sleep(2500);
          const seen = await computers.exec(
            botId,
            `grep -c '"kind": "route"' ${LIVE_EVENTS}; grep -c '"kind": "placed"' ${LIVE_EVENTS}; grep -c '"kind": "done"' ${LIVE_EVENTS}; pgrep -f build_board.py >/dev/null && echo run || echo end`,
            20,
            false,
          );
          const [, placed, done, state] = seen.output.trim().split(/\s+/);
          finished = done !== '0' || state === 'end';
          if (placed !== '0' && !shownPlaced) {
            shownPlaced = true;
            await sleep(500);
            await keys('PCB Editor', 'ctrl+Home');
            await reload3d();
            await opts.onStep?.('placed');
          } else if (i % 12 === 11) {
            await reload3d();
          }
        }
        // KiCad fills the copper pours and saves; pours can take a while on a big board.
        for (let i = 0; i < 48; i++) {
          const saved = await computers.exec(
            botId,
            `[ -f ${LIVE_EVENTS}.saved ] && echo saved || echo waiting`,
            20,
            false,
          );
          if (saved.output.includes('saved') || !saved.output.trim()) break;
          await sleep(2500);
        }
        await reload3d();
        // Byte for byte the board that passed the check, or not: the file store knows its checksum.
        const built = await computers.exec(botId, 'sha256sum /output/board.kicad_pcb', 20, false);
        const sameBoard = { output: built.output.includes(main.sha256) ? 'same' : 'different' };
        const poured = /"pours"\s*:\s*\[\s*\{/.test(design ? await this.read(design) : '');
        if (poured && sameBoard.output.includes('same')) {
          // What KiCad saved has the pours in it, so KiCad's own rule check judges that file, and
          // the person gets it with fabrication files that include the copper.
          const out = await computers.exec(
            botId,
            `cd ${quote(dir)} && kicad-cli pcb drc --format json -o kicad_drc.json ${quote(main.name)} >/dev/null 2>&1; mkdir -p gerber && kicad-cli pcb export gerbers -o gerber/ ${quote(main.name)} >/dev/null 2>&1; kicad-cli pcb export drill -o gerber/ ${quote(main.name)} >/dev/null 2>&1; ${opts.keepIn ? `cp ${quote(main.name)} kicad_drc.json ${quote(opts.keepIn)}/ && cp -r gerber ${quote(opts.keepIn)}/; ` : ''}python3 -c "import json;d=json.load(open('kicad_drc.json'));v=[x for x in d.get('violations',[]) if not x['type'].startswith('silk')];u=d.get('unconnected_items',[]);print('RESULT',len(v),len(u),len(d.get('violations',[]))-len(v),'; '.join(sorted(set(x['type']+': '+x['items'][0]['description'][:60] for x in v+u)))[:400])"`,
            120,
            false,
          );
          const said = /RESULT (\d+) (\d+) (\d+) ?(.*)/.exec(out.output);
          kicadCheck = !said
            ? "KiCad's own rule check did not finish, so the board with its copper planes is unjudged."
            : said[1] === '0' && said[2] === '0'
              ? `KiCad's own rule check on the board with its copper planes: no violations, nothing unconnected${said[3] === '0' ? '' : ` (${said[3]} notes about labels lying over copper, which change nothing electrically)`}. The report is kicad_drc.json in the project folder.`
              : `KiCad's own rule check on the board with its copper planes: ${said[1]} warnings or violations, ${said[2]} unconnected (${said[4]}). The report is kicad_drc.json in the project folder.`;
          await computers.log(botId, 'command', kicadCheck, {});
          // A design with a bench: SPICE runs the board's own nets, with the library KiCad brought along.
          if (design && /"bench"\s*:/.test(await this.read(design))) {
            await computers.writeFile(botId, `${dir}/design.json`, await this.read(design));
            await computers.writeFile(botId, `${dir}/simulate_motor.py`, MOTOR_SIM);
            const sim = await computers.exec(
              botId,
              `cd ${quote(dir)} && rm -f motor_simulation.json && timeout 280 python3 simulate_motor.py design.json . >/tmp/motor_sim.out 2>&1; cat motor_simulation.json 2>/dev/null; ${opts.keepIn ? `cp motor_simulation.json motor_simulation.svg ${quote(opts.keepIn)}/ 2>/dev/null; ` : ''}rm -f motor_sim.dat; true`,
              300,
              false,
            );
            const raw = sim.output.slice(sim.output.indexOf('{'));
            try {
              motorSim = describeMotorSim(raw);
            } catch {
              motorSim = 'The SPICE simulation of this board did not finish, so it says nothing.';
            }
            await computers.log(botId, 'command', motorSim, {});
          }
        } else {
          // The file on disk is the checked board; a build that came out differently gives way to it.
          await computers.exec(
            botId,
            `cp ${quote(`${dir}/checked.kicad_pcb`)} ${quote(`${dir}/${main.name}`)}`,
            20,
            false,
          );
        }
        if (!sameBoard.output.includes('same')) {
          await computers.log(
            botId,
            'command',
            'The live build differed: showing the checked board',
            {},
          );
          await openBoard(main.name);
        }
      }
      await opts.onStep?.('routed');
      await computers.exec(
        botId,
        `DISPLAY=:99 sh -c 'for W in $(xdotool search --onlyvisible --name "3D Viewer"); do xdotool windowstate --remove ABOVE $W; done' || true`,
        20,
        false,
      );
      // Seen at an angle like a product shot: drag with the left button in small steps (one
      // instant jump is ignored by the viewer).
      await computers.exec(
        botId,
        `DISPLAY=:99 sh -c 'W=$(xdotool search --name "3D Viewer" | head -1); [ -n "$W" ] && { xdotool windowactivate --sync $W; xdotool mousemove --window $W 250 600; sleep 0.3; xdotool mousedown 1; for i in $(seq 1 20); do xdotool mousemove_relative -- 4 -3; sleep 0.04; done; xdotool mouseup 1; xdotool mousemove --window $W 30 880; sleep 0.3; xdotool mousemove_relative 3 3; }' || true`,
        45,
      );
      // The finished picture comes from KiCad's raytracer, which takes a moment without a graphics card.
      await computers.exec(botId, `echo '{"kind": "raytrace"}' >> ${LIVE_EVENTS}`, 20, false);
      await sleep(opts.raytraceMs ?? 45_000);
      await opts.onStep?.('3d');
    } else if (staged) {
      const script = `${dir}/build_live.py`;
      await computers.writeFile(botId, script, buildLiveScript(dir));
      await launch(`freecad ${quote(script)}`, 'build_live.py', script);
    } else {
      await launch(`freecad ${quote(`${dir}/${main.name}`)}`, main.name, `${dir}/${main.name}`);
    }
    return {
      dir,
      opened,
      copied,
      ...(kicadCheck ? { kicadCheck } : {}),
      ...(motorSim ? { motorSim } : {}),
    };
  }

  /** Small files go straight over; big ones are compressed and unpacked on the computer. */
  private async push(botId: string, path: string, text: string): Promise<void> {
    const { computers } = this.deps;
    if (text.length <= PLAIN_BELOW) {
      await computers.writeFile(botId, path, text);
      return;
    }
    const b64 = gzipSync(Buffer.from(text, 'utf8')).toString('base64');
    const gz = `${path}.gz`;
    const dir = path.slice(0, path.lastIndexOf('/'));
    await computers.exec(botId, `mkdir -p ${quote(dir)} && rm -f ${quote(gz)}`, 30);
    for (let i = 0; i < b64.length; i += CHUNK) {
      await computers.exec(
        botId,
        `printf %s ${quote(b64.slice(i, i + CHUNK))} | base64 -d >> ${quote(gz)}`,
        60,
      );
    }
    await computers.exec(botId, `gunzip -f ${quote(gz)}`, 120);
    await computers.log(botId, 'file', `Wrote ${path}`, { bytes: text.length, compressed: true });
  }

  private async read(f: StoredFile): Promise<string> {
    return readFile(this.deps.files.filePath(f), 'utf8');
  }
}
