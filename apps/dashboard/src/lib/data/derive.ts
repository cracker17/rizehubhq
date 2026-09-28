// Pure view-model helpers: DB rows → what the tiles, KPIs, lists and activity strip show.
import type { AgentStatus, IdleActivity, RequestStatus, TaskStatus } from '@rizehubhq/shared';
import type {
  ActionPayload, ActivityRow, AgentRow, AgentScreenRow, ApprovalRow, DeliverablePayload, HqSnapshot, PlanPayload, RequestRow, TaskRow,
} from './types';

export const IDLE_LABEL: Record<IdleActivity, string> = {
  coffee: 'Coffee break',
  lounge_sofa: 'Relaxing in the lounge',
  lobby: 'Hanging out in the lobby',
  ping_pong: 'Playing ping-pong',
  foosball: 'Playing foosball',
  chat: 'Chatting',
  gym: 'Working out in the gym',
};

const VERBS: [RegExp, string][] = [
  [/lead/, 'Researching'], [/job/, 'Screening'],
  [/review|qa|check|test/, 'Reviewing'], [/plan/, 'Planning'], [/report|digest|data/, 'Reporting'],
  [/copy|article|blog|meta|caption|seo|writ/, 'Writing'], [/wire|ux|design|figma/, 'Designing'],
  [/(^|-)ad(-|s?$)|creative|graphic|banner/, 'Rendering'], [/reel|video|edit/, 'Editing'], [/voice|audio|sound|mix/, 'Recording'],
  [/proposal|pricing/, 'Drafting'], [/calendar|schedul|social/, 'Scheduling'],
  [/api|integration|code|next|node/, 'Coding'], [/shopify|webflow|wordpress|section|cms|theme|build/, 'Building'],
  [/onboard|workspace/, 'Onboarding'],
];
export function verbFor(workType: string | undefined): string {
  if (!workType) return 'Working';
  const w = workType.toLowerCase();
  return VERBS.find(([re]) => re.test(w))?.[1] ?? 'Working';
}

/** What an agent tile shows (the M2 mock "Agent" shape, now derived from DB rows). */
export interface TileAgent {
  id: string;
  name: string;
  department: string;
  color: string;
  status: AgentStatus;
  verb?: string;
  task?: string;
  progress?: number;
  idle?: IdleActivity;
  row: AgentRow;
  screen?: AgentScreenRow;
  currentTask?: TaskRow;
}

export function toTileAgent(a: AgentRow, s: HqSnapshot, idx: Indexes): TileAgent {
  const screen = idx.screenByAgent.get(a.id);
  let current = a.current_task_id ? idx.taskById.get(a.current_task_id) : undefined;
  if (!current && a.status === 'working' && screen?.task_id) current = idx.taskById.get(screen.task_id);
  let task: string | undefined = current?.title;
  if (a.status === 'waiting') task = s.approvals.find((p) => p.status === 'pending' && p.agent_id === a.id)?.title ?? task;
  if (a.status === 'blocked') task = s.tasks.find((t) => t.agent_id === a.id && t.status === 'failed')?.title ?? task;
  if (a.status === 'working' && !task) task = screen?.title ?? undefined;
  const progress = a.status === 'working' || a.status === 'waiting'
    ? (screen && (!current || screen.task_id === current.id) ? screen.progress ?? undefined : undefined) ?? (a.status === 'waiting' ? 100 : undefined)
    : undefined;
  return {
    id: a.id, name: a.name, department: a.department, color: a.avatar?.color ?? '#6D4AFF', status: a.status,
    verb: a.status === 'working' ? verbFor(current?.work_type) : undefined, task, progress,
    idle: a.idle_activity ?? undefined, row: a, screen, currentTask: current,
  };
}

export interface Indexes {
  taskById: Map<string, TaskRow>;
  screenByAgent: Map<string, AgentScreenRow>;
  agentById: Map<string, AgentRow>;
  requestById: Map<string, RequestRow>;
  clientById: Map<string, { id: string; name: string; slug: string }>;
}
export function buildIndexes(s: HqSnapshot): Indexes {
  return {
    taskById: new Map(s.tasks.map((t) => [t.id, t])),
    screenByAgent: new Map(s.screens.map((x) => [x.agent_id, x])),
    agentById: new Map(s.agents.map((a) => [a.id, a])),
    requestById: new Map(s.requests.map((r) => [r.id, r])),
    clientById: new Map(s.clients.map((c) => [c.id, c])),
  };
}

