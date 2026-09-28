// Director: HQ snapshot (store rows) → what every character should be doing in the office (docs/07 §4).
// Pure: the Phaser scene only animates what this returns, so LIVE and DEMO share one code path.
import type { AgentStatus } from '@rizehubhq/shared';
import { IDLE_LABEL, buildIndexes, clip, toTileAgent } from '../../../lib/data/derive';
import type { HqSnapshot, PlanPayload } from '../../../lib/data/types';
import { OFFICE, deskFor, spotsOf, type OfficeMap, type Spot } from './map';
import type { GestureName, Goal, LoopName } from './motion';
import { assignSpots } from './spots';

export type ScreenApp =
  | 'off' | 'screensaver' | 'editor' | 'browser' | 'doc' | 'sheet' | 'leads' | 'review' | 'timeline' | 'audio' | 'design';
export type Badge = 'hourglass' | 'hand' | 'warning' | null;

export interface AgentView {
  id: string;
  name: string;
  short: string;
  status: AgentStatus;
  color: string;
  department: string;
  /** null = not in the office (offline / disabled). */
  goal: Goal | null;
  /** One-line hover label ("Building · Madam Muse bundle hero · 60%"). */
  tag: string;
  badge: Badge;
  progress?: number;
  screen: ScreenApp;
}

export interface OfficeModel {
  agents: AgentView[];
  meeting: { label: string } | null;
  /** agentId → idle spot id (feed back in as `prevSpots` to keep spots stable). */
  spots: Map<string, string>;
}

export const SHORT: Record<string, string> = {
  coo: 'COO', ea: 'EA', 'client-success': 'Client Success', pipeline: 'Pipeline', prospector: 'Prospecting',
  inbound: 'Inbound', 'job-scout': 'Job Scout', 'shopify-dev': 'Shopify', 'webflow-dev': 'Webflow',
  'wordpress-dev': 'WordPress', 'fullstack-dev': 'Full-Stack', 'uiux-1': 'UI/UX 1', 'uiux-2': 'UI/UX 2',
  'graphic-1': 'Graphic 1', 'graphic-2': 'Graphic 2', 'social-1': 'Social 1', 'social-2': 'Social 2',
  'seo-1': 'SEO 1', 'seo-2': 'SEO 2', 'video-editor': 'Video', 'sound-engineer': 'Sound', 'qa-lead': 'QA Lead',
};

const COO_ID = 'coo';
const QA_ID = 'qa-lead';

export function workLoop(agentId: string, department: string): LoopName {
  if (agentId === 'video-editor') return 'scrub';
  if (agentId === 'sound-engineer') return 'sing';
  if (agentId === QA_ID) return 'review';
  if (agentId === COO_ID) return 'call';
  if (department === 'dev') return 'type';
  if (department === 'design') return 'draw';
  return 'write';
}

const SPOT_LOOP: Record<string, (s: Spot) => LoopName> = {
  coffee: () => 'coffee',
  lounge_sofa: () => 'sofa',
  lobby: (s) => (s.pose === 'sit' ? 'lobby_sit' : 'lobby_stand'),
  ping_pong: () => 'pingpong',
  foosball: () => 'foosball',
  chat: () => 'chat',
};

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function deskGoal(m: OfficeMap, agentId: string, loop: LoopName, seated = true): Goal | null {
  const d = deskFor(m, agentId);
  if (!d) return null;
  return { key: `desk:${agentId}`, x: d.x, y: d.y, face: d.face, seated: d.kind === 'booth' ? false : seated, loop };
}

export function spotGoal(s: Spot, loop: LoopName): Goal {
  return { key: `spot:${s.id}`, x: s.x, y: s.y, face: s.face, seated: s.pose === 'sit', loop };
}

