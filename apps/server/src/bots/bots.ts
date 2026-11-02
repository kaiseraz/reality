import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import {
  CreateBotRequest,
  UpdateBotRequest,
  type BotFigure,
  type BotView,
  type TaskStatus,
  type TaskSummary,
} from '@reality/schemas';

const FIGURES: BotFigure[] = ['orb', 'cube', 'pill', 'cloud'];

/** Colours for bots without one: Reality's figure palette (wine, purple, plum, black, white). */
const PALETTE = ['#7a1f35', '#3f2557', '#5b2448', '#1b1b20', '#ececee'];

interface BotRow {
  id: string;
  owner_id: string | null;
  name: string;
  role: BotView['role'];
  color: string;
  persona: string;
  figure: BotFigure;
  created_at: Date;
  is_main: boolean;
  resting: boolean;
}

/** A figure and colour that fit the role, so a hired team looks like one at a glance. */
export const ROLE_LOOK: Record<BotView['role'], { figure: BotFigure; color: string }> = {
  lead: { figure: 'orb', color: '#ececee' },
  researcher: { figure: 'pill', color: '#3f2557' },
  engineer: { figure: 'cube', color: '#7a1f35' },
  analyst: { figure: 'cloud', color: '#5b2448' },
  reviewer: { figure: 'orb', color: '#1b1b20' },
};

type Viewer = { id: string; role: 'admin' | 'member' } | undefined;

/** Bots as persistent team members. A bot's status is derived from its tasks, never stored. */
export class BotService {
  constructor(private readonly pool: pg.Pool) {}

