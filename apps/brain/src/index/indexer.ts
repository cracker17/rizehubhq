// Vault working tree → index. Incremental: every file's sha256 is compared with the index manifest, so only added or
// edited files are re-chunked, and only chunks whose text changed need a new embedding (the SQL keeps the rest).
// Files that look like they contain a secret are never indexed (and are dropped if they were before).
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../store/types';
import { findSecret } from '../secretScan';
import { chunkMarkdown, embedInput, sha256 } from './chunk';
import { classify, docDate, docTitle, parseFrontmatter, SLUG_RE, type DocKind } from './documents';
import { toPgVector, type Embedder } from './embed';
import { parseMemory } from './memoryParse';

export const MAX_FILE_BYTES = 512 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.trash']);
const SKIP_FILES = /^(BLOCKED-FILES\.txt)$|\.bak/;
/** Per-run cap on per-file events (a first index of hundreds of files becomes one summary event). */
const MAX_FILE_EVENTS = 25;

export interface IndexOptions {
  store: Store;
  embedder: Embedder | null;
  vaultDir: string;
  gitSha?: string | null;
  /** who caused this run (brain-service | github:<pusher> | …) */
  actor?: string;
  /** drop the whole index first ("Rebuild index") */
  full?: boolean;
  log?: (msg: string) => void;
}

export interface IndexReport {
  files: number;
  added: string[];
  changed: string[];
  removed: string[];
  blocked: Array<{ path: string; reason: string; kind: 'secret' | 'size' }>;
  embedded: number;
  pendingEmbeddings: number;
  ms: number;
}

interface ParsedDoc {
  path: string;
  kind: DocKind;
  project: string | null;
  title: string;
  date: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
  sha: string;
}

export function walk(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.isDirectory()) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...walk(root, r)); }
    else if (e.isFile() && e.name.endsWith('.md') && !SKIP_FILES.test(e.name)) out.push(r);
  }
  return out.sort();
}

interface ProjectEntry { slug: string; name?: string; aliases?: string[]; paths?: string[] }

function readProjectsJson(vaultDir: string): ProjectEntry[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(vaultDir, 'projects.json'), 'utf8')) as { projects?: ProjectEntry[] };
    return (j.projects ?? []).filter((p) => typeof p?.slug === 'string' && SLUG_RE.test(p.slug));
  } catch {
    return [];
  }
}

