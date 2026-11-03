import { z } from 'zod';
import { TeamMember, type BotView, type ChatCard } from '@reality/schemas';
import type { ToolOutcome } from '../chat/tools.ts';
import type { ToolSpec } from '../chat/model.ts';
import type { Chat, ChatStore } from '../chat/store.ts';
import { normalizeDomain, type BotComputers } from '../computer/computers.ts';
import { describeCheck, TeamError, type TeamService } from './team.ts';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const CHECK_SCHEMA = {
  type: 'object',
  description:
    'How code decides the job is done. Prefer command or file: {"type":"command","command":"python3 test_engine.py"} (exit 0 = done), {"type":"file","path":"report.md","contains":"Thrust"}, {"type":"task"} (a Reality task of the bot passes verification), {"type":"review","command":"grep -c ^ATOM ~/workspace/1TCA.pdb"} (the user judges, but only after the command passed; for taste). Every check needs something code runs: a review without a command is refused. Make the command test the result itself from the raw file (count, parse, recompute), not only that a file exists.',
  properties: {
    type: { type: 'string', enum: ['command', 'file', 'task', 'review'] },
    command: { type: 'string' },
    path: { type: 'string' },
    contains: { type: 'string' },
  },
  required: ['type'],
};

/** Tools only the lead has. */
export const LEAD_TOOLS: ToolSpec[] = [
  {
    name: 'propose_team',
    description:
      'Proposes specialists for a job the user gave you. The user hires the team once with a card; then every specialist works under a contract that code checks. Hire few (1–4), each with one clear deliverable on its own computer. Reuse resting bots with a good record (see team_status) via reuseBotId.',
    input_schema: obj(
      {
        goal: { type: 'string', description: 'The job in one sentence' },
        members: {
          type: 'array',
          items: obj(
            {
              name: {
                type: 'string',
                description:
                  'A short first name that is not already in the team (team_status lists everyone); never add a number to an existing name',
              },
              role: {
                type: 'string',
                enum: ['analyst', 'researcher', 'engineer', 'reviewer', 'lead'],
              },
              reuseBotId: { type: 'string' },
              mission: { type: 'string', description: 'What it does, 1–3 sentences' },
              deliverable: { type: 'string', description: 'The concrete result' },
              check: CHECK_SCHEMA,
              budgetMinutes: { type: 'integer', description: '5–1440' },
              domains: {
                type: 'array',
                items: { type: 'string' },
                description: 'Web domains its computer needs, e.g. pypi.org',
              },
              setup: {
                type: 'string',
                description: 'Shell command preparing its computer, e.g. pip install cadquery',
              },
            },
            ['name', 'role', 'mission', 'deliverable', 'check', 'budgetMinutes'],
          ),
        },
      },
      ['goal', 'members'],
    ),
  },
  {
    name: 'team_status',
    description:
      "Shows the contracts in this chat (who, what, deadline, status as judged by code), everyone you could hire with their record, and the team's saved skills.",
    input_schema: obj({}),
  },
  {
    name: 'release_bot',
    description:
      'Lets a specialist go when its job is done or no longer needed: it rests with its record and can be hired again.',
    input_schema: obj({ name: { type: 'string' } }, ['name']),
  },
];

/** For a specialist with an open contract. */
export const SUBMIT_TOOL: ToolSpec = {
  name: 'submit_work',
  description:
    "Hands in your deliverable. Code runs your contract's check; only that decides whether you are done. Submit when you believe the check passes.",
  input_schema: obj(
    { summary: { type: 'string', description: 'What you did and where the result is' } },
    ['summary'],
  ),
};

/** For everyone with a computer: reusable scripts the team keeps. */
export const SKILL_TOOLS: ToolSpec[] = [
  {
    name: 'save_skill',
    description:
      'Saves a script from your computer as a team skill, so you and others can reuse what worked (e.g. a converter, a test harness).',
    input_schema: obj(
      {
        name: { type: 'string', description: 'lowercase-with-dashes' },
        description: { type: 'string', description: 'What it does and how to run it' },
        path: { type: 'string', description: 'The script on your computer' },
      },
      ['name', 'description', 'path'],
    ),
  },
  {
    name: 'use_skill',
    description:
      'Puts a saved team skill onto your computer (in ~/workspace/skills/) and tells you how to run it.',
    input_schema: obj({ name: { type: 'string' } }, ['name']),
  },
];

export const TEAM_PRESENCE: Record<string, ['working' | 'searching' | 'reading', string]> = {
  propose_team: ['working', 'puts a team together'],
  team_status: ['reading', 'checks the team'],
  release_bot: ['working', 'releases a teammate'],
  submit_work: ['working', 'hands in its work'],
  save_skill: ['working', 'saves a skill'],
  use_skill: ['working', 'loads a skill'],
};

export interface TeamToolDeps {
  team: TeamService;
  store: ChatStore;
  computers: BotComputers | null;
}

