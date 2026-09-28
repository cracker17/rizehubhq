'use server';
// Server actions for /jobs (docs/06 §7c). Only through RPCs from supabase/migrations/20260928050000_rizehub.sql, as the
// signed-in CEO (RLS + hq_guard). DEMO mode never calls these; the page updates its own state in memory.
import { createSupabaseServer } from '@/lib/supabase/server';
import { normalizeJob, type JobRow } from '@/lib/data/rizehubView';

export type JobActionResult = { ok: true; job: JobRow } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CEO_STATUSES = ['skipped', 'shortlisted', 'replied', 'interview', 'offer', 'rejected'] as const;

async function ceoDb() {
  const db = await createSupabaseServer();
  if (!db) return { db: null, error: 'Demo mode: no database configured.' } as const;
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { db: null, error: 'Your session expired. Sign in again.' } as const;
  return { db, error: null } as const;
}
const friendly = (m: string) => (/not allowed|permission denied|42501/i.test(m) ? 'This account is not allowed to do that (not the CEO).' : m);

/** "Mark applied": status applied + applied_at + follow-up reminder in N days (RPC mark_job_applied). */
export async function markJobAppliedAction(input: { id: string; followUpDays: number }): Promise<JobActionResult> {
  if (!UUID.test(String(input.id))) return { ok: false, error: 'Unknown job.' };
  const days = Math.min(30, Math.max(1, Math.round(Number(input.followUpDays) || 5)));
  const { db, error } = await ceoDb();
  if (!db) return { ok: false, error };
  const res = await db.rpc('mark_job_applied', { p_id: input.id, p_follow_up_days: days });
  if (res.error) return { ok: false, error: friendly(res.error.message) };
  return { ok: true, job: normalizeJob(res.data as Record<string, unknown>) };
}

/** Other CEO status changes from the drawer (skip, got a reply, interview…). */
export async function setJobStatusAction(input: { id: string; status: (typeof CEO_STATUSES)[number] }): Promise<JobActionResult> {
  if (!UUID.test(String(input.id))) return { ok: false, error: 'Unknown job.' };
  if (!CEO_STATUSES.includes(input.status)) return { ok: false, error: 'Unknown status.' };
  const { db, error } = await ceoDb();
  if (!db) return { ok: false, error };
  const res = await db.rpc('set_job_status', { p_id: input.id, p_status: input.status, p_follow_up_at: null, p_note: null });
  if (res.error) return { ok: false, error: friendly(res.error.message) };
  return { ok: true, job: normalizeJob(res.data as Record<string, unknown>) };
}
