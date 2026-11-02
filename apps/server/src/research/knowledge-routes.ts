import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { KnowledgeError, type KnowledgeStore } from './knowledge.ts';
import { LiteratureError, searchLiterature } from './openalex.ts';

const AddSource = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('note'),
    name: z.string().trim().min(1).max(120),
    text: z.string().trim().min(1).max(200_000),
  }),
  z.object({
    kind: z.literal('url'),
    url: z.url({ protocol: /^https?$/ }).max(2000),
    name: z.string().trim().max(120).optional(),
  }),
  z.object({
    kind: z.literal('file'),
    name: z.string().trim().min(1).max(120),
    text: z.string().min(1),
  }),
]);

const Search = z.object({
  q: z.string().trim().min(2).max(300),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

/** Knowledge sources are private to their owner; literature search is open to every user. */
export function registerKnowledgeRoutes(
  app: FastifyInstance,
  knowledge: KnowledgeStore,
  opts: { openAlexUrl?: string } = {},
) {
  const owner = (req: { user?: { id: string } | null }) => req.user?.id ?? null;
  const rejected = (
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    err: Error,
  ) => reply.code(422).send({ error: 'rejected', message: err.message });

  app.get('/api/knowledge', async (req) => knowledge.list(owner(req)));

  app.post('/api/knowledge', { bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
    const body = AddSource.parse(req.body);
    try {
      const source =
        body.kind === 'note'
          ? await knowledge.addNote(owner(req), body.name, body.text)
          : body.kind === 'url'
            ? await knowledge.addUrl(owner(req), body.url, body.name)
            : await knowledge.addFile(owner(req), body.name, body.text);
      return reply.code(201).send(source);
    } catch (err) {
      if (err instanceof KnowledgeError) return rejected(reply, err);
      throw err;
    }
  });

  app.delete('/api/knowledge/:id', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!(await knowledge.remove(id, owner(req))))
      return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.get('/api/knowledge/search', async (req) => {
    const { q, limit } = Search.parse(req.query);
    return knowledge.search(owner(req), q, limit);
  });

  app.get('/api/literature', async (req, reply) => {
    const { q, limit } = Search.parse(req.query);
    try {
      return await searchLiterature(q, {
        limit,
        ...(opts.openAlexUrl ? { baseUrl: opts.openAlexUrl } : {}),
      });
    } catch (err) {
      if (err instanceof LiteratureError) {
        return reply.code(502).send({ error: 'upstream', message: err.message });
      }
      throw err;
    }
  });
}
