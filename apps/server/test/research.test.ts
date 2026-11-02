import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskSummary } from '@reality/schemas';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Planner } from '../src/planner/planner.ts';
import { researchQuery, RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { validatePlan } from '../src/planner/semantics.ts';
import {
  htmlToText,
  isPrivateAddress,
  KnowledgeError,
  KnowledgeStore,
} from '../src/research/knowledge.ts';
import { abstractFromIndex } from '../src/research/openalex.ts';
import { quoteFound, type Synthesizer } from '../src/research/research-step.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { TaskSpec } from '@reality/schemas';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

const index = (text: string) => {
  const out: Record<string, number[]> = {};
  text.split(' ').forEach((w, i) => (out[w] ??= []).push(i));
  return out;
};

const ABSTRACT_1 =
  'Urban tree canopy lowers daytime land surface temperature by up to four degrees in dense neighbourhoods across European cities.';
const ABSTRACT_2 =
  'Green roofs reduce rooftop temperatures but their effect on street level heat is small compared with street trees.';

const WORKS = {
  results: [
    {
      id: 'https://openalex.org/W1',
      doi: 'https://doi.org/10.1000/heat.1',
      title: 'Tree canopy and urban heat',
      publication_year: 2021,
      cited_by_count: 340,
      authorships: [{ author: { display_name: 'A. Researcher' } }],
      abstract_inverted_index: index(ABSTRACT_1),
      primary_location: {
        landing_page_url: 'https://example.org/w1',
        source: { display_name: 'Urban Climate' },
      },
    },
    {
      id: 'https://openalex.org/W2',
      doi: null,
      title: 'Green roofs and street heat',
      publication_year: 2023,
      cited_by_count: 25,
      authorships: [],
      abstract_inverted_index: index(ABSTRACT_2),
      primary_location: null,
    },
  ],
};

describe('research building blocks (pure)', () => {
  it('rebuilds OpenAlex abstracts from the inverted index', () => {
    expect(abstractFromIndex(index(ABSTRACT_1))).toBe(ABSTRACT_1);
    expect(abstractFromIndex(null)).toBe('');
  });

  it('turns a question into search terms, or nothing', () => {
    expect(researchQuery('What is known about urban heat islands and tree canopy?')).toBe(
      'urban heat islands tree canopy',
    );
    expect(researchQuery('Was weiß man über Hitzeinseln?')).toBe('hitzeinseln');
    expect(researchQuery('What is known?')).toBe('');
  });

  it('accepts only verbatim quotes of at least eight words', () => {
    expect(quoteFound('lowers daytime land surface temperature by up to four', ABSTRACT_1)).toBe(
      true,
    );
    expect(quoteFound('Lowers daytime land-surface temperature, by up to four', ABSTRACT_1)).toBe(
      true,
    );
    expect(quoteFound('lowers daytime land surface temperature by up to ten', ABSTRACT_1)).toBe(
      false,
    );
    expect(quoteFound('urban tree canopy lowers', ABSTRACT_1)).toBe(false);
  });

  it('refuses private and local addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.1',
      '172.20.0.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });

  it('reads HTML as text without scripts', () => {
    expect(htmlToText('<h1>Title</h1><script>evil()</script><p>Body &amp; more</p>')).toBe(
      'Title\n Body & more',
    );
  });

  it('validates research plans: recipes, params and synthesis sources', () => {
    const plan = (workflow: unknown[]) =>
      TaskSpec.parse({
        goal: 'g',
        requiredOutputs: ['x'],
        acceptanceCriteria: [{ id: 'a', description: 'd', checkType: 'human' }],
        workflow,
      });
    const ctx = { datasets: [], availableCapabilities: [] };
    expect(
      validatePlan(
        plan([
          {
            id: 'lit',
            description: 'd',
            agent: 'research-agent',
            recipe: { name: 'literature', params: { query: 'urban heat' } },
          },
          {
            id: 'ans',
            description: 'd',
            agent: 'research-agent',
            dependsOn: ['lit'],
            recipe: { name: 'synthesize', params: { question: 'What cools cities?' } },
          },
        ]),
        ctx,
      ),
    ).toEqual([]);
    const errors = validatePlan(
      plan([
        {
          id: 'ans',
          description: 'd',
          agent: 'research-agent',
          recipe: { name: 'synthesize', params: { question: 'What cools cities?' } },
        },
        {
          id: 'p',
          description: 'd',
          agent: 'analysis-agent',
          recipe: { name: 'profile', params: {} },
        },
        {
          id: 'r',
          description: 'd',
          agent: 'research-agent',
          recipe: { name: 'profile', params: {} },
        },
      ]),
      ctx,
    );
    expect(errors.join('\n')).toMatch(/synthesize must depend/);
    expect(errors.join('\n')).toMatch(/need a research recipe/);
  });
});

describe('research tasks (database, sandbox)', () => {
  let runtime: Runtime;
  let app: FastifyInstance;
  let dir: string;
  let server: Server;
  let base: string;
  let planner: Planner = new RuleBasedPlanner();
  const synthesizer: Synthesizer = {
    synthesize: async ({ sources }) => ({
      answer: 'Street trees cool cities more than green roofs.',
      model: 'fake-synthesizer',
      claims: [
        {
          text: 'Tree canopy lowers surface temperature by up to four degrees.',
          ref: sources[0]?.ref ?? 'S1',
          quote: 'lowers daytime land surface temperature by up to four degrees',
        },
        {
          text: 'Green roofs eliminate street heat.',
          ref: 'S2',
          quote: 'green roofs eliminate street level heat in every city studied',
        },
      ],
    }),
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/page')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          '<html><body><h1>Cooling plan</h1><p>Our city plants 2000 street trees per year to fight urban heat.</p></body></html>',
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(WORKS));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await resetTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'reality-research-'));
    const config = loadConfig({
      AUTH: 'off',
      DATABASE_URL: TEST_DATABASE_URL,
      ARTIFACT_DIR: dir,
      OPENALEX_URL: `${base}/works`,
    });
    runtime = await createRuntime(config, {
      planner: { name: 'switch', propose: (input) => planner.propose(input) },
      analyst: null,
      synthesizer,
      allowPrivateUrls: true,
      log: { error: () => {} },
    });
    app = buildApp(config, runtime);
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await runtime.close();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps knowledge sources: notes, pages, search', async () => {
    const note = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: {
        kind: 'note',
        name: 'Council notes',
        text: 'The council wants shade on every school yard by 2030.',
      },
    });
    expect(note.statusCode).toBe(201);
    const page = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: { kind: 'url', url: `${base}/page` },
    });
    expect(page.statusCode).toBe(201);
    expect(page.json()).toMatchObject({ status: 'ready', passages: 1 });
    const hits = (await app.inject({ url: '/api/knowledge/search?q=street%20trees%20heat' })).json<
      { source: string; score: number }[]
    >();
    expect(hits[0]).toMatchObject({ source: `${base}/page`, score: 1 });
    expect((await app.inject({ url: '/api/knowledge' })).json()).toHaveLength(2);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/knowledge',
          payload: { kind: 'url', url: 'ftp://x' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('never fetches private addresses for a user', async () => {
    const strict = new KnowledgeStore(runtime.knowledge['pool' as never]);
    await expect(strict.addUrl(null, `${base}/page`)).rejects.toThrow(KnowledgeError);
  });

  it('researches without data: literature and own notes, rule-based', async () => {
    planner = new RuleBasedPlanner();
    const task = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { request: 'What is known about street trees and urban heat?' },
      })
    ).json<TaskSummary>();
    await runtime.tasks.settled(task.id);
    await runtime.tasks.decide(task.id, { approved: true, by: 'user' });
    await runtime.tasks.settled(task.id);
    const state = await runtime.tasks.get(task.id);
    expect(state?.status).toBe('completed');
    const files = await runtime.artifacts.listForTask(task.id);
    const sources = files.find((f) => f.filename === 'literature_sources.csv');
    expect(sources?.rowCount).toBe(2);
    expect(files.find((f) => f.filename === 'knowledge_passages.csv')?.rowCount).toBeGreaterThan(0);
    const text = await readFile(runtime.artifacts.filePath(sources!), 'utf8');
    expect(text).toContain('10.1000/heat.1');
    const runs = await runtime.runs.listForTask(task.id);
    expect(runs.map((r) => r.kind)).toContain('research');
  }, 120_000);

  it('writes a cited answer and checks every quote against the stored source', async () => {
    planner = {
      name: 'research-test',
      propose: async () => ({
        model: 'research-test',
        usage: { inputTokens: 0, outputTokens: 0 },
        draft: {
          goal: 'What cools cities?',
          requiredOutputs: ['Cited answer'],
          acceptanceCriteria: [
            {
              id: 'quotes',
              description: 'Every claim quotes its source',
              checkType: 'recompute',
              check: { name: 'quotes_in_sources', params: { step: 'answer' } },
            },
          ],
          workflow: [
            {
              id: 'lit',
              description: 'Search',
              agent: 'research-agent',
              recipe: { name: 'literature', params: { query: 'urban heat trees' } },
            },
            {
              id: 'answer',
              description: 'Answer',
              agent: 'research-agent',
              dependsOn: ['lit'],
              recipe: { name: 'synthesize', params: { question: 'What cools cities?' } },
            },
            {
              id: 'verify',
              description: 'Verify',
              agent: 'verification-agent',
              dependsOn: ['answer'],
            },
          ],
        },
      }),
    };
    const task = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { request: 'What cools cities?' },
      })
    ).json<TaskSummary>();
    await runtime.tasks.settled(task.id);
    await runtime.tasks.decide(task.id, { approved: true, by: 'user' });
    await runtime.tasks.settled(task.id);
    const events = await runtime.events.list(task.id);
    const answer = events.find(
      (e) => e.type === 'step.completed' && (e.payload as { stepId: string }).stepId === 'answer',
    )?.payload as { status: string; summary: { claims: number; grounded: number } };
    expect(answer.status).toBe('done');
    expect(answer.summary).toMatchObject({ claims: 2, grounded: 1 });
    const check = events.find((e) => e.type === 'check.completed')?.payload as {
      status: string;
      detail: string;
    };
    // The forged quote is caught by the independent check, not trusted from the model.
    expect(check.status).toBe('failed');
    expect(check.detail).toContain('1 of 2 claims');
  }, 120_000);
});
