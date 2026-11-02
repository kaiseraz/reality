import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BotView } from '@reality/schemas';
import { buildApp } from '../src/app.ts';
import type { AgentMessage, AgentModel, Block, TurnResult } from '../src/chat/model.ts';
import { loadConfig } from '../src/config.ts';
import type { MissionView } from '../src/missions/missions.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

/**
 * The loop the bots are meant to run, as a script: read the engine's schema, write a board,
 * run it, read in the checked result what is wrong (the unrouted net), change exactly that,
 * run again, and close the mission only when the checked result meets the criteria. The
 * first board is walled in by mounting holes between its two parts, so it cannot be routed.
 */
const PARTS = (wall: boolean) => [
  { ref: 'R1', footprint: 'R0603', at: [6, 10] },
  { ref: 'R2', footprint: 'R0603', at: [34, 10] },
  ...(wall
    ? [3.5, 10, 16.5].map((y, i) => ({ ref: `H${i + 1}`, footprint: 'HOLE6', at: [20, y] }))
    : []),
];
const board = (wall: boolean) => ({
  board: { width_mm: 40, height_mm: 20 },
  parts: PARTS(wall),
  nets: [{ name: 'A', pins: ['R1.2', 'R2.1'] }],
  routing_seconds: 8,
});

class DesignerModel implements AgentModel {
  readonly name = 'designer';
  sawSchema = false;
  sawUnrouted = false;
  sawTrackLength = false;
  private started = 0;
  private listed = false;
  async turn(req: { messages: AgentMessage[] }): Promise<TurnResult> {
    // A real model reads the whole transcript; this one looks for what it needs in it.
    const seen = JSON.stringify(req.messages);
    this.sawSchema ||= seen.includes('"routing_seconds"');
    this.sawUnrouted ||= seen.includes('unrouted=[\\"A\\"]');
    this.sawTrackLength ||= seen.includes('track_length_mm=');
    const call = (id: string, name: string, input: Record<string, unknown>): Block[] => [
      { type: 'tool_use', id, name, input },
    ];
    let content: Block[];
    if (this.started === 0 && !this.listed) {
      this.listed = true;
      content = call('l1', 'list_engines', { engine: 'pcb_design' });
    } else if (this.started === 0) {
      this.started = 1;
      content = call('r1', 'run_simulation', {
        engine: 'pcb_design',
        params: board(true),
        question: 'Board with two resistors and one net',
      });
    } else if (seen.includes('design_ok=true')) {
      content = seen.includes('closed the mission')
        ? [{ type: 'text', text: 'Board done and checked.' }]
        : call('f', 'finish_mission', { summary: 'The board is routed and the checks pass.' });
    } else if (this.started === 1 && seen.includes('unrouted=[\\"A\\"]')) {
      this.started = 2;
      content = call('r2', 'run_simulation', {
        engine: 'pcb_design',
        params: board(false),
        question: 'Same board without the mounting holes in the way',
      });
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

describe('a bot designs a board in a mission (database, sandbox)', () => {
  let runtime: Runtime;
  let app: FastifyInstance;
  let dir: string;
  const model = new DesignerModel();

  beforeAll(async () => {
    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-design-loop-'));
    const config = loadConfig({ AUTH: 'off', DATABASE_URL: TEST_DATABASE_URL, ARTIFACT_DIR: dir });
    runtime = await createRuntime(config, {
      planner: new RuleBasedPlanner(),
      analyst: null,
      synthesizer: null,
      chatModel: model,
      log: { error: () => {} },
    });
    app = buildApp(config, runtime);
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the schema, sees what failed in the checked result, fixes it and is judged by code', async () => {
    const ada = (
      await app.inject({
        method: 'POST',
        url: '/api/bots',
        payload: { name: 'Ada', role: 'engineer' },
      })
    ).json<BotView>();
    const res = await app.inject({
      method: 'POST',
      url: '/api/missions',
      payload: {
        goal: 'Design a board that connects R1 and R2 and passes every check',
        botIds: [ada.id],
        criteria: [
          { field: 'design_ok', equals: 'true' },
          { field: 'drc_violations', max: 0 },
        ],
        maxTasks: 4,
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<MissionView>();
    for (let i = 0; i < 14; i++) {
      await runtime.chats.engine.idle(created.chatId);
      await runtime.tasks.settleAll();
      await runtime.chats.engine.tick();
    }
    await runtime.chats.engine.idle(created.chatId);
    const m = (await app.inject({ url: `/api/missions/${created.id}` })).json<MissionView>();
    // What the bot could see: the schema, the unrouted net by name, and the numbers.
    expect(model.sawSchema).toBe(true);
    expect(model.sawUnrouted).toBe(true);
    expect(model.sawTrackLength).toBe(true);
    // The verdict is computed from the checked results, not from the bot's word.
    expect(m).toMatchObject({ status: 'finished', verdict: 'verified', tasksUsed: 2 });
    expect(m.criteria.map((c) => c.status)).toEqual(['met', 'met']);
  }, 600_000);
});
