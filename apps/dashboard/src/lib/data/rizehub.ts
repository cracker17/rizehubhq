import 'server-only';
// Loaders for /leads and /jobs (docs/06 §7b, §7c). LIVE: rizehub_refs + job_opportunities as the signed-in CEO (RLS).
// DEMO (no Supabase env): lib/data/rizehubDemo.ts.
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { demoJobs, demoLeads } from './rizehubDemo';
import { leadFromRef, normalizeJob, type JobsData, type LeadsData } from './rizehubView';

export async function loadLeads(): Promise<LeadsData> {
  if (!supabaseEnv()) return { mode: 'demo', leads: demoLeads() };
  const db = await createSupabaseServer();
  if (!db) return { mode: 'demo', leads: demoLeads() };
  const { data, error } = await db.from('rizehub_refs').select('rizehub_id,summary,created_at,updated_at')
    .eq('kind', 'lead').order('updated_at', { ascending: false }).limit(500);
  return { mode: 'live', leads: (data ?? []).map((r) => leadFromRef(r as Parameters<typeof leadFromRef>[0])), error: error?.message };
}

export async function loadJobs(): Promise<JobsData> {
  if (!supabaseEnv()) return { mode: 'demo', jobs: demoJobs() };
  const db = await createSupabaseServer();
  if (!db) return { mode: 'demo', jobs: demoJobs() };
  const { data, error } = await db.from('job_opportunities')
    .select('id,source,url,title,company,platform_tags,rate,posted_at,fit_score,fit_reasons,red_flags,draft,status,applied_at,follow_up_at,notes,created_at')
    .order('created_at', { ascending: false }).limit(300);
  return { mode: 'live', jobs: (data ?? []).map((r) => normalizeJob(r as Record<string, unknown>)), error: error?.message };
}
