import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApprovalDecision, CreateTaskRequest, type TaskEvent } from '@reality/schemas';
import { modelConfig, resolvePlannerKind, type Config, type PlannerKind } from './config.ts';
import type { Runtime } from './runtime.ts';
import { findSample, readSample, SAMPLES } from './samples.ts';
import { registerAuth } from './auth/auth-routes.ts';
import { registerStatic } from './static.ts';
import { attachUpload } from './artifacts/attach.ts';
import { primaryDataset } from './analysis/executor.ts';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { registerProjectRoutes } from './projects/project-routes.ts';
import { registerCriteriaRoutes } from './verification/criteria-routes.ts';
import { registerBotRoutes } from './bots/bots.ts';
import { registerKnowledgeRoutes } from './research/knowledge-routes.ts';
import { registerPageRoutes } from './pages/page-routes.ts';
import { registerRoutineRoutes } from './routines/routine-routes.ts';
import { registerChatRoutes } from './chat/routes.ts';
import { registerComputerRoutes } from './computer/routes.ts';
import { registerMissionRoutes } from './missions/routes.ts';
import { ArtifactRejectedError, MAX_CSV_BYTES } from './artifacts/artifact-store.ts';
import { TaskNotFoundError, TaskStateError } from './tasks/task-service.ts';
import {
  ActionRejectedError,
  NothingToUndoError,
  PatchRejectedError,
  WorkspaceNotFoundError,
} from './workspaces/workspace-service.ts';

export interface HealthResponse {
  status: 'ok';
  service: 'reality-server';
  configured: { database: boolean; llm: boolean };
  /** Which planner is active; anything but "anthropic" must be visible to users. */
  planner: PlannerKind;
  /** null if sandboxed execution is available, otherwise why not. */
  sandboxProblem: string | null;
}

const SSE_HEARTBEAT_MS = 15_000;

export function buildApp(
  config: Config,
  runtime?: Runtime,
  opts: { logger?: boolean } = {},
): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get('/api/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'reality-server',
    configured: {
      database: config.DATABASE_URL !== undefined,
      llm: modelConfig(config) !== undefined,
    },
    planner: resolvePlannerKind(config),
    sandboxProblem: runtime ? runtime.sandboxProblem : null,
  }));

  if (runtime) {
    registerErrorHandler(app);
    registerAuth(app, config, runtime.auth);
    registerTaskRoutes(app, runtime);
    registerWorkspaceRoutes(app, runtime, config);
    registerProjectRoutes(app, runtime);
    registerCriteriaRoutes(app, { tasks: runtime.tasks, criteria: runtime.criteria });
    registerBotRoutes(app, runtime.bots);
    registerPageRoutes(app, {
      pages: runtime.pages,
      tasks: runtime.tasks,
      artifacts: runtime.artifacts,
    });
    registerChatRoutes(app, {
      folders: runtime.folders,
      files: runtime.files,
      store: runtime.chats.store,
      engine: runtime.chats.engine,
      bots: runtime.bots,
    });
    if (runtime.computers) {
      registerComputerRoutes(app, {
        computers: runtime.computers,
        bots: runtime.bots,
        auth: runtime.auth,
        authEnabled: config.AUTH === 'on',
      });
    }
    registerMissionRoutes(app, {
      missions: runtime.missions,
      engine: runtime.chats.engine,
      store: runtime.chats.store,
      bots: runtime.bots,
    });
    registerRoutineRoutes(app, {
      routines: runtime.routines,
      bots: runtime.bots,
      pages: runtime.pages,
    });
    registerKnowledgeRoutes(app, runtime.knowledge, {
      ...(config.OPENALEX_URL ? { openAlexUrl: config.OPENALEX_URL } : {}),
    });
  }
  if (config.WEB_DIST) registerStatic(app, config.WEB_DIST);
  return app;
}

const TaskParams = z.object({ id: z.uuid() });

function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: 'invalid_request', issues: err.issues });
    }
    if (err instanceof TaskNotFoundError || err instanceof WorkspaceNotFoundError) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (err instanceof TaskStateError || err instanceof NothingToUndoError) {
      return reply.code(409).send({ error: 'conflict', message: err.message });
    }
    if (err instanceof PatchRejectedError) {
      return reply.code(422).send({ error: 'patch_rejected', errors: err.errors });
    }
    if (err instanceof ActionRejectedError || err instanceof ArtifactRejectedError) {
      return reply.code(422).send({ error: 'rejected', message: err.message });
    }
    // Fastify-generated client errors (body too large, bad content type, malformed JSON).
    const { statusCode, message } = err as { statusCode?: number; message?: string };
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: 'invalid_request', message });
    }
    app.log.error(err);
    return reply.code(500).send({ error: 'internal' });
  });
}

