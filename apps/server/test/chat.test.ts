import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BotView, ChatState } from '@reality/schemas';
import { buildApp } from '../src/app.ts';
import type { AgentMessage, AgentModel, Block, TurnResult } from '../src/chat/model.ts';
import { loadConfig } from '../src/config.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

/** Plays a script per bot: each call returns the next step of that bot's script. */
class ScriptedModel implements AgentModel {
  readonly name = 'scripted';
  readonly calls: { bot: string; messages: AgentMessage[] }[] = [];
  private readonly scripts = new Map<string, ((m: AgentMessage[]) => Block[])[]>();

  script(bot: string, steps: ((m: AgentMessage[]) => Block[])[]) {
    this.scripts.set(bot, [...(this.scripts.get(bot) ?? []), ...steps]);
  }

  async turn(req: { system: string; messages: AgentMessage[] }): Promise<TurnResult> {
    const bot = /^You are (\S+),/.exec(req.system)?.[1] ?? '?';
    this.calls.push({ bot, messages: req.messages });
    const next = this.scripts.get(bot)?.shift();
    const content = next ? next(req.messages) : [{ type: 'text' as const, text: '[PASS]' }];
    return {
      content,
      stop: content.some((b) => b.type === 'text' && b.text === '[CUT]')
        ? 'cut'
        : content.some((b) => b.type === 'tool_use')
          ? 'tool_use'
          : 'end',
      model: 'scripted',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

const say = (text: string) => (): Block[] => [{ type: 'text', text }];
const tool =
  (name: string, input: Record<string, unknown>, text = '') =>
  (): Block[] => [
    ...(text ? [{ type: 'text' as const, text }] : []),
    { type: 'tool_use', id: `t-${name}-${Math.random()}`, name, input },
  ];

const WORKS = {
  results: [
    {
      id: 'W1',
      title: 'Street trees and urban heat',
      publication_year: 2021,
      cited_by_count: 340,
      authorships: [],
      abstract_inverted_index: { Trees: [0], cool: [1], streets: [2] },
    },
  ],
};

describe('chats with bots', () => {
  let runtime: Runtime;
  let rules: Runtime;
  let app: FastifyInstance;
  let rulesApp: FastifyInstance;
  let dir: string;
  let server: Server;
  const model = new ScriptedModel();

  const newBot = async (a: FastifyInstance, name: string, role = 'analyst') =>
    (await a.inject({ method: 'POST', url: '/api/bots', payload: { name, role } })).json<BotView>();
  const settle = async (rt: Runtime, chatId: string) => {
    for (let i = 0; i < 6; i++) {
      await rt.chats.engine.idle(chatId);
      await rt.tasks.settleAll();
      await rt.chats.engine.tick();
      await rt.chats.engine.idle(chatId);
    }
  };

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(WORKS));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-chat-'));
    const config = loadConfig({
      AUTH: 'off',
      DATABASE_URL: TEST_DATABASE_URL,
      ARTIFACT_DIR: dir,
      OPENALEX_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/works`,
    });
    const common = {
      planner: new RuleBasedPlanner(),
      analyst: null,
      synthesizer: null,
      log: { error: () => {} },
    };
    runtime = await createRuntime(config, { ...common, chatModel: model });
    rules = await createRuntime(config, { ...common, chatModel: null });
    app = buildApp(config, runtime);
    rulesApp = buildApp(config, rules);
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await rulesApp.close();
    await runtime.close();
    await rules.close();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it('a bot searches, answers, and numbers without a source are marked', async () => {
    const mila = await newBot(app, 'Mila');
    model.script('Mila', [
      tool('search_literature', { query: 'street trees heat' }),
      say('The most cited study has 340 citations; trees cut street heat by 9.5 degrees.'),
    ]);
    const chat = (await app.inject({ url: `/api/bots/${mila.id}/chat` })).json<ChatState>();
    expect(chat).toMatchObject({ kind: 'dm', botIds: [mila.id], engine: 'model' });
    await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: { text: 'What does research say about street trees?' },
    });
    await settle(runtime, chat.id);
    const state = (await app.inject({ url: `/api/chats/${chat.id}` })).json<ChatState>();
    const roles = state.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'action', 'card', 'bot']);
    expect(state.messages[2]?.card).toMatchObject({
      kind: 'sources',
      items: [{ ref: 'S1', citedBy: 340 }],
    });
    // 340 comes from the search result; 9.5 comes from nowhere.
    expect(state.messages[3]?.card).toEqual({ kind: 'unbacked', numbers: ['9.5'] });
    expect(state.presence[mila.id]?.state).toBe('idle');
    // The bot saw the user's message in its prompt.
    expect(JSON.stringify(model.calls[0]?.messages)).toContain('What does research say');
  });

  it('a person can put a file into a chat, and the bot is told of it', async () => {
    const ina = await newBot(app, 'Ina');
    const chat = (await app.inject({ url: `/api/bots/${ina.id}/chat` })).json<ChatState>();
    const upload = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/files?name=${encodeURIComponent('../My report (1).pdf')}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('%PDF-1.4 hello'),
    });
    expect(upload.statusCode).toBe(201);
    const card = upload.json<ChatState>().messages.at(-1)?.card;
    expect(card).toMatchObject({ kind: 'file', name: 'My report (1).pdf', fromPerson: true });
    if (card?.kind !== 'file') throw new Error('no file card');
    const got = await app.inject({ url: `/api/files/${card.fileId}?download=1` });
    expect(got.rawPayload.toString()).toBe('%PDF-1.4 hello');

    model.script('Ina', [say('I see the report.')]);
    await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: { text: 'Can you see it?' },
    });
    await settle(runtime, chat.id);
    const asked = JSON.stringify(model.calls.at(-1)?.messages);
    expect(asked).toContain('The person attached the file');
    expect(asked).toContain('My report (1).pdf');

    const empty = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/files?name=x`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(0),
    });
    expect(empty.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('a bot that worked never leaves the person with silence or a remark made on the way', async () => {
    const ivo = await newBot(app, 'Ivo');
    const ask = async (text: string) => {
      const chat = (await app.inject({ url: `/api/bots/${ivo.id}/chat` })).json<ChatState>();
      await app.inject({
        method: 'POST',
        url: `/api/chats/${chat.id}/messages`,
        payload: { text },
      });
      await settle(runtime, chat.id);
      const state = (await app.inject({ url: `/api/chats/${chat.id}` })).json<ChatState>();
      return state.messages.filter((m) => m.role === 'bot').at(-1)?.text;
    };
    // It ended without words: it is asked for them once.
    model.script('Ivo', [
      tool('search_literature', { query: 'street trees' }, 'Now I look at the sources.'),
      say(''),
      say('I found one study on street trees.'),
    ]);
    expect(await ask('What is known?')).toBe('I found one study on street trees.');
    // Out of steps: what stands is its report, not "now I look at the next page".
    model.script('Ivo', [
      ...Array.from({ length: 30 }, () =>
        tool('search_literature', { query: 'more trees' }, 'Now I look at the next page.'),
      ),
      say('I got as far as ten searches; the answer is not complete.'),
    ]);
    expect(await ask('And more?')).toBe(
      'I got as far as ten searches; the answer is not complete.',
    );
    // It still has nothing to say: the person is told so.
    model.script('Ivo', [tool('search_literature', { query: 'trees again' }), say(''), say('')]);
    expect(await ask('And again?')).toMatch(/stopped before I had an answer/);
    // Cut off mid-answer: it is told so, and goes again.
    model.script('Ivo', [say('[CUT]'), say('Done in pieces.')]);
    expect(await ask('Write something long.')).toBe('Done in pieces.');
    // "Now building it" with no call behind it is held to its word.
    model.script('Ivo', [
      say('Now building it.'),
      tool('search_literature', { query: 'built' }),
      say('Built: one more study found.'),
    ]);
    expect(await ask('Build it.')).toBe('Built: one more study found.');
  });

  it('data questions run as verified Reality tasks and the bot reports the result', async () => {
    const ada = await newBot(app, 'Ada');
    model.script('Ada', [
      tool('analyze_data', { question: 'Which regions drive revenue?', sample: 'sales' }),
      say('Started the analysis, the plan is above for you.'),
      (messages) => {
        // After the run, the verified result is in the transcript the bot sees.
        expect(JSON.stringify(messages)).toContain('Verified result');
        return [{ type: 'text', text: 'Done: see the verified result above.' }];
      },
    ]);
    const chat = (await app.inject({ url: `/api/bots/${ada.id}/chat` })).json<ChatState>();
    await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: { text: 'Which regions drive revenue?' },
    });
    await settle(runtime, chat.id);
    const state = (await app.inject({ url: `/api/chats/${chat.id}` })).json<ChatState>();
    const plan = state.messages.find((m) => m.card?.kind === 'plan');
    // Autonomous mode: the plan is approved by policy and runs at once; by the
    // time the chat settles, the card reads 'approved' (done), never 'waiting'.
    expect(plan?.card).toMatchObject({ kind: 'plan', status: 'approved' });
    const taskId = (plan?.card as { taskId: string }).taskId;
    expect((await runtime.tasks.get(taskId))?.botId).toBe(ada.id);
    const result = state.messages.find((m) => m.card?.kind === 'result')?.card as {
      status: string;
      verified: { passed: number; total: number };
    };
    expect(result.status).toBe('completed');
    expect(result.verified.total).toBeGreaterThan(0);
    expect(result.verified.passed).toBe(result.verified.total);
    expect(state.messages.at(-1)).toMatchObject({
      role: 'bot',
      text: 'Done: see the verified result above.',
    });
    // Deciding twice is refused.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/chats/${chat.id}/plans/${taskId}`,
          payload: { approved: true },
        })
      ).statusCode,
    ).toBe(409);
  }, 180_000);

  it('in a group, bots hand work to each other and ask the user', async () => {
    const lena = await newBot(app, 'Lena', 'lead');
    const theo = await newBot(app, 'Theo', 'reviewer');
    model.script('Lena', [
      tool('create_task', { title: 'Review the sources', owner: 'Theo' }),
      say('@Theo can you take the review?'),
    ]);
    model.script('Theo', [
      tool('ask_user', { question: 'Peer-reviewed only?', options: ['Yes', 'No'] }),
      say('One question first.'),
      say('Thanks, peer-reviewed only then.'),
    ]);
    const group = await app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: { title: 'Heat study', botIds: [lena.id, theo.id] },
    });
    expect(group.statusCode).toBe(201);
    const chat = group.json<ChatState>();
    await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: { text: '@Lena please organise a literature review' },
    });
    await settle(runtime, chat.id);
    let state = (await app.inject({ url: `/api/chats/${chat.id}` })).json<ChatState>();
    expect(state.tasks).toMatchObject([{ id: 1, title: 'Review the sources', ownerBot: theo.id }]);
    const question = state.messages.find((m) => m.card?.kind === 'question');
    expect(question?.card).toMatchObject({ status: 'open', options: ['Yes', 'No'] });
    expect(question?.botId).toBe(theo.id);
    expect(state.presence[theo.id]?.state).toBe('waiting');

    const answered = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/answers/${question?.id}`,
      payload: { answer: 'Yes' },
    });
    expect(answered.statusCode).toBe(200);
    await settle(runtime, chat.id);
    state = (await app.inject({ url: `/api/chats/${chat.id}` })).json<ChatState>();
    expect(state.messages.find((m) => m.id === question?.id)?.card).toMatchObject({
      status: 'answered',
      answer: 'Yes',
    });
    expect(state.messages.at(-1)).toMatchObject({
      botId: theo.id,
      text: 'Thanks, peer-reviewed only then.',
    });
    // A group needs bots the user can use.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/chats',
          payload: { title: 'x', botIds: [lena.id, '00000000-0000-4000-8000-000000000000'] },
        })
      ).statusCode,
    ).toBe(404);
  }, 120_000);

  it('a group room talks: a teammate gets addressed and answers', async () => {
    const nils = await newBot(app, 'Nils', 'analyst');
    const olivia = await newBot(app, 'Olivia', 'researcher');
    model.script('Nils', [say('The sample is clean. @Olivia can you check the outliers?')]);
    model.script('Olivia', [say('On it: two outliers, both in March.')]);
    const group = await app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: { title: 'Room', botIds: [nils.id, olivia.id] },
    });
    const chat = group.json<ChatState>();
    // No @ in the user's message: the room still talks to each other.
    await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: { text: 'How does the data look?' },
    });
    await settle(runtime, chat.id);
    const state = (await app.inject({ url: `/api/chats/${chat.id}` })).json<ChatState>();
    const bots = state.messages.filter((m) => m.role === 'bot');
    expect(bots.map((m) => m.botId)).toEqual([nils.id, olivia.id]);
    expect(bots[0]?.text).toContain('@Olivia');
    // The addressed teammate saw the mention in its prompt and answered it.
    const seen = JSON.stringify(model.calls.find((c) => c.bot === 'Olivia')?.messages);
    expect(seen).toContain('@Olivia');
  }, 120_000);

  it('a group answer that mentions nobody still gets one colleague line', async () => {
    const pia = await newBot(app, 'Pia', 'analyst');
    const ruben = await newBot(app, 'Ruben', 'engineer');
    model.script('Pia', [say('Numbers look consistent to me.')]);
    model.script('Ruben', [say('I can double-check the raw files.')]);
    const group = await app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: { title: 'Second room', botIds: [pia.id, ruben.id] },
    });
    const chat = group.json<ChatState>();
    await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: { text: 'Anything off in the numbers?' },
    });
    await settle(runtime, chat.id);
    const state = (await app.inject({ url: `/api/chats/${chat.id}` })).json<ChatState>();
    const bots = state.messages.filter((m) => m.role === 'bot');
    expect(bots.map((m) => m.botId)).toEqual([pia.id, ruben.id]);
    expect(bots[1]?.text).toBe('I can double-check the raw files.');
  }, 120_000);

  it('without a model, a bot still runs verified analyses and reports them', async () => {
    const noor = await newBot(rulesApp, 'Noor');
    const chat = (await rulesApp.inject({ url: `/api/bots/${noor.id}/chat` })).json<ChatState>();
    expect(chat.engine).toBe('rules');
    await rulesApp.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: { text: 'Which regions drive revenue?', sample: 'sales' },
    });
    await settle(rules, chat.id);
    let state = (await rulesApp.inject({ url: `/api/chats/${chat.id}` })).json<ChatState>();
    expect(state.messages[0]).toMatchObject({ role: 'system' });
    expect(state.messages[0]?.text).toContain('Weekly sales');
    const plan = state.messages.find((m) => m.card?.kind === 'plan')?.card as { taskId: string };
    expect(plan).toBeDefined();
    await rulesApp.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/plans/${plan.taskId}`,
      payload: { approved: true },
    });
    await settle(rules, chat.id);
    state = (await rulesApp.inject({ url: `/api/chats/${chat.id}` })).json<ChatState>();
    const last = state.messages.at(-1);
    expect(last?.role).toBe('bot');
    expect(last?.text).toMatch(/^Done\..*results verified independently\.$/);
  }, 180_000);

  it('chats belong to their owner', async () => {
    const authApp = buildApp(
      { ...loadConfig({ DATABASE_URL: TEST_DATABASE_URL }), AUTH: 'on' },
      runtime,
    );
    const a = await runtime.auth.createUser('chat-a@example.test', 'chat-a-test-password', 'admin');
    const b = await runtime.auth.createUser(
      'chat-b@example.test',
      'chat-b-test-password',
      'member',
    );
    const cookie = async (id: string) => ({
      cookie: `reality_session=${await runtime.auth.createSession(id)}`,
    });
    const bot = (
      await authApp.inject({
        method: 'POST',
        url: '/api/bots',
        headers: await cookie(a.id),
        payload: { name: 'Owned', role: 'analyst' },
      })
    ).json<BotView>();
    const chat = (
      await authApp.inject({ url: `/api/bots/${bot.id}/chat`, headers: await cookie(a.id) })
    ).json<ChatState>();
    const asB = await cookie(b.id);
    expect((await authApp.inject({ url: `/api/chats/${chat.id}`, headers: asB })).statusCode).toBe(
      404,
    );
    expect(
      (await authApp.inject({ url: `/api/bots/${bot.id}/chat`, headers: asB })).statusCode,
    ).toBe(404);
    expect(
      (await authApp.inject({ url: '/api/chats', headers: asB })).json<unknown[]>(),
    ).toHaveLength(0);
    await authApp.close();
  });
});
