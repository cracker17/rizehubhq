// Read queries shared by the internal HTTP API (http.ts) and the MCP tools (mcp/server.ts).
import type { Store } from './store/types';
import type { Embedder } from './index/embed';
import { toPgVector } from './index/embed';

export const DEFAULT_SEARCH_KINDS = ['memory', 'session', 'session_log', 'project_doc', 'profile', 'scheduled_task', 'prompt', 'command', 'readme', 'other'];

export interface SearchDeps { store: Store; embedder: Embedder | null }
export interface SearchHit { path: string; title: string; kind: string; project: string | null; doc_date: string | null; heading: string | null; text: string; score: number; via: unknown }

/**
 * Hybrid search. kinds: [] = the default set (raw Claude Code transcripts left out: long and noisy next to the curated
 * memory, sessions and docs), ['all'] = everything, else those kinds.
 */
export async function search(d: SearchDeps, o: { q: string; project?: string | null; kinds?: string[]; k?: number }) {
  const text = o.q.trim().slice(0, 500);
  let embedding: string | null = null;
  let semantic: string = d.embedder ? 'on' : 'off: no embeddings key';
  if (d.embedder) {
    try { embedding = toPgVector((await d.embedder.embed([text]))[0]!); } catch (e) { semantic = `off: ${(e as Error).message.slice(0, 120)}`; }
  }
  const asked = (o.kinds ?? []).filter((k) => /^[a-z_]{1,20}$/.test(k));
  const kinds = asked.includes('all') ? [] : asked.length ? asked : DEFAULT_SEARCH_KINDS;
  const results = await d.store.rpc<SearchHit[]>('brain_search', {
    p_query: text, p_embedding: embedding, p_project: o.project || null, p_kinds: kinds.length ? kinds : null,
    p_limit: Math.max(1, Math.min(50, o.k ?? 10)),
  });
  return { query: text, semantic, results: results ?? [] };
}