  async create(req: CreateBotRequest, ownerId: string | null): Promise<BotView> {
    const { rows } = await this.pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM bots WHERE owner_id IS NOT DISTINCT FROM $1',
      [ownerId],
    );
    if (Number(rows[0]?.n ?? 0) >= 50) throw new BotLimitError('At most 50 bots.');
    const id = randomUUID();
    const color = req.color ?? PALETTE[Number(rows[0]?.n ?? 0) % PALETTE.length] ?? PALETTE[0];
    await this.pool.query(
      `INSERT INTO bots (id, owner_id, name, role, color, persona, figure)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        ownerId,
        req.name,
        req.role,
        color,
        req.persona ?? '',
        req.figure ?? FIGURES[Number(rows[0]?.n ?? 0) % FIGURES.length] ?? 'orb',
      ],
    );
    const bot = await this.get(id);
    if (!bot) throw new Error('bot vanished');
    return bot;
  }

  /** The lead every person has from the start (created on first need). */
  async ensureMain(ownerId: string | null): Promise<BotView> {
    const { rows } = await this.pool.query<{ id: string }>(
      'SELECT id FROM bots WHERE is_main AND owner_id IS NOT DISTINCT FROM $1 LIMIT 1',
      [ownerId],
    );
    const found = rows[0] ? await this.get(rows[0].id) : undefined;
    if (found) return found;
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO bots (id, owner_id, name, role, color, persona, figure, is_main)
       VALUES ($1, $2, 'Reality', 'lead', '#e9e9eb', $3, 'orb', true)`,
      [
        id,
        ownerId,
        'The lead. Understands what you want, hires the right specialists for it, keeps them on budget and brings you the checked result.',
      ],
    );
    const bot = await this.get(id);
    if (!bot) throw new Error('lead vanished');
    return bot;
  }

  /** How a bot presents itself: its figure (orb, cube, pill, cloud) and colour. */
  async updateLook(
    id: string,
    look: { figure?: BotFigure | undefined; color?: string | undefined },
  ): Promise<BotView | undefined> {
    await this.pool.query(
      `UPDATE bots SET figure = COALESCE($2, figure), color = COALESCE($3, color) WHERE id = $1`,
      [id, look.figure ?? null, look.color ?? null],
    );
    return this.get(id);
  }

  async setResting(id: string, resting: boolean, hiredBy?: string): Promise<void> {
    await this.pool.query(
      'UPDATE bots SET resting = $2, hired_by = COALESCE($3, hired_by) WHERE id = $1',
      [id, resting, hiredBy ?? null],
    );
  }

  async list(viewer: Viewer): Promise<BotView[]> {
    const { rows } = viewer
      ? await this.pool.query<BotRow>(
          `SELECT * FROM bots WHERE owner_id = $1 OR ($2 AND owner_id IS NULL)
            ORDER BY is_main DESC, resting, created_at`,
          [viewer.id, viewer.role === 'admin'],
        )
      : await this.pool.query<BotRow>(
          'SELECT * FROM bots ORDER BY is_main DESC, resting, created_at',
        );
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(id: string): Promise<BotView | undefined> {
    const { rows } = await this.pool.query<BotRow>('SELECT * FROM bots WHERE id = $1', [id]);
    return rows[0] ? this.view(rows[0]) : undefined;
  }

  async tasks(id: string, limit = 50): Promise<TaskSummary[]> {
    const { rows } = await this.pool.query<{
      id: string;
      request: string;
      status: TaskStatus;
      created_at: Date;
      updated_at: Date;
      bot_id: string;
    }>('SELECT * FROM tasks WHERE bot_id = $1 ORDER BY updated_at DESC LIMIT $2', [id, limit]);
    return rows.map((r) => ({
      id: r.id,
      request: r.request,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      botId: r.bot_id,
    }));
  }

  async remove(id: string): Promise<void> {
    await this.pool.query('DELETE FROM bots WHERE id = $1', [id]);
  }

  /** Whether the account may use this bot: its own, or (admins) one without an owner. */
  async canUse(
    user: { id: string; role: 'admin' | 'member' } | null,
    id: string,
  ): Promise<boolean> {
    const { rows } = await this.pool.query<{ owner_id: string | null }>(
      'SELECT owner_id FROM bots WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (!row) return false;
    if (!user) return true; // AUTH=off: single user
    return row.owner_id === user.id || (row.owner_id === null && user.role === 'admin');
  }

  private async view(r: BotRow): Promise<BotView> {
    const { rows: current } = await this.pool.query<{
      id: string;
      request: string;
      status: TaskStatus;
    }>(
      `SELECT id, request, status FROM tasks
       WHERE bot_id = $1 AND status IN ('planning', 'running', 'awaiting_approval')
       ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'planning' THEN 1 ELSE 2 END, updated_at DESC
       LIMIT 1`,
      [r.id],
    );
    const { rows: done } = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM tasks WHERE bot_id = $1 AND status = 'completed'",
      [r.id],
    );
    const { rows: record } = await this.pool.query<{ met: string; failed: string }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'met') AS met,
              COUNT(*) FILTER (WHERE status = 'failed') AS failed
         FROM bot_contracts WHERE bot_id = $1`,
      [r.id],
    );
    const c = current[0];
    return {
      id: r.id,
      name: r.name,
      role: r.role,
      color: r.color,
      persona: r.persona,
      figure: r.figure,
      createdAt: r.created_at.toISOString(),
      status: !c ? 'idle' : c.status === 'awaiting_approval' ? 'waiting' : 'working',
      current: c ? { taskId: c.id, request: c.request, status: c.status } : null,
      done: Number(done[0]?.n ?? 0),
      isMain: r.is_main,
      resting: r.resting,
      record: { met: Number(record[0]?.met ?? 0), failed: Number(record[0]?.failed ?? 0) },
    };
  }
}

export class BotLimitError extends Error {}

export function registerBotRoutes(app: FastifyInstance, bots: BotService) {
  const Params = z.object({ id: z.uuid() });

  app.get('/api/bots', async (req) => {
    // Everyone starts with the lead.
    await bots.ensureMain(req.user?.id ?? null);
    return bots.list(req.user ?? undefined);
  });

  app.post('/api/bots', async (req, reply) => {
    const body = CreateBotRequest.parse(req.body);
    try {
      return reply.code(201).send(await bots.create(body, req.user?.id ?? null));
    } catch (err) {
      if (err instanceof BotLimitError) {
        return reply.code(422).send({ error: 'rejected', message: err.message });
      }
      throw err;
    }
  });

  app.get('/api/bots/:id', async (req, reply) => {
    const { id } = Params.parse(req.params);
    const bot = await bots.get(id);
    if (!bot) return reply.code(404).send({ error: 'not_found' });
    return { ...bot, tasks: await bots.tasks(id) };
  });

  app.patch('/api/bots/:id', async (req, reply) => {
    const { id } = Params.parse(req.params);
    if (!(await bots.canUse(req.user ?? null, id))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const body = UpdateBotRequest.parse(req.body);
    const bot = await bots.updateLook(id, body);
    return bot ?? reply.code(404).send({ error: 'not_found' });
  });

  app.delete('/api/bots/:id', async (req, reply) => {
    const { id } = Params.parse(req.params);
    const bot = await bots.get(id);
    if (!bot) return reply.code(404).send({ error: 'not_found' });
    if (bot.isMain) {
      return reply.code(409).send({ error: 'lead', message: 'The lead stays on the team.' });
    }
    await bots.remove(id);
    return { ok: true };
  });
}
