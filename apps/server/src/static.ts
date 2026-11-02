import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Vega compiles chart expressions with new Function, hence 'unsafe-eval' for scripts.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/**
 * Serves the built web app (production): files from `dir`, and index.html for any other
 * non-API path so client-side routes work. Paths are resolved strictly inside `dir`.
 */
export function registerStatic(app: FastifyInstance, dir: string) {
  const root = resolve(dir);

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    // A bot's live screen and its visuals are shown inside Reality's own page; nothing else may
    // frame anything.
    const framed = /^\/api\/(bots\/[^/]+\/computer\/screen\/|files\/[^/]+\/visual)/.test(req.url);
    reply.header('x-frame-options', framed ? 'SAMEORIGIN' : 'DENY');
    return payload;
  });

  app.get('/*', async (req, reply) => {
    const raw = decodeURIComponent((req.params as { '*': string })['*'] || 'index.html');
    if (raw.startsWith('api/')) return reply.code(404).send({ error: 'not_found' });
    let file = resolve(root, normalize(raw));
    if (file !== root && !file.startsWith(root + sep)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const isFile = await stat(file)
      .then((s) => s.isFile())
      .catch(() => false);
    if (!isFile) file = join(root, 'index.html');
    const ext = extname(file);
    reply.type(TYPES[ext] ?? 'application/octet-stream');
    if (ext === '.html') {
      reply.header('content-security-policy', CSP);
      reply.header('cache-control', 'no-cache');
    } else if (file.includes(`${sep}assets${sep}`)) {
      // Vite fingerprints asset names, so they can be cached for good.
      reply.header('cache-control', 'public, max-age=31536000, immutable');
    }
    return reply.send(await readFile(file));
  });
}
