// /wall (docs/17-OPERATOR.md "Live wall"): one "camera" per AI worker, the six HQ agents from agent_screens and one per
// Operator client from operator_actions. Pure: builds the tiles, their recorded steps (for the replay scrubber) and the
// spots a simulated Claude-style cursor visits on each kind of screen.
import type { ActivityRow, AgentRow, AgentScreenRow, HqSnapshot } from '@/lib/data/types';
import { buildIndexes, describeActivity, toTileAgent, type Indexes } from '@/lib/data/derive';
import { describeAction, type OperatorActionRow, type OperatorClientRow } from '@/lib/operatorView';

export type ScreenApp = 'editor' | 'browser' | 'doc' | 'sheet' | 'whiteboard' | 'review' | 'chat' | 'idle';
export type TileState = 'working' | 'waiting' | 'blocked' | 'idle' | 'offline';

export interface WallStep { at: string; text: string }

export interface WallTile {
  id: string;
  cam: number;
  kind: 'agent' | 'operator';
  name: string;
  role: string;
  color: string;
  project: string | null;
  app: ScreenApp;
  title: string;
  content: string;
  imageUrl: string | null;
  note: string;
  progress: number | null;
  state: TileState;
  updatedAt: string | null;
  /** Newest first. */
  steps: WallStep[];
  href: string;
  viewerUrl?: string | null;
}

const APPS: ScreenApp[] = ['editor', 'browser', 'doc', 'sheet', 'whiteboard', 'review', 'chat', 'idle'];
export function screenApp(app: string | null | undefined): ScreenApp {
  const a = (app ?? '').toLowerCase();
  if ((APPS as string[]).includes(a)) return a as ScreenApp;
  if (a === 'leads' || a === 'inbox') return 'sheet';
  return a ? 'browser' : 'idle';
}

function agentState(a: AgentRow): TileState {
  if (!a.enabled) return 'offline';
  return a.status === 'working' ? 'working' : a.status === 'waiting' ? 'waiting' : a.status === 'blocked' ? 'blocked' : a.status === 'offline' ? 'offline' : 'idle';
}

const IDLE_NOTE: Record<string, string> = {
  coffee: 'On a coffee break', lounge_sofa: 'In the lounge', lobby: 'In the lobby', ping_pong: 'Playing ping pong', foosball: 'Playing foosball',
  chat: 'Chatting with the team', gym: 'At the gym',
};

function agentTile(a: AgentRow, i: number, s: HqSnapshot, idx: Indexes): WallTile {
  const t = toTileAgent(a, s, idx);
  const screen: AgentScreenRow | undefined = t.screen;
  const state = agentState(a);
  const client = t.currentTask?.client_id ? idx.clientById.get(t.currentTask.client_id)?.name ?? null : null;
  const steps: WallStep[] = s.activity
    .filter((r: ActivityRow) => r.actor === a.id && !r.action.startsWith('usage.'))
    .slice(0, 30)
    .map((r) => ({ at: r.created_at, text: describeActivity(r, s, idx).text }));
  if (screen?.step_note && state === 'working') steps.unshift({ at: screen.updated_at, text: screen.step_note });
  const note = state === 'working' ? screen?.step_note ?? (t.verb && t.task ? `${t.verb} ${t.task}` : 'Working')
    : state === 'waiting' ? `Waiting for you: ${t.task ?? 'an approval'}`
    : state === 'blocked' ? `Stuck: ${t.task ?? 'a task'}`
    : state === 'offline' ? 'Switched off'
    : (t.idle && IDLE_NOTE[t.idle]) || 'Idle';
  return {
    id: `agent:${a.id}`, cam: i + 1, kind: 'agent', name: a.name, role: a.department, color: t.color, project: client,
    app: state === 'working' || state === 'waiting' ? screenApp(screen?.app) : 'idle',
    title: screen?.title ?? t.task ?? '', content: screen?.content ?? '', imageUrl: screen?.image_url ?? null,
    note, progress: t.progress ?? null, state, updatedAt: screen?.updated_at ?? a.updated_at, steps, href: `/agents/${a.id}`,
  };
}

