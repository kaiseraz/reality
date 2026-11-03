import { projectFolder } from '../computer/computers.ts';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  ContractCheck,
  type BotView,
  type ChatCard,
  type ContractStatus,
  type TeamMember,
} from '@reality/schemas';
import { ROLE_LOOK, type BotService } from '../bots/bots.ts';
import type { ChatStore, Chat } from '../chat/store.ts';
import type { BotComputers } from '../computer/computers.ts';
import type { CheckResult } from '../orchestrator/graph.ts';
import type { TaskService } from '../tasks/task-service.ts';

/**
 * The team behind the lead. The lead proposes specialists for a job; once the person hires
 * the team, every specialist gets a contract: a mission, a deliverable, a budget and a check
 * that code runs. A bot never declares its own contract met, and neither does the lead.
 * Specialists rest between jobs with their record (met and failed contracts, counted by
 * code) and the skills they saved, so the lead can hire proven bots again.
 */

export interface Contract {
  id: string;
  chatId: string;
  botId: string;
  mission: string;
  deliverable: string;
  check: ContractCheck;
  deadline: string;
  status: ContractStatus;
  evidence: string;
  cardMessageId: number | null;
  boardTaskId: number | null;
}

interface ContractRow {
  id: string;
  chat_id: string;
  bot_id: string;
  mission: string;
  deliverable: string;
  check_spec: ContractCheck;
  deadline: Date;
  status: ContractStatus;
  evidence: string;
  card_message_id: string | null;
  board_task_id: number | null;
}

const toContract = (r: ContractRow): Contract => ({
  id: r.id,
  chatId: r.chat_id,
  botId: r.bot_id,
  mission: r.mission,
  deliverable: r.deliverable,
  check: r.check_spec,
  deadline: r.deadline.toISOString(),
  status: r.status,
  evidence: r.evidence,
  cardMessageId: r.card_message_id === null ? null : Number(r.card_message_id),
  boardTaskId: r.board_task_id,
});

export interface Skill {
  name: string;
  description: string;
  filename: string;
  createdBy: string | null;
  uses: number;
}

/** A check in words, for the contract card and the bot's brief. */
export function describeCheck(c: ContractCheck): string {
  switch (c.type) {
    case 'command':
      return `\`${c.command}\` exits 0 on its computer`;
    case 'file':
      return `${c.path} exists on its computer${c.contains ? ` and contains "${c.contains}"` : ''}`;
    case 'task':
      return 'a Reality task it started passes independent verification';
    case 'review':
      return c.command
        ? `\`${c.command}\` exits 0 on its computer, and then you accept it`
        : 'you accept it';
  }
}

/**
 * The shell test behind a file check. A leading ~ has to stay outside the quotes, or the shell
 * looks for a folder literally named "~". STEP files shout their keywords, so case does not count.
 */
export function fileCheckCommand(path: string, contains?: string): string {
  const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
  const file = /^~(\/|$)/.test(path) ? `"$HOME"${quote(path.slice(1))}` : quote(path);
  const text = contains
    ? `elif ! grep -qiF -- ${quote(contains)} ${file}; then echo NO_TEXT; false; `
    : '';
  return `if ! test -s ${file}; then echo NO_FILE; false; ${text}fi`;
}

export class TeamError extends Error {}

export class TeamService {
  constructor(
    private readonly deps: {
      pool: pg.Pool;
      bots: BotService;
      store: ChatStore;
      tasks: TaskService;
      computers: BotComputers | null;
      log?: { error: (obj: unknown, msg?: string) => void };
    },
  ) {}

  private get pool() {
    return this.deps.pool;
  }

  /* ---------- Hiring ---------- */

