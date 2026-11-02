/**
 * Mouse and keyboard on a bot's desktop. The bot looks at its screen (computer_screen), then acts
 * (computer_input), the way a person does; this turns one action into xdotool calls. Everything
 * the model sends is checked here and quoted, since it ends up in a shell.
 */

export const SCREEN_WIDTH = 1280;
export const SCREEN_HEIGHT = 1024;

const ACTIONS = [
  'click',
  'double_click',
  'right_click',
  'move',
  'drag',
  'scroll',
  'type',
  'key',
] as const;
export type InputAction = (typeof ACTIONS)[number];

const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;

const coord = (v: unknown, max: number, name: string): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || n >= max) {
    throw new InputError(`${name} must be a pixel position from 0 to ${max - 1}.`);
  }
  return Math.round(n);
};

export class InputError extends Error {}

/** One action in words, for the activity list the user watches. */
export function describeInput(input: Record<string, unknown>): string {
  const at = `at ${String(input.x)}, ${String(input.y)}`;
  const text = typeof input.text === 'string' ? input.text.slice(0, 80) : '';
  switch (input.action) {
    case 'click_text':
      return `Clicks “${text}”`;
    case 'click':
      return `Clicks ${at}`;
    case 'double_click':
      return `Double-clicks ${at}`;
    case 'right_click':
      return `Right-clicks ${at}`;
    case 'move':
      return `Moves the pointer ${at}`;
    case 'drag':
      return `Drags from ${String(input.x)}, ${String(input.y)} to ${String(input.x2)}, ${String(input.y2)}`;
    case 'scroll':
      return `Scrolls ${input.direction === 'up' ? 'up' : 'down'} ${at}`;
    case 'type':
      return `Types “${text}”`;
    case 'key':
      return `Presses ${String(input.keys).slice(0, 60)}`;
    default:
      return 'Operates the desktop';
  }
}

/** The shell command for one action on display :99. Throws InputError on anything malformed. */
export function buildInputCommand(input: Record<string, unknown>): string {
  const action = input.action as InputAction;
  if (!ACTIONS.includes(action)) {
    throw new InputError(`Unknown action. Use one of: ${ACTIONS.join(', ')}.`);
  }
  const at = () =>
    `mousemove ${coord(input.x, SCREEN_WIDTH, 'x')} ${coord(input.y, SCREEN_HEIGHT, 'y')}`;
  const xdo = (args: string) => `DISPLAY=:99 xdotool ${args}`;
  switch (action) {
    case 'move':
      return xdo(at());
    case 'click':
      return xdo(`${at()} click 1`);
    case 'double_click':
      return xdo(`${at()} click --repeat 2 --delay 120 1`);
    case 'right_click':
      return xdo(`${at()} click 3`);
    case 'scroll': {
      const down = input.direction !== 'up';
      const amount = Math.max(1, Math.min(20, Math.round(Number(input.amount) || 3)));
      return xdo(`${at()} click --repeat ${amount} --delay 40 ${down ? 5 : 4}`);
    }
    case 'drag': {
      // In small steps: programs like KiCad's 3D viewer ignore one instant jump.
      const x1 = coord(input.x, SCREEN_WIDTH, 'x');
      const y1 = coord(input.y, SCREEN_HEIGHT, 'y');
      const x2 = coord(input.x2, SCREEN_WIDTH, 'x2');
      const y2 = coord(input.y2, SCREEN_HEIGHT, 'y2');
      const steps = 20;
      const path = Array.from({ length: steps }, (_, i) => {
        const t = (i + 1) / steps;
        return `mousemove ${Math.round(x1 + (x2 - x1) * t)} ${Math.round(y1 + (y2 - y1) * t)} sleep 0.03`;
      }).join(' ');
      return xdo(`mousemove ${x1} ${y1} mousedown 1 sleep 0.1 ${path} mouseup 1`);
    }
    case 'type': {
      const text = typeof input.text === 'string' ? input.text : '';
      if (!text) throw new InputError('Give the text to type.');
      if (text.length > 2000) throw new InputError('At most 2000 characters at once.');
      return xdo(`type --clearmodifiers --delay 15 -- ${quote(text)}`);
    }
    case 'key': {
      const keys = typeof input.keys === 'string' ? input.keys.trim() : '';
      if (!/^[A-Za-z0-9_+ -]{1,120}$/.test(keys)) {
        throw new InputError('Give keys like "ctrl+s", "Return" or "alt+3 Escape".');
      }
      return xdo(`key --clearmodifiers -- ${keys}`);
    }
  }
}

