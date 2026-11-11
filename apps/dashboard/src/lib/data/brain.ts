import 'server-only';
// /brain loaders (docs/16-BRAIN.md "UI"). LIVE: the CEO's own session calls the brain_* CEO API (RLS + hq_guard, aal2),
// so the dashboard never needs the service key. DEMO: brainDemo.ts. Client components import types only.
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import type { BrainBundle, BrainConnection, BrainEvent, BrainHealth, BrainProject } from '@/lib/brainView';
import type { BrainDevice } from '@/lib/brainDevices';
import type { BrainPerson } from '@/lib/brainPeople';
import { demoBundle, demoConnections, demoDevices, demoEvents, demoHealth, demoPeople, demoProjects } from './brainDemo';

export interface Loaded<T> { data: T; error?: string }
export interface BrainHome { health: BrainHealth | null; projects: BrainProject[]; events: BrainEvent[]; connections: BrainConnection[]; devices: BrainDevice[]; demo: boolean }

async function liveDb(): Promise<SupabaseClient | null> {
  if (!supabaseEnv()) return null;
  return createSupabaseServer();
}

async function rpc<T>(db: SupabaseClient, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

/** Each part loads on its own: one slow or failing call (2026-11-11: brain_health timed out) must not blank the page. */
export async function loadBrainHome(): Promise<Loaded<BrainHome>> {
  const db = await liveDb();
  if (!db) return { data: { health: demoHealth(), projects: demoProjects, events: demoEvents(), connections: demoConnections(), devices: demoDevices(), demo: true } };
  const [health, projects, events, connections, devices] = await Promise.allSettled([
    rpc<BrainHealth>(db, 'brain_health'),
    rpc<BrainProject[]>(db, 'brain_list_projects'),
    rpc<BrainEvent[]>(db, 'brain_recent_events', { p_limit: 400 }),
    rpc<BrainConnection[]>(db, 'brain_connections'),
    rpc<BrainDevice[]>(db, 'brain_devices_list'),
  ]);
  const val = <T,>(r: PromiseSettledResult<T>, fallback: T): T => (r.status === 'fulfilled' ? (r.value ?? fallback) : fallback);
  const failed = ([['status', health], ['projects', projects], ['activity', events]] as const)
    .filter(([, r]) => r.status === 'rejected').map(([name]) => name);
  return {
    data: {
      health: val(health, null), projects: val(projects, []), events: val(events, []),
      connections: val(connections, []), devices: val(devices, []), demo: false,
    },
    error: failed.length ? `Could not load the brain's ${failed.join(', ')} just now. The rest of the page is current; refresh in a minute.` : undefined,
  };
}

export interface BrainPeopleData { people: BrainPerson[]; projects: Array<{ slug: string; name: string }>; demo: boolean }

export async function loadBrainPeople(): Promise<Loaded<BrainPeopleData>> {
  const db = await liveDb();
  const listed = (ps: BrainProject[]) => ps.filter((p) => p.listed !== false).map((p) => ({ slug: p.slug, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  if (!db) return { data: { people: demoPeople(), projects: listed(demoProjects), demo: true } };
  const [people, projects] = await Promise.allSettled([rpc<BrainPerson[]>(db, 'brain_people_list'), rpc<BrainProject[]>(db, 'brain_list_projects')]);
  return {
    data: { people: people.status === 'fulfilled' ? people.value ?? [] : [], projects: projects.status === 'fulfilled' ? listed(projects.value ?? []) : [], demo: false },
    error: people.status === 'rejected' ? 'People are not switched on yet (apply migration 20261111020000_brain_people.sql).' : undefined,
  };
}

export interface BrainDevicesData { health: BrainHealth | null; devices: BrainDevice[]; connections: BrainConnection[]; demo: boolean }

export async function loadBrainDevices(): Promise<Loaded<BrainDevicesData>> {
  const db = await liveDb();
  if (!db) return { data: { health: demoHealth(), devices: demoDevices(), connections: demoConnections(), demo: true } };
  const [health, devices, connections] = await Promise.allSettled([
    rpc<BrainHealth>(db, 'brain_health'),
    rpc<BrainDevice[]>(db, 'brain_devices_list'),
    rpc<BrainConnection[]>(db, 'brain_connections'),
  ]);
  const errs = [health.status === 'rejected' && 'brain status', devices.status === 'rejected' && 'device list'].filter(Boolean);
  return {
    data: {
      health: health.status === 'fulfilled' ? health.value : null,
      devices: devices.status === 'fulfilled' ? devices.value ?? [] : [],
      connections: connections.status === 'fulfilled' ? connections.value ?? [] : [],
      demo: false,
    },
    error: errs.length ? `Could not load the ${errs.join(' and ')} just now (the devices migration may not be applied yet).` : undefined,
  };
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
