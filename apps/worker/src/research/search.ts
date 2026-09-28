// web_search: pluggable providers chosen by env, tried in order Tavily → Brave → Serper (first configured
// that answers wins; a failing provider falls through to the next).
import { wrapUntrusted } from './fetch';

export interface SearchResult { title: string; url: string; snippet: string }
export type ApiFetch = typeof fetch;

export interface SearchProvider {
  name: string;
  envKey: string;
  search(query: string, count: number, key: string, f: ApiFetch): Promise<SearchResult[]>;
}

async function json(res: Response, name: string): Promise<unknown> {
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export const tavily: SearchProvider = {
  name: 'tavily', envKey: 'TAVILY_API_KEY',
  async search(query, count, key, f) {
    const res = await f('https://api.tavily.com/search', {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: count, search_depth: 'basic' }),
    });
    const j = (await json(res, 'Tavily')) as { results?: { title?: string; url?: string; content?: string }[] };
    return (j.results ?? []).map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.content) }));
  },
};

export const brave: SearchProvider = {
  name: 'brave', envKey: 'BRAVE_SEARCH_API_KEY',
  async search(query, count, key, f) {
    const u = new URL('https://api.search.brave.com/res/v1/web/search');
    u.searchParams.set('q', query);
    u.searchParams.set('count', String(Math.min(count, 20)));
    const res = await f(u, { headers: { accept: 'application/json', 'x-subscription-token': key }, signal: AbortSignal.timeout(20_000) });
    const j = (await json(res, 'Brave')) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (j.web?.results ?? []).map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.description).replace(/<\/?strong>/g, '') }));
  },
};

export const serper: SearchProvider = {
  name: 'serper', envKey: 'SERPER_API_KEY',
  async search(query, count, key, f) {
    const res = await f('https://google.serper.dev/search', {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ q: query, num: count }),
    });
    const j = (await json(res, 'Serper')) as { organic?: { title?: string; link?: string; snippet?: string }[] };
    return (j.organic ?? []).map((r) => ({ title: str(r.title), url: str(r.link), snippet: str(r.snippet) }));
  },
};

export const SEARCH_PROVIDERS: SearchProvider[] = [tavily, brave, serper];

export const NO_SEARCH_MESSAGE = 'web_search is not connected: no search provider key is set on the worker '
  + '(TAVILY_API_KEY, BRAVE_SEARCH_API_KEY or SERPER_API_KEY). Use web_fetch on URLs you already know '
  + '(the client site, brain/ sources, official docs), mark unverified facts as [PLACEHOLDER: ...], or ask_ceo if search is essential.';

export interface SearchOutcome { provider: string | null; results: SearchResult[]; errors: string[]; text: string }

export async function webSearch(query: string, count: number, env: Record<string, string | undefined>, f: ApiFetch,
  providers: SearchProvider[] = SEARCH_PROVIDERS): Promise<SearchOutcome> {
  const configured = providers.filter((p) => env[p.envKey]);
  if (!configured.length) return { provider: null, results: [], errors: [], text: NO_SEARCH_MESSAGE };
  const errors: string[] = [];
  for (const p of configured) {
    try {
      const results = (await p.search(query, count, env[p.envKey]!, f)).filter((r) => /^https?:\/\//i.test(r.url)).slice(0, count);
      const body = results.length
        ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')
        : 'No results.';
      const note = errors.length ? `\n(Fell back after: ${errors.join('; ')})` : '';
      return { provider: p.name, results, errors, text: `Search via ${p.name}: "${query}"${note}\n\n${wrapUntrusted(`search:${p.name}`, body, 'search_results')}` };
    } catch (e) {
      errors.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
    }
  }
  return { provider: null, results: [], errors, text: `All search providers failed (${errors.join('; ')}). Use web_fetch on known URLs instead.` };
}