  /**
   * Hires the proposed team into the chat: resting bots come back, missing ones are created
   * with a look that fits their role. Each gets a contract (with a card and a board task),
   * its web domains and, in the background, its computer prepared.
   */
  async hire(
    chat: Chat,
    lead: BotView,
    members: TeamMember[],
    goal: string,
  ): Promise<{ bot: BotView; contract: Contract }[]> {
    const hired: { bot: BotView; contract: Contract }[] = [];
    const owned = await this.deps.bots.list(
      chat.ownerId ? { id: chat.ownerId, role: 'member' } : undefined,
    );
    for (const m of members) {
      // Reuse before creating: the lead's explicit pick, else a bot it already has
      // under this name and role. Without the name match, a proposal that names an
      // existing specialist ("Mila") silently cloned her as "Mila 2".
      const again =
        (m.reuseBotId ? owned.find((b) => b.id === m.reuseBotId && !b.isMain) : undefined) ??
        owned.find(
          (b) =>
            !b.isMain &&
            b.role === m.role &&
            b.name.toLowerCase() === m.name.trim().toLowerCase() &&
            !hired.some((h) => h.bot.id === b.id),
        );
      const bot =
        again ??
        (await this.deps.bots.create(
          {
            name: uniqueName(
              m.name,
              owned.map((b) => b.name),
            ),
            role: m.role,
            persona: m.mission.slice(0, 600),
            figure: ROLE_LOOK[m.role].figure,
            color: ROLE_LOOK[m.role].color,
          },
          chat.ownerId,
        ));
      owned.push(bot);
      await this.deps.bots.setResting(bot.id, false, lead.id);
      const contract = await this.open(chat, bot, m);
      hired.push({ bot: { ...bot, resting: false }, contract });
      if (this.deps.computers) {
        for (const d of m.domains) {
          await this.deps.computers.allow(bot.id, d, chat.ownerId).catch(() => undefined);
        }
        if (m.setup) {
          const setup = m.setup;
          // Preparing a computer can take minutes; the specialist starts meanwhile.
          void this.deps.computers
            .exec(bot.id, setup, 600)
            .catch((err: unknown) => this.deps.log?.error({ err }, 'computer setup'));
        }
      }
    }
    const ids = [...new Set([lead.id, ...chat.botIds, ...hired.map((h) => h.bot.id)])];
    await this.deps.store.setMembers(chat.id, ids, chat.kind === 'dm' ? goal : undefined);
    return hired;
  }

  private async open(chat: Chat, bot: BotView, m: TeamMember): Promise<Contract> {
    const id = randomUUID();
    const deadline = new Date(Date.now() + m.budgetMinutes * 60_000);
    const check = ContractCheck.parse(m.check);
    const task = await this.deps.store.createTask(chat.id, m.deliverable, bot.id);
    const card: ChatCard = {
      kind: 'contract',
      contractId: id,
      botId: bot.id,
      botName: bot.name,
      mission: m.mission,
      deliverable: m.deliverable,
      check: describeCheck(check),
      deadline: deadline.toISOString(),
      status: 'active',
    };
    const msg = await this.deps.store.add(chat.id, { role: 'card', botId: bot.id, card });
    await this.pool.query(
      `INSERT INTO bot_contracts (id, chat_id, bot_id, mission, deliverable, check_spec,
              deadline, status, card_message_id, board_task_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9)`,
      [
        id,
        chat.id,
        bot.id,
        m.mission,
        m.deliverable,
        JSON.stringify(check),
        deadline,
        msg.id,
        task.id,
      ],
    );
    const c = await this.contract(id);
    if (!c) throw new Error('contract vanished');
    return c;
  }

  /* ---------- Contracts ---------- */

  async contract(id: string): Promise<Contract | undefined> {
    const { rows } = await this.pool.query<ContractRow>(
      'SELECT * FROM bot_contracts WHERE id = $1',
      [id],
    );
    return rows[0] ? toContract(rows[0]) : undefined;
  }

  /** The bot's open contract in this chat (active or waiting for review). */
  async openContract(chatId: string, botId: string): Promise<Contract | undefined> {
    const { rows } = await this.pool.query<ContractRow>(
      `SELECT * FROM bot_contracts WHERE chat_id = $1 AND bot_id = $2
          AND status IN ('active', 'review') ORDER BY created_at DESC LIMIT 1`,
      [chatId, botId],
    );
    return rows[0] ? toContract(rows[0]) : undefined;
  }

  async forChat(chatId: string): Promise<Contract[]> {
    const { rows } = await this.pool.query<ContractRow>(
      'SELECT * FROM bot_contracts WHERE chat_id = $1 ORDER BY created_at',
      [chatId],
    );
    return rows.map(toContract);
  }

