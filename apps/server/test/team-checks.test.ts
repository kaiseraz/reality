import { describe, expect, it } from 'vitest';
import type { BotView } from '@reality/schemas';
import type { Chat } from '../src/chat/store.ts';
import type { BotComputers } from '../src/computer/computers.ts';
import { describeCheck } from '../src/team/team.ts';
import { teamTool, type TeamToolDeps } from '../src/team/tools.ts';

const lead = { id: 'lead', name: 'Reality', isMain: true } as BotView;
const chat = { id: 'chat-1', ownerId: null } as Chat;
const member = (check: Record<string, unknown>) => ({
  name: 'Cleo',
  role: 'researcher',
  mission: 'Show the enzyme from real data.',
  deliverable: 'The structure on screen',
  check,
  budgetMinutes: 30,
});

describe('every contract has a check that code runs', () => {
  const propose = async (check: Record<string, unknown>, computers: boolean) => {
    const cards: unknown[] = [];
    const deps = {
      team: { roster: async () => [] },
      store: { add: async (_c: string, m: { card: unknown }) => void cards.push(m.card) },
      computers: computers ? ({} as BotComputers) : null,
    } as unknown as TeamToolDeps;
    const out = await teamTool(deps, { chat, bot: lead, team: [lead] }, 'propose_team', {
      goal: 'A biofuel turbine',
      members: [member(check)],
    });
    return { out, cards };
  };

  it('refuses a review that code does not check first, where a computer could run one', async () => {
    const { out, cards } = await propose({ type: 'review' }, true);
    expect(out?.isError).toBe(true);
    expect(out?.text).toContain('Cleo');
    expect(cards).toHaveLength(0);
  });

  it('takes a review behind a command, and a plain review where no computer exists', async () => {
    const checked = await propose({ type: 'review', command: 'grep -c ^ATOM 1TCA.pdb' }, true);
    expect(checked.out?.isError).toBeFalsy();
    expect(checked.cards).toHaveLength(1);
    const offline = await propose({ type: 'review' }, false);
    expect(offline.out?.isError).toBeFalsy();
  });

  it('says that code runs first', () => {
    expect(describeCheck({ type: 'review', command: 'pytest' })).toBe(
      '`pytest` exits 0 on its computer, and then you accept it',
    );
  });
});
