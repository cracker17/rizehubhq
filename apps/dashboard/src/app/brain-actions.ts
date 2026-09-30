'use server';
// /brain actions (docs/16-BRAIN.md "UI"). Reads go through the CEO's session (brain_* CEO API); search and writes go to
// the brain service (lib/brainCall.ts), which embeds the query, or runs the vault write path (pull → edit → secret scan →
// commit + push → re-index), attributed to "julev". The CEO check happens here first; the brain never sees the session.
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { callBrain } from '@/lib/brainCall';
import { nextStepLines, parseMarkdown, stripFrontmatter, type BrainHit } from '@/lib/brainView';
import { demoBundle, demoProjects } from '@/lib/data/brainDemo';

export type BrainResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };
type Db = NonNullable<Awaited<ReturnType<typeof createSupabaseServer>>>;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID = /^[0-9a-f-]{36}$/i;
const DEMO = 'Demo mode: saving needs the live dashboard.';

async function requireCeo(): Promise<{ demo: true } | { demo: false; db: Db } | { error: string }> {
  if (!supabaseEnv()) return { demo: true };
  const db = await createSupabaseServer();
  if (!db) return { error: 'Supabase is not configured.' };
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { error: 'Your session expired. Sign in again.' };
  const ceo = await db.from('ceo_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!ceo.data) return { error: 'This account is not the CEO.' };
  return { demo: false, db };
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');
const lines = (v: unknown, maxItems: number, max = 500) => (Array.isArray(v) ? v : []).map((x) => text(x, max)).filter(Boolean).slice(0, maxItems);

/** Hybrid search (semantic + keyword) across the vault, or one project. */
export async function searchBrainAction(q: unknown, project?: unknown): Promise<BrainResult<{ hits: BrainHit[]; semantic: string }>> {
  const query = text(q, 300);
  if (!query) return { ok: true, hits: [], semantic: 'off' };
  const slug = typeof project === 'string' && SLUG.test(project) ? project : null;
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) {
    // Demo: a plain word match over the demo memory files.
    const words = query.toLowerCase().split(/\s+/);
    const hits = demoProjects.filter((p) => !slug || p.slug === slug).flatMap((p) => {
      const b = demoBundle(p.slug)!;
      const body = b.memory!.body;
      if (!words.every((w) => `${p.name} ${body}`.toLowerCase().includes(w))) return [];
      const h = parseMarkdown(body).find((x) => x.t === 'h' && x.level === 2);
      return [{ path: b.memory!.path, title: p.name, kind: 'memory', project: p.slug, doc_date: b.memory!.doc_date, heading: h && h.t === 'h' ? h.text.map((i) => i.v).join('') : null, text: stripFrontmatter(body).trim().slice(0, 280), score: 1 }];
    });
    return { ok: true, hits, semantic: 'demo' };
  }
  const qs = new URLSearchParams({ q: query, k: '12', ...(slug ? { project: slug } : {}) });
  const r = await callBrain<{ results: BrainHit[]; semantic: string }>(`/search?${qs}`);
  if (r.status !== 200) return { ok: false, error: r.body.error ?? `The brain answered ${r.status}` };
  return { ok: true, hits: r.body.results ?? [], semantic: r.body.semantic ?? 'off' };
}

async function write(path: '/write/project' | '/write/memory', body: Record<string, unknown>): Promise<BrainResult<{ project: string | null; summary: string }>> {
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  const r = await callBrain<{ project: string | null; summary: string }>(path, { method: 'POST', body, timeoutMs: 90_000 });
  if (r.status !== 200) return { ok: false, error: r.body.error ?? `The brain answered ${r.status}` };
  return { ok: true, project: r.body.project, summary: r.body.summary };
}

/** New Project wizard → projects.json entry + memory.md from the template + sessions/LOG.md, one commit. */
export async function createBrainProjectAction(input: {
  name: unknown; slug?: unknown; aliases?: unknown; description?: unknown; client?: unknown; platform?: unknown; links?: unknown;
}): Promise<BrainResult<{ project: string | null; summary: string }>> {
  const name = text(input.name, 100);
  if (!name) return { ok: false, error: 'Give the project a name.' };
  const slug = text(input.slug, 64);
  if (slug && !SLUG.test(slug)) return { ok: false, error: 'The short name may only use lowercase letters, digits and "-".' };
  return write('/write/project', {
    name, ...(slug ? { slug } : {}), aliases: lines(input.aliases, 20, 80).map((a) => a.toLowerCase()),
    description: text(input.description, 500) || undefined, client: text(input.client, 200) || undefined,
    platform: text(input.platform, 200) || undefined, links: lines(input.links, 20),
  });
}

/** Rewrite "Open next steps" from the checklist (done items kept as "[x] …" until removed). */
export async function saveNextStepsAction(project: unknown, steps: Array<{ text: string; done: boolean }>): Promise<BrainResult<{ project: string | null; summary: string }>> {
  if (typeof project !== 'string' || !SLUG.test(project)) return { ok: false, error: 'Unknown project.' };
  const clean = (Array.isArray(steps) ? steps : []).slice(0, 30).map((s) => ({ text: text(s?.text, 500), done: s?.done === true }));
  return write('/write/memory', { project, next_steps: nextStepLines(clean) });
}

/** Add one dated line to "Decisions log". */
export async function addDecisionAction(project: unknown, decision: unknown): Promise<BrainResult<{ project: string | null; summary: string }>> {
  if (typeof project !== 'string' || !SLUG.test(project)) return { ok: false, error: 'Unknown project.' };
  const d = text(decision, 500);
  if (!d) return { ok: false, error: 'Write the decision first.' };
  return write('/write/memory', { project, decisions: [d] });
}

/** Devices & accounts: revoke one connector connection (all its tokens). */
export async function revokeBrainConnectionAction(familyId: unknown): Promise<BrainResult> {
  if (typeof familyId !== 'string' || !ID.test(familyId)) return { ok: false, error: 'Unknown connection.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  const { error } = await ceo.db.rpc('brain_revoke_connection', { p_family_id: familyId });
  if (error) return { ok: false, error: /permission|42501/i.test(error.message) ? 'This account is not allowed to do that.' : error.message };
  return { ok: true };
}
