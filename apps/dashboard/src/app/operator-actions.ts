'use server';
// /operator actions (docs/17-OPERATOR.md "Operator page"). Everything runs as the CEO's own session through the operator
// SQL functions (hq_guard: CEO or service role), so the rules and the audit log live in one place. The kill switch and
// "Take over" only ever STOP sends; nothing here can post to a client.
import { revalidatePath } from 'next/cache';
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { ensureStepUp } from '@/lib/auth/mfaServer';
import { ACCOUNT_KINDS, channelUrl, CHANNEL_KINDS, parseTargets, taskBrief, type ChannelKind, type SweepKind } from '@/lib/operatorView';

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
  revalidatePath('/operator/setup');
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

export async function addChannelAction(slug: string, name: string, url: string, kind: ChannelKind = 'google_chat', phoneId = ''): Promise<OperatorResult> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  const k = CHANNEL_KINDS.find((c) => c.kind === kind);
  if (!k) return { ok: false, error: 'Unknown kind of channel.' };
  const n = String(name ?? '').trim().slice(0, 120);
  const u = channelUrl(k.kind, String(url ?? ''));
  if (!n) return { ok: false, error: 'Give it a name, e.g. "Alex, Riley".' };
  if (!u) return { ok: false, error: `Paste the ${k.label} address (${k.placeholder}). ${k.hint}` };
  if (k.kind === 'whatsapp') {
    const pid = String(phoneId ?? '').trim();
    if (!/^\d{6,30}$/.test(pid)) return { ok: false, error: 'Paste the phone number ID from Meta (WhatsApp → API setup): a long number.' };
    return call('operator_add_whatsapp', { p_client: slug, p_name: n, p_number: u.replace(/^https:\/\/wa\.me\//, ''), p_phone_id: pid });
  }
  // Google Chat keeps its phase 1 function; the other kinds need 20261017020000_operator_watchers.sql.
  return k.kind === 'google_chat' ? call('operator_add_channel', { p_client: slug, p_name: n, p_url: u })
    : call('operator_add_watch', { p_client: slug, p_kind: k.kind, p_name: n, p_url: u });
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

// ---------- unread sweep: accounts and the "addressed" rule ----------

export async function addAccountAction(slug: string, kind: SweepKind, label: string, homeUrl: string): Promise<OperatorResult> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  const k = ACCOUNT_KINDS.find((a) => a.kind === kind);
  if (!k) return { ok: false, error: 'Unknown app.' };
  const u = channelUrl(k.kind, String(homeUrl ?? ''));
  if (!u) return { ok: false, error: `Paste the ${k.label} address. ${k.hint}` };
  return call('operator_add_account', { p_client: slug, p_kind: k.kind, p_label: String(label ?? '').trim().slice(0, 120) || `${k.label}`, p_home_url: u });
}

export async function setAccountEnabledAction(id: string, enabled: boolean): Promise<OperatorResult> {
  if (!ID.test(id)) return { ok: false, error: 'Unknown account.' };
  return call('operator_set_account_enabled', { p_account: id, p_enabled: enabled === true });
}

/** Send test: the operator posts a unique test message in this conversation and reads it back. */
export async function requestSendTestAction(slug: string, kind: 'gmail' | 'slack' | 'teams', url: string): Promise<OperatorResult> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  if (!['gmail', 'slack', 'teams'].includes(kind)) return { ok: false, error: 'Send tests are for Slack, Teams and Gmail.' };
  const u = channelUrl(kind, String(url ?? ''));
  if (!u) return { ok: false, error: kind === 'gmail' ? 'Paste the address of an email thread with yourself (open it, copy the address bar).' : 'Paste the address of a DM to yourself or a test channel.' };
  return call('operator_request_send_test', { p_client: slug, p_kind: kind, p_url: u });
}

export async function setPostingAction(slug: string, kind: 'gmail' | 'slack' | 'teams', on: boolean): Promise<OperatorResult> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  return call('operator_set_posting', { p_client: slug, p_kind: kind, p_on: on === true });
}

/** Gmail: the senders to watch (one per line: an address, @domain or a name; empty = everyone). */
export async function setEmailTargetsAction(slug: string, text: string): Promise<OperatorResult> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  return call('operator_set_email_targets', { p_client: slug, p_patterns: parseTargets(String(text ?? '')) });
}