// ---------- dates ----------
export function startOfToday(now = new Date()) { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; }
export function isToday(iso: string | null | undefined, now = new Date()) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= startOfToday(now).getTime() && t < startOfToday(now).getTime() + 86400_000;
}
export function timeHM(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
export function relDay(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  const diff = Math.round((startOfToday(d).getTime() - startOfToday(now).getTime()) / 86400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
export function money(v: number | string | null | undefined) {
  const n = Number(v ?? 0);
  return `$${n < 1 && n > 0 ? n.toFixed(2) : n.toFixed(n % 1 ? 2 : 0)}`;
}

// ---------- KPIs ----------
export interface Kpis {
  working: number; totalAgents: number; pendingApprovals: number; pendingByKind: [number, number, number];
  doneToday: number; doneSpark: number[]; activeSpark: number[]; qaPassRate: number | null; qaDaily: number[]; spendToday: number;
}
export function computeKpis(s: HqSnapshot, now = new Date()): Kpis {
  const enabled = s.agents.filter((a) => a.enabled);
  const pending = s.approvals.filter((a) => a.status === 'pending');
  const doneToday = s.tasks.filter((t) => t.status === 'done' && isToday(t.completed_at ?? t.updated_at, now));
  const hour = now.getHours();
  const buckets = Math.max(2, Math.min(8, hour + 1));
  const step = Math.max(1, Math.ceil((hour + 1) / buckets));
  const cumul = (times: string[]) => Array.from({ length: buckets }, (_, i) => {
    const edge = startOfToday(now).getTime() + Math.min(24, (i + 1) * step) * 3600_000;
    return times.filter((iso) => new Date(iso).getTime() < edge).length;
  });
  const since7 = startOfToday(now).getTime() - 6 * 86400_000;
  const qa7 = s.qaReviews.filter((r) => new Date(r.created_at).getTime() >= since7);
  const qaDaily = Array.from({ length: 7 }, (_, i) => {
    const from = since7 + i * 86400_000;
    const day = qa7.filter((r) => { const t = new Date(r.created_at).getTime(); return t >= from && t < from + 86400_000; });
    return day.length ? Math.round((day.filter((r) => r.verdict === 'pass').length / day.length) * 100) : 0;
  });
  const startedToday = s.tasks.map((t) => t.claimed_at ?? t.started_at).filter((x): x is string => isToday(x, now));
  return {
    working: enabled.filter((a) => a.status === 'working').length,
    totalAgents: enabled.length,
    pendingApprovals: pending.length,
    pendingByKind: [
      pending.filter((a) => a.kind === 'plan').length,
      pending.filter((a) => a.kind === 'deliverable').length,
      pending.filter((a) => a.kind === 'external_action').length,
    ],
    doneToday: doneToday.length,
    doneSpark: cumul(doneToday.map((t) => t.completed_at ?? t.updated_at)),
    activeSpark: cumul(startedToday),
    qaPassRate: qa7.length ? Math.round((qa7.filter((r) => r.verdict === 'pass').length / qa7.length) * 100) : null,
    qaDaily,
    spendToday: s.activity.filter((a) => isToday(a.created_at, now)).reduce((n, a) => n + Number(a.cost_usd || 0), 0),
  };
}

// ---------- activity ----------
export type Tone = 'info' | 'success' | 'warning' | 'primary' | 'danger';
export function describeActivity(a: ActivityRow, s: HqSnapshot, idx: Indexes): { text: string; tone: Tone } {
  const d = a.detail ?? {};
  const custom = typeof d.text === 'string' ? d.text : null;
  const who = a.actor === 'ceo' ? 'You' : idx.agentById.get(a.actor)?.name ?? (a.actor === 'system' ? 'System' : a.actor);
  const req = a.request_id ? idx.requestById.get(a.request_id) : undefined;
  const reqName = req ? `"${req.title ?? clip(req.raw_text, 48)}"` : 'a request';
  const task = a.task_id ? idx.taskById.get(a.task_id) : undefined;
  const taskName = task?.title ?? 'a task';
  const kind = typeof d.kind === 'string' ? (d.kind === 'external_action' ? 'action' : d.kind) : 'item';
  const tone: Tone =
    /approved|pass|done/.test(a.action) ? 'success'
    : /rejected|failed|escalated/.test(a.action) ? 'danger'
    : /revision|changes/.test(a.action) ? 'warning'
    : a.actor === 'ceo' ? 'primary' : 'info';
  if (custom) return { text: custom, tone };
  switch (a.action) {
    case 'request.created': return { text: `${who} assigned ${reqName}`, tone: 'primary' };
    case 'plan.submitted': return { text: `COO sent a plan for ${reqName} (${d.tasks ?? '?'} tasks)`, tone: 'info' };
    case 'approval.approved': return { text: `You approved the ${kind}${task ? `: ${taskName}` : req ? ` for ${reqName}` : ''}`, tone };
    case 'approval.rejected': return { text: `You rejected the ${kind}${task ? `: ${taskName}` : req ? ` for ${reqName}` : ''}`, tone };
    case 'approval.changes_requested': return { text: `You asked for changes${task ? ` to ${taskName}` : req ? ` to ${reqName}` : ''}`, tone };
    case 'task.submitted': return { text: `${who} sent ${taskName} to QA`, tone: 'info' };
    case 'task.failed': return { text: `${who} is stuck on ${taskName}`, tone };
    case 'qa.pass': return { text: `QA passed: ${taskName}${d.score ? ` (${d.score})` : ''}`, tone };
    case 'qa.revision': return { text: `QA sent ${taskName} back for fixes`, tone };
    case 'qa.escalated': return { text: `QA escalated ${taskName} to you`, tone };
    default: return { text: `${who}: ${a.action.replace(/[._]/g, ' ')}`, tone };
  }
}
function clip(s: string, n: number) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
export { clip };

// ---------- requests ----------
export const PIPELINE = ['staged', 'planning', 'review', 'in progress', 'done'] as const;
export function pipelineStep(status: RequestStatus): number {
  switch (status) {
    case 'staged': return 0;
    case 'planning': return 1;
    case 'plan_review': return 2;
    case 'in_progress': case 'awaiting_ceo': return 3;
    case 'done': return 4;
    default: return -1; // rejected / cancelled / failed
  }
}
export function requestProgress(r: RequestRow, tasks: TaskRow[]) {
  const mine = tasks.filter((t) => t.request_id === r.id && t.status !== 'cancelled');
  const done = mine.filter((t) => t.status === 'done').length;
  return { done, total: mine.length, pct: mine.length ? Math.round((done / mine.length) * 100) : r.status === 'done' ? 100 : 0 };
}

// ---------- tasks kanban ----------
export type Column = 'queued' | 'working' | 'qa' | 'needs' | 'done';
export const COLUMNS: { id: Column; label: string }[] = [
  { id: 'queued', label: 'Queued' }, { id: 'working', label: 'Working' }, { id: 'qa', label: 'QA' },
  { id: 'needs', label: 'Needs you' }, { id: 'done', label: 'Done today' },
];
export function columnFor(t: TaskRow, now = new Date()): Column | null {
  const map: Partial<Record<TaskStatus, Column>> = {
    pending: 'queued', queued: 'queued', revision: 'queued', working: 'working', qa_pending: 'qa', qa_reviewing: 'qa',
    awaiting_ceo: 'needs', failed: 'needs',
  };
  if (t.status === 'done') return isToday(t.completed_at ?? t.updated_at, now) ? 'done' : null;
  return map[t.status] ?? null;
}

// ---------- approval payloads ----------
export const asPlan = (a: ApprovalRow) => a.payload as unknown as PlanPayload;
export const asDeliverable = (a: ApprovalRow) => a.payload as unknown as DeliverablePayload;
export const asAction = (a: ApprovalRow) => a.payload as unknown as ActionPayload;
export function qaScore(a: ApprovalRow): number | undefined {
  if (a.kind !== 'deliverable') return undefined;
  const s = asDeliverable(a).qa?.score;
  return typeof s === 'number' ? s : undefined;
}
