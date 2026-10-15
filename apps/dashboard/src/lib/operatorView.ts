// /operator view helpers (docs/17-OPERATOR.md "Operator page"). Pure, shared by the server loader and the client page.

export type Tone = 'brand' | 'info' | 'success' | 'warning' | 'danger' | 'muted';

export interface OperatorClientRow {
  slug: string; name: string; profile: string; paused: boolean; enabled: boolean; viewer_url: string | null; brain_project: string | null;
}
export interface OperatorChannelRow {
  id: string; client_slug: string; name: string; url: string; enabled: boolean; last_polled_at: string | null; last_error: string | null;
}
export type InboxStatus = 'new' | 'classifying' | 'fyi' | 'drafted' | 'approved' | 'sending' | 'sent' | 'skipped' | 'failed' | 'blocked';
export interface OperatorInboxRow {
  id: string; client_slug: string; channel_id: string; sender_name: string; body: string; sent_at: string | null; created_at: string;
  status: InboxStatus; category: string | null; mode: string | null; draft: string | null; final_text: string | null; approval_id: string | null;
  error: string | null; mentions_me: boolean; from_me: boolean; space_name: string | null;
}
export interface OperatorActionRow {
  id: number; created_at: string; client_slug: string | null; inbox_id: string | null; actor: 'operator' | 'ceo' | 'system';
  action: string; ok: boolean; detail: Record<string, unknown> | null;
}
export type JobStatus = 'queued' | 'running' | 'waiting' | 'verifying' | 'done' | 'escalated' | 'failed' | 'cancelled';
export interface OperatorJobRow {
  id: string; client_slug: string; source: 'chat' | 'ceo'; title: string; brief: string; status: JobStatus; runs: number; max_runs: number;
  cost_usd: number | string; error: string | null; feedback: string | null; created_at: string; updated_at: string;
  result: { summary?: string; links?: string[]; needs_from_julev?: string | null } | null;
  qa: { pass?: boolean; errors?: string[]; evidence?: number[] } | null;
}
export interface OperatorJobActionRow {
  id: string; job_id: string; kind: string; summary: string; status: string; error: string | null; approval_id: string | null; created_at: string;
}
export type AutonomyMode = 'auto' | 'approve' | 'never';
export interface OperatorAutonomyRow { client_slug: string; action_type: string; mode: AutonomyMode }

export interface OperatorHomeData {
  clients: OperatorClientRow[];
  channels: OperatorChannelRow[];
  inbox: OperatorInboxRow[];
  actions: OperatorActionRow[];
  /** Phase 2+: open jobs and the last week's finished ones, newest first (empty before the migration). */
  jobs: OperatorJobRow[];
  jobActions: OperatorJobActionRow[];
  autonomy: OperatorAutonomyRow[];
  /** Telegram digest times 'HH:MM' (null = off); settings.operator_digest_times. */
  digestTimes: { morning: string | null; evening: string | null };
  killSwitch: boolean;
  officePaused: boolean;
  autoSend: boolean;
  heartbeatAt: string | null;
  demo: boolean;
}

// ---------- jobs ----------

export const JOB_STATUS: Record<JobStatus, { label: string; tone: Tone; open: boolean }> = {
  queued: { label: 'Queued', tone: 'info', open: true },
  running: { label: 'Working', tone: 'brand', open: true },
  waiting: { label: 'Needs your OK', tone: 'warning', open: true },
  verifying: { label: 'Checking (QA)', tone: 'brand', open: true },
  done: { label: 'Done', tone: 'success', open: false },
  escalated: { label: 'Needs you', tone: 'danger', open: false },
  failed: { label: 'Failed', tone: 'danger', open: false },
  cancelled: { label: 'Cancelled', tone: 'muted', open: false },
};

/** Open jobs first (oldest waiting first), then finished ones newest first. */
export function sortJobs(jobs: OperatorJobRow[]): OperatorJobRow[] {
  const open = (j: OperatorJobRow) => JOB_STATUS[j.status]?.open ?? false;
  return [...jobs].sort((a, b) => (open(a) === open(b)
    ? (open(a) ? a.created_at.localeCompare(b.created_at) : b.updated_at.localeCompare(a.updated_at))
    : open(a) ? -1 : 1));
}

