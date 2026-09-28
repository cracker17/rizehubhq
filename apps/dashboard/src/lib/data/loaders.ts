import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv, workerEnv } from '@/lib/env';
import { demoSnapshot } from '@/lib/mock';
import type {
  ActivityRow, AgentRow, AgentScreenRow, ApprovalRow, ClientRow, HqSession, HqSnapshot, QaReviewRow, RequestRow, TaskRow,
} from './types';

const TERMINAL_TASK = '(done,cancelled)';
const REQUEST_LIMIT = 60;
const HISTORY_LIMIT = 40;
const ACTIVITY_LIMIT = 60;

export function emptySnapshot(): HqSnapshot {
  return { clients: [], agents: [], screens: [], approvals: [], requests: [], tasks: [], activity: [], qaReviews: [], loadedAt: new Date().toISOString() };
}

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return (res.data ?? []) as T;
}

// ---- individual loaders (all run as the signed-in CEO; RLS applies) ----
export async function loadAgents(db: SupabaseClient) {
  return must<AgentRow[]>(await db.from('agents')
    .select('id,name,department,model_role,status,current_task_id,idle_activity,idle_since,avatar,enabled,updated_at')
    .order('department').order('name'), 'agents');
}

export async function loadScreens(db: SupabaseClient) {
  return must<AgentScreenRow[]>(await db.from('agent_screens').select('*'), 'agent_screens');
}

export async function loadPendingApprovals(db: SupabaseClient) {
  return must<ApprovalRow[]>(await db.from('approvals').select('*').eq('status', 'pending').order('created_at', { ascending: false }), 'approvals');
}

export async function loadApprovalHistory(db: SupabaseClient) {
  return must<ApprovalRow[]>(await db.from('approvals').select('*').neq('status', 'pending')
    .order('decided_at', { ascending: false, nullsFirst: false }).limit(HISTORY_LIMIT), 'approval history');
}

export async function loadRecentActivity(db: SupabaseClient) {
  const since = new Date(Date.now() - 36 * 3600_000).toISOString();
  return must<ActivityRow[]>(await db.from('activity_log').select('*').gte('created_at', since)
    .order('created_at', { ascending: false }).limit(ACTIVITY_LIMIT), 'activity_log');
}

export async function loadRequests(db: SupabaseClient) {
  return must<RequestRow[]>(await db.from('requests')
    .select('id,source,raw_text,client_id,title,brief,priority,due_date,status,cost_usd,created_at,updated_at')
    .order('created_at', { ascending: false }).limit(REQUEST_LIMIT), 'requests');
}

const TASK_COLS = 'id,request_id,client_id,agent_id,title,instructions,work_type,acceptance_criteria,depends_on,status,revision_count,max_revisions,output,claimed_at,started_at,completed_at,cost_usd,created_at,updated_at';

/** Open tasks + tasks finished in the last 36 h + every task of the listed requests (for progress %). */
export async function loadTasks(db: SupabaseClient, requestIds: string[]) {
  const since = new Date(Date.now() - 36 * 3600_000).toISOString();
  const [open, recent, ofRequests] = await Promise.all([
    db.from('tasks').select(TASK_COLS).not('status', 'in', TERMINAL_TASK),
    db.from('tasks').select(TASK_COLS).in('status', ['done', 'cancelled']).gte('updated_at', since),
    requestIds.length ? db.from('tasks').select(TASK_COLS).in('request_id', requestIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const byId = new Map<string, TaskRow>();
  for (const list of [must<TaskRow[]>(open, 'tasks'), must<TaskRow[]>(recent, 'tasks'), must<TaskRow[]>(ofRequests, 'tasks')]) {
    for (const t of list) byId.set(t.id, t);
  }
  return [...byId.values()];
}

/** qa_reviews from the last 7 days (verdict only) for the QA pass-rate KPI. */
export async function loadQaReviews(db: SupabaseClient) {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  return must<QaReviewRow[]>(await db.from('qa_reviews').select('id,task_id,verdict,score,created_at').gte('created_at', since), 'qa_reviews');
}

export async function loadClients(db: SupabaseClient) {
  return must<ClientRow[]>(await db.from('clients').select('id,name,slug').order('name'), 'clients');
}

export async function loadLiveSnapshot(db: SupabaseClient): Promise<HqSnapshot> {
  const [clients, agents, screens, pending, history, activity, requests, qaReviews] = await Promise.all([
    loadClients(db), loadAgents(db), loadScreens(db), loadPendingApprovals(db), loadApprovalHistory(db),
    loadRecentActivity(db), loadRequests(db), loadQaReviews(db),
  ]);
  const tasks = await loadTasks(db, requests.map((r) => r.id));
  return { clients, agents, screens, approvals: [...pending, ...history], requests, tasks, activity, qaReviews, loadedAt: new Date().toISOString() };
}

/**
 * Session + data for the current request.
 * DEMO: mock data. LIVE: the signed-in user's data (middleware guarantees a session; RLS returns
 * nothing for accounts that are not in ceo_users, which we detect and show a friendly message for).
 */
export async function loadHq(): Promise<{ session: HqSession; snapshot: HqSnapshot; error?: string }> {
  const env = supabaseEnv();
  const chatLive = workerEnv() !== null;
  if (!env) {
    return { session: { mode: 'demo', supabase: null, user: null, isCeo: true, chatLive: false }, snapshot: demoSnapshot() };
  }
  const db = (await createSupabaseServer())!;
  const { data: { user } } = await db.auth.getUser();
  const base: HqSession = { mode: 'live', supabase: env, user: user ? { id: user.id, email: user.email ?? null } : null, isCeo: false, chatLive };
  if (!user) return { session: base, snapshot: emptySnapshot() };

  // ceo_users has a "read your own row" policy, so this tells us whether RLS will show anything.
  const ceo = await db.from('ceo_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!ceo.data) return { session: base, snapshot: emptySnapshot() };

  try {
    return { session: { ...base, isCeo: true }, snapshot: await loadLiveSnapshot(db) };
  } catch (e) {
    return { session: { ...base, isCeo: true }, snapshot: emptySnapshot(), error: e instanceof Error ? e.message : 'Could not load data' };
  }
}
