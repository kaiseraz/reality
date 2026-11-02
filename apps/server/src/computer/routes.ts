import { connect } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/auth-service.ts';
import { readCookie, SESSION_COOKIE } from '../auth/auth-routes.ts';
import type { BotService } from '../bots/bots.ts';
import { ComputerError, type BotComputers } from './computers.ts';

const Params = z.object({ id: z.uuid() });
const SCREEN = /^\/api\/bots\/([0-9a-f-]{36})\/computer\/screen\/(.*)$/;

/**
 * The bot's computer for people: status, files, history and web access, and its live
 * screen. The screen (noVNC and its WebSocket) is proxied through Reality, so the browser
 * never sees the computer's key and the usual sign-in and bot ownership checks apply.
 */
export function registerComputerRoutes(
  app: FastifyInstance,
  deps: { computers: BotComputers; bots: BotService; auth: AuthService; authEnabled: boolean },
) {
  const { computers, bots } = deps;

  // A removed bot takes its computer and home folder with it.
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'DELETE' || reply.statusCode !== 200) return;
    if (req.routeOptions.url !== '/api/bots/:id') return;
    const id = (req.params as { id?: string }).id;
    if (id) await computers.destroy(id).catch(() => undefined);
  });

  app.get('/api/bots/:id/computer', async (req, reply) => {
    const { id } = Params.parse(req.params);
    if (!(await bots.get(id))) return reply.code(404).send({ error: 'not_found' });
    const info = await computers.info(id);
    return {
      ...info,
      imageReady: await computers.imageReady(),
      files: info.running ? await computers.listFiles(id).catch(() => []) : [],
      history: await computers.history(id, 60),
    };
  });

  /** Which of the person's bots have their computer on (for the overview). */
  app.get('/api/computers', async (req) => {
    const on: string[] = [];
    for (const id of computers.running()) {
      if (await bots.canUse(req.user ?? null, id)) on.push(id);
    }
    return { running: on };
  });

  app.get('/api/bots/:id/computer/thumb', async (req, reply) => {
    const { id } = Params.parse(req.params);
    const image = await computers.thumbnail(id);
    if (!image) return reply.code(204).send();
    reply.header('content-type', 'image/jpeg');
    reply.header('cache-control', 'no-store');
    return reply.send(image);
  });

  app.post('/api/bots/:id/computer/start', async (req, reply) => {
    const { id } = Params.parse(req.params);
    if (!(await bots.get(id))) return reply.code(404).send({ error: 'not_found' });
    try {
      await computers.ensure(id);
    } catch (err) {
      if (err instanceof ComputerError)
        return reply.code(409).send({ error: 'computer', message: err.message });
      throw err;
    }
    return computers.info(id);
  });

  app.post('/api/bots/:id/computer/stop', async (req) => {
    const { id } = Params.parse(req.params);
    await computers.stop(id);
    return computers.info(id);
  });

  app.post('/api/bots/:id/computer/access', async (req, reply) => {
    const { id } = Params.parse(req.params);
    const { domain } = z.object({ domain: z.string().min(1).max(300) }).parse(req.body);
    try {
      await computers.allow(id, domain, req.user?.id ?? null);
    } catch (err) {
      if (err instanceof ComputerError)
        return reply.code(400).send({ error: 'domain', message: err.message });
      throw err;
    }
    return computers.info(id);
  });

  app.delete('/api/bots/:id/computer/access/:domain', async (req) => {
    const { id, domain } = Params.extend({ domain: z.string().min(1).max(300) }).parse(req.params);
    await computers.revoke(id, domain, req.user?.id ?? null);
    return computers.info(id);
  });

  // Plain HTTP of the live screen (noVNC page and its assets).
  app.get('/api/bots/:id/computer/screen/*', async (req, reply) => {
    const { id } = Params.parse(req.params);
    const end = computers.endpoint(id);
    if (!end) return reply.code(409).send({ error: 'stopped', message: 'The computer is off.' });
    const rest = (req.params as { '*': string })['*'];
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const res = await fetch(`http://127.0.0.1:${end.port}/${rest}${query}`, {
      headers: { 'x-aio-api-key': end.key },
    });
    reply.code(res.status);
    const type = res.headers.get('content-type');
    if (type) reply.header('content-type', type);
    reply.header('cache-control', 'no-store');
    return reply.send(Buffer.from(await res.arrayBuffer()));
  });

  // The screen's WebSocket: checked like any request, then piped raw to the computer.
  app.server.on('upgrade', (req, socket, head) => {
    const m = SCREEN.exec((req.url ?? '').split('?')[0] ?? '');
    if (!m) return;
    const botId = m[1] ?? '';
    const rest = m[2] ?? '';
    void (async () => {
      if (deps.authEnabled) {
        const user = await deps.auth.userForSession(readCookie(req, SESSION_COOKIE));
        if (!user || !(await deps.auth.canAccessBot(user, botId))) {
          socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
          return;
        }
      }
      const end = computers.endpoint(botId);
      if (!end) {
        socket.end('HTTP/1.1 409 Conflict\r\n\r\n');
        return;
      }
      const upstream = connect(end.port, '127.0.0.1', () => {
        const query = (req.url ?? '').includes('?')
          ? (req.url ?? '').slice((req.url ?? '').indexOf('?'))
          : '';
        const lines = [`GET /${rest}${query} HTTP/1.1`, `host: 127.0.0.1:${end.port}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const k = req.rawHeaders[i] ?? '';
          if (/^(host|cookie|origin|x-aio-api-key)$/i.test(k)) continue;
          lines.push(`${k}: ${req.rawHeaders[i + 1] ?? ''}`);
        }
        lines.push(`x-aio-api-key: ${end.key}`);
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      const close = () => {
        upstream.destroy();
        socket.destroy();
      };
      upstream.on('error', close);
      socket.on('error', close);
    })();
  });
}
