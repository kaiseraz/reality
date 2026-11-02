/**
 * Literature search through OpenAlex (https://openalex.org): free, no key, over 250
 * million scholarly works. Independent of the model provider, so research also works
 * with models that have no web search of their own, and without any model at all.
 */

export const OPENALEX_URL = 'https://api.openalex.org/works';

export interface Work {
  title: string;
  year: number | null;
  authors: string;
  venue: string | null;
  citedBy: number;
  doi: string | null;
  url: string | null;
  abstract: string;
}

export class LiteratureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiteratureError';
  }
}

/** OpenAlex ships abstracts as an inverted index (word → positions). */
export function abstractFromIndex(index: unknown): string {
  if (!index || typeof index !== 'object') return '';
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) if (Number.isInteger(p) && p >= 0 && p < 20_000) words[p] = word;
  }
  return words.filter(Boolean).join(' ');
}

interface RawWork {
  id?: string;
  doi?: string | null;
  title?: string | null;
  publication_year?: number | null;
  cited_by_count?: number | null;
  authorships?: { author?: { display_name?: string } }[];
  abstract_inverted_index?: unknown;
  primary_location?: {
    landing_page_url?: string | null;
    source?: { display_name?: string } | null;
  };
}

export async function searchLiterature(
  query: string,
  opts: { limit?: number; fromYear?: number; baseUrl?: string; mailto?: string } = {},
): Promise<Work[]> {
  const q = query.trim().slice(0, 300);
  if (!q) throw new LiteratureError('Empty literature query.');
  const url = new URL(opts.baseUrl ?? OPENALEX_URL);
  url.searchParams.set('search', q);
  url.searchParams.set('per-page', String(Math.max(1, Math.min(25, opts.limit ?? 8))));
  url.searchParams.set(
    'select',
    'id,doi,title,publication_year,cited_by_count,authorships,abstract_inverted_index,primary_location',
  );
  if (opts.fromYear) url.searchParams.set('filter', `from_publication_date:${opts.fromYear}-01-01`);
  if (opts.mailto) url.searchParams.set('mailto', opts.mailto);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': 'Reality/1.0 (research step)' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new LiteratureError(`OpenAlex is not reachable: ${(err as Error).message}`);
  }
  if (!res.ok) throw new LiteratureError(`OpenAlex answered ${res.status}.`);
  const body = (await res.json()) as { results?: RawWork[] };
  return (body.results ?? []).map((w) => {
    const names = (w.authorships ?? [])
      .map((a) => a.author?.display_name)
      .filter((n): n is string => typeof n === 'string');
    return {
      title: String(w.title ?? '(untitled)').slice(0, 300),
      year: w.publication_year ?? null,
      authors: names.length > 3 ? `${names.slice(0, 3).join(', ')} et al.` : names.join(', '),
      venue: w.primary_location?.source?.display_name ?? null,
      citedBy: w.cited_by_count ?? 0,
      doi: w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//i, '') : null,
      url: w.primary_location?.landing_page_url ?? w.id ?? null,
      abstract: abstractFromIndex(w.abstract_inverted_index).slice(0, 3000),
    };
  });
}
