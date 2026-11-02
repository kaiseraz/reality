import { describe, expect, it } from 'vitest';
import {
  probeNames,
  gather,
  judge,
  MIN_AGE_DAYS,
  MIN_MONTHLY_DOWNLOADS,
  namedPackage,
  needWords,
  normalizeName,
  searchCapabilities,
  validName,
  wantsMcp,
  type Found,
} from '../src/capabilities/search.ts';
import { factsFromPyPi, type PackageFacts } from '../src/capabilities/catalog.ts';
import { genericLibraryTest } from '../src/capabilities/engine.ts';
import { libraryPlan } from '../src/lab/plan.ts';
import { launchFromScripts } from '../src/capabilities/mcp.ts';
import { TaskSpec } from '@reality/schemas';
import { validatePlan } from '../src/planner/semantics.ts';

const NOW = Date.parse('2025-08-22T12:00:00Z');
const days = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const facts = (over: Partial<PackageFacts> = {}): PackageFacts => ({
  package: 'pyfiglet',
  version: '1.0',
  license: 'MIT',
  released: days(100),
  firstReleased: days(2000),
  hasCompatibleWheel: true,
  dependencies: 1,
  requiresPython: '>=3.9',
  summary: 'Pure-python FIGlet implementation: turn text into ASCII art banners',
  ...over,
});
const found = (over: Partial<Found> = {}): Found => ({
  package: 'pyfiglet',
  foundBy: ['model'],
  why: 'Renders text as ASCII art.',
  kind: 'python-package',
  ...over,
});
const words = needWords('turn text into ASCII art banners');

describe('reading a need', () => {
  it('keeps the words that say what it is about, longest first', () => {
    expect(needWords('I need a library to read FITS astronomy image files')).toEqual(
      ['astronomy', 'images'.slice(0, 0) || 'image', 'fits'].filter(Boolean),
    );
  });

  it('knows a package named in the request, and refuses names that are not safe', () => {
    expect(namedPackage('read this [package: Py_Figlet]')).toBe('py-figlet');
    expect(namedPackage('no name here')).toBeUndefined();
    expect(namedPackage('x [package: ../../etc]')).toBeUndefined();
    expect(validName('good-name')).toBe(true);
    for (const bad of ['', 'a b', 'a;b', '../x', 'A$B', '-x']) expect(validName(bad)).toBe(false);
    expect(normalizeName('Py_Figlet.X')).toBe('py-figlet-x');
  });
});

describe('judging a package that nobody reviewed', () => {
  it('accepts a known, widely used package that fits', () => {
    const a = judge(found(), facts(), 5_000_000, words, NOW);
    expect(a.eligible).toBe(true);
    expect(a.reasons).toEqual([]);
    expect(a.fit).toBeLessThan(1);
  });

  it('refuses a name nobody uses: that is what a squatter registers', () => {
    const a = judge(found(), facts(), MIN_MONTHLY_DOWNLOADS - 1, words, NOW);
    expect(a.eligible).toBe(false);
    expect(a.reasons.join()).toMatch(/few people/);
  });

  it('refuses a package first published a few weeks ago, however many downloads it claims', () => {
    const a = judge(
      found(),
      facts({ firstReleased: days(MIN_AGE_DAYS - 1) }),
      9_000_000,
      words,
      NOW,
    );
    expect(a.eligible).toBe(false);
    expect(a.reasons.join()).toMatch(/days ago/);
  });

  it('refuses when the download figure is missing, copyleft, or no compatible wheel', () => {
    expect(judge(found(), facts(), null, words, NOW).eligible).toBe(false);
    expect(judge(found(), facts({ license: 'GPL-3.0' }), 9_000_000, words, NOW).eligible).toBe(
      false,
    );
    expect(
      judge(found(), facts({ hasCompatibleWheel: false }), 9_000_000, words, NOW).eligible,
    ).toBe(false);
  });

  it('refuses a package that says nothing about the need, unless a person named it', () => {
    const other = facts({ summary: 'Parser for configuration files' });
    expect(judge(found({ why: '' }), other, 9_000_000, words, NOW).eligible).toBe(false);
    expect(
      judge(found({ why: '', foundBy: ['named'] }), other, 9_000_000, words, NOW).eligible,
    ).toBe(true);
  });

  it('never rates an unreviewed package as high as the reviewed catalog', () => {
    expect(
      judge(found({ foundBy: ['named', 'model', 'keyword'] }), facts(), 9e6, words, NOW).fit,
    ).toBeLessThan(1);
  });

  it('lists an MCP server it found but never offers to run it unreviewed', () => {
    const a = judge(
      found({ package: 'some-mcp', kind: 'mcp-server', foundBy: ['mcp-registry'] }),
      facts({ package: 'some-mcp' }),
      9e6,
      words,
      NOW,
    );
    expect(a.eligible).toBe(false);
    expect(a.reasons.join()).toMatch(/launch configuration/);
  });
});

