import 'server-only';
// /brain loaders (docs/16-BRAIN.md "UI"). LIVE: the CEO's own session calls the brain_* CEO API (RLS + hq_guard, aal2),
// so the dashboard never needs the service key. DEMO: brainDemo.ts. Client components import types only.
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import type { BrainBundle, BrainConnection, BrainEvent, BrainHealth, BrainProject } from '@/lib/brainView';
import { demoBundle, demoConnections, demoEvents, demoHealth, demoProjects } from './brainDemo';

export interface Loaded<T> { data: T; error?: string }
export interface BrainHome { health: BrainHealth | null; projects: BrainProject[]; events: BrainEvent[]; connections: BrainConnection[]; demo: boolean }

async function liveDb(): Promise<SupabaseClient | null> {
  if (!supabaseEnv()) return null;
  return createSupabaseServer();
}

async function rpc<T>(db: SupabaseClient, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

export async function loadBrainHome(): Promise<Loaded<BrainHome>> {
  const db = await liveDb();
  if (!db) return { data: { health: demoHealth(), projects: demoProjects, events: demoEvents(), connections: demoConnections(), demo: true } };
  try {
    const [health, projects, events, connections] = await Promise.all([
      rpc<BrainHealth>(db, 'brain_health'),
      rpc<BrainProject[]>(db, 'brain_list_projects'),
      rpc<BrainEvent[]>(db, 'brain_recent_events', { p_limit: 400 }),
      rpc<BrainConnection[]>(db, 'brain_connections').catch(() => []), // before migration 20260930020000
    ]);
    return { data: { health, projects: projects ?? [], events: events ?? [], connections: connections ?? [], demo: false } };
  } catch (e) {
    return { data: { health: null, projects: [], events: [], connections: [], demo: false }, error: e instanceof Error ? e.message : 'Could not load the brain' };
  }
}

export async function loadBrainProject(slug: string): Promise<Loaded<{ bundle: BrainBundle | null; events: BrainEvent[] }>> {
  const db = await liveDb();
  if (!db) return { data: { bundle: demoBundle(slug), events: demoEvents().filter((e) => e.project_slug === slug) } };
  try {
    const [bundle, events] = await Promise.all([
      rpc<BrainBundle | null>(db, 'brain_project_bundle', { p_slug: slug, p_sessions: 12 }),
      rpc<BrainEvent[]>(db, 'brain_recent_events', { p_limit: 300 }),
    ]);
    return { data: { bundle, events: (events ?? []).filter((e) => e.project_slug === slug) } };
  } catch (e) {
    return { data: { bundle: null, events: [] }, error: e instanceof Error ? e.message : 'Could not load the project' };
  }
}

export interface BrainDocument { path: string; project_slug: string | null; kind: string; title: string; doc_date: string | null; body: string; indexed_at?: string }

export async function loadBrainDoc(path: string): Promise<Loaded<BrainDocument | null>> {
  const db = await liveDb();
  if (!db) {
    const slug = /^projects\/([^/]+)\//.exec(path)?.[1];
    const b = slug ? demoBundle(slug) : null;
    const doc = b && [b.memory, ...b.sessions].find((d) => d?.path === path);
    return { data: doc ? { path, project_slug: slug!, kind: 'memory', title: doc.title, doc_date: doc.doc_date, body: doc.body } : null };
  }
  try {
    return { data: await rpc<BrainDocument | null>(db, 'brain_get_document', { p_path: path }) };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : 'Could not load the file' };
  }
}
