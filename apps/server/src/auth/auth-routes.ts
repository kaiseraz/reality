import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { AuthError, LoginLimiter, type AuthService, type User } from './auth-service.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in account; null when AUTH=off. */
    user: User | null;
  }
}

export const SESSION_COOKIE = 'reality_session';
const SESSION_MAX_AGE_S = 30 * 86_400;

const Credentials = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});
const NewUser = Credentials.extend({ role: z.enum(['admin', 'member']).default('member') });

export function readCookie(
  req: { headers: { cookie?: string | undefined } },
  name: string,
): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function setSessionCookie(reply: FastifyReply, config: Config, token: string, maxAge: number) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(config.COOKIE_SECURE === 'true' ? ['Secure'] : []),
  ];
  reply.header('set-cookie', attrs.join('; '));
}

function sameHost(origin: string, host: string | undefined): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false; // malformed Origin
  }
}

const PUBLIC = new Set(['/api/health', '/api/auth/me', '/api/auth/login', '/api/auth/setup']);

/**
 * Accounts and access control. With AUTH=on every /api route except the public ones
 * needs a session, state-changing requests must come from this origin, and task,
 * workspace and artifact routes only serve the account that owns the task (404 otherwise,
 * so ids of other accounts' tasks are not confirmed).
 */
export function registerAuth(app: FastifyInstance, config: Config, auth: AuthService) {
  const enabled = config.AUTH === 'on';
  const limiter = new LoginLimiter();
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // Cross-site requests cannot change anything (in addition to SameSite cookies).
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin) {
      if (!sameHost(origin, req.headers.host))
        return reply.code(403).send({ error: 'forbidden', message: 'Bad origin.' });
    }
    if (!enabled) return;
    req.user = await auth.userForSession(readCookie(req, SESSION_COOKIE));
    const path = req.url.split('?')[0] ?? '';
    if (!req.user && !PUBLIC.has(path)) {
      return reply.code(401).send({ error: 'unauthenticated', message: 'Please sign in.' });
    }
  });

  // Ownership of the task behind every :id route.
  app.addHook('preHandler', async (req, reply) => {
    if (!enabled || !req.user) return;
    const route = req.routeOptions.url ?? '';
    const id = (req.params as { id?: string } | undefined)?.id;
    if (!id) return;
    if (route.startsWith('/api/bots/:id')) {
      if (!(await auth.canAccessBot(req.user, id))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return;
    }
    if (route.startsWith('/api/projects/:id')) {
      if (!(await auth.canAccessProject(req.user, id))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return;
    }
    let taskId: string | undefined;
    if (route.startsWith('/api/tasks/:id')) taskId = id;
    else if (route.startsWith('/api/workspaces/:id')) taskId = await auth.taskOfWorkspace(id);
    else if (route.startsWith('/api/artifacts/:id')) taskId = await auth.taskOfArtifact(id);
    else if (route.startsWith('/api/files/:id')) {
      taskId = await auth.taskOfFile(id);
      // A file from a chat belongs to no task: the route itself checks whose it is.
      if (!taskId) return;
    } else return;
    if (!taskId || !(await auth.canAccessTask(req.user, taskId))) {
      return reply.code(404).send({ error: 'not_found' });
    }
  });

  app.get('/api/auth/me', async (req) => ({
    authEnabled: enabled,
    setupRequired: enabled && !(await auth.hasUsers()),
    user: req.user,
  }));

  app.post('/api/auth/setup', async (req, reply) => {
    if (!enabled) return reply.code(404).send({ error: 'not_found' });
    const { email, password } = Credentials.parse(req.body);
    try {
      const user = await auth.setup(email, password);
      setSessionCookie(reply, config, await auth.createSession(user.id), SESSION_MAX_AGE_S);
      return reply.code(201).send({ user });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.code === 'weak_password' ? 400 : 409).send({
          error: err.code,
          message: err.message,
        });
      }
      throw err;
    }
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (!enabled) return reply.code(404).send({ error: 'not_found' });
    const { email, password } = Credentials.parse(req.body);
    const key = `${email.trim().toLowerCase()}|${req.ip}`;
    if (limiter.blocked(key)) {
      return reply
        .code(429)
        .send({ error: 'too_many_attempts', message: 'Too many attempts. Try again later.' });
    }
    try {
      const { user, token } = await auth.login(email, password);
      limiter.reset(key);
      setSessionCookie(reply, config, token, SESSION_MAX_AGE_S);
      return { user };
    } catch (err) {
      if (err instanceof AuthError) {
        limiter.fail(key);
        return reply.code(401).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await auth.logout(readCookie(req, SESSION_COOKIE));
    setSessionCookie(reply, config, '', 0);
    return { ok: true };
  });

  app.get('/api/auth/users', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    return auth.listUsers();
  });

  app.post('/api/auth/users', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const { email, password, role } = NewUser.parse(req.body);
    try {
      return reply.code(201).send(await auth.createUser(email, password, role));
    } catch (err) {
      if (err instanceof AuthError) {
        return reply
          .code(err.code === 'exists' ? 409 : 400)
          .send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
}
