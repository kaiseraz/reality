import { DYNAMIC_ENTRY, type McpLaunch } from './mcp.ts';
import { safeId, wantsMcp } from './search.ts';

/**
 * Tool servers for the jobs that come up all the time, each started and called by hand against
 * the real service before it went on this list. A search can turn up anything; this is what makes
 * the sure way the easy way: asked for such a job, a bot gets the server that is known to work
 * instead of whatever a search ranks highest that day. A person still approves each install, its
 * files are still inspected, and it must pass its test against the real service again.
 */
export interface ReviewedServer {
  package: string;
  runtime: 'python' | 'node';
  /** What a need must say for this to be the server. */
  need: RegExp;
  /** For the bot's prompt and the card: what it is for, in a few words. */
  job: string;
  fitNote: string;
  domains: string[];
  secrets?: { name: string; description: string }[];
  args?: string[];
  /** Not named to bots unasked: a small job does it without a server and without a card. */
  onRequest?: boolean;
  /** Only these tools can be called, though the server offers more (it could also write). */
  onlyTools?: string[];
  /** A real call and what must come back; absent: it needs a key, so it can only start. */
  test?: { tool: string; args: Record<string, unknown>; expect: RegExp; description: string };
}

export const REVIEWED_SERVERS: ReviewedServer[] = [
  {
    package: '@cyanheads/wikidata-mcp-server',
    runtime: 'node',
    need: /wikidata/i,
    job: 'Wikidata: entities, statements, SPARQL',
    fitNote: 'Searches Wikidata and reads items and their statements, or runs SPARQL.',
    domains: ['wikidata.org'],
    test: {
      tool: 'wikidata_search_entities',
      args: { query: 'Berlin' },
      expect: /Q64\b/,
      description: 'It must find Berlin on the real Wikidata and return its id, Q64.',
    },
  },
  {
    package: 'arxiv-mcp-server',
    runtime: 'python',
    need: /arxiv|preprint/i,
    job: 'arXiv: search papers, abstracts, full text',
    fitNote: 'Searches arXiv by query and date, and reads abstracts and papers.',
    domains: ['arxiv.org'],
    args: [],
    test: {
      tool: 'get_abstract',
      args: { paper_id: '1706.03762' },
      expect: /Attention Is All You Need/i,
      description: 'It must fetch a known paper from the real arXiv by its id.',
    },
  },
  {
    package: '@cyanheads/osv-advisory-mcp-server',
    runtime: 'node',
    need: /\bosv\b|known vulnerabilit|security advisor|\bghsa\b|\bcve-/i,
    job: 'Known vulnerabilities of packages (OSV database)',
    fitNote: 'Queries the OSV database for vulnerabilities of a package version.',
    domains: ['osv.dev'],
    test: {
      tool: 'osv_query_package',
      args: { name: 'requests', ecosystem: 'PyPI', version: '2.25.0' },
      expect: /GHSA-|CVE-/,
      description:
        'It must find the known vulnerabilities of requests 2.25.0 in the real database.',
    },
  },
  {
    package: '@modelcontextprotocol/server-github',
    runtime: 'node',
    need: /github|pull requests?\b/i,
    job: 'GitHub: commits, issues, pull requests, files, search (read only)',
    fitNote:
      'The MCP project’s GitHub server, no longer developed by them but the most used. Only its reading tools can be called. Without a token GitHub allows 60 requests an hour.',
    domains: ['github.com'],
    onlyTools: [
      'search_repositories',
      'get_file_contents',
      'list_commits',
      'list_issues',
      'search_code',
      'search_issues',
      'search_users',
      'get_issue',
      'get_pull_request',
      'list_pull_requests',
      'get_pull_request_files',
      'get_pull_request_status',
      'get_pull_request_comments',
      'get_pull_request_reviews',
    ],
    test: {
      tool: 'search_repositories',
      args: { query: 'modelcontextprotocol/servers' },
      expect: /full_name/,
      description: 'It must find a known repository on the real GitHub.',
    },
  },
  {
    package: '@brave/brave-search-mcp-server',
    runtime: 'node',
    need: /\bbrave\b/i,
    job: 'Brave Search (needs an API key)',
    fitNote: 'Brave’s own server for its search API. Needs a key from brave.com/search/api.',
    domains: ['api.search.brave.com'],
    secrets: [{ name: 'BRAVE_API_KEY', description: 'from brave.com/search/api' }],
  },
  {
    package: '@upstash/context7-mcp',
    runtime: 'node',
    need: /(library|framework|package|api|sdk)('s)? (docs|documentation)|documentation of .*(librar|framework|package)|context7|up-to-date docs/i,
    job: 'Current documentation of programming libraries',
    fitNote: 'Finds a library and returns its current documentation and examples.',
    domains: ['context7.com'],
    test: {
      tool: 'resolve-library-id',
      args: { libraryName: 'react', query: 'hooks' },
      expect: /\/[\w-]+\/react/i,
      description: 'It must find React in the real documentation index.',
    },
  },
  {
    package: 'markitdown-mcp',
    runtime: 'python',
    need: /markitdown|documents? to text|(convert|extract|read)\b.*\b(pdf|docx|pptx|xlsx|word document)/i,
    job: 'Documents to text: PDF, Word, PowerPoint, Excel, web pages',
    fitNote: 'Microsoft’s MarkItDown as a server: turns a document at a URL into markdown.',
    domains: ['example.com'],
    test: {
      tool: 'convert_to_markdown',
      args: { uri: 'https://example.com' },
      expect: /documentation examples/,
      description: 'It must turn a real web page into markdown.',
    },
  },
  {
    package: 'duckduckgo-mcp-server',
    runtime: 'python',
    need: /web search|search (the )?(web|internet)|duckduckgo|internet search/i,
    job: 'Web search without a key (DuckDuckGo)',
    fitNote: 'Searches the web through DuckDuckGo, with no key, and reads result pages.',
    domains: ['duckduckgo.com'],
    test: {
      tool: 'search',
      args: { query: 'python programming language' },
      expect: /https?:\/\/|ref:\/\//,
      description: 'It must return real search results, with links.',
    },
  },
  {
    package: 'mcp-server-time',
    runtime: 'python',
    need: /time ?zones?|current time|convert\b.*\btimes?\b/i,
    job: 'Time zones and the current time',
    onRequest: true,
    fitNote: 'Reference server from the MCP project for time and time zones. No network.',
    domains: [],
    test: {
      tool: 'convert_time',
      args: { source_timezone: 'Europe/Berlin', time: '09:00', target_timezone: 'Asia/Tokyo' },
      expect: /1[67]:00/,
      description: '9:00 in Berlin must come out as 16:00 or 17:00 in Tokyo.',
    },
  },
  {
    package: 'mcp-server-fetch',
    runtime: 'python',
    need: /\bfetch\b|wikipedia|web ?pages?|websites?|\burls?\b|(http|rest|json) api/i,
    job: 'Reading web pages, Wikipedia and web APIs',
    onRequest: true,
    fitNote:
      'Reference server from the MCP project. It reaches only the domains on its card; more can be asked for one at a time.',
    domains: ['example.com', 'wikipedia.org'],
    test: {
      tool: 'fetch',
      args: { url: 'https://example.com', raw: true },
      expect: /Example Domain/,
      description: 'It must read a real page, through the gateway, from a domain on its list.',
    },
  },
];

export const reviewedId = (s: ReviewedServer) =>
  s.runtime === 'node' ? `npm-${safeId(s.package)}` : s.package;

export function findReviewedServer(need: string): ReviewedServer | undefined {
  // A server asked for by name is that server, checked like any other.
  if (!wantsMcp(need) || need.includes('[package:')) return undefined;
  const text = need.replace(/\s*\[[^\]]*\]/g, ' ');
  return REVIEWED_SERVERS.find((s) => s.need.test(text));
}

export const reviewedById = (id: string) => REVIEWED_SERVERS.find((s) => reviewedId(s) === id);

export function reviewedLaunch(s: ReviewedServer): McpLaunch {
  return {
    entry: DYNAMIC_ENTRY,
    args: s.args ?? [],
    allowedTools: [],
    runtime: s.runtime,
    ...(s.domains.length ? { domains: s.domains } : {}),
    ...(s.secrets?.length ? { secrets: s.secrets } : {}),
  };
}