/** Chats: the people whose messages get drafts (one per line; empty = everyone). Others are kept as history. */
export async function setChatPeopleAction(slug: string, text: string): Promise<OperatorResult> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  return call('operator_set_chat_people', { p_client: slug, p_names: parseTargets(String(text ?? '')) });
}

export async function setEmailModeAction(slug: string, mode: 'pick' | 'auto'): Promise<OperatorResult> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  if (mode !== 'pick' && mode !== 'auto') return { ok: false, error: 'Unknown mode.' };
  return call('operator_set_email_mode', { p_client: slug, p_mode: mode });
}

export async function setReplyWhenAction(slug: string, mode: 'addressed' | 'all'): Promise<OperatorResult> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  if (mode !== 'addressed' && mode !== 'all') return { ok: false, error: 'Unknown rule.' };
  return call('operator_set_reply_when', { p_client: slug, p_mode: mode });
}

export async function setViewerUrlAction(slug: string, url: string): Promise<OperatorResult> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  const u = String(url ?? '').trim();
  if (u && !/^https:\/\/\S+$/.test(u)) return { ok: false, error: 'The live screen address must start with https://' };
  return call('operator_set_viewer_url', { p_client: slug, p_url: u || null });
}

// ---------- setup wizard ----------

export async function saveClientAction(input: { slug: string; name: string; brainProject: string; myNames: string; rules: string }): Promise<OperatorResult & { slug?: string }> {
  const slug = String(input.slug ?? '').trim().toLowerCase();
  if (!SLUG.test(slug)) return { ok: false, error: 'The short name must be lowercase letters, digits and dashes, e.g. madam-muse.' };
  const names = String(input.myNames ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6);
  const r = await call('operator_save_client', { p_slug: slug, p_name: String(input.name ?? '').trim(), p_brain_project: String(input.brainProject ?? '').trim() || null,
    p_my_names: names, p_rules: String(input.rules ?? '').slice(0, 4000) });
  return r.ok ? { ok: true, slug } : r;
}

export async function setLoginSiteAction(slug: string, site: string, label: string, url: string, enabled: boolean): Promise<OperatorResult> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(site)) return { ok: false, error: 'Unknown site.' };
  if (!/^https:\/\/\S+$/.test(String(url ?? '').trim())) return { ok: false, error: 'The page to check must start with https://' };
  return call('operator_set_login_site', { p_client: slug, p_site: site, p_label: String(label ?? site).slice(0, 80), p_url: String(url).trim(), p_enabled: enabled === true });
}

/** The client's Vercel team (id team_... or slug) for team projects; empty = the token's own account. */
export async function setVercelTeamAction(slug: string, team: string): Promise<OperatorResult> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  const t = String(team ?? '').trim();
  if (t && !/^[A-Za-z0-9_-]{2,64}$/.test(t)) return { ok: false, error: 'Paste the team id (team_...) or its slug from the Vercel URL.' };
  return call('operator_set_vercel_team', { p_client: slug, p_team: t || null });
}

export async function requestLoginCheckAction(slug: string): Promise<OperatorResult> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  return call('operator_request_login_check', { p_client: slug });
}

/** Link (or unlink with null) a Client Vault API token for the operator. Needs your 2FA code when 2FA is on. */
export async function linkCredentialAction(slug: string, platform: 'webflow' | 'airtable' | 'github' | 'vercel', credentialId: string | null, totp?: string | null): Promise<OperatorResult & { stepUp?: boolean }> {
  if (!SLUG.test(slug)) return { ok: false, error: 'Unknown client.' };
  if (!['webflow', 'airtable', 'github', 'vercel'].includes(platform)) return { ok: false, error: 'Unknown platform.' };
  if (credentialId && !ID.test(credentialId)) return { ok: false, error: 'Unknown credential.' };
  const c = await ceoDb();
  if ('error' in c) return { ok: false, error: c.error };
  const step = await ensureStepUp(c.db, (s) => (s.factorId ? 'required' : 'not_needed'), totp);
  if (!step.ok) return step;
  const { error } = await c.db.rpc('operator_set_credential', { p_client: slug, p_platform: platform, p_credential: credentialId });
  if (error) return { ok: false, error: error.message.replace(/^.*?ERROR:\s*/, ''), stepUp: /step_up/i.test(error.message) };
  revalidatePath('/operator');
  return { ok: true };
}