function screenFor(app: string | undefined, agentId: string, department: string): ScreenApp {
  if (agentId === 'video-editor') return 'timeline';
  if (agentId === 'sound-engineer') return 'audio';
  if (department === 'design') return 'design';
  switch (app) {
    case 'editor': return 'editor';
    case 'browser': return 'browser';
    case 'sheet': return 'sheet';
    case 'leads': return 'leads';
    case 'review': return 'review';
    case 'doc': return 'doc';
    default: return department === 'dev' ? 'editor' : 'doc';
  }
}

export interface DeriveOptions {
  nowMs: number;
  prevSpots?: Map<string, string>;
  map?: OfficeMap;
}

/** Requests in planning/plan_review → meeting label + the agents named in the plan. */
export function planningInfo(snap: HqSnapshot) {
  // The COO holds the meeting while a request is being planned; once the plan is sent for review
  // (plan_review) everyone goes back to work until the CEO decides.
  const r = snap.requests.find((x) => x.status === 'planning');
  if (!r) return null;
  const plan = snap.approvals.find((a) => a.kind === 'plan' && a.request_id === r.id && a.status === 'pending');
  const named = new Set(((plan?.payload as unknown as PlanPayload | undefined)?.tasks ?? []).map((t) => t.agent_id));
  const title = r.title ?? (plan?.payload as { title?: string } | undefined)?.title ?? clip(r.raw_text, 36);
  return { label: `Meeting: ${title}`, attendees: named };
}

export function deriveOffice(snap: HqSnapshot, opts: DeriveOptions): OfficeModel {
  const m = opts.map ?? OFFICE;
  const idx = buildIndexes(snap);
  const tiles = snap.agents.map((a) => toTileAgent(a, snap, idx));
  const plan = planningInfo(snap);
  const boardSeats = spotsOf(m, 'boardroom');
  const head = spotsOf(m, 'boardroom_head')[0];
  const bench = spotsOf(m, 'qa_bench')[0];
  const whiteboard = spotsOf(m, 'whiteboard')[0];

  // Idle agents named in a plan under review join the meeting; the rest take a break spot.
  const attendees = tiles.filter((t) => plan && t.id !== COO_ID && t.status === 'idle' && t.row.enabled && plan.attendees.has(t.id));
  const attendeeIds = new Set(attendees.map((t) => t.id));
  const idlers = tiles.filter((t) => t.status === 'idle' && t.row.enabled && !attendeeIds.has(t.id) && !(plan && t.id === COO_ID));
  const spots = assignSpots(m, idlers.map((t) => ({ id: t.id, activity: t.idle ?? null })), opts.prevSpots);
  const spotById = new Map(m.spots.map((s) => [s.id, s]));

  const agents: AgentView[] = tiles.map((t) => {
    const base = {
      id: t.id, name: t.name, short: SHORT[t.id] ?? t.name, status: t.status, color: t.color, department: t.department,
      progress: t.progress,
    };
    const task = t.task ? clip(t.task, 48) : undefined;
    if (!t.row.enabled || t.status === 'offline') {
      return { ...base, status: 'offline', goal: null, tag: 'Offline', badge: null, screen: 'off' };
    }
    // COO runs planning meetings in the Boardroom.
    if (t.id === COO_ID && plan) {
      return { ...base, goal: spotGoal(head, 'present'), tag: `In the Boardroom · ${plan.label}`, badge: null, screen: 'screensaver' };
    }
    const ai = attendees.findIndex((x) => x.id === t.id);
    if (ai >= 0 && boardSeats[ai]) {
      return { ...base, goal: spotGoal(boardSeats[ai], 'meeting'), tag: `In the Boardroom · ${plan!.label}`, badge: null, screen: 'screensaver' };
    }
    switch (t.status) {
      case 'working': {
        const cur = t.currentTask;
        const pct = t.progress !== undefined ? ` · ${t.progress}%` : '';
        const screen = screenFor(t.screen?.app, t.id, t.department);
        if (t.id !== QA_ID && cur && (cur.status === 'qa_pending' || cur.status === 'qa_reviewing')) {
          return { ...base, goal: deskGoal(m, t.id, 'wait_qa'), tag: `Waiting for QA${task ? ` · ${task}` : ''}`, badge: 'hourglass', screen };
        }
        const verb = t.id === QA_ID && cur?.status === 'qa_reviewing' ? 'Reviewing' : t.verb ?? 'Working';
        const label = `${verb}${task ? ` · ${task}` : ''}${pct}`;
        if (t.id === QA_ID) {
          const reviewing = !cur || cur.status === 'qa_reviewing' || /review|check|test/.test(cur.work_type);
          if (reviewing && bench) return { ...base, goal: spotGoal(bench, 'inspect'), tag: label, badge: null, screen: 'review' };
          return { ...base, goal: deskGoal(m, t.id, 'review'), tag: label, badge: null, screen: 'review' };
        }
        if (t.id === COO_ID && whiteboard) {
          // Alternates between the whiteboard and a call at the desk (~50 s each).
          const atBoard = Math.floor(opts.nowMs / 50_000 + (hash(t.id) % 7)) % 2 === 0;
          return atBoard
            ? { ...base, goal: spotGoal(whiteboard, 'whiteboard'), tag: label, badge: null, screen: 'doc' }
            : { ...base, goal: deskGoal(m, t.id, 'call'), tag: label, badge: null, screen: 'doc' };
        }
        return { ...base, goal: deskGoal(m, t.id, workLoop(t.id, t.department)), tag: label, badge: null, screen };
      }
      case 'waiting':
        return { ...base, goal: deskGoal(m, t.id, 'raise_hand', false), tag: `Needs you${task ? ` · ${task}` : ''}`, badge: 'hand', screen: 'doc' };
      case 'blocked':
        return { ...base, goal: deskGoal(m, t.id, 'head_in_hands'), tag: `Blocked${task ? ` · ${task}` : ''}`, badge: 'warning', screen: 'screensaver' };
      case 'idle':
      default: {
        const sid = spots.get(t.id);
        const s = sid ? spotById.get(sid) : undefined;
        const label = t.idle ? IDLE_LABEL[t.idle] : 'On break';
        if (s) return { ...base, goal: spotGoal(s, SPOT_LOOP[s.kind]?.(s) ?? 'stand'), tag: label, badge: null, screen: 'screensaver' };
        return { ...base, goal: deskGoal(m, t.id, 'desk_idle'), tag: label, badge: null, screen: 'screensaver' };
      }
    }
  });

  return { agents, meeting: plan ? { label: plan.label } : null, spots };
}

