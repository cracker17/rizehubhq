'use server';
// /operator actions (docs/17-OPERATOR.md "Operator page"). Everything runs as the CEO's own session through the operator
// SQL functions (hq_guard: CEO or service role), so the rules and the audit log live in one place. The kill switch and
// "Take over" only ever STOP sends; nothing here can post to a client.
import { revalidatePath } from 'next/cache';
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { chatUrl, taskBrief } from '@/lib/operatorView';

export type OperatorResult = { ok: true } | { ok: false; error: string };
type Db = NonNullable<Awaited<ReturnType<typeof createSupabaseServer>>>;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID = /^[0-9a-f-]{36}$/i;
const DEMO = 'Demo mode: this works on the live dashboard.';

async function ceoDb(): Promise<{ db: Db } | { error: string }> {
  if (!supabaseEnv()) return { error: DEMO };
  const db = await createSupabaseServer();
  if (!db) return { error: 'Supabase is not configured.' };
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { error: 'Your session expired. Sign in again.' };
  const ceo = await db.from('ceo_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!ceo.data) return { error: 'This account is not the CEO.' };
  return { db };
}

async function call(fn: string, args: Record<string, unknown>): Promise<OperatorResult> {
  const c = await ceoDb();
  if ('error' in c) return { ok: false, error: c.error };
  const { error } = await c.db.rpc(fn, args);
  if (error) return { ok: false, error: error.message.replace(/^.*?ERROR:\s*/, '') };
  revalidatePath('/operator');
  return { ok: true };
}

/** The kill switch: true = no client message is posted at all. */
export async function setOperatorPausedAction(paused: boolean): Promise<OperatorResult> {
  return call('operator_set_paused', { p_paused: paused === true, p_via: 'dashboard' });
}

/** "Take over" (pause this client's sends while you drive the browser) and "Hand back". */
export async function setClientPausedAction(slug: string, paused: boolean): Promise<OperatorResult> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  return call('operator_set_client_paused', { p_client: slug, p_paused: paused === true, p_via: 'dashboard' });
}

export async function addChannelAction(slug: string, name: string, url: string): Promise<OperatorResult> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  const n = String(name ?? '').trim().slice(0, 120);
  const u = chatUrl(String(url ?? ''));
  if (!n) return { ok: false, error: 'Give the chat a name, e.g. "Alex, Riley".' };
  if (!u) return { ok: false, error: 'Paste the chat address from chat.google.com (open the chat, copy the address bar).' };
  return call('operator_add_channel', { p_client: slug, p_name: n, p_url: u });
}

export async function setChannelEnabledAction(id: string, enabled: boolean): Promise<OperatorResult> {
  if (!ID.test(id)) return { ok: false, error: 'Unknown chat.' };
  return call('operator_set_channel_enabled', { p_channel: id, p_enabled: enabled === true });
}

// ---------- jobs (phase 2 functions; the job runs in the operator container) ----------

/** Add task: queues a job for the client. `channelId` = the chat the client update goes to (optional). */
export async function addJobAction(slug: string, brief: string, channelId: string | null): Promise<OperatorResult> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  const b = taskBrief(String(brief ?? ''));
  if (!b) return { ok: false, error: 'Describe the task in a few words.' };
  if (channelId && !ID.test(channelId)) return { ok: false, error: 'Unknown chat.' };
  return call('operator_add_job', { p_client: slug, p_brief: b, p_channel: channelId || null, p_via: 'dashboard' });
}

export async function cancelJobAction(id: string): Promise<OperatorResult> {
  if (!ID.test(id)) return { ok: false, error: 'Unknown job.' };
  return call('operator_cancel_job', { p_job: id, p_via: 'dashboard' });
}

// ---------- autonomy ----------

/** One rule: client slug or '*' (all clients), an action type, auto | approve | never | inherit. SQL enforces the limits. */
export async function setAutonomyAction(client: string, actionType: string, mode: string): Promise<OperatorResult> {
  if (client !== '*' && !SLUG.test(client)) return { ok: false, error: 'Unknown client.' };
  if (!/^[a-z_]{2,20}$/.test(actionType)) return { ok: false, error: 'Unknown action type.' };
  if (!['auto', 'approve', 'never', 'inherit'].includes(mode)) return { ok: false, error: 'Unknown rule.' };
  return call('operator_set_autonomy', { p_client: client, p_action: actionType, p_mode: mode });
}

export async function setAutoSendAction(on: boolean): Promise<OperatorResult> {
  return call('operator_set_auto_send', { p_on: on === true });
}

/** Telegram digest times; '' = that digest off. */
export async function setDigestTimesAction(morning: string, evening: string): Promise<OperatorResult> {
  const t = (v: string) => { const x = String(v ?? '').trim(); return x === '' ? null : /^([01]\d|2[0-3]):[0-5]\d$/.test(x) ? x : undefined; };
  const m = t(morning), e = t(evening);
  if (m === undefined || e === undefined) return { ok: false, error: 'Use a time like 08:00, or leave it empty to turn that digest off.' };
  return call('operator_set_digest_times', { p_morning: m, p_evening: e });
}

export async function setViewerUrlAction(slug: string, url: string): Promise<OperatorResult> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  const u = String(url ?? '').trim();
  if (u && !/^https:\/\/\S+$/.test(u)) return { ok: false, error: 'The live screen address must start with https://' };
  return call('operator_set_viewer_url', { p_client: slug, p_url: u || null });
}
