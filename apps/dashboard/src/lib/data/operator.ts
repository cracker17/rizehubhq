import 'server-only';
// /operator loader (docs/17-OPERATOR.md "Operator page"). LIVE: the CEO's own session reads the operator_* tables
// (RLS: CEO select only). DEMO: a small believable LvlUp morning. Before the migration is applied the page says so.
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { digestTimes } from '@/lib/operatorView';
import type {
  OperatorActionRow, OperatorAutonomyRow, OperatorChannelRow, OperatorClientRow, OperatorHomeData, OperatorInboxRow, OperatorJobActionRow, OperatorJobRow,
} from '@/lib/operatorView';

export interface Loaded<T> { data: T; error?: string }

const on = (v: unknown) => v === true || v === 'true';

export async function loadOperatorHome(): Promise<Loaded<OperatorHomeData>> {
  if (!supabaseEnv()) return { data: demoOperator() };
  const db = await createSupabaseServer();
  const empty: OperatorHomeData = { clients: [], channels: [], inbox: [], actions: [], jobs: [], jobActions: [], autonomy: [], digestTimes: { morning: '08:00', evening: '18:00' }, killSwitch: false, officePaused: false, autoSend: false, heartbeatAt: null, demo: false };
  if (!db) return { data: empty, error: 'Supabase is not configured.' };
  try {
    const [clients, channels, inbox, actions, settings] = await Promise.all([
      db.from('operator_clients').select('slug,name,profile,paused,enabled,viewer_url,brain_project').order('name'),
      db.from('operator_channels').select('id,client_slug,kind,name,url,enabled,last_polled_at,last_error').order('created_at'),
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
    const [jobs, autonomy] = await Promise.all([
      db.from('operator_jobs').select('id,client_slug,source,title,brief,status,runs,max_runs,cost_usd,error,feedback,created_at,updated_at,result,qa')
        .or(`status.in.(queued,running,waiting,verifying),updated_at.gt.${weekAgo}`).order('updated_at', { ascending: false }).limit(60),
      db.from('operator_autonomy').select('client_slug,action_type,mode'),
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

/** Demo: one client, two chats, a morning of activity (times relative to now so it always looks alive). */
export function demoOperator(now = Date.now()): OperatorHomeData {
  const t = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const ch1 = 'demo-ch-1', ch2 = 'demo-ch-2';
  const inbox: OperatorInboxRow[] = [
    { id: 'demo-i3', client_slug: 'lvlup', channel_id: ch1, sender_name: 'Alex', body: 'Can you add Sam to the team page today? Photo is in the drive.', sent_at: t(3), created_at: t(3),
      status: 'drafted', category: 'task', mode: 'approve', draft: 'On it, @Alex. I\'ll add Sam to /fund/team and send you the preview link here before publishing.', final_text: null,
      approval_id: null, error: null, mentions_me: true, from_me: false, space_name: 'Alex, Riley' },
    { id: 'demo-i2', client_slug: 'lvlup', channel_id: ch2, sender_name: 'Sam Lee', body: 'Thanks Julev, the sign-up form works great!', sent_at: t(26), created_at: t(26),
      status: 'sent', category: 'reply', mode: 'auto', draft: 'Glad it works, Sam! Shout if anything looks off.', final_text: 'Glad it works, Sam! Shout if anything looks off.',
      approval_id: null, error: null, mentions_me: false, from_me: false, space_name: 'Sam, Riley' },
    { id: 'demo-i1', client_slug: 'lvlup', channel_id: ch1, sender_name: 'Riley', body: 'FYI the launch event moved to Friday.', sent_at: t(48), created_at: t(48),
      status: 'fyi', category: 'fyi', mode: null, draft: null, final_text: null, approval_id: null, error: null, mentions_me: false, from_me: false, space_name: 'Alex, Riley' },
  ];
  let id = 1000;
  const a = (minAgo: number, action: string, detail: Record<string, unknown> = {}, actor: OperatorActionRow['actor'] = 'operator', inbox_id: string | null = null): OperatorActionRow =>
    ({ id: id--, created_at: t(minAgo), client_slug: 'lvlup', inbox_id, actor, action, ok: !/failed|blocked/.test(action), detail });
  return {
    clients: [{ slug: 'lvlup', name: 'LvlUp Ventures', profile: 'lvlup', paused: false, enabled: true, viewer_url: null, brain_project: 'lvlup-ventures' }],
    channels: [
      { id: ch1, client_slug: 'lvlup', name: 'Alex, Riley', url: 'https://chat.google.com/room/demo1', enabled: true, last_polled_at: t(1), last_error: null },
      { id: ch2, client_slug: 'lvlup', name: 'Sam, Riley', url: 'https://chat.google.com/room/demo2', enabled: true, last_polled_at: t(1), last_error: null },
    ],
    inbox,
    actions: [
      a(3, 'approval.requested', {}, 'operator', 'demo-i3'),
      a(3, 'message.classified', { category: 'task', confidence: 0.82 }, 'operator', 'demo-i3'),
      a(3, 'message.new', { channel: 'Alex, Riley', sender: 'Alex' }, 'operator', 'demo-i3'),
      a(25, 'send.done', { mode: 'auto' }, 'operator', 'demo-i2'),
      a(25, 'browser.typed', { chars: 49, mentions_linked: 0 }, 'operator', 'demo-i2'),
      a(25, 'browser.compose', { quoted: true }, 'operator', 'demo-i2'),
      a(25, 'browser.open', { channel: 'Sam, Riley' }, 'operator', 'demo-i2'),
      a(26, 'message.classified', { category: 'reply', confidence: 0.93 }, 'operator', 'demo-i2'),
      a(26, 'message.new', { channel: 'Sam, Riley', sender: 'Sam Lee' }, 'operator', 'demo-i2'),
      a(48, 'message.classified', { category: 'fyi', confidence: 0.9 }, 'operator', 'demo-i1'),
    ],
    jobs: [
      { id: 'demo-j2', client_slug: 'lvlup', source: 'chat', title: 'Add Sam to the team page', brief: 'From Alex in Alex, Riley:\nCan you add Sam to the team page today? Photo is in the drive.',
        status: 'waiting', runs: 1, max_runs: 4, cost_usd: 0.41, error: null, feedback: null, created_at: t(2), updated_at: t(1), result: null, qa: null },
      { id: 'demo-j1', client_slug: 'lvlup', source: 'ceo', title: 'Check the fund page on mobile', brief: 'Check the fund page on mobile and fix anything broken',
        status: 'done', runs: 2, max_runs: 4, cost_usd: 1.12, error: null, feedback: null, created_at: t(190), updated_at: t(140),
        result: { summary: 'Fixed the overflowing stats row at 375 px; the page passes QA on mobile and desktop.', links: ['https://www.lvlup.vc/fund'] },
        qa: { pass: true, errors: [], evidence: [1, 2] } },
      { id: 'demo-j0', client_slug: 'lvlup', source: 'chat', title: 'Update the portfolio logos', brief: 'From Riley: new logos for Kinetic and Ardent',
        status: 'escalated', runs: 1, max_runs: 4, cost_usd: 0.3, error: 'Two logos (Kinetic, Ardent) are not in the drive.', feedback: null, created_at: t(400), updated_at: t(380),
        result: { summary: 'Blocked: logos missing', needs_from_julev: 'Send the Kinetic and Ardent logos (SVG or 800 px PNG).' }, qa: null },
    ],
    jobActions: [
      { id: 'demo-x1', job_id: 'demo-j2', kind: 'webflow_cms', summary: 'Create the "Sam Lee" item in the Team collection (draft)', status: 'pending', error: null, approval_id: null, created_at: t(1) },
      { id: 'demo-x0', job_id: 'demo-j1', kind: 'webflow_publish', summary: 'Publish www.lvlup.vc', status: 'done', error: null, approval_id: null, created_at: t(150) },
    ],
    autonomy: [
      ...(['ack', 'status', 'thanks'] as const).map((type) => ({ client_slug: '*', action_type: type, mode: 'auto' as const })),
      ...(['factual', 'reply', 'task', 'publish', 'deadline', 'commitment', 'money', 'new_contact', 'delete'] as const).map((type) => ({ client_slug: '*', action_type: type, mode: 'approve' as const })),
      { client_slug: '*', action_type: 'credentials', mode: 'never' },
      { client_slug: 'lvlup', action_type: 'money', mode: 'never' },
    ],
    digestTimes: { morning: '08:00', evening: '18:00' },
    killSwitch: false, officePaused: false, autoSend: true, heartbeatAt: t(0.5), demo: true,
  };
}
