import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collectToolFiles,
  describeAdvisories,
  evaluatePolicy,
  sameMajorFixes,
} from '../src/capabilities/engine.ts';
import { findReviewedServer, REVIEWED_SERVERS } from '../src/capabilities/servers.ts';
import { assertPublicUrl, isPublicAddress, scriptFromBin } from '../src/capabilities/mcp.ts';
import { neededDomains, neededSecrets } from '../src/capabilities/search.ts';
import { scrubSecrets, SecretStore, validSecretName } from '../src/capabilities/secrets.ts';
import { migrate } from '../src/db/migrate.ts';
import { resetTestDatabase, TEST_DATABASE_URL } from './db.ts';

describe('how a server is started and reached', () => {
  it('finds the program a Node package declares, and stays inside the package', () => {
    expect(scriptFromBin('tool', 'dist/index.js')).toBe('dist/index.js');
    expect(scriptFromBin('@a/tool', { tool: './dist/cli.js', other: 'x.js' })).toBe('dist/cli.js');
    expect(scriptFromBin('tool', '../../etc/passwd')).toBeNull();
    expect(scriptFromBin('tool', '/etc/passwd')).toBeNull();
    expect(scriptFromBin('tool', undefined)).toBeNull();
  });

  it('never lets a hosted server point at this machine or a private network', async () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.8',
      '192.168.1.1',
      '172.17.0.2',
      '169.254.169.254',
      '::1',
      'fd00::1',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    const resolver = (ip: string) => async () => [ip];
    await expect(assertPublicUrl('http://example.com/mcp', resolver('8.8.8.8'))).rejects.toThrow();
    await expect(
      assertPublicUrl('https://inside.example/mcp', resolver('10.1.2.3')),
    ).rejects.toThrow();
    await expect(
      assertPublicUrl('https://example.com/mcp', resolver('8.8.8.8')),
    ).resolves.toBeDefined();
  });

  it('reads the domains and keys a bot asked for out of the need', () => {
    const need = 'read issues [mcp] [domains: api.github.com, github.com] [secrets: GITHUB_TOKEN]';
    expect(neededDomains(need)).toEqual(['api.github.com', 'github.com']);
    expect(neededSecrets(need)).toEqual(['GITHUB_TOKEN']);
    expect(neededDomains('nothing here')).toEqual([]);
  });
});

describe('a known vulnerability in a dependency of a Node server', () => {
  const osv = (fixedBy: Record<string, string[]>) =>
    (async (input: string | URL | Request) => {
      const id = String(input).split('/').pop() ?? '';
      return new Response(
        JSON.stringify({
          affected: Object.entries(fixedBy)
            .filter(([k]) => k.startsWith(`${id}:`))
            .map(([k, fixed]) => ({
              package: { name: k.split(':')[1], ecosystem: 'npm' },
              ranges: [{ events: [{ introduced: '0' }, ...fixed.map((f) => ({ fixed: f }))] }],
            })),
        }),
      );
    }) as typeof fetch;

  it('is fixed when a fix exists in the same major version, taking the newest needed', async () => {
    const fixes = await sameMajorFixes(
      [{ package: 'sdk', version: '1.30.0', ids: ['A', 'B'] }],
      osv({ 'A:sdk': ['1.30.1'], 'B:sdk': ['1.32.0'] }),
    );
    expect(fixes).toEqual({ sdk: '1.32.0' });
  });

  it('goes on the card for a tool server, and still rejects anything else', () => {
    const wheels = [{ file: 'x', name: 'x', version: '1.0.0', license: 'MIT' }];
    const vulns = [{ package: 'x', version: '1.0.0', ids: ['A'] }];
    expect(evaluatePolicy(wheels, vulns).blocking).toHaveLength(1);
    expect(evaluatePolicy(wheels, vulns, undefined, 'card').blocking).toEqual([]);
    // Code that runs at start-up is never a matter for the card.
    const pth = [{ ...wheels[0]!, pth_files: ['evil.pth'] }];
    expect(evaluatePolicy(pth, vulns, undefined, 'card').blocking).toHaveLength(1);
  });

  it('is described so a person can judge it', async () => {
    const osvBody = (async () =>
      new Response(
        JSON.stringify({ summary: 'Eats memory', database_specific: { severity: 'HIGH' } }),
      )) as typeof fetch;
    expect(
      await describeAdvisories([{ package: 'zod', version: '3.25.76', ids: ['A'] }], osvBody),
    ).toEqual(['zod 3.25.76 A (HIGH): Eats memory']);
    const down = (async () => new Response('', { status: 500 })) as typeof fetch;
    expect(
      await describeAdvisories([{ package: 'zod', version: '3.25.76', ids: ['A'] }], down),
    ).toEqual(['zod 3.25.76 A']);
  });

  it('stays as it is when the only fix is a new major version', async () => {
    const fixes = await sameMajorFixes(
      [{ package: 'zod', version: '3.25.76', ids: ['A'] }],
      osv({ 'A:zod': ['4.6.6'] }),
    );
    expect(fixes).toEqual({});
  });

  it('ignores packages without one, and takes no fix when the database cannot say', async () => {
    expect(await sameMajorFixes([{ package: 'ok', version: '1.0.0', ids: [] }], osv({}))).toEqual(
      {},
    );
    const down = (async () => new Response('', { status: 500 })) as typeof fetch;
    expect(await sameMajorFixes([{ package: 'x', version: '1.0.0', ids: ['A'] }], down)).toBeNull();
  });
});