/** A network that answers like PyPI, pypistats, ecosyste.ms and the MCP registry would. */
function fakeNet(spec: {
  pypi: Record<string, { summary: string; license?: string; first?: string; wheel?: boolean }>;
  downloads: Record<string, number>;
  keyword?: Record<string, string[]>;
  mcp?: { name: string; pkg: string }[];
  down?: string[];
}) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (spec.down?.some((d) => url.includes(d))) throw new Error('down');
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const py = /pypi\.org\/pypi\/([^/]+)\/json/.exec(url);
    if (py) {
      const p = spec.pypi[decodeURIComponent(py[1]!)];
      if (!p) return new Response('{}', { status: 404 });
      return ok({
        info: {
          version: '1.0',
          license: p.license ?? 'MIT',
          summary: p.summary,
          requires_dist: [],
          classifiers: [],
        },
        urls: [
          {
            filename: p.wheel === false ? 'x-1.0.tar.gz' : 'x-1.0-py3-none-any.whl',
            packagetype: p.wheel === false ? 'sdist' : 'bdist_wheel',
            upload_time_iso_8601: days(60),
          },
        ],
        releases: { '0.1': [{ upload_time_iso_8601: p.first ?? days(1500) }] },
      });
    }
    const dl = /pypistats\.org\/api\/packages\/([^/]+)\/recent/.exec(url);
    if (dl) {
      const n = spec.downloads[decodeURIComponent(dl[1]!)];
      return n === undefined
        ? new Response('{}', { status: 404 })
        : ok({ data: { last_month: n } });
    }
    const kw = /ecosyste\.ms\/api\/v1\/keywords\/([^?]+)/.exec(url);
    if (kw) {
      const names = spec.keyword?.[decodeURIComponent(kw[1]!)] ?? [];
      return ok({ packages: names.map((name) => ({ name, ecosystem: 'pypi', description: '' })) });
    }
    if (url.includes('registry.modelcontextprotocol.io')) {
      return ok({
        servers: (spec.mcp ?? []).map((m) => ({
          server: {
            name: m.name,
            description: 'An MCP server',
            packages: [{ registryType: 'pypi', identifier: m.pkg }],
          },
        })),
      });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

describe('searching', () => {
  const spec = {
    pypi: {
      pyfiglet: { summary: 'Pure-python FIGlet implementation: ASCII art banners from text' },
      'ascii-banner-pro': { summary: 'ASCII art banners from text', first: days(10) },
      'ghost-lib': { summary: 'ASCII art banners from text' },
      cowsay: { summary: 'ASCII art banners from text', license: 'GNU General Public License v3' },
    },
    downloads: {
      pyfiglet: 5_000_000,
      'ascii-banner-pro': 900_000,
      cowsay: 800_000,
      'ghost-lib': 7_000,
    },
    keyword: { banner: ['ascii-banner-pro'], text: [] },
  };

  it('verifies every name on PyPI and drops what is invented, young or copyleft', async () => {
    const net = fakeNet(spec);
    const result = await searchCapabilities('turn text into ASCII art banners', {
      fetchImpl: net.impl,
      now: NOW,
      propose: async () => [
        { package: 'pyfiglet', why: 'FIGlet fonts' },
        { package: 'figlet-supreme-9000', why: 'invented by the model' },
        { package: 'ascii-banner-pro', why: 'ASCII banners' },
        { package: 'cowsay', why: 'prints cows' },
      ],
    });
    const byName = Object.fromEntries(result.ranked.map((a) => [a.package, a]));
    expect(byName.pyfiglet?.eligible).toBe(true);
    expect(byName['figlet-supreme-9000']).toBeUndefined(); // not on PyPI at all
    expect(byName['ascii-banner-pro']?.eligible).toBe(false); // young, found twice
    expect(byName['ascii-banner-pro']?.foundBy).toEqual(
      expect.arrayContaining(['model', 'keyword']),
    );
    expect(byName.cowsay?.eligible).toBe(false);
    expect(result.ranked[0]?.package).toBe('pyfiglet');
    expect(result.bySource.model).toBe(4);
  });

  it('still works without a model, and says when the model failed', async () => {
    const net = fakeNet(spec);
    const none = await searchCapabilities('turn text into ASCII art banners', {
      fetchImpl: net.impl,
      now: NOW,
    });
    expect(none.ranked.map((a) => a.package)).toContain('ascii-banner-pro');
    const failed = await searchCapabilities('turn text into ASCII art banners', {
      fetchImpl: net.impl,
      now: NOW,
      propose: async () => {
        throw new Error('model unreachable');
      },
    });
    expect(failed.notes.join()).toMatch(/model unreachable/);
  });

  it('does not stop when a source is down', async () => {
    const net = fakeNet({ ...spec, down: ['ecosyste.ms', 'registry.modelcontextprotocol.io'] });
    const result = await searchCapabilities('turn text into ASCII art banners', {
      fetchImpl: net.impl,
      now: NOW,
      propose: async () => [{ package: 'pyfiglet', why: 'FIGlet' }],
    });
    expect(result.ranked[0]?.package).toBe('pyfiglet');
  });

  it('lists MCP servers from the registry but offers none of them', async () => {
    const net = fakeNet({
      ...spec,
      pypi: { ...spec.pypi, 'mcp-fig': { summary: 'MCP server for ASCII art banners' } },
      downloads: { ...spec.downloads, 'mcp-fig': 90_000 },
      mcp: [{ name: 'io.example/mcp-fig', pkg: 'mcp-fig' }],
    });
    const result = await searchCapabilities('turn text into ASCII art banners', {
      fetchImpl: net.impl,
      now: NOW,
    });
    const mcp = result.ranked.find((a) => a.package === 'mcp-fig');
    expect(mcp?.eligible).toBe(false);
    expect(mcp?.kind).toBe('mcp-server');
  });

  it('puts a package a person named first, and still checks it', async () => {
    const net = fakeNet(spec);
    const named = await gather('banners [package: ghost-lib]', { fetchImpl: net.impl });
    expect(named.find((f) => f.package === 'ghost-lib')?.foundBy).toContain('named');
    const result = await searchCapabilities('banners [package: ghost-lib]', {
      fetchImpl: net.impl,
      now: NOW,
    });
    expect(result.ranked.find((a) => a.package === 'ghost-lib')?.eligible).toBe(true);
    const bad = await searchCapabilities('banners [package: cowsay]', {
      fetchImpl: net.impl,
      now: NOW,
    });
    expect(bad.ranked.find((a) => a.package === 'cowsay')?.eligible).toBe(false);
  });

  it('puts keyword names into the request URL only after validation', async () => {
    const net = fakeNet(spec);
    await gather('text with weird\nwords; rm -rf banners', { fetchImpl: net.impl });
    for (const url of net.calls) expect(url).not.toMatch(/[;\n ]/);
  });
});

describe('what PyPI says', () => {
  it('reads the first release from the release list', () => {
    const f = factsFromPyPi('p', {
      info: { version: '2', summary: 's' },
      urls: [
        {
          filename: 'p-2-py3-none-any.whl',
          packagetype: 'bdist_wheel',
          upload_time_iso_8601: '2024-10-24T00:00:00Z',
        },
      ],
      releases: {
        '1': [{ upload_time_iso_8601: '2020-03-01T00:00:00Z' }],
        '2': [{ upload_time_iso_8601: '2024-10-24T00:00:00Z' }],
      },
    });
    expect(f.firstReleased).toBe('2020-03-01T00:00:00Z');
  });
});

describe('the test a found library gets, and the plan to get one', () => {
  it('loads the library from its own layer, with the names put in as data', () => {
    const t = genericLibraryTest('pyfiglet', 'pyfiglet');
    expect(t.code).toContain('root = "/caps/" + ID');
    expect(t.code).toContain('ID, PKG = "pyfiglet", "pyfiglet"');
    expect(t.code).toContain('.startswith(root + "/")');
    // A hostile name cannot leave the string it is put in.
    expect(genericLibraryTest('x"; import os #', 'p').code).toContain('"x\\"; import os #"');
  });

  it('is a one-step plan that only a person can finish', () => {
    const out = libraryPlan('turn text into ASCII art banners', 'pyfiglet', 'Get a library');
    const spec = TaskSpec.parse(out.draft);
    expect(spec.workflow.map((s) => [s.agent, s.capability])).toEqual([
      ['capability-agent', 'turn text into ASCII art banners [package: pyfiglet]'],
    ]);
    expect(spec.acceptanceCriteria[0]?.checkType).toBe('human');
    expect(validatePlan(spec, { datasets: [], availableCapabilities: [] })).toEqual([]);
  });
});

describe('MCP servers found by search', () => {
  const base = {
    pypi: {
      'mcp-server-time': {
        summary: 'A Model Context Protocol server providing time and timezone tools',
      },
      'mcp-server-fetch': { summary: 'A Model Context Protocol server for fetching web pages' },
      'tiny-mcp': { summary: 'An MCP server for unit conversion', first: days(10) },
      'not-a-server': { summary: 'Utilities for dates' },
    },
    downloads: {
      'mcp-server-time': 589_169,
      'mcp-server-fetch': 800_000,
      'tiny-mcp': 9_000,
      'not-a-server': 50_000,
    },
  };

  it('does not take an SDK for a server, whatever a model says about it', async () => {
    const net = fakeNet({
      pypi: {
        ...base.pypi,
        mcp: { summary: 'Model Context Protocol SDK' },
        fastmcp: { summary: 'The fast way to build MCP servers and clients' },
      },
      downloads: { ...base.downloads, mcp: 235_000_000, fastmcp: 9_000_000 },
    });
    const { ranked } = await searchCapabilities('fetch web pages [mcp]', {
      fetchImpl: net.impl,
      propose: async () => [
        { package: 'mcp', why: 'It can fetch web pages' },
        { package: 'fastmcp', why: 'It can fetch web pages' },
      ],
    });
    const of = (p: string) => ranked.find((a) => a.package === p);
    expect(of('mcp')?.eligible).toBe(false);
    expect(of('fastmcp')?.eligible).toBe(false);
    expect(ranked.find((a) => a.eligible)?.package).toBe('mcp-server-fetch');
  });

  it('a model can rule a server out, but not bring one in', async () => {
    const net = fakeNet({ pypi: base.pypi, downloads: base.downloads });
    const search = (ruleOut: () => Promise<string[]>) =>
      searchCapabilities('fetch web pages [mcp]', {
        fetchImpl: net.impl,
        propose: async () => [{ package: 'mcp-server-fetch', why: 'Fetches pages' }],
        ruleOut,
      });
    const out = await search(async () => ['mcp-server-fetch', 'tiny-mcp']);
    const fetchServer = out.ranked.find((a) => a.package === 'mcp-server-fetch');
    expect(fetchServer?.eligible).toBe(false);
    expect(fetchServer?.reasons.join()).toMatch(/not this need/);
    // What failed the checks stays failed, whatever the model says; its failure changes nothing.
    const down = await search(async () => {
      throw new Error('model down');
    });
    expect(down.ranked.find((a) => a.package === 'mcp-server-fetch')?.eligible).toBe(true);
    expect(down.ranked.find((a) => a.package === 'not-a-server')?.eligible).not.toBe(true);
  });

  it('is asked for by a marker in the need', () => {
    expect(wantsMcp('convert time zones [mcp]')).toBe(true);
    expect(wantsMcp('convert time zones')).toBe(false);
    expect(needWords('convert time zones [mcp] [package: x]')).not.toContain('mcp');
  });

  it('reads how to start a server from its own console scripts, never from a source', () => {
    expect(
      launchFromScripts('mcp-server-time', ['mcp-server-time = mcp_server_time:main'], ['--x']),
    ).toEqual({ entry: 'mcp_server_time:main', args: ['--x'], allowedTools: [] });
    // The script named like the package wins; else one that says mcp or server; else the first.
    expect(
      launchFromScripts('thing', ['helper = thing.cli:run', 'thing-mcp = thing.server:serve'], [])
        ?.entry,
    ).toBe('thing.server:serve');
    expect(launchFromScripts('thing', ['a = thing.cli:run'], [])?.entry).toBe('thing.cli:run');
    expect(launchFromScripts('thing', [], [])).toBeNull();
    // Anything that is not module:function is not a way to start it.
    expect(launchFromScripts('thing', ['x = ../../etc/passwd'], [])).toBeNull();
    expect(launchFromScripts('thing', ['x = os.path:join; rm'], [])?.entry).toBe('os.path:join');
  });

  it('guesses the conventional names from the need, in the order it was written', () => {
    const names = probeNames('convert between time zones [mcp]');
    expect(names).toEqual(
      expect.arrayContaining(['mcp-server-time', 'time-mcp', 'mcp-server-timezone']),
    );
    expect(names.length).toBeLessThanOrEqual(36);
    for (const n of names) expect(validName(n)).toBe(true);
    // Nothing from a hostile need survives as a name.
    expect(probeNames('x; rm -rf / $(reboot) [package: ../etc]').every(validName)).toBe(true);
  });

  it('reaches a reference server the registry cannot find, by its conventional name', async () => {
    const net = fakeNet({ ...base, mcp: [] });
    const result = await searchCapabilities('convert between time zones [mcp]', {
      fetchImpl: net.impl,
      now: NOW,
    });
    const time = result.ranked.find((a) => a.package === 'mcp-server-time');
    expect(time?.eligible).toBe(true);
    expect(time?.foundBy).toContain('probe');
    expect(result.ranked[0]?.package).toBe('mcp-server-time');
  });

  it('offers a server that works offline and refuses the rest, with the reasons', async () => {
    const net = fakeNet({
      ...base,
      mcp: [
        { name: 'io.example/time', pkg: 'mcp-server-time' },
        { name: 'io.example/fetch', pkg: 'mcp-server-fetch' },
      ],
    });
    const result = await searchCapabilities('convert between time zones [mcp]', {
      fetchImpl: net.impl,
      now: NOW,
      propose: async (_need, want) =>
        want === 'mcp-server'
          ? [
              { package: 'mcp-server-time', why: 'time zones' },
              { package: 'tiny-mcp', why: 'units' },
              { package: 'not-a-server', why: 'dates' },
            ]
          : [{ package: 'wrong-kind', why: 'asked for a library' }],
    });
    const byName = Object.fromEntries(result.ranked.map((a) => [a.package, a]));
    expect(byName['mcp-server-time']?.eligible).toBe(true);
    expect(byName['mcp-server-time']?.kind).toBe('mcp-server');
    expect(byName['mcp-server-time']?.foundBy).toEqual(
      expect.arrayContaining(['model', 'mcp-registry']),
    );
    expect(byName['tiny-mcp']?.eligible).toBe(false); // young
    expect(byName['not-a-server']?.eligible).toBe(false);
    expect(byName['not-a-server']?.reasons.join()).toMatch(
      /does not describe itself as an MCP server/,
    );
    expect(result.ranked[0]?.package).toBe('mcp-server-time');
    // A library need is not answered with servers, and a server need not with libraries.
    expect(byName['wrong-kind']).toBeUndefined();
  });

  it('offers Node, hosted and key-needing servers with what they need, and counts containers', async () => {
    const calls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('registry.modelcontextprotocol.io')) {
        return new Response(
          JSON.stringify({
            servers: [
              {
                server: {
                  name: 'a/hosted',
                  description: 'convert time zones',
                  remotes: [{ type: 'streamable-http', url: 'https://x.example/mcp' }],
                },
              },
              { server: { name: 'e/box', packages: [{ registryType: 'oci', identifier: 'y' }] } },
              { server: { name: 'b/node', packages: [{ registryType: 'npm', identifier: 'x' }] } },
              {
                server: {
                  name: 'c/secret',
                  packages: [
                    {
                      registryType: 'pypi',
                      identifier: 'needs-key',
                      environmentVariables: [{ name: 'API_KEY', isRequired: true }],
                    },
                  ],
                },
              },
              {
                server: {
                  name: 'd/ok',
                  packages: [
                    {
                      registryType: 'pypi',
                      identifier: 'good-mcp',
                      packageArguments: [
                        { type: 'positional', value: '--transport' },
                        { type: 'positional', value: 'stdio; rm -rf /' },
                      ],
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const notes: string[] = [];
    const found = await gather('convert time zones [mcp]', { fetchImpl: impl }, notes);
    const by = (p: string) => found.find((f) => f.package === p);
    expect(by('x')?.runtime).toBe('node');
    expect(by('needs-key')?.secrets?.map((s) => s.name)).toEqual(['API_KEY']);
    const hosted = found.find((f) => f.runtime === 'remote');
    expect(hosted?.remote?.url).toBe('https://x.example/mcp');
    // An argument that is not a plain literal is dropped, whatever the registry says.
    expect(by('good-mcp')?.args).toEqual(['--transport']);
    expect(notes.join()).toMatch(/1 servers of a kind that cannot run here/);
  });
});
