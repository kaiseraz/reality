import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ArtifactStore } from '../artifacts/artifact-store.ts';
import type { TaskService } from '../tasks/task-service.ts';
import { PageConflictError, PageError, type PageStore } from './pages.ts';
import { taskReport } from './report.ts';

const Id = z.object({ id: z.uuid() });

/** Pages belong to their owner; every write is a version, a conflicting write is a 409. */
export function registerPageRoutes(
  app: FastifyInstance,
  deps: { pages: PageStore; tasks: TaskService; artifacts: ArtifactStore },
) {
  const { pages } = deps;
  const owner = (req: { user?: { id: string } | null }) => req.user?.id ?? null;
  const author = (req: { user?: { email?: string } | null }) => req.user?.email ?? 'You';

  const guarded = async <T>(
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    fn: () => Promise<T>,
  ) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PageConflictError) {
        return reply
          .code(409)
          .send({ error: 'conflict', message: err.message, current: err.current });
      }
      if (err instanceof PageError) {
        return reply.code(422).send({ error: 'rejected', message: err.message });
      }
      throw err;
    }
  };

  app.get('/api/pages', async (req) => pages.list(owner(req)));

  app.post('/api/pages', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const body = z
      .object({
        title: z.string().trim().min(1).max(160),
        content: z.string().max(400_000).default(''),
      })
      .parse(req.body);
    return guarded(reply, async () =>
      reply.code(201).send(await pages.create(owner(req), { ...body, author: author(req) })),
    );
  });

  app.get('/api/pages/:id', async (req, reply) => {
    const { id } = Id.parse(req.params);
    return (await pages.get(id, owner(req))) ?? reply.code(404).send({ error: 'not_found' });
  });

  app.get('/api/pages/:id/versions/:version', async (req, reply) => {
    const { id, version } = z
      .object({ id: z.uuid(), version: z.coerce.number().int().min(1) })
      .parse(req.params);
    return (
      (await pages.version(id, owner(req), version)) ?? reply.code(404).send({ error: 'not_found' })
    );
  });

  app.put('/api/pages/:id', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = z
      .object({
        content: z.string().max(400_000),
        title: z.string().trim().max(160).optional(),
        change: z.string().trim().max(200).default('Edited'),
        baseVersion: z.number().int().min(1),
      })
      .parse(req.body);
    return guarded(reply, async () => {
      const page = await pages.write(id, owner(req), {
        content: body.content,
        ...(body.title ? { title: body.title } : {}),
        author: author(req),
        change: body.change || 'Edited',
        baseVersion: body.baseVersion,
      });
      return page ?? reply.code(404).send({ error: 'not_found' });
    });
  });

  app.post('/api/pages/:id/restore', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const { version } = z.object({ version: z.number().int().min(1) }).parse(req.body);
    return guarded(reply, async () => {
      const page = await pages.restore(id, owner(req), version, author(req));
      return page ?? reply.code(404).send({ error: 'not_found' });
    });
  });

  app.delete('/api/pages/:id', async (req, reply) => {
    const { id } = Id.parse(req.params);
    if (!(await pages.remove(id, owner(req)))) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  /** A task's result as a page: a new page, or a new version of an existing one. */
  app.post('/api/tasks/:id/page', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = z
      .object({ pageId: z.uuid().optional(), title: z.string().trim().min(1).max(160).optional() })
      .parse(req.body ?? {});
    const report = await taskReport(deps, id);
    if (!report) return reply.code(404).send({ error: 'not_found' });
    const task = await deps.tasks.get(id);
    return guarded(reply, async () => {
      if (body.pageId) {
        const page = await pages.write(body.pageId, owner(req), {
          append: report,
          author: author(req),
          change: 'Added a task result',
          taskId: id,
        });
        return page ?? reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(201).send(
        await pages.create(owner(req), {
          title: body.title ?? (task?.request ?? 'Result').slice(0, 160),
          content: report,
          author: author(req),
          change: 'Created from a task result',
          taskId: id,
        }),
      );
    });
  });
}
