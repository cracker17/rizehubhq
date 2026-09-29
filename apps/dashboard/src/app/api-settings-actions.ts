'use server';
// Admin → API & AI actions (docs/14 "Dashboard settings"). The CEO check happens here; a key only travels browser →
// this action → worker (/settings/keys/set), which tests, seals and stores it. Nothing here stores or logs it.
// Every change needs a fresh 2FA code when the CEO has one (the UI retries with the code when an action answers
// { stepUp: true }); the database also demands it for raising a budget (ai_settings_set) whatever the caller.
import { isProviderKeyName } from '@rizehubhq/shared';
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { ensureStepUp } from '@/lib/auth/mfaServer';
import { isStepUpError } from '@/lib/auth/stepUp';
import { callWorker } from '@/lib/workerCall';
import { parseAiForm, type AiFormInput } from '@/lib/apiSettings';

export type ApiResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; stepUp?: boolean };
type Db = NonNullable<Awaited<ReturnType<typeof createSupabaseServer>>>;

const DEMO = 'Demo mode: API keys and AI settings need the live dashboard.';

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

function friendly(message: string): string {
  if (isStepUpError(message)) return 'Confirm with a fresh 2FA code.';
  if (/not allowed|permission denied|42501|row-level security/i.test(message)) return 'This account is not allowed to do that (not the CEO).';
  if (/JWT|session/i.test(message)) return 'Your session expired. Sign in again.';
  return message.replace(/^(ai_settings_set|provider_key_\w+): /, '');
}

/** Every change on this page: a fresh code when the CEO has 2FA. */
const stepUp = (db: Db, totp: unknown) => ensureStepUp(db, (s) => (s.factorId ? 'required' : 'not_needed'), totp);

/** Tells the worker to re-read keys and settings now (it also does every 60 s). */
async function reloadWorker(): Promise<boolean> {
  const r = await callWorker<{ ok: boolean }>('/settings/reload', {}, 10_000);
  return r.status === 200;
}
const later = ' The worker is not reachable right now: it picks the change up within a minute of coming back.';

export async function setProviderKeyAction(input: { name: string; value: string; test?: boolean; totp?: string | null }): Promise<ApiResult<{ last4: string; message: string }>> {
  if (!isProviderKeyName(input.name)) return { ok: false, error: 'Unknown key name.' };
  const value = String(input.value ?? '').trim();
  if (!value) return { ok: false, error: 'Paste the key first.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  const step = await stepUp(ceo.db, input.totp);
  if (!step.ok) return step;
  const r = await callWorker<{ ok: boolean; last4: string; message: string; applied?: boolean }>('/settings/keys/set', { name: input.name, value, test: input.test !== false }, 30_000);
  if (r.status !== 200 || !('last4' in r.body)) return { ok: false, error: r.body.error ?? 'Could not save the key.' };
  return { ok: true, last4: r.body.last4, message: r.body.message };
}

export async function testProviderKeyAction(input: { name: string }): Promise<ApiResult<{ working: boolean | null; message: string }>> {
  if (!isProviderKeyName(input.name)) return { ok: false, error: 'Unknown key name.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: true, working: true, message: 'Demo mode: pretending the key works.' };
  const r = await callWorker<{ ok: boolean | null; message?: string; error?: string }>('/settings/keys/test', { name: input.name }, 30_000);
  if (r.status !== 200) return { ok: false, error: r.body.error ?? 'Test failed.' };
  return { ok: true, working: r.body.ok, message: r.body.ok === false ? (r.body.error ?? 'The provider refused the key.') : (r.body.message ?? 'Works.') };
}

export async function removeProviderKeyAction(input: { name: string; totp?: string | null }): Promise<ApiResult<{ message: string }>> {
  if (!isProviderKeyName(input.name)) return { ok: false, error: 'Unknown key name.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  const step = await stepUp(ceo.db, input.totp);
  if (!step.ok) return step;
  const r = await ceo.db.rpc('provider_key_delete', { p_name: input.name });
  if (r.error) return { ok: false, error: friendly(r.error.message), stepUp: isStepUpError(r.error.message) || undefined };
  const reloaded = await reloadWorker();
  return { ok: true, message: `Removed. Agents use the .env value of ${input.name} again, if there is one.${reloaded ? '' : later}` };
}

export async function saveAiSettingsAction(input: AiFormInput & { totp?: string | null }): Promise<ApiResult<{ message: string }>> {
  const parsed = parseAiForm(input);
  if (!parsed.ok) return parsed;
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  const step = await stepUp(ceo.db, input.totp);
  if (!step.ok) return step;
  const v = parsed.value;
  const r = await ceo.db.rpc('ai_settings_set', { p_profile: v.profile, p_monthly: v.monthly, p_daily: v.daily, p_model_ids: v.modelIds });
  if (r.error) return { ok: false, error: friendly(r.error.message), stepUp: isStepUpError(r.error.message) || undefined };
  const reloaded = await reloadWorker();
  return { ok: true, message: `AI settings saved.${reloaded ? ' The worker is using them now.' : later}` };
}