  /**
   * A specialist hands in its work. Code runs the contract's check; the bot's own claim
   * counts for nothing. Returns what the bot is told.
   */
  async submit(chat: Chat, bot: BotView, summary: string): Promise<string> {
    const c = await this.openContract(chat.id, bot.id);
    if (!c) return 'You have no open contract in this chat.';
    if (c.status === 'review') return 'Your work is waiting for the person to review it.';
    const result = await this.runCheck(c, bot).catch((err: unknown) => ({
      passed: false,
      detail: `The check could not run: ${err instanceof Error ? err.message : String(err)}`,
    }));
    // A review whose code check fails is not shown to the person: the bot fixes it first.
    if (c.check.type === 'review' && (!c.check.command || result.passed)) {
      const checked = c.check.command ? `Code check: ${result.detail}. ` : '';
      await this.close(c, 'review', `${checked}${summary}`.slice(0, 1000));
      return 'Handed in. The person reviews it now; wait for their decision.';
    }
    if (result.passed) {
      await this.close(c, 'met', result.detail);
      return `Contract met: ${result.detail}. Tell the lead in one sentence; then you are done.`;
    }
    // Not met yet: the contract stays open while there is time.
    await this.pool.query('UPDATE bot_contracts SET evidence = $2 WHERE id = $1', [
      c.id,
      `Not yet: ${result.detail}`,
    ]);
    await this.updateCard(c, 'active', `Not yet: ${result.detail}`);
    return `The check did not pass: ${result.detail}. Fix it and submit again before the deadline.`;
  }

  private async runCheck(c: Contract, bot: BotView): Promise<{ passed: boolean; detail: string }> {
    const pc = this.deps.computers;
    const command = async (cmd: string) => {
      if (!pc) return { passed: false, detail: 'no computer available to run the check' };
      const out = await pc.exec(bot.id, cmd, 300);
      const tail = out.output.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      return {
        passed: out.exitCode === 0,
        detail: `\`${cmd}\` exited ${out.exitCode}${tail ? ` (${tail})` : ''}`,
      };
    };
    switch (c.check.type) {
      case 'command':
        return command(c.check.command);
      case 'file': {
        if (!pc) return { passed: false, detail: 'no computer available to run the check' };
        // A path without a place means the chat's project folder, not the bot's own.
        const path = /^[/~]/.test(c.check.path)
          ? c.check.path
          : `${projectFolder(c.chatId)}/${c.check.path}`;
        const out = await pc.exec(bot.id, fileCheckCommand(path, c.check.contains), 60);
        return {
          passed: out.exitCode === 0,
          detail:
            out.exitCode === 0
              ? `${c.check.path} is there${c.check.contains ? ` with "${c.check.contains}"` : ''}`
              : out.output.includes('NO_TEXT')
                ? `${c.check.path} is there, but does not contain "${c.check.contains}"`
                : `${c.check.path} is missing or empty`,
        };
      }
      case 'task': {
        const { rows } = await this.pool.query<{ id: string }>(
          `SELECT id FROM tasks WHERE bot_id = $1 AND status = 'completed'
              AND created_at >= (SELECT created_at FROM bot_contracts WHERE id = $2)
            ORDER BY updated_at DESC LIMIT 5`,
          [bot.id, c.id],
        );
        for (const r of rows) {
          const checks = ((await this.deps.tasks.get(r.id))?.state?.verification ??
            []) as CheckResult[];
          const auto = checks.filter((x) => x.status !== 'unverified');
          if (auto.length > 0 && auto.every((x) => x.status === 'passed')) {
            return {
              passed: true,
              detail: `task ${r.id.slice(0, 8)} passed ${auto.length} independent checks`,
            };
          }
        }
        return { passed: false, detail: 'no task of yours has passed verification yet' };
      }
      case 'review':
        return c.check.command
          ? command(c.check.command)
          : { passed: false, detail: 'waits for the person' };
    }
  }

  /** The person's decision on work handed in for review. */
  async review(c: Contract, accept: boolean): Promise<void> {
    await this.close(c, accept ? 'met' : 'failed', accept ? 'accepted by you' : 'not accepted');
  }

  private async close(c: Contract, status: ContractStatus, evidence: string): Promise<void> {
    const final = status === 'met' || status === 'failed' || status === 'released';
    await this.pool.query(
      `UPDATE bot_contracts SET status = $2, evidence = $3,
              closed_at = CASE WHEN $4 THEN now() ELSE NULL END WHERE id = $1`,
      [c.id, status, evidence, final],
    );
    await this.updateCard(c, status, evidence);
    if (c.boardTaskId !== null) {
      await this.deps.store.updateTask(c.chatId, c.boardTaskId, {
        status: status === 'met' ? 'done' : status === 'review' ? 'waiting' : 'open',
        note: evidence.slice(0, 200),
      });
    }
  }

  private async updateCard(c: Contract, status: ContractStatus, evidence: string) {
    if (c.cardMessageId === null) return;
    const m = await this.deps.store.message(c.cardMessageId);
    if (m?.card?.kind !== 'contract') return;
    await this.deps.store.setCard(c.cardMessageId, { ...m.card, status, evidence });
  }