export function usd(v: number | string | null | undefined): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? `$${n.toFixed(2)}` : '$0';
}

export const ACTION_KIND_LABEL: Record<string, string> = {
  webflow_cms: 'Webflow CMS change', webflow_publish: 'Publish (Webflow)', airtable_write: 'Airtable change', browser_click: 'Click in the browser', delete: 'Delete',
};

/** settings.operator_digest_times → 'HH:MM' or null (off); missing = the defaults. */
export function digestTimes(v: unknown): { morning: string | null; evening: string | null } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const t = (x: unknown, d: string) => (x === undefined ? d : typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x) ? x : null);
  return { morning: t(o.morning, '08:00'), evening: t(o.evening, '18:00') };
}

/** A task as typed in "Add task": trimmed, 3 to 8000 characters. */
export function taskBrief(v: string): string | null {
  const t = v.trim();
  return t.length >= 3 ? t.slice(0, 8000) : null;
}

// ---------- autonomy ----------

/** The action types a reply can have, in the order the CEO reads them (low risk first), with plain labels. */
export const ACTION_TYPES: { type: string; label: string; hint: string; autoAllowed: boolean }[] = [
  { type: 'ack', label: 'Acknowledgements', hint: '"Got it, on it."', autoAllowed: true },
  { type: 'thanks', label: 'Thank-yous', hint: '"Thanks Alex!"', autoAllowed: true },
  { type: 'status', label: 'Status updates', hint: '"Done, here is the link."', autoAllowed: true },
  { type: 'factual', label: 'Facts from memory', hint: 'Meeting times, where a file is', autoAllowed: true },
  { type: 'reply', label: 'Other replies', hint: 'Anything conversational', autoAllowed: true },
  { type: 'task', label: 'New tasks', hint: 'Ack + start the job (its changes still ask)', autoAllowed: true },
  { type: 'deadline', label: 'Deadlines', hint: 'Dates and "by Friday"', autoAllowed: false },
  { type: 'commitment', label: 'Commitments', hint: 'Promising new work', autoAllowed: false },
  { type: 'publish', label: 'Publishing', hint: 'Going live', autoAllowed: false },
  { type: 'money', label: 'Money', hint: 'Prices, invoices, numbers', autoAllowed: false },
  { type: 'new_contact', label: 'New people', hint: 'Someone not in the memory', autoAllowed: false },
  { type: 'delete', label: 'Deleting', hint: 'Removing anything', autoAllowed: false },
  { type: 'credentials', label: 'Logins and keys', hint: 'Always blocked', autoAllowed: false },
];

export const MODE_LABEL: Record<AutonomyMode, string> = { auto: 'Posts by itself', approve: 'Asks you', never: 'Never' };

/** Effective rule per action type for one client ('*' = the defaults): its own row, else the default, else approve. */
export function autonomyFor(rows: OperatorAutonomyRow[], client: string): { type: string; mode: AutonomyMode; own: boolean }[] {
  const key = (c: string, t: string) => `${c}\u0000${t}`;
  const m = new Map(rows.map((r) => [key(r.client_slug, r.action_type), r.mode]));
  return ACTION_TYPES.map(({ type }) => {
    const own = client !== '*' ? m.get(key(client, type)) : undefined;
    return { type, mode: own ?? m.get(key('*', type)) ?? 'approve', own: own !== undefined || client === '*' };
  });
}

/** Modes the CEO may pick for a type (mirrors operator_set_autonomy). */
export function allowedModes(type: string): AutonomyMode[] {
  if (type === 'credentials') return ['never'];
  return ACTION_TYPES.find((a) => a.type === type)?.autoAllowed ? ['auto', 'approve', 'never'] : ['approve', 'never'];
}

export const INBOX_STATUS: Record<InboxStatus, { label: string; tone: Tone }> = {
  new: { label: 'New', tone: 'info' },
  classifying: { label: 'Reading', tone: 'brand' },
  fyi: { label: 'FYI', tone: 'muted' },
  drafted: { label: 'Waiting for you', tone: 'warning' },
  approved: { label: 'Approved', tone: 'brand' },
  sending: { label: 'Posting', tone: 'brand' },
  sent: { label: 'Sent', tone: 'success' },
  skipped: { label: 'Skipped', tone: 'muted' },
  failed: { label: 'Failed', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'danger' },
};

