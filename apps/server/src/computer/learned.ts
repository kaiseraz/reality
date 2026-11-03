import type pg from 'pg';

/**
 * What bots taught themselves on their computers. A package a bot installed with success is
 * written to its own workspace (so it comes back after the computer restarts) and to a list per
 * person (so the next bot that needs the same field starts from what worked).
 */

export type Manager = 'apt' | 'pip' | 'conda';
export interface Install {
  manager: Manager;
  package: string;
}

const APT_NAME = /^[a-z0-9][a-z0-9.+-]{0,99}$/;
const PIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Options that take the next word as their value, so that word is no package. */
const TAKES_VALUE = new Set([
  '-r',
  '--requirement',
  '-e',
  '--editable',
  '-t',
  '--target',
  '-i',
  '--index-url',
  '--extra-index-url',
  '-c',
  '--constraint',
  '--channel',
  '-n',
  '--name',
  '-p',
  '--prefix',
  '-o',
  '--option',
]);

const PATTERNS: { manager: Manager; re: RegExp }[] = [
  { manager: 'apt', re: /\b(?:apt-get|apt)\s+(?:-\S+\s+)*install\b([^;&|\n]*)/g },
  { manager: 'pip', re: /\b(?:pip3?|python3?\s+-m\s+pip)\s+install\b([^;&|\n]*)/g },
  { manager: 'conda', re: /\b(?:conda|mamba|micromamba)\s+install\b([^;&|\n]*)/g },
];

/** The packages a shell command installs, read from its apt-get, pip and conda calls. */
export function installsIn(command: string): Install[] {
  const found: Install[] = [];
  for (const { manager, re } of PATTERNS) {
    for (const m of command.matchAll(re)) {
      const words = (m[1] ?? '').trim().split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i++) {
        const w = words[i] as string;
        if (w.startsWith('-')) {
          if (TAKES_VALUE.has(w)) i++;
          continue;
        }
        if (w.startsWith('2>') || w.startsWith('>') || w.includes('/')) break;
        // pymol=2.5.0, numpy>=2, biopython[extras]: the package is the name in front.
        const name = w.replace(/^['"]|['"]$/g, '').split(/[=<>!~[]/)[0] ?? '';
        const ok = manager === 'apt' ? APT_NAME.test(name) : PIP_NAME.test(name);
        if (ok && !found.some((f) => f.manager === manager && f.package === name)) {
          found.push({ manager, package: name });
        }
      }
    }
  }
  return found;
}

/** One line per package, as the restore list on a bot's computer keeps them. */
export const installLine = (i: Install) => `${i.manager} ${i.package}`;

export function parseInstallLines(text: string): Install[] {
  const out: Install[] = [];
  for (const line of text.split('\n')) {
    const [manager, pkg] = line.trim().split(/\s+/);
    if ((manager === 'apt' || manager === 'pip' || manager === 'conda') && pkg) {
      const ok = manager === 'apt' ? APT_NAME.test(pkg) : PIP_NAME.test(pkg);
      if (ok) out.push({ manager, package: pkg });
    }
  }
  return out;
}

/**
 * The commands that bring a list of packages back, one package at a time: one that no longer
 * exists must not keep the others away. Each says "restored <name>" or "not restored <name>".
 */
export function restoreCommands(installs: Install[]): string[] {
  const of = (m: Manager) =>
    installs
      .filter((i) => i.manager === m)
      .map((i) => i.package)
      .join(' ');
  const each = (pkgs: string, install: string) =>
    `for p in ${pkgs}; do ${install} "$p" >/dev/null 2>&1 && echo "restored $p" || echo "not restored $p"; done`;
  const cmds: string[] = [];
  if (of('apt')) {
    cmds.push(
      each(
        of('apt'),
        'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends',
      ),
    );
  }
  if (of('pip')) cmds.push(each(of('pip'), 'python3 -m pip install -q'));
  if (of('conda')) cmds.push(each(of('conda'), 'conda install -y'));
  return cmds;
}

export interface LearnedTool {
  manager: Manager;
  package: string;
  program: string | null;
  opens: string[];
  uses: number;
}

const ownerKey = (ownerId: string | null) => ownerId ?? 'local';

export class LearnedTools {
  constructor(private readonly pool: pg.Pool) {}

  async installed(ownerId: string | null, installs: Install[]): Promise<void> {
    for (const i of installs) {
      await this.pool.query(
        `INSERT INTO learned_tools (owner_key, manager, package) VALUES ($1, $2, $3)
         ON CONFLICT (owner_key, manager, package)
         DO UPDATE SET uses = learned_tools.uses + 1, last_used = now()`,
        [ownerKey(ownerId), i.manager, i.package],
      );
    }
  }

  /**
   * A program opened a file of this type on a desktop. It is noted on the package that brought
   * the program; a program that came with the computer has none and is not noted.
   */
  async opened(ownerId: string | null, program: string, ext: string): Promise<void> {
    if (!ext) return;
    await this.pool.query(
      `UPDATE learned_tools
          SET program = $3,
              opens = CASE WHEN $4 = ANY(opens) THEN opens ELSE array_append(opens, $4) END,
              uses = uses + 1, last_used = now()
        WHERE owner_key = $1 AND (program = $3 OR package = $2)`,
      [ownerKey(ownerId), program, program, ext],
    );
  }

  async list(ownerId: string | null, limit = 20): Promise<LearnedTool[]> {
    const { rows } = await this.pool.query<LearnedTool>(
      `SELECT manager, package, program, opens, uses FROM learned_tools
        WHERE owner_key = $1 ORDER BY uses DESC, last_used DESC LIMIT $2`,
      [ownerKey(ownerId), limit],
    );
    return rows;
  }
}

/** The learned tools as lines for a bot's instructions. */
export function describeLearned(tools: LearnedTool[]): string {
  return tools
    .map((t) => {
      const how =
        t.manager === 'apt'
          ? `sudo apt-get install -y ${t.package}`
          : t.manager === 'pip'
            ? `pip install ${t.package}`
            : `conda install -y ${t.package}`;
      const shows = t.program
        ? `; opens ${t.opens.length ? t.opens.map((e) => `.${e}`).join(', ') : 'files'} with ${t.program}`
        : '';
      return `- ${t.package} (${how})${shows}; used ${t.uses}x`;
    })
    .join('\n');
}
