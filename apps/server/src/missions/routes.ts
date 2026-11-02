import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BotService } from '../bots/bots.ts';
import type { ChatEngine } from '../chat/engine.ts';
import type { ChatStore } from '../chat/store.ts';
import { RESULT_FIELDS } from '../verification/criteria.ts';
import { CreateMissionRequest, type MissionService } from './missions.ts';

/** Missions belong to their owner; their team must be bots the owner can use. */
export function registerMissionRoutes(
  app: FastifyInstance,
  deps: { missions: MissionService; engine: ChatEngine; store: ChatStore; bots: BotService },
) {
  const owner = (req: { user?: { id: string } | null }) => req.user?.id ?? null;
  const Id = z.object({ id: z.uuid() });

  app.get('/api/missions', async (req) => deps.missions.list(owner(req)));

  /** Result values a criterion can name, by engine or recipe. */
  app.get('/api/missions/fields', async () => RESULT_FIELDS);

  /** The unit mission cost budgets are counted in. */
  app.get('/api/missions/pricing', async () => ({ unit: deps.missions.unit() }));

  app.post('/api/missions', async (req, reply) => {
    const body = CreateMissionRequest.parse(req.body);
    for (const id of body.botIds) {
      if (!(await deps.bots.canUse(req.user ?? null, id))) {
        return reply.code(404).send({ error: 'not_found', message: 'No such bot.' });
      }
    }
    const mission = await deps.missions.create(owner(req), body);
    const chat = await deps.store.get(mission.chatId);
    if (chat) await deps.engine.startMission(chat);
    return reply.code(201).send(mission);
  });

  app.get('/api/missions/:id', async (req, reply) => {
    const { id } = Id.parse(req.params);
    return (
      (await deps.missions.get(id, owner(req))) ?? reply.code(404).send({ error: 'not_found' })
    );
  });

  app.post('/api/missions/:id/stop', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const mission = await deps.missions.get(id, owner(req));
    const chat = mission ? await deps.store.get(mission.chatId, owner(req)) : undefined;
    if (!mission || !chat) return reply.code(404).send({ error: 'not_found' });
    return deps.engine.stopMission(chat, req.user?.email ?? 'You');
  });

  app.get('/api/chats/:id/mission', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const chat = await deps.store.get(id, owner(req));
    const mission = chat ? await deps.missions.forChat(chat.id) : undefined;
    return mission ?? reply.code(404).send({ error: 'not_found' });
  });
}
