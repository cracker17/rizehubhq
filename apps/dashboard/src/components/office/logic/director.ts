// Director: HQ snapshot (store rows) → what every character should be doing in the office (docs/07 §4).
// Pure: the Phaser scene only animates what this returns, so LIVE and DEMO share one code path.
import type { AgentStatus } from '@rizehubhq/shared';
import { IDLE_LABEL, buildIndexes, clip, toTileAgent } from '../../../lib/data/derive';
import type { HqSnapshot, PlanPayload } from '../../../lib/data/types';
import { OFFICE, assignmentsFor, buildOfficeMap, deskFor, spotsOf, type OfficeMap, type Spot } from './map';
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
  /** The map (desk assignments) this model was derived for. */
  map: OfficeMap;
}

export const SHORT: Record<string, string> = {
  coo: 'COO', 'web-dev': 'Web Dev', designer: 'Designer', writer: 'Writer', sales: 'Sales', 'qa-lead': 'QA',
};

const COO_ID = 'coo';
const QA_ID = 'qa-lead';

export function workLoop(agentId: string, department: string): LoopName {
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
  return { key: `desk:${agentId}`, x: d.x, y: d.y, face: d.face, seated, loop };
}

/** Where the COO stands next to an agent's desk while handing over a task. */
export function visitGoal(m: OfficeMap, agentId: string): Goal | null {
  const d = deskFor(m, agentId);
  const v = d ? m.visits.get(d.id) : undefined;
  if (!d || !v) return null;
  const dx = d.x - v.x;
  const dy = d.y - v.y;
  const face = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'down' : 'up';
  return { key: `visit:${agentId}`, x: v.x, y: v.y, face, seated: false, loop: 'present' };
}

export function spotGoal(s: Spot, loop: LoopName): Goal {
  return { key: `spot:${s.id}`, x: s.x, y: s.y, face: s.face, seated: s.pose === 'sit', loop };
}

function screenFor(app: string | undefined, _agentId: string, department: string): ScreenApp {
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

/** Tasks the COO has just handed out (queued, not yet picked up) → the COO walks over to that desk. */
export function handoverTarget(snap: HqSnapshot, nowMs: number, windowMs = 90_000): string | null {
  const t = snap.tasks
    .filter((x) => x.status === 'queued' && x.agent_id !== COO_ID && x.agent_id !== QA_ID)
    .filter((x) => nowMs - Date.parse(x.created_at) >= 0 && nowMs - Date.parse(x.created_at) <= windowMs)
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0];
  return t?.agent_id ?? null;
}

export function officeMapFor(snap: HqSnapshot): OfficeMap {
  const a = assignmentsFor(snap.agents);
  const same = Object.keys(a).length === OFFICE.desks.length && OFFICE.desks.every((d) => a[d.agentId] === d.id);
  return same ? OFFICE : buildOfficeMap(a);
}

export function deriveOffice(snap: HqSnapshot, opts: DeriveOptions): OfficeModel {
  const m = opts.map ?? officeMapFor(snap);
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
    // The COO walks over to a desk to hand over a freshly queued task.
    if (t.id === COO_ID && (t.status === 'working' || t.status === 'idle')) {
      const target = handoverTarget(snap, opts.nowMs);
      const visit = target ? visitGoal(m, target) : null;
      if (visit) {
        const who = tiles.find((x) => x.id === target)?.name ?? 'the team';
        const brief = snap.tasks.find((x) => x.agent_id === target && x.status === 'queued');
        return { ...base, status: 'working', goal: visit, tag: `Briefing ${who}${brief ? ` · ${clip(brief.title, 40)}` : ''}`, badge: null, screen: 'doc' };
      }
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

  return { agents, meeting: plan ? { label: plan.label } : null, spots, map: m };
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
