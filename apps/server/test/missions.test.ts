import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BotView, ChatState } from '@reality/schemas';
import { buildApp } from '../src/app.ts';
import type { AgentMessage, AgentModel, Block, TurnResult } from '../src/chat/model.ts';
import { loadConfig } from '../src/config.ts';
import type { MissionView } from '../src/missions/missions.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

/** A bot that runs the copper simulation, then claims success with a made-up number. */
class OverclaimingModel implements AgentModel {
  readonly name = 'overclaiming';
  async turn(req: { messages: AgentMessage[] }): Promise<TurnResult> {
    const seen = JSON.stringify(req.messages);
    let content: Block[];
    if (!seen.includes('Started lab task') && !seen.includes('Lab simulation fcc_crystal')) {
      content = [
        {
          type: 'tool_use',
          id: 'sim',
          name: 'run_simulation',
          input: { engine: 'fcc_crystal', params: { element: 'Cu' }, question: 'Copper crystal' },
        },
      ];
    } else if (!seen.includes('Lab simulation fcc_crystal')) {
      content = [{ type: 'text', text: '[PASS]' }];
    } else if (!seen.includes('closed the mission')) {
      content = [
        {
          type: 'tool_use',
          id: 'fin',
          name: 'finish_mission',
          input: { summary: 'Copper is very stiff: bulk modulus 250 GPa. Goal achieved.' },
        },
      ];
    } else {
      content = [{ type: 'text', text: 'Mission done.' }];
    }
    return {
      content,
      stop: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end',
      model: this.name,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

describe('research missions (database, sandbox)', () => {
  let rules: Runtime;
  let modelRt: Runtime;
  let app: FastifyInstance;
  let modelApp: FastifyInstance;
  let dir: string;

  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-missions-'));
    const config = loadConfig({ AUTH: 'off', DATABASE_URL: TEST_DATABASE_URL, ARTIFACT_DIR: dir });
    const common = {
      planner: new RuleBasedPlanner(),
      analyst: null,
      synthesizer: null,
      log: { error: () => {} },
    };
    rules = await createRuntime(config, { ...common, chatModel: null });
    modelRt = await createRuntime(config, { ...common, chatModel: new OverclaimingModel() });
    app = buildApp(config, rules);
    modelApp = buildApp(config, modelRt);
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await modelApp.close();
    await rules.close();
    await modelRt.close();
    await rm(dir, { recursive: true, force: true });
  });

  const bot = async (a: FastifyInstance, name: string) =>
    (
      await a.inject({ method: 'POST', url: '/api/bots', payload: { name, role: 'researcher' } })
    ).json<BotView>();
  const settle = async (rt: Runtime, chatId: string) => {
    for (let i = 0; i < 8; i++) {
      await rt.chats.engine.idle(chatId);
      await rt.tasks.settleAll();
      await rt.chats.engine.tick();
    }
    await rt.chats.engine.idle(chatId);
  };
  const start = async (a: FastifyInstance, rt: Runtime, payload: Record<string, unknown>) => {
    const res = await a.inject({ method: 'POST', url: '/api/missions', payload });
    expect(res.statusCode).toBe(201);
    const m = res.json<MissionView>();
    await settle(rt, m.chatId);
    return (await a.inject({ url: `/api/missions/${m.id}` })).json<MissionView>();
  };

  it('works overnight without a model: policy approves, code judges, a report is written', async () => {
    const curie = await bot(app, 'Curie');
    const m = await start(app, rules, {
      goal: 'Design a Bragg mirror with 8 pairs at 1550 nm',
      botIds: [curie.id],
      criteria: [{ field: 'peak_reflectance', min: 0.999 }],
      hours: 8,
      maxTasks: 3,
    });
    expect(m).toMatchObject({ status: 'finished', verdict: 'verified', tasksUsed: 1 });
    expect(m.criteria[0]).toMatchObject({ status: 'met', evidenceId: 'B1' });
    expect(m.journal.map((j) => j.text).join('\n')).toMatch(/Plan approved/);
    const page = await rules.pages.get(m.reportPageId!, null);
    expect(page?.content).toContain('**Verdict:** verified');
    expect(page?.content).toContain('peak_reflectance ≥ 0.999: actual 0.999');
    const chat = (await app.inject({ url: `/api/chats/${m.chatId}` })).json<ChatState>();
    expect(chat.messages.find((x) => x.card?.kind === 'mission')?.card).toMatchObject({
      status: 'finished',
      verdict: 'verified',
    });
    expect(chat.messages.at(-1)?.text).toMatch(/Mission closed by the system: finished/);
  }, 180_000);

  it('a missed criterion fails the mission even though the team reported it as done', async () => {
    const noor = await bot(app, 'Noor');
    const m = await start(app, rules, {
      goal: 'Design a Bragg mirror with 3 pairs at 1550 nm',
      botIds: [noor.id],
      criteria: [{ field: 'peak_reflectance', min: 0.999 }],
    });
    expect(m).toMatchObject({ status: 'failed', verdict: 'refuted' });
    const page = await rules.pages.get(m.reportPageId!, null);
    expect(page?.content).toContain('recorded it as failed because the criteria are not met');
  }, 180_000);

  it('a bot cannot talk its way to success: verdict by code, made-up numbers flagged', async () => {
    const ada = await bot(modelApp, 'Ada');
    const m = await start(modelApp, modelRt, {
      goal: 'Find out how stiff copper is',
      botIds: [ada.id],
      criteria: [{ field: 'bulk_modulus_GPa', min: 200 }],
    });
    expect(m).toMatchObject({ status: 'failed', verdict: 'refuted' });
    expect(m.criteria[0]?.status).toBe('missed');
    const page = await modelRt.pages.get(m.reportPageId!, null);
    expect(page?.content).toContain('Numbers in the summary without evidence:** 250');
  }, 180_000);

  it('closes at the end of the time budget, and can be stopped', async () => {
    const theo = await bot(app, 'Theo');
    const res = await app.inject({
      method: 'POST',
      url: '/api/missions',
      payload: { goal: 'Ring resonator with 20 um radius', botIds: [theo.id], autoApprove: false },
    });
    const m = res.json<MissionView>();
    // Bots are autonomous and approve their own plans, so the mission would finish by itself;
    // the time budget is exhausted right away to test that it closes at its end.
    const db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    await db.query("UPDATE missions SET ends_at = now() - interval '1 minute' WHERE id = $1", [
      m.id,
    ]);
    await db.end();
    await rules.chats.engine.tick();
    const after = (await app.inject({ url: `/api/missions/${m.id}` })).json<MissionView>();
    expect(after).toMatchObject({ status: 'timeout', verdict: 'no_criteria' });

    const other = await bot(app, 'Lina');
    const second = (
      await app.inject({
        method: 'POST',
        url: '/api/missions',
        payload: { goal: 'GHZ state on 3 qubits', botIds: [other.id], autoApprove: false },
      })
    ).json<MissionView>();
    const stopped = await app.inject({ method: 'POST', url: `/api/missions/${second.id}/stop` });
    expect(stopped.json<MissionView>()).toMatchObject({ status: 'stopped' });
    expect((await app.inject({ url: '/api/missions/fields' })).json()).toHaveProperty('thin_film');
  }, 180_000);
});
