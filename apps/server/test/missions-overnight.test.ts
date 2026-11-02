import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BotView, ChatState } from '@reality/schemas';
import { buildApp } from '../src/app.ts';
import type { AgentMessage, AgentModel, Block, TurnResult } from '../src/chat/model.ts';
import { loadConfig } from '../src/config.ts';
import type { MissionView } from '../src/missions/missions.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

/**
 * Overnight missions: a cost budget in credits that warns, then stops; and rounds led by the
 * lead when the team runs out of steps. The model is scripted: one keeps talking and spends
 * 900 credits a turn (900k tokens at 1 credit per thousand), the other has nothing to say.
 */
class ScriptedModel implements AgentModel {
  readonly name = 'scripted';
  constructor(
    private readonly says: string,
    private readonly tokens: number,
  ) {}
  async turn(req: { messages: AgentMessage[] }): Promise<TurnResult> {
    void req;
    const content: Block[] = [{ type: 'text', text: this.says }];
    return {
      content,
      stop: 'end',
      model: this.name,
      usage: { inputTokens: this.tokens, outputTokens: 0 },
    };
  }
}

describe('overnight missions (database)', () => {
  let spender: Runtime;
  let quiet: Runtime;
  let spendApp: FastifyInstance;
  let quietApp: FastifyInstance;
  let dir: string;

  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-overnight-'));
    const config = loadConfig({
      AUTH: 'off',
      DATABASE_URL: TEST_DATABASE_URL,
      ARTIFACT_DIR: dir,
      COMPUTERS: 'off',
      MODEL_PRICE_INPUT: '1000',
      MODEL_PRICE_OUTPUT: '1000',
      MODEL_PRICE_UNIT: 'credits',
    });
    const common = {
      planner: new RuleBasedPlanner(),
      analyst: null,
      synthesizer: null,
      log: { error: () => {} },
    };
    spender = await createRuntime(config, {
      ...common,
      chatModel: new ScriptedModel('Still working on the design.', 900_000),
    });
    quiet = await createRuntime(config, { ...common, chatModel: new ScriptedModel('[PASS]', 1) });
    spendApp = buildApp(config, spender);
    quietApp = buildApp(config, quiet);
  }, 60_000);
  afterAll(async () => {
    await spendApp.close();
    await quietApp.close();
    await spender.close();
    await quiet.close();
    await rm(dir, { recursive: true, force: true });
  });

  const bot = async (a: FastifyInstance, name: string) =>
    (
      await a.inject({ method: 'POST', url: '/api/bots', payload: { name, role: 'engineer' } })
    ).json<BotView>();
  const settle = async (rt: Runtime, chatId: string) => {
    for (let i = 0; i < 6; i++) {
      await rt.chats.engine.idle(chatId);
      await rt.tasks.settleAll();
      await rt.chats.engine.tick();
    }
    await rt.chats.engine.idle(chatId);
  };

  it('warns near the cost budget, then closes the mission with a report of what it cost', async () => {
    const vera = await bot(spendApp, 'Vera');
    const res = await spendApp.inject({
      method: 'POST',
      url: '/api/missions',
      payload: {
        goal: 'Design a small satellite structure',
        botIds: [vera.id],
        costBudget: 2000,
        allowInstalls: ['statsmodels'],
        allowDomains: ['celestrak.org'],
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<MissionView>();
    expect(created).toMatchObject({
      costBudget: 2000,
      costUnit: 'credits',
      allowInstalls: ['statsmodels'],
      allowDomains: ['celestrak.org'],
      maxRounds: 12,
    });
    await settle(spender, created.chatId);
    const m = (await spendApp.inject({ url: `/api/missions/${created.id}` })).json<MissionView>();
    expect(m.status).toBe('out_of_budget');
    // 900 per turn: warned past 1600, closed at 2700 after the third turn.
    expect(m.spent).toBe(2700);
    const journal = m.journal.map((j) => j.text).join('\n');
    expect(journal).toMatch(/1800 credits of 2000 credits spent; the team was told to wrap up/);
    const chat = (await spendApp.inject({ url: `/api/chats/${m.chatId}` })).json<ChatState>();
    expect(chat.messages.some((x) => /Start no new work/.test(x.text))).toBe(true);
    const page = await spender.pages.get(m.reportPageId!, null);
    expect(page?.content).toContain('Model use: 2700 credits of 2000 credits');
    expect(page?.content).toContain('- Vera: 2700 credits in 3 calls');
    expect(page?.content).toContain('## Waiting for you');
    expect(page?.content).toContain('## Timeline');
  }, 120_000);

  it('when the team runs out of steps, the lead reviews in rounds before the mission stops', async () => {
    const otto = await bot(quietApp, 'Otto');
    const res = await quietApp.inject({
      method: 'POST',
      url: '/api/missions',
      payload: { goal: 'Plan a rocket recovery system', botIds: [otto.id], maxRounds: 2 },
    });
    const created = res.json<MissionView>();
    await settle(quiet, created.chatId);
    const m = (await quietApp.inject({ url: `/api/missions/${created.id}` })).json<MissionView>();
    expect(m.rounds).toBe(2);
    const journal = m.journal.map((j) => j.text);
    expect(journal).toContain('Round 1 of 2.');
    expect(journal).toContain('Round 2 of 2.');
    expect(m.status).toBe('failed');
    expect(journal.join('\n')).toMatch(/Closed \(stalled\)/);
  }, 120_000);
});