export async function indexVault(o: IndexOptions): Promise<IndexReport> {
  const t0 = Date.now();
  const log = o.log ?? (() => {});
  const actor = o.actor ?? 'brain-service';
  const report: IndexReport = { files: 0, added: [], changed: [], removed: [], blocked: [], embedded: 0, pendingEmbeddings: 0, ms: 0 };

  // 1. read + parse every markdown file
  const docs: ParsedDoc[] = [];
  for (const rel of walk(o.vaultDir)) {
    const abs = path.join(o.vaultDir, rel);
    const size = fs.statSync(abs).size;
    if (size > MAX_FILE_BYTES) { report.blocked.push({ path: rel, reason: `too big (${Math.round(size / 1024)} KB)`, kind: 'size' }); continue; }
    const raw = fs.readFileSync(abs, 'utf8');
    const secret = findSecret(raw);
    if (secret) { report.blocked.push({ path: rel, reason: `looks like it contains a secret (${secret})`, kind: 'secret' }); continue; }
    const { data, body } = parseFrontmatter(raw);
    const { kind, project: pathProject } = classify(rel);
    const fmProject = typeof data.project === 'string' && SLUG_RE.test(data.project) ? data.project : null;
    docs.push({
      path: rel, kind, project: pathProject ?? fmProject, title: docTitle(rel, data, body), date: docDate(rel, data),
      frontmatter: data, body, sha: sha256(raw),
    });
  }
  report.files = docs.length;

  // 2. projects: projects.json + status/links from each memory.md; folders without an entry are listed=false
  const entries = readProjectsJson(o.vaultDir);
  const memories = new Map(docs.filter((d) => d.kind === 'memory' && d.project).map((d) => [d.project as string, parseMemory(d.body)]));
  const slugs = new Set([...entries.map((e) => e.slug), ...docs.map((d) => d.project).filter((p): p is string => !!p)]);
  const projects = [...slugs].map((slug) => {
    const e = entries.find((x) => x.slug === slug);
    const m = memories.get(slug);
    return {
      slug, name: e?.name ?? slug, aliases: e?.aliases ?? [], paths: e?.paths ?? [], listed: !!e,
      status: m?.status ?? null, links: m?.links ?? [],
    };
  });
  await o.store.rpc('brain_sync_projects', { p_projects: projects });

  // 3. diff against the index
  if (o.full) {
    const n = await o.store.rpc<number>('brain_reset_index');
    log(`rebuild: dropped ${n} documents`);
  }
  const manifest = await o.store.rpc<Record<string, string>>('brain_document_manifest') ?? {};
  const current = new Set(docs.map((d) => d.path));

  for (const d of docs) {
    const before = manifest[d.path];
    if (before === d.sha) continue;
    const facts = d.kind === 'memory' ? parseMemory(d.body) : null;
    await o.store.rpc('brain_upsert_document', {
      p_doc: {
        path: d.path, project_slug: d.project, kind: d.kind, title: d.title, doc_date: d.date, frontmatter: d.frontmatter,
        body: d.body, content_sha: d.sha, git_sha: o.gitSha ?? null,
      },
      p_chunks: chunkMarkdown(d.title, d.body),
      p_decisions: facts?.decisions ?? [],
      p_next_steps: facts?.next_steps ?? [],
    });
    (before ? report.changed : report.added).push(d.path);
  }
  report.removed = Object.keys(manifest).filter((p) => !current.has(p));
  if (report.removed.length) await o.store.rpc('brain_delete_documents', { p_paths: report.removed });
  await o.store.rpc('brain_refresh_projects');

  // 4. events (paths and counts only, never content)
  const projectOf = new Map(docs.map((d) => [d.path, d.project]));
  const fileEvents: Array<[string, string]> = [
    ...report.added.map((p): [string, string] => ['doc_added', p]),
    ...report.changed.map((p): [string, string] => ['doc_changed', p]),
    ...report.removed.map((p): [string, string] => ['doc_removed', p]),
  ];
  for (const [action, p] of fileEvents.slice(0, MAX_FILE_EVENTS)) {
    await o.store.rpc('brain_log_event', { p_actor: actor, p_action: action, p_project: projectOf.get(p) ?? p.split('/')[1] ?? null, p_path: p, p_summary: p, p_meta: {} });
  }
  for (const b of report.blocked) {
    await o.store.rpc('brain_log_event', { p_actor: 'brain-service', p_action: b.kind === 'secret' ? 'blocked_secret' : 'blocked_size', p_project: classify(b.path).project, p_path: b.path, p_summary: b.reason, p_meta: {} });
  }

  // 5. embeddings for every chunk that has none (new text, or everything after a model change)
  if (o.embedder) {
    const state = await o.store.rpc<{ embed_model: string | null }>('brain_health');
    if (state?.embed_model && state.embed_model !== o.embedder.model) {
      const n = await o.store.rpc<number>('brain_clear_embeddings');
      log(`embedding model changed ${state.embed_model} → ${o.embedder.model}: cleared ${n} vectors`);
    }
    await o.store.rpc('brain_set_sync_state', { p: { embed_model: o.embedder.model } });
    for (;;) {
      const batch = await o.store.rpc<Array<{ id: number; title: string; heading: string; text: string }>>('brain_chunks_missing_embedding', { p_limit: 96 });
      if (!batch?.length) break;
      const vectors = await o.embedder.embed(batch.map((c) => embedInput(c.title, c.heading, c.text)));
      report.embedded += await o.store.rpc<number>('brain_set_embeddings', {
        p_items: batch.map((c, i) => ({ id: c.id, embedding: toPgVector(vectors[i]) })),
      });
      if (batch.length < 96) break;
    }
  }
  const health = await o.store.rpc<{ chunks: number; embedded: number }>('brain_health');
  report.pendingEmbeddings = Math.max(0, (health?.chunks ?? 0) - (health?.embedded ?? 0));

  const touched = report.added.length + report.changed.length + report.removed.length;
  if (touched || o.full) {
    await o.store.rpc('brain_log_event', {
      p_actor: actor, p_action: 'indexed', p_project: null, p_path: null,
      p_summary: `${report.added.length} added · ${report.changed.length} changed · ${report.removed.length} removed · ${report.embedded} embedded`,
      p_meta: { files: report.files, blocked: report.blocked.length, git_sha: o.gitSha ?? null, full: !!o.full },
    });
  }
  report.ms = Date.now() - t0;
  log(`indexed ${report.files} files in ${report.ms} ms: +${report.added.length} ~${report.changed.length} -${report.removed.length}, ${report.embedded} embedded, ${report.blocked.length} blocked`);
  return report;
}
