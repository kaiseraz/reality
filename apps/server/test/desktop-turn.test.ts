import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { buildApp } from '../src/app.ts';
import type { AgentMessage, AgentModel, Block } from '../src/chat/model.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

/** A bot operating its desktop: it may take many steps, and it looks before it stops. */
class ClickingModel implements AgentModel {
  readonly name = 'fake';
  calls = 0;
  seen: AgentMessage[][] = [];
  /** Clicks before the model says it is done, then one reply, then a real finish. */
  constructor(private readonly clicks: number) {}
  turn(req: { messages: AgentMessage[] }) {
    this.calls++;
    this.seen.push(req.messages.map((m) => ({ ...m })));
    const content: Block[] =
      this.calls <= this.clicks
        ? [
            {
              type: 'tool_use',
              id: `c${this.calls}`,
              name: 'computer_input',
              input: { action: 'click', x: 10, y: 10 },
            },
          ]
        : [{ type: 'text', text: `Finished after ${this.calls - 1} clicks.` }];
    return Promise.resolve({
      content,
      stop: content[0]?.type === 'tool_use' ? ('tool_use' as const) : ('end' as const),
      model: 'fake',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }
}

describe('a turn on the desktop', () => {
  let runtime: Runtime;
  let dir: string;
  const model = new ClickingModel(25);

  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-desktop-turn-'));
    runtime = await createRuntime(
      loadConfig({
        AUTH: 'off',
        COMPUTERS: 'off',
        DATABASE_URL: TEST_DATABASE_URL,
        ARTIFACT_DIR: dir,
      }),
      {
        planner: new RuleBasedPlanner(),
        analyst: null,
        chatModel: model,
        log: { error: () => {} },
      },
    );
  }, 60_000);
  afterAll(async () => {
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('gets past the ordinary step limit and is asked to look before it stops', async () => {
    const app = buildApp(
      loadConfig({
        AUTH: 'off',
        COMPUTERS: 'off',
        DATABASE_URL: TEST_DATABASE_URL,
        ARTIFACT_DIR: dir,
      }),
      runtime,
    );
    const bot = (
      await app.inject({
        method: 'POST',
        url: '/api/bots',
        payload: { name: 'Eddie', role: 'engineer' },
      })
    ).json<{ id: string }>();
    const chat = (await app.inject({ url: `/api/bots/${bot.id}/chat` })).json<{ id: string }>();
    await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: { text: 'Click through the program.' },
    });
    for (let i = 0; i < 3; i++) {
      await runtime.chats.engine.idle(chat.id);
      await runtime.chats.engine.tick();
      await runtime.chats.engine.idle(chat.id);
    }
    // 25 clicks: more than the 10 steps of an ordinary turn. No computers here, so each click
    // comes back as an error, which is the same step for the loop.
    expect(model.calls).toBeGreaterThan(25);
    const all = model.seen.flat();
    const asked = all.some(
      (m) => typeof m.content === 'string' && m.content.includes('Look at the screen'),
    );
    expect(asked).toBe(true);

    // A bot woken after it has delivered is told not to start the job again.
    const first = model.seen[0]?.[0];
    expect(typeof first?.content === 'string' && first.content).toContain(
      'do not start the job again',
    );
    await app.close();
  }, 60_000);
});
