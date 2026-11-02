import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BotView, ChatState } from '@reality/schemas';
import { buildApp } from '../src/app.ts';
import type { AgentMessage, AgentModel, Block, TurnResult } from '../src/chat/model.ts';
import { loadConfig } from '../src/config.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { fileCheckCommand } from '../src/team/team.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

describe('file check', () => {
  it('leaves a leading ~ for the shell to expand and quotes the rest', () => {
    expect(fileCheckCommand("~/work space/it's.step", 'ASSEMBLY')).toBe(
      `if ! test -s "$HOME"'/work space/it'"'"'s.step'; then echo NO_FILE; false; elif ! grep -qiF -- 'ASSEMBLY' "$HOME"'/work space/it'"'"'s.step'; then echo NO_TEXT; false; fi`,
    );
    expect(fileCheckCommand('/home/gem/a~b')).toBe(
      `if ! test -s '/home/gem/a~b'; then echo NO_FILE; false; fi`,
    );
  });
});

/**
 * Scripted stand-in for the model: the lead puts a team together, one specialist hands in
 * work that its check refuses, the other hands in work for the person to review.
 */
class TeamModel implements AgentModel {
  readonly name = 'team-script';
  async turn(req: { system: string; messages: AgentMessage[] }): Promise<TurnResult> {
    const seen = JSON.stringify(req.messages);
    const who = /You are (\w+),/.exec(req.system)?.[1] ?? '';
    const call = (name: string, input: Record<string, unknown>): Block[] => [
      { type: 'tool_use', id: `${who}-${name}`, name, input },
    ];
    let content: Block[];
    if (who === 'Reality') {
      content = !seen.includes('Contracts here:')
        ? call('team_status', {})
        : !seen.includes('Proposed.')
          ? call('propose_team', {
              goal: 'Design a small turbofan and check it against the literature',
              members: [
                {
                  name: 'Ada',
                  role: 'engineer',
                  mission: 'Build the CAD model of the engine.',
                  deliverable: 'engine.step on your computer',
                  check: { type: 'command', command: 'test -s engine.step' },
                  budgetMinutes: 30,
                  domains: ['https://pypi.org/simple', 'localhost'],
                  setup: 'pip install cadquery',
                },
                {
                  name: 'Kim',
                  role: 'researcher',
                  mission: 'Find reference engines of similar size.',
                  deliverable: 'A short comparison',
                  check: { type: 'review' },
                  budgetMinutes: 30,
                },
              ],
            })
          : [{ type: 'text', text: '[PASS]' }];
    } else if (who === 'Ada' || who === 'Kim') {
      content = !seen.includes('submit_work')
        ? call('submit_work', { summary: `${who} is done.` })
        : [{ type: 'text', text: '[PASS]' }];
    } else {
      content = [{ type: 'text', text: '[PASS]' }];
    }
    return {
      content,
      stop: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end',
      model: this.name,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

describe('the lead hires a team under contracts judged by code (database)', () => {
  let rt: Runtime;
  let app: FastifyInstance;

  beforeAll(async () => {
    await resetTestDatabase();
    // No bot computers here: command checks must then fail, never pass.
    const config = loadConfig({ AUTH: 'off', DATABASE_URL: TEST_DATABASE_URL, COMPUTERS: 'off' });
    rt = await createRuntime(config, {
      planner: new RuleBasedPlanner(),
      analyst: null,
      chatModel: new TeamModel(),
      log: { error: () => {} },
    });
    app = buildApp(config, rt);
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await rt.close();
  });

  const settle = async (chatId: string) => {
    for (let i = 0; i < 6; i++) {
      await rt.chats.engine.idle(chatId);
      await rt.chats.engine.tick();
    }
    await rt.chats.engine.idle(chatId);
  };
  const cards = (s: ChatState, kind: string) =>
    s.messages.filter((m) => m.card?.kind === kind).map((m) => ({ id: m.id, card: m.card }));

  let chatId: string;
  let lead: BotView;

  it('everyone starts with the lead, and the lead cannot be removed', async () => {
    const bots = (await app.inject({ url: '/api/bots' })).json<BotView[]>();
    lead = bots[0] as BotView;
    expect(lead).toMatchObject({ name: 'Reality', isMain: true, role: 'lead', resting: false });
    const del = await app.inject({ method: 'DELETE', url: `/api/bots/${lead.id}` });
    expect(del.statusCode).toBe(409);
  });

  it('proposes a team with a card and waits for the person', async () => {
    const chat = (await app.inject({ url: `/api/bots/${lead.id}/chat` })).json<ChatState>();
    chatId = chat.id;
    await app.inject({
      method: 'POST',
      url: `/api/chats/${chatId}/messages`,
      payload: { text: 'Design a small turbofan and compare it with real engines.' },
    });
    await settle(chatId);
    const state = (await app.inject({ url: `/api/chats/${chatId}` })).json<ChatState>();
    const [team] = cards(state, 'team');
    expect(team?.card).toMatchObject({ kind: 'team', status: 'open' });
    const members = (team?.card as { members: { name: string; domains: string[] }[] }).members;
    expect(members.map((m) => m.name)).toEqual(['Ada', 'Kim']);
    // Domains are cleaned; names leading into this machine are dropped.
    expect(members[0]?.domains).toEqual(['pypi.org']);
    expect(state.kind).toBe('dm');
  });

  it('hiring creates the specialists, contracts and board tasks; code refuses unproven work', async () => {
    let state = (await app.inject({ url: `/api/chats/${chatId}` })).json<ChatState>();
    const [team] = cards(state, 'team');
    const res = await app.inject({
      method: 'POST',
      url: `/api/chats/${chatId}/answers/${team?.id}`,
      payload: { answer: 'Hire' },
    });
    expect(res.statusCode).toBe(200);
    await settle(chatId);
    state = (await app.inject({ url: `/api/chats/${chatId}` })).json<ChatState>();
    expect(state.kind).toBe('group');
    expect(state.botIds).toHaveLength(3);
    // The team lives in this chat by its own id. Opening the lead directly must
    // NOT dump the person (or a new message) back into the old team: it opens a
    // clean direct chat with only the lead.
    const home = (await app.inject({ url: `/api/bots/${lead.id}/chat` })).json<ChatState>();
    expect(home.id).not.toBe(chatId);
    expect(home.kind).toBe('dm');
    expect(home.botIds).toEqual([lead.id]);
    const teamChat = (await app.inject({ url: `/api/chats/${chatId}` })).json<ChatState>();
    expect(teamChat.kind).toBe('group');
    expect(teamChat.botIds).toHaveLength(3);
    expect(state.tasks.map((t) => t.title)).toEqual([
      'engine.step on your computer',
      'A short comparison',
    ]);

    const contracts = await rt.team.forChat(chatId);
    expect(contracts).toHaveLength(2);
    const [ada, kim] = contracts;
    // Ada said she was done; without a computer the check cannot pass.
    expect(ada).toMatchObject({ status: 'active' });
    expect(ada?.evidence).toMatch(/Not yet: no computer/);
    // Kim's work goes to the person.
    expect(kim).toMatchObject({ status: 'review' });
    expect(cards(state, 'contract').map((c) => (c.card as { status: string }).status)).toEqual([
      'active',
      'review',
    ]);
  });

  it('the person accepts reviewed work; deadlines fail; released bots rest with their record', async () => {
    const state = (await app.inject({ url: `/api/chats/${chatId}` })).json<ChatState>();
    const review = cards(state, 'contract').find(
      (c) => (c.card as { status: string }).status === 'review',
    );
    await app.inject({
      method: 'POST',
      url: `/api/chats/${chatId}/answers/${review?.id}`,
      payload: { answer: 'Accept' },
    });
    await settle(chatId);
    const [ada, kim] = await rt.team.forChat(chatId);
    expect(kim).toMatchObject({ status: 'met', evidence: 'accepted by you' });

    // Ada's budget runs out.
    await rt.team['deps'].pool.query(
      "UPDATE bot_contracts SET deadline = now() - interval '1 minute' WHERE id = $1",
      [ada?.id],
    );
    await rt.chats.engine.tick();
    expect((await rt.team.contract(ada?.id ?? ''))?.status).toBe('failed');

    const chat = await rt.chats.store.get(chatId);
    if (!chat || !ada || !kim) throw new Error('missing');
    await rt.team.release(chat, kim.botId);
    const after = await rt.chats.store.get(chatId);
    expect(after?.botIds).not.toContain(kim.botId);
    const bots = (await app.inject({ url: '/api/bots' })).json<BotView[]>();
    const k = bots.find((b) => b.id === kim.botId);
    const a = bots.find((b) => b.id === ada.botId);
    expect(k).toMatchObject({ resting: true, record: { met: 1, failed: 0 } });
    expect(a).toMatchObject({ resting: false, record: { met: 0, failed: 1 } });
    // Hired specialists get a look that fits their role.
    expect(a).toMatchObject({ figure: 'cube', role: 'engineer' });
  });
});
