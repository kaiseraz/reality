import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPreflight } from '../src/llm/preflight.ts';

/**
 * The model check against a stand-in for Meta's Anthropic-compatible endpoint that behaves
 * awkwardly on purpose: the first call is rate-limited, tool arguments come as a JSON
 * string, and a tool call arrives with the wrong stop reason. A second endpoint refuses the
 * key, and the check must say so plainly.
 */

interface Body {
  model: string;
  tools?: { name: string }[];
  tool_choice?: { type: string; name?: string };
  messages: { role: string; content: unknown }[];
}

const message = (model: string, content: unknown[], stop = 'end_turn') => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model,
  content,
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

let calls = 0;
function awkward(body: Body) {
  const names = (body.tools ?? []).map((t) => t.name);
  const last = body.messages[body.messages.length - 1];
  const hasResult = Array.isArray(last?.content);
  if (body.tool_choice?.type === 'tool') {
    return message(
      body.model,
      [
        {
          type: 'tool_use',
          id: 'tu_x',
          name: body.tool_choice.name,
          input: { city: 'Paris', population: 2100000 },
        },
      ],
      'tool_use',
    );
  }
  if (names.includes('add_numbers')) {
    if (hasResult) return message(body.model, [{ type: 'text', text: 'The sum is 42.' }]);
    // Arguments as a string and the wrong stop reason: Reality must cope.
    return message(
      body.model,
      [{ type: 'tool_use', id: 'tu_add', name: 'add_numbers', input: '{"a":17,"b":25}' }],
      'end_turn',
    );
  }
  if (names.length > 10) return message(body.model, [{ type: 'text', text: 'Hello there!' }]);
  return message(body.model, [{ type: 'text', text: 'OK' }]);
}

function serve(
  handler: (body: Body) => { status: number; json: unknown; headers?: Record<string, string> },
) {
  return new Promise<{ server: Server; url: string }>((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const out = handler(JSON.parse(raw || '{}') as Body);
        res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
        res.end(JSON.stringify(out.json));
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    );
  });
}

describe('model check (preflight)', () => {
  let good: { server: Server; url: string };
  let refused: { server: Server; url: string };

  beforeAll(async () => {
    good = await serve((body) => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 429,
          json: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
          headers: { 'retry-after-ms': '5' },
        };
      }
      return { status: 200, json: awkward(body) };
    });
    refused = await serve(() => ({
      status: 401,
      json: {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      },
    }));
  });
  afterAll(() => {
    good.server.close();
    refused.server.close();
  });

  it('passes every step against an awkward but working endpoint', async () => {
    const steps = await runPreflight({
      provider: 'meta',
      model: 'muse-spark-test',
      apiKey: 'test-key',
      baseURL: good.url,
    });
    expect(steps.map((s) => [s.name.replace(/\d+/, 'N'), s.ok])).toEqual([
      ['Answers', true],
      ['Calls a tool and uses its result', true],
      ['Structured output (planner)', true],
      ['Accepts all N Reality tools', true],
    ]);
    expect(steps[1]?.detail).toContain('42');
    expect(steps[2]?.detail).toContain('Paris');
  }, 30_000);

  it('stops at the first step with a plain hint when the key is refused', async () => {
    const steps = await runPreflight({
      provider: 'meta',
      model: 'muse-spark-test',
      apiKey: 'wrong',
      baseURL: refused.url,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ name: 'Answers', ok: false });
    expect(steps[0]?.hint).toMatch(/META_MODEL_API_KEY/);
    expect(JSON.stringify(steps)).not.toContain('wrong');
  }, 30_000);
});