const str = (v: unknown, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Runs a team tool; undefined when the name is not one. */
export async function teamTool(
  deps: TeamToolDeps,
  ctx: { chat: Chat; bot: BotView; team: BotView[] },
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome | undefined> {
  const { chat, bot } = ctx;
  const card = (c: ChatCard) => deps.store.add(chat.id, { role: 'card', botId: bot.id, card: c });
  try {
    switch (name) {
      case 'propose_team': {
        if (!bot.isMain) return { text: 'Only the lead hires.', isError: true };
        const parsed = z
          .object({
            goal: z.string().trim().min(1).max(500),
            members: z.array(TeamMember).min(1).max(6),
          })
          .safeParse(input);
        if (!parsed.success) {
          return { text: `Invalid team: ${parsed.error.message}`, isError: true };
        }
        // Nobody's work counts on its word alone: a person may judge taste, but after code.
        // Without computers there is nowhere to run a command, and the person is all there is.
        const unchecked = deps.computers
          ? parsed.data.members.filter((m) => m.check.type === 'review' && !m.check.command)
          : [];
        if (unchecked.length) {
          return {
            text: `Every contract needs a check that code runs. Give ${unchecked.map((m) => m.name).join(', ')} a command (alone or with the review), one that tests the result from the raw file.`,
            isError: true,
          };
        }
        const roster = await deps.team.roster(chat.ownerId);
        const members = parsed.data.members.map((m) => ({
          ...m,
          domains: m.domains.map((d) => normalizeDomain(d)).filter((d): d is string => Boolean(d)),
          // Only a resting bot of this person can be hired again.
          ...(m.reuseBotId && roster.some((b) => b.id === m.reuseBotId && b.resting)
            ? {}
            : { reuseBotId: undefined }),
        }));
        await card({ kind: 'team', goal: parsed.data.goal, members, status: 'open' });
        return {
          text: 'Proposed. The user decides with the team card; wait for it.',
          waiting: true,
        };
      }

      case 'team_status': {
        const contracts = await deps.team.forChat(chat.id);
        const roster = await deps.team.roster(chat.ownerId);
        const skills = await deps.team.skills(chat.ownerId);
        const name = (id: string) => roster.find((b) => b.id === id)?.name ?? id;
        return {
          text: [
            'Contracts here:',
            ...(contracts.length
              ? contracts.map(
                  (c) =>
                    `- ${name(c.botId)}: ${c.deliverable} — ${c.status}${c.evidence ? ` (${c.evidence})` : ''}; check: ${describeCheck(c.check)}; deadline ${c.deadline}`,
                )
              : ['- none']),
            'People you could hire (id, role, record met/failed, state):',
            ...(roster.length
              ? roster.map(
                  (b) =>
                    `- ${b.name} (${b.id}, ${b.role}, ${b.record.met}/${b.record.failed}, ${b.resting ? 'resting' : 'on a job'})`,
                )
              : ['- nobody yet']),
            'Team skills:',
            ...(skills.length
              ? skills.map((s) => `- ${s.name}: ${s.description} (used ${s.uses}×)`)
              : ['- none yet']),
          ].join('\n'),
        };
      }

      case 'release_bot': {
        if (!bot.isMain) return { text: 'Only the lead releases teammates.', isError: true };
        const target = ctx.team.find(
          (b) =>
            b.name.toLowerCase() === str(input.name, 60).trim().toLowerCase().replace(/^@/, ''),
        );
        if (!target || target.isMain) return { text: 'No such teammate here.', isError: true };
        await deps.team.release(chat, target.id);
        return { text: `${target.name} is resting now.` };
      }

      case 'submit_work':
        return { text: await deps.team.submit(chat, bot, str(input.summary, 2000)) };

      case 'save_skill': {
        if (!deps.computers) return { text: 'No computer here.', isError: true };
        const path = str(input.path, 500);
        const code = await deps.computers.readFile(bot.id, path);
        const filename = path.split('/').pop() || 'skill.sh';
        await deps.team.saveSkill(
          chat.ownerId,
          bot,
          str(input.name, 60),
          str(input.description, 300),
          filename,
          code,
        );
        return { text: `Saved skill "${str(input.name, 60)}" for the whole team.` };
      }

      case 'use_skill': {
        if (!deps.computers) return { text: 'No computer here.', isError: true };
        const skill = await deps.team.skillCode(chat.ownerId, str(input.name, 60));
        if (!skill) return { text: 'No such skill. Use team_status to list them.', isError: true };
        const path = `skills/${skill.filename}`;
        await deps.computers.writeFile(bot.id, path, skill.code);
        return { text: `Put it at ~/workspace/${path}. Read it, then run it.` };
      }
    }
  } catch (err) {
    if (err instanceof TeamError) return { text: err.message, isError: true };
    throw err;
  }
  return undefined;
}
