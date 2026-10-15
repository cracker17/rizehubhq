// The /operator demo (docs/17-OPERATOR.md "Demo"): a scripted LvlUp morning that plays on the real Operator page with
// fake data, plus the Telegram messages Julev would get. Pure and tested; the player (OperatorDemoPlayer) only adds
// timing and taps. Nothing here touches the database or any client tool.
import type { OperatorActionRow, OperatorHomeData, OperatorInboxRow, OperatorJobActionRow, OperatorJobRow } from './operatorView';

export interface TgButton { label: string; tap?: string }
export interface TgMessage { id: number; at: string; lines: string[]; buttons?: TgButton[]; decided?: string; photos?: string[] }
/** What the client's browser shows in the demo's live screen. */
export interface DemoScreen {
  app: 'idle' | 'chat' | 'github' | 'vercel' | 'site';
  url: string;
  /** chat: the text being typed in the composer (typed out by the player); sent = it is in the thread. */
  typing?: string; sent?: string[];
  /** the element the cursor goes to (a data-demo-target in the screen). */
  target?: string;
  /** github: merged yet; vercel: state; site: QA widths done. */
  merged?: boolean; deploy?: 'building' | 'ready'; qa?: number[];
}
export interface DemoState { data: OperatorHomeData; telegram: TgMessage[]; caption: string; nextId: number; done: boolean; screen: DemoScreen }

/** One beat of the story: what changes, how long to wait after it, or which tap it waits for. */
export interface DemoEvent { caption?: string; ms?: number; waitFor?: string; apply: (s: DemoState, now: number) => void }

const CH = 'demo-ch-1';
const JOB = 'demo-job-careers';
const iso = (now: number) => new Date(now).toISOString();

function act(s: DemoState, now: number, action: string, detail: Record<string, unknown> = {}, actor: OperatorActionRow['actor'] = 'operator', inbox: string | null = null) {
  s.data.actions = [{ id: s.nextId++, created_at: iso(now), client_slug: 'lvlup', inbox_id: inbox, actor, action, ok: !/failed|blocked/.test(action), detail }, ...s.data.actions];
}
function tg(s: DemoState, now: number, lines: string[], buttons?: TgButton[], photos?: string[]) {
  s.telegram = [...s.telegram, { id: s.nextId++, at: iso(now), lines, buttons, photos }];
}
function decide(s: DemoState, tap: string, line: string) {
  s.telegram = s.telegram.map((m) => (m.buttons?.some((b) => b.tap === tap) ? { ...m, buttons: undefined, decided: line } : m));
}
const job = (s: DemoState) => s.data.jobs.find((j) => j.id === JOB);
function setJob(s: DemoState, p: Partial<OperatorJobRow>, now: number) {
  s.data.jobs = s.data.jobs.map((j) => (j.id === JOB ? { ...j, ...p, updated_at: iso(now) } : j));
}
function setInbox(s: DemoState, id: string, p: Partial<OperatorInboxRow>) {
  s.data.inbox = s.data.inbox.map((r) => (r.id === id ? { ...r, ...p } : r));
}

const MSG = 'demo-i-careers';
const REQUEST = 'The careers link in the site footer goes to a 404. Can you fix it today? We have a candidate looking.';
const DRAFT = 'On it, @Alex. Fixing the footer link now; I’ll send you the live link once it’s checked.';
const UPDATE = 'Fixed, @Alex! The Careers link in the footer works again: https://www.lvlup.vc/careers (checked on mobile and desktop).';
const MEMORY = 'Footer links live in lvlup/site (components/Footer.tsx); merging to main deploys production on Vercel.';

/** The conversation in the demo chat (read by the demo screen). */
export const DEMO_CHAT = { request: REQUEST, earlier: [['Riley', 'FYI the launch event moved to Friday.'], ['Julev', 'Thanks Riley, noted!']] as [string, string][] };

