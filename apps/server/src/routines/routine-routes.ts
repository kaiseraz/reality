import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BotService } from '../bots/bots.ts';
import type { PageStore } from '../pages/pages.ts';
import { findSample } from '../samples.ts';
import { RoutineError, RoutineInput, RoutinePatch, type RoutineService } from './routines.ts';

const Id = z.object({ id: z.uuid() });

/** Routines belong to their owner; the bot, page and dataset they use must be the owner's too. */
export function registerRoutineRoutes(
  app: FastifyInstance,
  deps: { routines: RoutineService; bots: BotService; pages: PageStore },
) {
  const { routines } = deps;
  const owner = (req: { user?: { id: string } | null }) => req.user?.id ?? null;

  /** Why the referenced bot, page or dataset cannot be used, if so. */
  const problem = async (
    req: { user?: { id: string; role: 'admin' | 'member' } | null },
    input: {
      botId?: string | null | undefined;
      pageId?: string | null | undefined;
      sample?: string | null | undefined;
    },
  ): Promise<string | null> => {
    if (input.botId && !(await deps.bots.canUse(req.user ?? null, input.botId)))
      return 'No such bot.';
    if (input.pageId && !(await deps.pages.get(input.pageId, owner(req)))) return 'No such page.';
    if (input.sample && !findSample(input.sample)) return 'No such example dataset.';
    return null;
  };

  app.get('/api/routines', async (req) => routines.list(owner(req)));

  app.post('/api/routines', async (req, reply) => {
    const body = RoutineInput.parse(req.body);
    const why = await problem(req, body);
    if (why) return reply.code(404).send({ error: 'not_found', message: why });
    try {
      return reply.code(201).send(await routines.create(owner(req), body));
    } catch (err) {
      if (err instanceof RoutineError) {
        return reply.code(422).send({ error: 'rejected', message: err.message });
      }
      throw err;
    }
  });

  app.get('/api/routines/:id', async (req, reply) => {
    const { id } = Id.parse(req.params);
    return (await routines.get(id, owner(req))) ?? reply.code(404).send({ error: 'not_found' });
  });

  app.patch('/api/routines/:id', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = RoutinePatch.parse(req.body);
    const why = await problem(req, body);
    if (why) return reply.code(404).send({ error: 'not_found', message: why });
    return (
      (await routines.update(id, owner(req), body)) ?? reply.code(404).send({ error: 'not_found' })
    );
  });

  app.delete('/api/routines/:id', async (req, reply) => {
    const { id } = Id.parse(req.params);
    if (!(await routines.remove(id, owner(req))))
      return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.post('/api/routines/:id/run', async (req, reply) => {
    const { id } = Id.parse(req.params);
    try {
      const taskId = await routines.runNow(id, owner(req));
      return taskId
        ? reply.code(201).send({ taskId })
        : reply.code(404).send({ error: 'not_found' });
    } catch (err) {
      if (err instanceof RoutineError) {
        return reply.code(422).send({ error: 'rejected', message: err.message });
      }
      throw err;
    }
  });
}
