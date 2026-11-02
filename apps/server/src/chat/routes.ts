import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AnswerRequest,
  CreateChatRequest,
  RenameChatRequest,
  SendMessageRequest,
  UpdateBoardTaskRequest,
} from '@reality/schemas';
import type { BotService } from '../bots/bots.ts';
import type { ChatEngine } from './engine.ts';
import type { FileStore } from '../artifacts/file-store.ts';
import type { Chat, ChatStore } from './store.ts';
import { FolderError, type ProjectFolders } from '../projects/folders.ts';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Chats belong to their owner; a group may only contain bots the owner can use. */
export function registerChatRoutes(
  app: FastifyInstance,
  deps: {
    store: ChatStore;
    engine: ChatEngine;
    bots: BotService;
    files?: FileStore;
    folders?: ProjectFolders | null;
  },
) {
  const { store, engine, bots, files, folders } = deps;
  const owner = (req: FastifyRequest) => req.user?.id ?? null;
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
  const chatOf = async (req: FastifyRequest): Promise<Chat | undefined> => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return store.get(id, owner(req));
  };

  app.get('/api/chats', async (req) => store.list(owner(req)));

  app.post('/api/chats', async (req, reply) => {
    const body = CreateChatRequest.parse(req.body);
    for (const id of body.botIds) {
      if (!(await bots.canUse(req.user ?? null, id))) {
        return reply.code(404).send({ error: 'not_found', message: 'No such bot.' });
      }
    }
    const chat = await store.create(owner(req), body.kind, body.title, [...new Set(body.botIds)]);
    return reply.code(201).send(await engine.state(chat));
  });

  /** The direct chat with a bot, created on first open. */
  app.get('/api/bots/:id/chat', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const bot = await bots.get(id);
    if (!bot || !(await bots.canUse(req.user ?? null, id))) return notFound(reply);
    return engine.state(await store.dmFor(id, owner(req), bot.name));
  });

  app.get('/api/chats/:id', async (req, reply) => {
    const chat = await chatOf(req);
    return chat ? engine.state(chat) : notFound(reply);
  });

  /** Renaming a conversation (its 3-dot menu in the sidebar). */
  app.patch('/api/chats/:id', async (req, reply) => {
    const chat = await chatOf(req);
    if (!chat) return notFound(reply);
    const { title } = RenameChatRequest.parse(req.body);
    await store.rename(chat.id, title);
    return engine.state({ ...chat, title });
  });

  app.post('/api/chats/:id/messages', async (req, reply) => {
    const chat = await chatOf(req);
    if (!chat) return notFound(reply);
    const body = SendMessageRequest.parse(req.body);
    await engine.userMessage(chat, body.text, body.sample);
    return reply.code(202).send(await engine.state(chat));
  });

  /** The person takes the bot's desktop in the live screen: its turn pauses. */
  app.post('/api/chats/:id/takeover/:botId', async (req, reply) => {
    const chat = await chatOf(req);
    if (!chat) return notFound(reply);
    const { botId } = z.object({ id: z.uuid(), botId: z.uuid() }).parse(req.params);
    if (!chat.botIds.includes(botId)) return notFound(reply);
    engine.takeOver(chat.id, botId);
    return engine.state(chat);
  });

  /**
   * Handing the desktop back: the turn resumes, and an optional note — what the person
   * did or wants next ("logged in — pick the 6:15 flight") — reaches the bot directly.
   */
  app.post('/api/chats/:id/handback/:botId', async (req, reply) => {
    const chat = await chatOf(req);
    if (!chat) return notFound(reply);
    const { botId } = z.object({ id: z.uuid(), botId: z.uuid() }).parse(req.params);
    if (!chat.botIds.includes(botId)) return notFound(reply);
    const parsed = await z
      .object({ note: z.string().trim().min(1).max(4000).optional() })
      .safeParseAsync(req.body ?? {});
    const note = parsed.success ? parsed.data.note : undefined;
    const state = await engine.handBack(chat, botId, note);
    return reply.code(202).send(state);
  });

  /** A file the person puts into the chat: stored as theirs, read by nothing until a bot uses it. */
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );
  app.post('/api/chats/:id/files', { bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
    const chat = await chatOf(req);
    if (!chat || !files) return notFound(reply);
    const { name } = z.object({ name: z.string().trim().min(1).max(200) }).parse(req.query);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reply.code(400).send({ error: 'empty', message: 'The file is empty.' });
    }
    const clean = (name.split(/[\\/]/).pop() ?? 'file').replace(/[^\w.() -]+/g, '_') || 'file';
    const dir = await mkdtemp(join(tmpdir(), 'reality-upload-'));
    try {
      await writeFile(join(dir, 'file'), req.body);
      const stored = await files.put(null, null, clean, join(dir, 'file'), owner(req));
      await store.add(chat.id, {
        role: 'card',
        card: {
          kind: 'file',
          fileId: stored.id,
          name: clean,
          sizeBytes: stored.sizeBytes,
          fromPerson: true,
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return reply.code(201).send(await engine.state(chat));
  });

  // Folders on this machine: for whoever runs it, not for other accounts on it.
  const mayUseFolders = (req: FastifyRequest) => !req.user || req.user.role === 'admin';
  const folderError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof FolderError) {
      return reply.code(400).send({ error: 'bad_folder', message: err.message });
    }
    throw err;
  };

  app.get('/api/chats/:id/folder', async (req, reply) => {
    const chat = await chatOf(req);
    if (!chat || !folders) return notFound(reply);
    return folders.status(chat);
  });

  app.put('/api/chats/:id/folder', async (req, reply) => {
    const chat = await chatOf(req);
    if (!chat || !folders || !mayUseFolders(req)) return notFound(reply);
    const { path } = z.object({ path: z.string().trim().min(1).max(500) }).parse(req.body);
    return folders
      .choose(chat, path)
      .then((chosen) => ({ path: chosen }))
      .catch((err: unknown) => folderError(reply, err));
  });

  app.post('/api/chats/:id/folder/open', async (req, reply) => {
    const chat = await chatOf(req);
    if (!chat?.hostFolder || !folders || !mayUseFolders(req)) return notFound(reply);
    folders.open(chat.hostFolder);
    return { ok: true };
  });

  app.get('/api/folders', async (req, reply) => {
    if (!folders || !mayUseFolders(req)) return notFound(reply);
    const { path } = z.object({ path: z.string().max(500).optional() }).parse(req.query);
    return folders.browse(path).catch((err: unknown) => folderError(reply, err));
  });

  app.post('/api/chats/:id/answers/:messageId', async (req, reply) => {
    const chat = await chatOf(req);
    if (!chat) return notFound(reply);
    const { messageId } = z
      .object({ id: z.uuid(), messageId: z.coerce.number().int().min(1) })
      .parse(req.params);
    const { answer } = AnswerRequest.parse(req.body);
    if (!(await engine.answer(chat, messageId, answer))) {
      return reply.code(409).send({ error: 'conflict', message: 'This question is not open.' });
    }
    return engine.state(chat);
  });

  app.post('/api/chats/:id/plans/:taskId', async (req, reply) => {
    const chat = await chatOf(req);
    if (!chat) return notFound(reply);
    const { taskId } = z.object({ id: z.uuid(), taskId: z.uuid() }).parse(req.params);
    const { approved, secrets } = z
      .object({
        approved: z.boolean(),
        secrets: z.record(z.string().max(100), z.string().max(4000)).optional(),
      })
      .parse(req.body);
    if (!(await engine.decidePlan(chat, taskId, approved, secrets))) {
      return reply.code(409).send({ error: 'conflict', message: 'This plan is not waiting.' });
    }
    return engine.state(chat);
  });

  app.patch('/api/chats/:id/tasks/:taskId', async (req, reply) => {
    const chat = await chatOf(req);
    if (!chat) return notFound(reply);
    const { taskId } = z
      .object({ id: z.uuid(), taskId: z.coerce.number().int().min(1) })
      .parse(req.params);
    const body = UpdateBoardTaskRequest.parse(req.body);
    if (body.ownerBot && !chat.botIds.includes(body.ownerBot)) {
      return reply.code(404).send({ error: 'not_found', message: 'That bot is not in this chat.' });
    }
    const task = await store.updateTask(chat.id, taskId, {
      ...(body.status ? { status: body.status } : {}),
      ...(body.ownerBot ? { ownerBot: body.ownerBot } : {}),
      ...(body.title ? { title: body.title } : {}),
    });
    return task ?? notFound(reply);
  });

  app.post('/api/chats/:id/stop', async (req, reply) => {
    const chat = await chatOf(req);
    if (!chat) return notFound(reply);
    engine.stop(chat);
    return { ok: true };
  });

  app.delete('/api/chats/:id', async (req, reply) => {
    const chat = await chatOf(req);
    if (!chat) return notFound(reply);
    engine.stop(chat);
    await store.remove(chat.id, owner(req));
    return { ok: true };
  });
}
