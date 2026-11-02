import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CreateProjectRequest } from '@reality/schemas';
import type { Runtime } from '../runtime.ts';
import { ProjectPlanError } from './project-planner.ts';
import { ProjectBudgetError, ProjectNotFoundError } from './project-service.ts';

const ProjectParams = z.object({ id: z.uuid() });
const NewTask = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  request: z.string().trim().min(1).max(10_000),
  dependsOn: z.array(z.uuid()).max(20).default([]),
  inputFrom: z.uuid().optional(),
});

/** Projects (M7) and the inbox of decisions waiting for the user. Ownership: auth hook. */
export function registerProjectRoutes(app: FastifyInstance, runtime: Runtime) {
  const { projects, tasks } = runtime;

  const handle = async <T>(fn: () => Promise<T>, reply: FastifyReply) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        return reply.code(404).send({ error: 'not_found', message: err.message });
      }
      if (err instanceof ProjectPlanError || err instanceof ProjectBudgetError) {
        return reply.code(422).send({ error: 'rejected', message: err.message });
      }
      throw err;
    }
  };

  app.post('/api/projects', async (req, reply) => {
    const body = CreateProjectRequest.parse(req.body);
    for (const botId of body.team) {
      if (!(await runtime.bots.canUse(req.user ?? null, botId))) {
        return reply.code(404).send({ error: 'not_found', message: 'No such bot in the team.' });
      }
    }
    return handle(async () => {
      const project = await projects.create(body, req.user?.id ?? null);
      return reply.code(201).send(project);
    }, reply);
  });

  app.get('/api/projects', async (req) => projects.list(req.user ?? undefined));

  app.get('/api/projects/:id', async (req, reply) => {
    const { id } = ProjectParams.parse(req.params);
    return handle(() => projects.detail(id), reply);
  });

  app.post('/api/projects/:id/tasks', async (req, reply) => {
    const { id } = ProjectParams.parse(req.params);
    const t = NewTask.parse(req.body);
    return handle(async () => {
      const taskId = await projects.addTask(
        id,
        {
          title: t.title ?? (t.request.length > 80 ? `${t.request.slice(0, 77)}…` : t.request),
          request: t.request,
          dependsOn: t.dependsOn,
          inputFrom: t.inputFrom,
        },
        req.user?.id ?? null,
      );
      return reply.code(201).send({ taskId });
    }, reply);
  });

  app.post('/api/projects/:id/files', async (req, reply) => {
    const { id } = ProjectParams.parse(req.params);
    if (typeof req.body !== 'string') {
      return reply.code(415).send({ error: 'unsupported_media_type', message: 'Send text/csv.' });
    }
    const { filename } = z.object({ filename: z.string().min(1).max(255) }).parse(req.query);
    const text = req.body;
    return handle(async () => {
      await projects.addFile(id, filename, text);
      return reply.code(201).send({ ok: true });
    }, reply);
  });

  app.post('/api/projects/:id/pause', async (req, reply) => {
    const { id } = ProjectParams.parse(req.params);
    return handle(async () => {
      await projects.setPaused(id, true);
      return { ok: true };
    }, reply);
  });

  app.post('/api/projects/:id/resume', async (req, reply) => {
    const { id } = ProjectParams.parse(req.params);
    return handle(async () => {
      await projects.setPaused(id, false);
      return { ok: true };
    }, reply);
  });

  app.get('/api/tasks/:id/project', async (req) => {
    const { id } = ProjectParams.parse(req.params);
    return (await projects.projectOfTask(id)) ?? null;
  });

  /** Every decision waiting for this account, across projects and single tasks. */
  app.get('/api/inbox', async (req) => {
    const waiting = await tasks.listWaiting(req.user ?? undefined);
    const items = [];
    for (const t of waiting) {
      const detail = await tasks.get(t.id);
      const pending = detail?.pendingApproval as
        | { kind?: string; proposal?: { package?: string; version?: string; need?: string } }
        | null
        | undefined;
      const project = await projects.projectOfTask(t.id);
      items.push({
        taskId: t.id,
        request: t.request,
        since: t.updatedAt,
        kind: pending?.kind ?? 'unknown',
        summary:
          pending?.kind === 'capability-approval'
            ? `Install ${pending.proposal?.package ?? 'a capability'} ${pending.proposal?.version ?? ''} for “${pending.proposal?.need ?? ''}”`
            : `Plan with ${detail?.state?.spec?.workflow.length ?? 0} steps and ${detail?.state?.spec?.acceptanceCriteria.length ?? 0} checks`,
        project: project ?? null,
        reason: (await projects.deferralReason(t.id)) ?? null,
      });
    }
    return items;
  });
}