export interface OfficeEvent { agentId: string; gesture: GestureName }

/** Gestures implied by a data change: task done, QA pass (nod) / fail (head-scratch). */
export function diffEvents(prev: HqSnapshot, next: HqSnapshot): OfficeEvent[] {
  const out: OfficeEvent[] = [];
  const seen = new Set<string>();
  const push = (agentId: string, gesture: GestureName) => {
    const k = `${agentId}:${gesture}`;
    if (!seen.has(k)) { seen.add(k); out.push({ agentId, gesture }); }
  };
  const before = new Map(prev.tasks.map((t) => [t.id, t]));
  for (const t of next.tasks) {
    const p = before.get(t.id);
    if (!p || p.status === t.status) continue;
    if (p.status === 'working' && ['qa_pending', 'awaiting_ceo', 'done'].includes(t.status)) push(t.agent_id, 'done');
    if (p.status === 'qa_reviewing') {
      if (['revision', 'queued', 'failed'].includes(t.status)) { push(t.agent_id, 'scratch'); push(QA_ID, 'nod'); }
      else if (['awaiting_ceo', 'done'].includes(t.status)) { push(t.agent_id, 'nod'); push(QA_ID, 'nod'); }
    }
  }
  const agentsBefore = new Map(prev.agents.map((a) => [a.id, a]));
  for (const a of next.agents) {
    const p = agentsBefore.get(a.id);
    if (p && p.status === 'working' && a.status === 'idle') push(a.id, 'done');
  }
  return out;
}