function registerTaskRoutes(app: FastifyInstance, runtime: Runtime) {
  const { tasks, events } = runtime;

  app.post('/api/tasks', async (req, reply) => {
    const { request, start, botId } = CreateTaskRequest.parse(req.body);
    if (botId && !(await runtime.bots.canUse(req.user ?? null, botId))) {
      return reply.code(404).send({ error: 'not_found', message: 'No such bot.' });
    }
    return reply.code(201).send(
      await tasks.create(request, {
        start,
        ownerId: req.user?.id ?? null,
        botId: botId ?? null,
      }),
    );
  });

  app.post('/api/tasks/:id/start', async (req, reply) => {
    const { id } = TaskParams.parse(req.params);
    await tasks.start(id);
    return reply.code(202).send({ accepted: true });
  });

  app.get('/api/tasks', async (req) => tasks.list(req.user ?? undefined));

  app.get('/api/tasks/:id', async (req, reply) => {
    const { id } = TaskParams.parse(req.params);
    const detail = await tasks.get(id);
    return detail ?? reply.code(404).send({ error: 'not_found' });
  });

  /** Lab results of a task as cards (charts, CAD, facts), as a chat shows them. */
  app.get('/api/tasks/:id/lab', async (req, reply) => {
    const { id } = TaskParams.parse(req.params);
    if (!(await tasks.get(id))) return reply.code(404).send({ error: 'not_found' });
    return runtime.chats.engine.labCards(id);
  });

  app.post('/api/tasks/:id/approval', async (req, reply) => {
    const { id } = TaskParams.parse(req.params);
    // Decisions through the API are always the user's; only the scheduler acts as policy.
    await tasks.decide(id, { ...ApprovalDecision.parse(req.body), by: 'user' });
    return reply.code(202).send({ accepted: true });
  });

  app.get('/api/tasks/:id/history', async (req, reply) => {
    const { id } = TaskParams.parse(req.params);
    if (!(await tasks.get(id))) return reply.code(404).send({ error: 'not_found' });
    return events.list(id);
  });

  app.get('/api/tasks/:id/events', async (req, reply) => {
    const { id } = TaskParams.parse(req.params);
    if (!(await tasks.get(id))) return reply.code(404).send({ error: 'not_found' });

    // Resume point: EventSource sends Last-Event-ID on reconnect; ?after= for first load.
    const header = req.headers['last-event-id'];
    const query = z.object({ after: z.coerce.number().int().nonnegative().optional() });
    let lastSent = Number(header ?? query.parse(req.query).after ?? 0) || 0;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const send = (event: TaskEvent) => {
      if (event.id <= lastSent) return;
      lastSent = event.id;
      res.write(`id: ${event.id}\nevent: task-event\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // Subscribe before replaying so nothing falls in the gap; `send` drops duplicates.
    const buffered: TaskEvent[] = [];
    let replaying = true;
    const unsubscribe = events.subscribe(id, (e) => (replaying ? buffered.push(e) : send(e)));
    for (const e of await events.list(id, lastSent)) send(e);
    replaying = false;
    buffered.forEach(send);

    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), SSE_HEARTBEAT_MS);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}

const WorkspaceParams = z.object({ id: z.uuid() });
const RowsQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50_000).default(50),
  sort: z.string().min(1).optional(),
  desc: z.enum(['true', 'false']).optional(),
});

function registerWorkspaceRoutes(app: FastifyInstance, runtime: Runtime, config: Config) {
  const { tasks, workspaces, artifacts, events } = runtime;

  app.addContentTypeParser(
    ['text/csv', 'application/csv'],
    { parseAs: 'string', bodyLimit: MAX_CSV_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.get('/api/tasks/:id/workspace', async (req, reply) => {
    const { id } = TaskParams.parse(req.params);
    const spec = await workspaces.getByTask(id);
    if (spec) return spec;
    // Tasks created before workspaces existed (M1) get their template workspace lazily.
    if (!(await tasks.get(id))) return reply.code(404).send({ error: 'not_found' });
    return workspaces.createForTask(id);
  });

  app.get('/api/workspaces/:id', async (req, reply) => {
    const { id } = WorkspaceParams.parse(req.params);
    const spec = await workspaces.get(id);
    return spec ?? reply.code(404).send({ error: 'not_found' });
  });

  // Patches from the browser are always attributed to the user, whatever they claim.
  app.post('/api/workspaces/:id/patches', async (req) => {
    const { id } = WorkspaceParams.parse(req.params);
    const body = z.object({}).loose().parse(req.body);
    return workspaces.applyPatch(id, { ...body, workspaceId: id, proposedBy: 'user' }, 'user');
  });

  app.post('/api/workspaces/:id/undo', async (req) => {
    const { id } = WorkspaceParams.parse(req.params);
    return workspaces.undo(id, 'user');
  });

  app.post('/api/workspaces/:id/actions', async (req, reply) => {
    const { id } = WorkspaceParams.parse(req.params);
    await workspaces.handleAction(id, req.body);
    return reply.code(202).send({ accepted: true });
  });

  app.post('/api/tasks/:id/artifacts', async (req, reply) => {
    const { id } = TaskParams.parse(req.params);
    if (!(await tasks.get(id))) return reply.code(404).send({ error: 'not_found' });
    if (typeof req.body !== 'string') {
      return reply.code(415).send({ error: 'unsupported_media_type', message: 'Send text/csv.' });
    }
    const { filename } = z.object({ filename: z.string().min(1).max(255) }).parse(req.query);
    return reply.code(201).send(await attach(id, filename, req.body));
  });

  app.get('/api/samples', async () => SAMPLES);

  /**
   * A follow-up question: a new task on the same data, started right away (its plan still
   * waits for approval). The original file is attached again, so preparation runs as usual.
   */
  app.post('/api/tasks/:id/follow-up', async (req, reply) => {
    const { id } = TaskParams.parse(req.params);
    const { request } = z.object({ request: z.string().trim().min(1).max(10_000) }).parse(req.body);
    if (!(await tasks.get(id))) return reply.code(404).send({ error: 'not_found' });
    const data = await primaryDataset(artifacts, id);
    const source =
      data?.provenance.kind === 'prepared' ? await artifacts.get(data.provenance.from) : data;
    const next = await tasks.create(request, { start: false, ownerId: req.user?.id ?? null });
    if (source) {
      await attach(next.id, source.filename, await readFile(artifacts.filePath(source), 'utf8'));
    }
    await tasks.start(next.id);
    return reply.code(201).send(next);
  });

  /** Attaches a bundled example dataset, through the same path as a user upload. */
  app.post('/api/tasks/:id/samples/:sample', async (req, reply) => {
    const { id, sample: sampleId } = z
      .object({ id: z.uuid(), sample: z.string().max(40) })
      .parse(req.params);
    const sample = findSample(sampleId);
    if (!sample) return reply.code(404).send({ error: 'not_found' });
    if (!(await tasks.get(id))) return reply.code(404).send({ error: 'not_found' });
    const text = await readSample(config.SAMPLES_DIR, sample);
    return reply
      .code(201)
      .send(await attach(id, sample.file.split('/').pop() ?? sample.file, text));
  });

  const attach = (id: string, filename: string, text: string) =>
    attachUpload({ artifacts, events, workspaces }, id, filename, text);

  app.get('/api/capabilities', async () => runtime.capabilities.list());

  app.get('/api/tasks/:id/runs', async (req) => {
    const { id } = TaskParams.parse(req.params);
    return runtime.runs.listForTask(id);
  });

  app.get('/api/tasks/:id/artifacts', async (req) => {
    const { id } = TaskParams.parse(req.params);
    return artifacts.listForTask(id);
  });

  /** A stored step file (STEP assembly, mesh): inline for the viewer, or as a download. */
  app.get('/api/files/:id', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { download } = z.object({ download: z.string().optional() }).parse(req.query);
    const file = await runtime.files.get(id);
    if (!file || (file.ownerId !== null && file.ownerId !== (req.user?.id ?? null))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
    return reply
      .header('content-type', file.mediaType)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('content-disposition', `${download ? 'attachment' : 'inline'}; filename="${safe}"`)
      .send(createReadStream(runtime.files.filePath(file)));
  });

  /**
   * A page a bot drew. It comes with its own closed world, even when opened directly: a sandbox
   * means no cookies or storage of ours, and nothing may load or leave.
   */
  app.get('/api/files/:id/visual', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const file = await runtime.files.get(id);
    if (!file || (file.ownerId !== null && file.ownerId !== (req.user?.id ?? null))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const body = await readFile(runtime.files.filePath(file), 'utf8');
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header(
        'content-security-policy',
        "sandbox allow-scripts; default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'",
      )
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><style>html{color-scheme:dark}body{margin:0;padding:16px;background:#0b0b0c;color:#ececec;font:14px/1.5 Inter,system-ui,sans-serif}svg,canvas,img{max-width:100%;height:auto}</style></head><body>${body}</body></html>`,
      );
  });

  app.get('/api/artifacts/:id/rows', async (req, reply) => {
    const { id } = WorkspaceParams.parse(req.params);
    const meta = await artifacts.get(id);
    if (!meta) return reply.code(404).send({ error: 'not_found' });
    const q = RowsQuery.parse(req.query);
    return artifacts.rows(meta, {
      offset: q.offset,
      limit: q.limit,
      sort: q.sort,
      desc: q.desc === 'true',
    });
  });
}