function operatorTile(c: OperatorClientRow, cam: number, actions: OperatorActionRow[], online: boolean): WallTile {
  const mine = actions.filter((x) => x.client_slug === c.slug).sort((a, b) => b.id - a.id);
  const last = mine[0];
  const recent = last && Date.now() - new Date(last.created_at).getTime() < 90_000;
  const state: TileState = !online ? 'offline' : c.paused ? 'waiting' : recent ? 'working' : 'idle';
  const lastText = last ? describeAction(last).text : '';
  const typing = last?.action.startsWith('browser.');
  return {
    id: `operator:${c.slug}`, cam, kind: 'operator', name: `Operator · ${c.name}`, role: 'client chats', color: '#a78bfa',
    project: c.name, app: state === 'idle' || state === 'offline' ? 'idle' : typing ? 'chat' : 'browser',
    title: 'chat.google.com', content: lastText, imageUrl: null,
    note: state === 'offline' ? 'Operator offline' : c.paused ? 'You have control (sends paused)' : recent ? lastText : 'Watching the chats',
    progress: null, state, updatedAt: last?.created_at ?? null,
    steps: mine.slice(0, 30).map((x) => ({ at: x.created_at, text: describeAction(x).text })), href: '/operator', viewerUrl: c.viewer_url,
  };
}

export interface WallInput {
  snap: HqSnapshot;
  operator: { clients: OperatorClientRow[]; actions: OperatorActionRow[]; online: boolean } | null;
}

/** Working first, then waiting / blocked, then idle; agents keep their camera number. */
export function buildWall({ snap, operator }: WallInput): WallTile[] {
  const idx = buildIndexes(snap);
  const agents = snap.agents.filter((a) => a.enabled !== false).map((a, i) => agentTile(a, i, snap, idx));
  const ops = (operator?.clients ?? []).map((c, i) => operatorTile(c, agents.length + i + 1, operator!.actions, operator!.online));
  const rank: Record<TileState, number> = { working: 0, waiting: 1, blocked: 1, idle: 2, offline: 3 };
  return [...ops, ...agents].sort((a, b) => rank[a.state] - rank[b.state] || a.cam - b.cam);
}

/** Where the simulated cursor goes on each kind of screen (percent of the screen area): x, y, then the box it highlights. */
export interface Spot { x: number; y: number; box: { x: number; y: number; w: number; h: number } }
const S = (x: number, y: number, w: number, h: number): Spot => ({ x: x + w * 0.6, y: y + h * 0.55, box: { x, y, w, h } });
export const CURSOR_SPOTS: Record<ScreenApp, Spot[]> = {
  editor: [S(14, 22, 60, 8), S(14, 46, 48, 8), S(14, 62, 70, 8), S(78, 6, 18, 8)],
  browser: [S(6, 4, 70, 9), S(8, 26, 44, 18), S(56, 30, 36, 10), S(30, 70, 40, 12)],
  doc: [S(10, 18, 80, 8), S(10, 40, 70, 18), S(10, 66, 60, 8)],
  sheet: [S(4, 22, 30, 8), S(36, 38, 28, 8), S(66, 54, 30, 8), S(4, 70, 30, 8)],
  whiteboard: [S(8, 14, 36, 22), S(54, 30, 36, 22), S(20, 62, 40, 18)],
  review: [S(8, 16, 84, 10), S(8, 40, 50, 22), S(62, 72, 30, 10)],
  chat: [S(8, 18, 70, 12), S(8, 44, 60, 12), S(6, 80, 76, 10), S(84, 80, 10, 10)],
  idle: [],
};

/** The step the replay scrubber points at (0 = now). */
export function replayStep(steps: WallStep[], back: number): WallStep | null {
  if (!steps.length) return null;
  return steps[Math.min(Math.max(0, back), steps.length - 1)] ?? null;
}

/** "14:03:22" in Manila time, for the camera overlay clock. */
export function camClock(d: Date, tz = 'Asia/Manila'): string {
  return d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}