describe('files a tool produces', () => {
  it('come from /output and from its answer, under clean names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reality-out-'));
    try {
      await writeFile(join(dir, 'result.csv'), 'a,b');
      await mkdir(join(dir, 'folder'));
      const got: { name: string; text: string }[] = [];
      const names = await collectToolFiles(
        dir,
        [{ name: '../../evil\\pic.png', data: Buffer.from('png') }],
        async (f) => {
          got.push({ name: f.name, text: await readFile(f.path, 'utf8') });
        },
      );
      expect(names).toEqual(['result.csv', 'pic.png']);
      expect(got).toEqual([
        { name: 'result.csv', text: 'a,b' },
        { name: 'pic.png', text: 'png' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('are nothing when there is nowhere they could be', async () => {
    expect(await collectToolFiles(undefined, undefined, async () => undefined)).toEqual([]);
  });
});

describe('the reviewed servers', () => {
  const server = (need: string) => findReviewedServer(need)?.package;

  it('are what a job gets, by what the job is, and only when tools are asked for', () => {
    expect(server('List commits of a GitHub repository [mcp]')).toBe(
      '@modelcontextprotocol/server-github',
    );
    expect(server('Search arXiv papers [mcp]')).toBe('arxiv-mcp-server');
    expect(server('Query Wikidata items [mcp]')).toBe('@cyanheads/wikidata-mcp-server');
    expect(server('Read a Wikipedia article [mcp]')).toBe('mcp-server-fetch');
    expect(server('Query the OSV database for a package [mcp]')).toBe(
      '@cyanheads/osv-advisory-mcp-server',
    );
    expect(server('Search the web with the Brave Search API [mcp]')).toBe(
      '@brave/brave-search-mcp-server',
    );
    expect(server('Search the web [mcp]')).toBe('duckduckgo-mcp-server');
    expect(server('Convert between time zones [mcp]')).toBe('mcp-server-time');
    expect(server('Fetch a web page [mcp]')).toBe('mcp-server-fetch');
    expect(server('Fetch web pages and convert them to markdown [mcp]')).toBe('mcp-server-fetch');
    expect(server('Convert a PDF to text [mcp]')).toBe('markitdown-mcp');
    // A server asked for by name is that one.
    expect(server('Convert time zones [package: other-server] [mcp]')).toBeUndefined();
    expect(server('Draw a diagram of a molecule [mcp]')).toBeUndefined();
    expect(server('Fetch a web page')).toBeUndefined();
    // A marker's words do not choose the server.
    expect(server('Convert time zones [mcp] [domains: github.com]')).toBe('mcp-server-time');
  });

  it('have a real test, or say why not, and the GitHub one cannot write', () => {
    for (const s of REVIEWED_SERVERS) {
      expect(s.test ?? s.secrets, s.package).toBeDefined();
      // What the bot is told about it brings the bot to it.
      expect(findReviewedServer(`${s.job} [mcp]`)?.package, s.job).toBe(s.package);
    }
    const github = REVIEWED_SERVERS.find((s) => s.package.includes('server-github'));
    expect(github?.onlyTools?.some((t) => /create|update|push|merge|fork/.test(t))).toBe(false);
  });
});

describe('keys a person gives a tool server', () => {
  let pool: pg.Pool;
  let dir: string;

  beforeAll(async () => {
    await resetTestDatabase();
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await migrate(pool);
    dir = await mkdtemp(join(tmpdir(), 'reality-secrets-'));
  });
  afterAll(async () => {
    await pool?.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('stores them encrypted, and only the engine can read them back', async () => {
    const store = new SecretStore(pool, join(dir, '.key'));
    await store.set('srv', 'API_KEY', 'super-secret-value', 'person-1');
    const { rows } = await pool.query<{ value: string }>(
      'SELECT value FROM capability_secrets WHERE capability_id = $1',
      ['srv'],
    );
    expect(rows[0]?.value).not.toContain('super-secret-value');
    expect(await store.names('srv')).toEqual([{ name: 'API_KEY', owner: 'person-1' }]);
    expect(await store.reveal('srv')).toEqual({ API_KEY: 'super-secret-value' });
    // Another key cannot open it.
    const other = new SecretStore(pool, join(dir, '.other'));
    await expect(other.reveal('srv')).rejects.toThrow();
  });

  it('refuses names that would change how a program runs', () => {
    for (const bad of [
      'PATH',
      'LD_PRELOAD',
      'PYTHONPATH',
      'NODE_OPTIONS',
      'HTTPS_PROXY',
      'a b',
      '',
    ]) {
      expect(validSecretName(bad), bad).toBe(false);
    }
    expect(validSecretName('GITHUB_TOKEN')).toBe(true);
  });

  it('cuts a key out of whatever a server sends back', () => {
    expect(scrubSecrets('auth failed for abc12345!', ['abc12345'])).toBe(
      'auth failed for [secret removed]!',
    );
  });
});