export const DEMO_SCRIPT: DemoEvent[] = [
  { caption: 'Alex writes in the LvlUp Google Chat. The operator reads every watched chat (and the unread sweep finds new ones).', ms: 2600,
    apply: (s, now) => {
      s.data.inbox = [{ id: MSG, client_slug: 'lvlup', channel_id: CH, sender_name: 'Alex', body: REQUEST, sent_at: iso(now), created_at: iso(now), status: 'new', category: null, mode: null,
        draft: null, final_text: null, approval_id: null, error: null, mentions_me: true, from_me: false, space_name: 'Alex, Riley' }, ...s.data.inbox];
      act(s, now, 'message.new', { channel: 'Alex, Riley', sender: 'Alex' }, 'operator', MSG);
      s.screen = { app: 'chat', url: 'https://chat.google.com/room/AAAAlvlup', target: 'last-message' };
    } },
  { caption: 'It reads the project memory, decides this is a task meant for you, and drafts a reply. It never posts this kind by itself.', ms: 2400,
    apply: (s, now) => {
      setInbox(s, MSG, { status: 'drafted', category: 'task', mode: 'approve', draft: DRAFT });
      act(s, now, 'message.classified', { category: 'task', confidence: 0.88 }, 'operator', MSG);
      act(s, now, 'approval.requested', {}, 'operator', MSG);
      tg(s, now, ['💬 REPLY · LvlUp Ventures · Alex, Riley', `Alex: ${REQUEST}`, '', 'Draft (new task):', `❝ ${DRAFT} ❞`, 'ack, task · confidence 88%',
        'Plan: 1. Find the footer in lvlup/site 2. Check the open PRs 3. Ship the fix after approval 4. QA on mobile + desktop'],
      [{ label: '✅ Send + start', tap: 'reply' }, { label: '✏️ Edit' }, { label: '⏭ Skip' }]);
    } },
  { caption: 'Your turn: tap “✅ Send + start” on Telegram (right). One tap posts the reply AND starts the job.', waitFor: 'reply',
    apply: () => undefined },
  { caption: 'It types the reply into Google Chat, checks the text matches exactly, then sends.', ms: 2200,
    apply: (s, now) => {
      decide(s, 'reply', '✅ Approved: posting the draft + starting the task');
      act(s, now, 'reply.approved', {}, 'ceo', MSG);
      act(s, now, 'browser.open', { channel: 'Alex, Riley' }, 'operator', MSG);
      act(s, now, 'browser.compose', { quoted: true }, 'operator', MSG);
      act(s, now, 'browser.typed', { chars: DRAFT.length, mentions_linked: 1 }, 'operator', MSG);
      s.screen = { app: 'chat', url: 'https://chat.google.com/room/AAAAlvlup', typing: DRAFT, target: 'composer' };
    } },
  { caption: 'Posted. You get a short notice, and the task becomes a job.', ms: 2400,
    apply: (s, now) => {
      setInbox(s, MSG, { status: 'sent', final_text: DRAFT });
      act(s, now, 'send.done', { mode: 'approve' }, 'operator', MSG);
      s.screen = { app: 'chat', url: 'https://chat.google.com/room/AAAAlvlup', sent: [DRAFT], target: 'sent' };
      tg(s, now, ['✅ Reply posted to Alex · lvlup', `❝ ${DRAFT} ❞`]);
      s.data.jobs = [{ id: JOB, client_slug: 'lvlup', source: 'chat', title: 'Fix the broken Careers link in the footer', brief: `From Alex in Alex, Riley:\n${REQUEST}`,
        status: 'queued', runs: 0, max_runs: 4, cost_usd: 0, error: null, feedback: null, created_at: iso(now), updated_at: iso(now), result: null, qa: null }, ...s.data.jobs];
      act(s, now, 'job.queued', { title: 'Fix the broken Careers link in the footer', source: 'chat' });
    } },
  { caption: 'The job starts. It works with LvlUp’s own logins and API tokens (GitHub, Vercel, Webflow, Airtable).', ms: 2300,
    apply: (s, now) => {
      setJob(s, { status: 'running', runs: 1, cost_usd: 0.08 }, now);
      act(s, now, 'job.started', { title: 'Fix the broken Careers link in the footer' });
      tg(s, now, ['🛠 Started · lvlup', 'Fix the broken Careers link in the footer']);
    } },
  { caption: 'GitHub: it finds an open pull request that already fixes the link, and CI passed.', ms: 2600,
    apply: (s, now) => {
      act(s, now, 'job.progress', { step: 'GitHub lvlup/site: PR #42 “Fix careers link in footer” by Riley, CI passed' });
      s.screen = { app: 'github', url: 'https://github.com/lvlup/site/pull/42', target: 'checks' };
      setJob(s, { cost_usd: 0.21 }, now);
    } },
  { caption: 'Vercel: the PR’s preview deployment is ready, so it QA-checks the preview before anything goes live.', ms: 2600,
    apply: (s, now) => {
      act(s, now, 'job.progress', { step: 'Vercel: preview lvlup-site-git-fix-footer.vercel.app is Ready' });
      act(s, now, 'qa.run', { urls: ['https://lvlup-site-git-fix-footer.vercel.app/careers'] });
      s.screen = { app: 'site', url: 'https://lvlup-site-git-fix-footer.vercel.app/careers', qa: [375, 1366], target: 'footer' };
      setJob(s, { cost_usd: 0.37 }, now);
    } },
  { caption: 'Merging changes the live site, so it asks first. Every outside change is one tap for you.', ms: 1500,
    apply: (s, now) => {
      setJob(s, { status: 'waiting' }, now);
      const a: OperatorJobActionRow = { id: 'demo-x-merge', job_id: JOB, kind: 'github_merge', summary: 'Merge PR #42 “Fix careers link in footer” into main (squash); Vercel then deploys production',
        status: 'pending', error: null, approval_id: null, created_at: iso(now) };
      s.data.jobActions = [...s.data.jobActions, a];
      act(s, now, 'action.requested', { summary: a.summary, kind: 'github_merge' });
      s.screen = { app: 'github', url: 'https://github.com/lvlup/site/pull/42', target: 'merge' };
      tg(s, now, ['🚀 Merge pull request · LvlUp Ventures ⚠️', 'Job: Fix the broken Careers link in the footer', a.summary,
        '{ "repo": "lvlup/site", "number": 42, "method": "squash" }', 'Runs exactly as shown, only after ✅.'],
      [{ label: '✅ Do it', tap: 'merge' }, { label: '✏️ Not like this' }, { label: '❌ Don’t' }]);
    } },
  { caption: 'Your turn: tap “✅ Do it” to merge.', waitFor: 'merge', apply: () => undefined },
  { caption: 'Merged through the GitHub API. Vercel builds production from main.', ms: 2600,
    apply: (s, now) => {
      decide(s, 'merge', '✅ Approved: the operator does it now');
      s.data.jobActions = s.data.jobActions.map((x) => (x.id === 'demo-x-merge' ? { ...x, status: 'done' } : x));
      act(s, now, 'action.done', { summary: 'Merged PR #42 into main', kind: 'github_merge' });
      tg(s, now, ['☑️ Done: Merge pull request · lvlup', 'Merged PR #42 into main (squash)']);
      setJob(s, { status: 'running', runs: 2, cost_usd: 0.49 }, now);
      act(s, now, 'job.progress', { step: 'Vercel: production deployment for www.lvlup.vc is Ready' });
      s.screen = { app: 'vercel', url: 'https://vercel.com/lvlup/lvlup-site/deployments', deploy: 'ready', target: 'deploy', merged: true };
    } },
  { caption: 'It checks the live page like QA would: 375 and 1366 px, console errors, failed requests, broken links.', ms: 2600,
    apply: (s, now) => {
      setJob(s, { status: 'verifying' }, now);
      act(s, now, 'qa.run', { urls: ['https://www.lvlup.vc/careers'] });
      s.screen = { app: 'site', url: 'https://www.lvlup.vc/careers', qa: [375, 1366], target: 'footer' };
    } },
  { caption: 'Done. You get the summary, the link, the QA result and the screenshots.', ms: 2200,
    apply: (s, now) => {
      setJob(s, { status: 'done', cost_usd: 0.62, result: { summary: 'Merged Riley’s fix (PR #42); production redeployed by Vercel. /careers loads on mobile and desktop; no broken links in the footer.', links: ['https://www.lvlup.vc/careers'] },
        qa: { pass: true, errors: [], evidence: [1, 2] } }, now);
      act(s, now, 'job.done', { title: 'Fix the broken Careers link in the footer' });
      tg(s, now, ['✅ Done · lvlup · $0.62', 'Fix the broken Careers link in the footer',
        'Merged Riley’s fix (PR #42); production redeployed by Vercel. /careers loads on mobile and desktop.', 'Links: www.lvlup.vc/careers',
        'QA ✅ 375 / 1366 px · console · requests · links'], undefined, ['QA 375px', 'QA 1366px']);
    } },
  { caption: 'Telling the client follows your reply rules: here it asks you first.', ms: 1200,
    apply: (s, now) => {
      act(s, now, 'update.requested', {});
      tg(s, now, ['📣 CLIENT UPDATE · LvlUp Ventures · Alex, Riley', 'Job done: Fix the broken Careers link in the footer', `Alex asked: ${REQUEST}`, '', 'Update:', `❝ ${UPDATE} ❞`],
        [{ label: '✅ Send', tap: 'update' }, { label: '✏️ Edit' }, { label: '⏭ Skip' }]);
    } },
  { caption: 'Your turn: tap “✅ Send” to tell Alex.', waitFor: 'update', apply: () => undefined },
  { caption: 'Posted in the same thread, quoting Alex’s message.', ms: 2400,
    apply: (s, now) => {
      decide(s, 'update', '✅ Approved: sending the update');
      act(s, now, 'browser.typed', { chars: UPDATE.length, mentions_linked: 1 });
      s.screen = { app: 'chat', url: 'https://chat.google.com/room/AAAAlvlup', sent: [DRAFT], typing: UPDATE, target: 'composer' };
      act(s, now, 'update.done', {});
      s.screen = { app: 'chat', url: 'https://chat.google.com/room/AAAAlvlup', sent: [DRAFT, UPDATE], target: 'sent' };
      tg(s, now, ['📣 Client informed · lvlup · Alex, Riley', 'Job: Fix the broken Careers link in the footer', `❝ ${UPDATE} ❞`]);
    } },
  { caption: 'Last: what it learned goes to LvlUp’s project memory, so next time it already knows.', ms: 1200,
    apply: (s, now) => {
      tg(s, now, ['🧠 MEMORY · decision · LvlUp Ventures', `❝ ${MEMORY} ❞`], [{ label: '✅ Save', tap: 'memory' }, { label: '✏️ Not like this' }, { label: '❌ Drop' }]);
    } },
  { caption: 'Your turn: tap “✅ Save”.', waitFor: 'memory', apply: () => undefined },
  { caption: 'That’s the whole loop: you tapped 4 times, the operator did the rest. Tonight’s digest sums up the day.', ms: 1800,
    apply: (s, now) => {
      decide(s, 'memory', '✅ Saved to memory');
      tg(s, now, ['🌙 Operator · evening · ▶️ Live · every reply asks · $0.62', '', 'LvlUp Ventures: 4 messages · 2 replies sent · 1 client update',
        '✅ Fix the broken Careers link in the footer · link', '🙋 Update the portfolio logos: send the Kinetic and Ardent logos']);
      s.done = true;
    } },
];

export function initialDemo(base: OperatorHomeData): DemoState {
  return { data: { ...base, jobs: base.jobs.filter((j) => j.status !== 'waiting'), jobActions: [], actions: base.actions.slice(-4), inbox: base.inbox.filter((r) => r.status !== 'drafted') },
    telegram: [], caption: 'Press Play to watch the operator handle a request from Alex, start to finish.', nextId: 900_000, done: false,
    screen: { app: 'idle', url: 'about:blank' } };
}

/** Applies one event to a copy of the state (the player keeps the copies; tests run the whole script). */
export function step(s: DemoState, ev: DemoEvent, now = Date.now()): DemoState {
  const n: DemoState = { ...s, data: { ...s.data }, telegram: [...s.telegram], screen: { ...s.screen } };
  ev.apply(n, now);
  if (ev.caption) n.caption = ev.caption;
  return n;
}

/** How many taps the demo asks for (and which). */
export const DEMO_TAPS = DEMO_SCRIPT.filter((e) => e.waitFor).map((e) => e.waitFor!);