export const TONE_CLASS: Record<Tone, string> = {
  brand: 'bg-[color-mix(in_oklab,var(--color-primary)_18%,transparent)] text-[#c4b5ff]',
  info: 'bg-[color-mix(in_oklab,var(--color-info)_16%,transparent)] text-[#8fd0ff]',
  success: 'bg-[color-mix(in_oklab,var(--color-success)_18%,transparent)] text-[#6ee7b7]',
  warning: 'bg-[color-mix(in_oklab,var(--color-warning)_18%,transparent)] text-[#fcd34d]',
  danger: 'bg-[color-mix(in_oklab,var(--color-danger)_18%,transparent)] text-[#ff9a9d]',
  muted: 'bg-[var(--color-panel-2)] text-[var(--color-muted)]',
};

/** The operator process writes a heartbeat every minute; older than 3 minutes = offline. */
export function isOnline(heartbeatAt: string | null, now = Date.now()): boolean {
  return !!heartbeatAt && now - new Date(heartbeatAt).getTime() < 3 * 60_000;
}

export type SendState = { label: string; tone: Tone; detail: string };
export function sendState(d: Pick<OperatorHomeData, 'killSwitch' | 'officePaused' | 'autoSend'>): SendState {
  if (d.killSwitch) return { label: 'Sends stopped', tone: 'danger', detail: 'Kill switch is on: nothing is posted in any client chat.' };
  if (d.officePaused) return { label: 'Office paused', tone: 'warning', detail: 'The office is paused, so the operator does not post either.' };
  return d.autoSend
    ? { label: 'Live · auto-send on', tone: 'success', detail: 'Acknowledgements, status updates and thank-yous post by themselves; everything else waits for you.' }
    : { label: 'Live · every reply asks', tone: 'success', detail: 'Every reply waits for your OK on Telegram or in Approvals.' };
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One line of the live feed: what happened, in plain words, with a tone. */
export function describeAction(a: OperatorActionRow): { text: string; tone: Tone; kind: 'read' | 'think' | 'type' | 'send' | 'you' | 'warn' } {
  const d = a.detail ?? {};
  switch (a.action) {
    case 'message.new':
      return d.baseline ? { text: `Read earlier history${d.channel ? ` in ${str(d.channel)}` : ''}`, tone: 'muted', kind: 'read' }
        : { text: `New message from ${str(d.sender) || 'someone'}${d.channel ? ` in ${str(d.channel)}` : ''}${d.from_me ? ' (you)' : ''}`, tone: 'info', kind: 'read' };
    case 'message.classified': {
      const cat = str(d.category);
      const conf = typeof d.confidence === 'number' || typeof d.confidence === 'string' ? ` · ${Math.round(Number(d.confidence) * 100)}%` : '';
      return { text: cat === 'fyi' ? `Nothing to answer (FYI)${conf}` : `Drafted a ${cat === 'task' ? 'task reply' : 'reply'}${conf}`, tone: 'brand', kind: 'think' };
    }
    case 'message.classify_failed': return { text: `Couldn't draft: ${clip(str(d.error), 120)}`, tone: 'danger', kind: 'warn' };
    case 'classify.waiting': return { text: `Waiting: ${str(d.reason)}`, tone: 'warning', kind: 'warn' };
    case 'approval.requested': return { text: 'Asked you to approve the reply', tone: 'warning', kind: 'think' };
    case 'send.auto_approved': return { text: 'Reply cleared to auto-send', tone: 'brand', kind: 'think' };
    case 'browser.open': return { text: `Opened ${str(d.channel) || 'the chat'} in the browser`, tone: 'info', kind: 'type' };
    case 'browser.compose': return { text: `Focused the composer${d.quoted ? ', quoting the message' : ''}${d.in_thread ? ' in the thread' : ''}`, tone: 'info', kind: 'type' };
    case 'browser.typed': return { text: `Typed ${Number(d.chars) || 0} characters${Number(d.mentions_linked) ? ` with ${Number(d.mentions_linked)} @mention(s)` : ''}`, tone: 'info', kind: 'type' };
    case 'send.done': return { text: 'Posted the reply', tone: 'success', kind: 'send' };
    case 'send.retry': return { text: `Will retry: ${clip(str(d.error), 100)}`, tone: 'warning', kind: 'warn' };
    case 'send.failed': return { text: `Not posted: ${clip(str(d.error), 120)}`, tone: 'danger', kind: 'warn' };
    case 'send.blocked': return { text: 'Blocked by a "never" rule; nothing sent', tone: 'danger', kind: 'warn' };
    case 'watch.failed': return { text: `Can't read ${str(d.channel) || 'a chat'}: ${clip(str(d.error), 100)}`, tone: 'danger', kind: 'warn' };
    case 'watch.recovered': return { text: `Reading ${str(d.channel) || 'the chat'} again`, tone: 'success', kind: 'read' };
    case 'reply.approved': return { text: 'You approved the draft', tone: 'success', kind: 'you' };
    case 'reply.edited': return { text: 'You edited the reply', tone: 'success', kind: 'you' };
    case 'reply.skipped': return { text: 'You skipped the reply', tone: 'muted', kind: 'you' };
    case 'operator.paused': return { text: 'Kill switch on: all sends stopped', tone: 'danger', kind: 'you' };
    case 'operator.resumed': return { text: 'Sends resumed', tone: 'success', kind: 'you' };
    case 'client.paused': return { text: 'You took over: this client\'s sends paused', tone: 'warning', kind: 'you' };
    case 'client.resumed': return { text: 'Handed back to the operator', tone: 'success', kind: 'you' };
    case 'channel.added': return { text: `Watching ${str(d.channel)}`, tone: 'info', kind: 'you' };
    case 'channel.enabled': return { text: `Watching ${str(d.channel)} again`, tone: 'info', kind: 'you' };
    case 'channel.disabled': return { text: `Stopped watching ${str(d.channel)}`, tone: 'muted', kind: 'you' };
    case 'autonomy.changed': return { text: `Rule changed: ${str(d.action_type)} → ${str(d.now)}${d.client === '*' ? ' (all clients)' : ''}`, tone: 'info', kind: 'you' };
    case 'autosend.on': return { text: 'Auto-send turned on', tone: 'warning', kind: 'you' };
    case 'autosend.off': return { text: 'Auto-send turned off: every reply asks', tone: 'info', kind: 'you' };
    case 'job.queued': return { text: `New job: ${clip(str(d.title), 90)}`, tone: 'info', kind: d.source === 'ceo' ? 'you' : 'think' };
    case 'job.started': return { text: `Started: ${clip(str(d.title), 90)}`, tone: 'brand', kind: 'think' };
    case 'job.done': return { text: `Done: ${clip(str(d.title), 90)}`, tone: 'success', kind: 'send' };
    case 'job.escalated': return { text: `Needs you: ${clip(str(d.reason) || str(d.error), 100)}`, tone: 'danger', kind: 'warn' };
    case 'job.failed': return { text: `Job failed: ${clip(str(d.error), 100)}`, tone: 'danger', kind: 'warn' };
    case 'job.cancelled': return { text: 'You cancelled a job', tone: 'muted', kind: 'you' };
    case 'action.requested': return { text: `Asked you: ${clip(str(d.summary), 100)}`, tone: 'warning', kind: 'think' };
    case 'action.done': return { text: `Did: ${clip(str(d.summary), 100)}`, tone: 'success', kind: 'send' };
    case 'update.done': return { text: 'Told the client it\'s done', tone: 'success', kind: 'send' };
    case 'qa.run': return { text: 'Checking the result (375 / 1366 px, console, links)', tone: 'brand', kind: 'think' };
    default: return { text: a.action.replace(/[._]/g, ' '), tone: a.ok ? 'muted' : 'danger', kind: a.ok ? 'read' : 'warn' };
  }
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** Inbox rows worth showing: everything except baseline history and your own messages, newest first. */
export function visibleInbox(rows: OperatorInboxRow[]): OperatorInboxRow[] {
  return rows.filter((r) => !r.from_me && !(r.status === 'fyi' && !r.category)).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** A Google Chat address as the CEO pasted it; null when it is not one the operator can watch. */
export function chatUrl(v: string): string | null {
  const u = v.trim();
  return /^https:\/\/(chat\.google\.com\/|mail\.google\.com\/chat\/)\S+$/.test(u) ? u : null;
}
