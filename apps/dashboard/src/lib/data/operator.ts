import 'server-only';
// /operator loader (docs/17-OPERATOR.md "Operator page"). LIVE: the CEO's own session reads the operator_* tables
// (RLS: CEO select only). DEMO: a small believable LvlUp morning. Before the migration is applied the page says so.
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { digestTimes } from '@/lib/operatorView';
import { demoOperator } from './operatorDemoData';

export { demoOperator };
import type {
  OperatorAccountRow, OperatorActionRow, OperatorPostingRow, OperatorAutonomyRow, OperatorChannelRow, OperatorClientRow, OperatorHomeData, OperatorInboxRow, OperatorJobActionRow, OperatorJobRow,
} from '@/lib/operatorView';

export interface Loaded<T> { data: T; error?: string }

const on = (v: unknown) => v === true || v === 'true';

export async function loadOperatorHome(): Promise<Loaded<OperatorHomeData>> {
  if (!supabaseEnv()) return { data: demoOperator() };
  const db = await createSupabaseServer();
  const empty: OperatorHomeData = { clients: [], channels: [], inbox: [], actions: [], jobs: [], jobActions: [], autonomy: [], accounts: [], posting: [], emailTargets: [], digestTimes: { morning: '08:00', evening: '18:00' }, killSwitch: false, officePaused: false, autoSend: false, heartbeatAt: null, demo: false };
  if (!db) return { data: empty, error: 'Supabase is not configured.' };
  try {
    const [clients, channels, inbox, actions, settings] = await Promise.all([
      db.from('operator_clients').select('*').order('name'),
      db.from('operator_channels').select('*').order('created_at'),
      db.from('operator_inbox').select('id,client_slug,channel_id,sender_name,body,sent_at,created_at,status,category,mode,draft,final_text,approval_id,error,mentions_me,from_me,space_name')
        .order('created_at', { ascending: false }).limit(60),
      db.from('operator_actions').select('id,created_at,client_slug,inbox_id,actor,action,ok,detail').order('id', { ascending: false }).limit(120),
      db.from('settings').select('key,value').in('key', ['operator_paused', 'paused', 'operator_auto_send', 'operator_heartbeat', 'operator_digest_times']),
    ]);
    const err = clients.error ?? channels.error ?? inbox.error ?? actions.error ?? settings.error;
    if (err) {
      const missing = /operator_\w+/.test(err.message) && /does not exist|schema cache/i.test(err.message);
      return { data: empty, error: missing ? 'The operator tables are not in the database yet: apply migration 20261015000000_operator.sql first.' : err.message };
    }
    // Phase 2+ tables: missing before 20261016000000_operator_worker.sql is applied; the page still works without them.
    const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
    const [jobs, autonomy, accounts, posting, targets] = await Promise.all([
      db.from('operator_jobs').select('id,client_slug,source,title,brief,status,runs,max_runs,cost_usd,error,feedback,created_at,updated_at,result,qa')
        .or(`status.in.(queued,running,waiting,verifying),updated_at.gt.${weekAgo}`).order('updated_at', { ascending: false }).limit(60),
      db.from('operator_autonomy').select('client_slug,action_type,mode'),
      db.from('operator_accounts').select('id,client_slug,kind,label,home_url,enabled,last_swept_at,last_found,last_error').order('created_at'),
      db.from('operator_posting').select('client_slug,kind,test_url,test_state,test_detail,tested_at,enabled'),
      db.from('operator_email_targets').select('client_slug,pattern').order('pattern'),
    ]);
    const jobRows = (jobs.error ? [] : jobs.data ?? []) as OperatorJobRow[];
    const jobActions = jobRows.length
      ? await db.from('operator_job_actions').select('id,job_id,kind,summary,status,error,approval_id,created_at').in('job_id', jobRows.map((j) => j.id)).order('created_at')
      : { data: [], error: null };
    const s = Object.fromEntries(((settings.data ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
    return {
      data: {
        clients: (clients.data ?? []) as OperatorClientRow[],
        channels: (channels.data ?? []) as OperatorChannelRow[],
        inbox: (inbox.data ?? []) as OperatorInboxRow[],
        actions: (actions.data ?? []) as OperatorActionRow[],
        jobs: jobRows,
        jobActions: (jobActions.error ? [] : jobActions.data ?? []) as OperatorJobActionRow[],
        autonomy: (autonomy.error ? [] : autonomy.data ?? []) as OperatorAutonomyRow[],
        accounts: (accounts.error ? [] : accounts.data ?? []) as OperatorAccountRow[],
        posting: (posting.error ? [] : posting.data ?? []) as OperatorPostingRow[],
        emailTargets: (targets.error ? [] : targets.data ?? []) as { client_slug: string; pattern: string }[],
        digestTimes: digestTimes(s.operator_digest_times),
        killSwitch: on(s.operator_paused), officePaused: on(s.paused), autoSend: on(s.operator_auto_send),
        heartbeatAt: (s.operator_heartbeat as { at?: string } | undefined)?.at ?? null,
        demo: false,
      },
    };
  } catch (e) {
    return { data: empty, error: e instanceof Error ? e.message : 'Could not load the operator' };
  }
}

// ---------- setup wizard (/operator/setup) ----------

export interface OperatorSetupClient {
  slug: string; name: string; brain_project: string | null; my_names: string[]; rules: string; viewer_url: string | null;
  client_id: string | null; webflow_credential: string | null; airtable_credential: string | null;
  github_credential?: string | null; vercel_credential?: string | null; vercel_team?: string | null;
}
export interface OperatorSetupData {
  home: OperatorHomeData;
  client: OperatorSetupClient | null;
  logins: { site: string; label: string; check_url: string; enabled: boolean; state: string; last_checked_at: string | null; detail: string | null }[];
  credentials: { id: string; label: string; platform: string; secret_type: string; status: string }[];
}

/** The wizard for one client (slug), or for a new one (null). */
export async function loadOperatorSetup(slug: string | null): Promise<Loaded<OperatorSetupData>> {
  const { data: home, error } = await loadOperatorHome();
  const row = slug ? (home.clients.find((c) => c.slug === slug) as unknown as OperatorSetupClient | undefined) ?? null : null;
  if (home.demo) {
    return { data: { home, client: row ? { ...row, my_names: ['Julev', 'Julev Ajeto'], rules: '- No financial figures', client_id: null, webflow_credential: null, airtable_credential: null } : null,
      logins: row ? [
        { site: 'google', label: 'Google (Chat, Gmail)', check_url: 'https://chat.google.com/', enabled: true, state: 'ok', last_checked_at: new Date().toISOString(), detail: null },
        { site: 'webflow', label: 'Webflow', check_url: 'https://webflow.com/dashboard', enabled: true, state: 'signed_out', last_checked_at: new Date().toISOString(), detail: 'redirected to https://webflow.com/login' },
      ] : [],
      credentials: [] } };
  }
  if (!row || error) return { data: { home, client: row, logins: [], credentials: [] }, error };
  const db = await createSupabaseServer();
  if (!db) return { data: { home, client: row, logins: [], credentials: [] }, error: 'Supabase is not configured.' };
  const [logins, creds] = await Promise.all([
    db.from('operator_logins').select('site,label,check_url,enabled,state,last_checked_at,detail').eq('client_slug', row.slug).order('site'),
    row.client_id
      ? db.from('client_credentials').select('id,label,platform,secret_type,status').eq('client_id', row.client_id).in('platform', ['webflow', 'airtable', 'github', 'vercel', 'Webflow', 'Airtable', 'GitHub', 'Github', 'Vercel'])
      : Promise.resolve({ data: [], error: null }),
  ]);
  return {
    data: { home, client: row, logins: (logins.error ? [] : logins.data ?? []) as OperatorSetupData['logins'], credentials: (creds.error ? [] : creds.data ?? []) as OperatorSetupData['credentials'] },
    error: logins.error?.message,
  };
}