  /** Contracts past their deadline fail; returns the chats that changed. */
  async expire(): Promise<string[]> {
    const { rows } = await this.pool.query<ContractRow>(
      `SELECT * FROM bot_contracts WHERE status = 'active' AND deadline < now()`,
    );
    for (const r of rows) await this.close(toContract(r), 'failed', 'out of time');
    return [...new Set(rows.map((r) => r.chat_id))];
  }

  /** The lead lets a specialist go: it rests, keeps its record, and leaves the chat. */
  async release(chat: Chat, botId: string): Promise<void> {
    const open = await this.openContract(chat.id, botId);
    if (open) await this.close(open, 'released', 'released by the lead');
    await this.deps.bots.setResting(botId, true);
    await this.deps.store.setMembers(
      chat.id,
      chat.botIds.filter((id) => id !== botId),
    );
    await this.deps.computers?.stop(botId).catch(() => undefined);
  }

  /** The lead's view of everyone it could hire, with their records. */
  async roster(ownerId: string | null): Promise<BotView[]> {
    return (
      await this.deps.bots.list(ownerId ? { id: ownerId, role: 'member' } : undefined)
    ).filter((b) => !b.isMain);
  }

  /* ---------- Skills ---------- */

  async saveSkill(
    ownerId: string | null,
    bot: BotView,
    name: string,
    description: string,
    filename: string,
    code: string,
  ): Promise<void> {
    if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(name)) {
      throw new TeamError('A skill name is 2–41 lowercase letters, digits, - or _.');
    }
    if (code.length > 200_000) throw new TeamError('A skill is at most 200 KB.');
    await this.pool.query(
      `INSERT INTO bot_skills (id, owner_id, name, description, filename, code, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (COALESCE(owner_id, ''), name) DO UPDATE
         SET description = EXCLUDED.description, filename = EXCLUDED.filename,
             code = EXCLUDED.code, created_by = EXCLUDED.created_by`,
      [randomUUID(), ownerId, name, description.slice(0, 300), filename, code, bot.id],
    );
  }

  async skills(ownerId: string | null): Promise<Skill[]> {
    const { rows } = await this.pool.query<{
      name: string;
      description: string;
      filename: string;
      created_by: string | null;
      uses: number;
    }>(
      `SELECT name, description, filename, created_by, uses FROM bot_skills
        WHERE owner_id IS NOT DISTINCT FROM $1 ORDER BY uses DESC, name`,
      [ownerId],
    );
    return rows.map((r) => ({
      name: r.name,
      description: r.description,
      filename: r.filename,
      createdBy: r.created_by,
      uses: r.uses,
    }));
  }

  async skillCode(
    ownerId: string | null,
    name: string,
  ): Promise<{ filename: string; code: string } | undefined> {
    const { rows } = await this.pool.query<{ filename: string; code: string }>(
      `UPDATE bot_skills SET uses = uses + 1
        WHERE owner_id IS NOT DISTINCT FROM $1 AND name = $2 RETURNING filename, code`,
      [ownerId, name],
    );
    return rows[0];
  }
}

/** Keeps names unique on a team without ever creating "Rosa 2". */
export function uniqueName(name: string, taken: string[]): string {
  const lower = new Set(taken.map((t) => t.trim().toLowerCase()));
  const wanted = name.trim() || 'New bot';
  if (!lower.has(wanted.toLowerCase())) return wanted;
  // A taken name gets a fresh first name from the pool, not a number. The fleet is
  // the person's team, so a new specialist feels like a new colleague.
  const fresh = NAME_POOL.find((n) => !lower.has(n.toLowerCase()));
  if (fresh) return fresh;
  return `${wanted}-${randomUUID().slice(0, 4)}`;
}

/** Fresh first names for specialists; never a numbered copy of an existing bot. */
const NAME_POOL = [
  'Ada',
  'Ben',
  'Cleo',
  'Dario',
  'Elif',
  'Finn',
  'Greta',
  'Hugo',
  'Ida',
  'Jonas',
  'Kai',
  'Lena',
  'Milo',
  'Nora',
  'Omar',
  'Pia',
  'Quentin',
  'Rosa',
  'Sam',
  'Tara',
  'Ulf',
  'Vera',
  'Wim',
  'Yara',
  'Zoe',
  'Amira',
  'Bruno',
  'Clara',
  'David',
  'Elena',
  'Felix',
  'Giorgia',
  'Henrik',
  'Ines',
  'Jasper',
  'Klara',
  'Lars',
  'Maya',
  'Nils',
  'Olga',
  'Pablo',
  'Rafael',
  'Sofia',
  'Timo',
  'Uma',
  'Viktor',
  'Wanda',
  'Xenia',
  'Yusuf',
  'Zara',
] as const;