/** Menu text is too small for OCR at its real size, so the picture is enlarged first. */
const OCR_SCALE = 3;

/**
 * Text on the screen with its position: words as tesseract sees them, one per line of its table.
 * The columns travel with ~ between them, since the computer's shell turns tabs into spaces.
 */
export const READ_SCREEN_COMMAND = `DISPLAY=:99 scrot -o /tmp/reality-screen.png && convert /tmp/reality-screen.png -resize ${OCR_SCALE * 100}% /tmp/reality-screen-big.png && tesseract /tmp/reality-screen-big.png stdout --psm 11 tsv 2>/dev/null | tr '\\t' '~'`;

export interface ScreenText {
  text: string;
  x: number;
  y: number;
}

/**
 * Tesseract's TSV into phrases: neighbouring words on one line become one phrase ("Run DRC"), each
 * with the pixel centre of its words, which is where a click belongs.
 */
export function parseScreenText(tsv: string): ScreenText[] {
  interface Word {
    key: string;
    left: number;
    top: number;
    width: number;
    height: number;
    text: string;
  }
  const words: Word[] = [];
  for (const line of tsv.split('\n').slice(1)) {
    const c = line.trim().split('~');
    if (c.length < 12 || c[0] !== '5') continue;
    const text = c.slice(11).join('~').trim();
    const conf = Number(c[10]);
    if (!/[A-Za-z0-9]/.test(text) || !(conf >= 30)) continue;
    words.push({
      key: `${c[2]}.${c[3]}.${c[4]}`,
      left: Number(c[6]) / OCR_SCALE,
      top: Number(c[7]) / OCR_SCALE,
      width: Number(c[8]) / OCR_SCALE,
      height: Number(c[9]) / OCR_SCALE,
      text,
    });
  }
  const out: ScreenText[] = [];
  let run: Word[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const left = Math.min(...run.map((w) => w.left));
    const right = Math.max(...run.map((w) => w.left + w.width));
    const top = Math.min(...run.map((w) => w.top));
    const bottom = Math.max(...run.map((w) => w.top + w.height));
    out.push({
      text: run.map((w) => w.text).join(' '),
      x: Math.round((left + right) / 2),
      y: Math.round((top + bottom) / 2),
    });
    run = [];
  };
  for (const w of words) {
    const prev = run[run.length - 1];
    const gap = prev ? w.left - (prev.left + prev.width) : 0;
    const near = prev && prev.key === w.key && gap > -3 && gap < w.height * 1.2;
    if (!near) flush();
    run.push(w);
  }
  flush();
  return out;
}

/** Where a text is on the screen: an exact phrase first, then a phrase that contains it. */
export function findText(found: ScreenText[], wanted: string): ScreenText | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const w = norm(wanted);
  if (!w) return undefined;
  return found.find((f) => norm(f.text) === w) ?? found.find((f) => norm(f.text).includes(w));
}

/** Lists the open windows, so a bot knows what is on screen and which program is in front. */
export const WINDOWS_COMMAND = `DISPLAY=:99 sh -c 'A=$(xdotool getactivewindow 2>/dev/null); for w in $(xdotool search --onlyvisible --name ".+" 2>/dev/null); do n=$(xdotool getwindowname $w 2>/dev/null); [ "$w" = "$A" ] && echo "* $n" || echo "  $n"; done' | sort -u`;
