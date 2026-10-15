// /operator demo data (no server-only: the demo player and the tests use it too).
import type {
  OperatorAccountRow, OperatorActionRow, OperatorChannelRow, OperatorHomeData, OperatorInboxRow, OperatorPostingRow,
} from '@/lib/operatorView';

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
    clients: [{ slug: 'lvlup', name: 'LvlUp Ventures', profile: 'lvlup', paused: false, enabled: true, viewer_url: null, brain_project: 'lvlup-ventures', reply_when: 'addressed' }],
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
    accounts: [
      { id: 'demo-a1', client_slug: 'lvlup', kind: 'slack', label: 'LvlUp Slack', home_url: 'https://app.slack.com/client/T0LVLUP', enabled: true, last_swept_at: t(1), last_found: 2, last_error: null },
      { id: 'demo-a2', client_slug: 'lvlup', kind: 'gmail', label: 'LvlUp mail', home_url: 'https://mail.google.com/mail/u/0/#search/is%3Aunread+in%3Ainbox', enabled: true, last_swept_at: t(1), last_found: 1, last_error: null },
    ],
    posting: [{ client_slug: 'lvlup', kind: 'slack', test_url: 'https://app.slack.com/client/T0LVLUP/D0JULEV', test_state: 'passed', test_detail: 'posted and read back', tested_at: t(300), enabled: false }],
    digestTimes: { morning: '08:00', evening: '18:00' },
    killSwitch: false, officePaused: false, autoSend: true, heartbeatAt: t(0.5), demo: true,
  };
}

