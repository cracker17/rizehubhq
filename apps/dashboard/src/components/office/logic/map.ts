// Logical office map (docs/07 §3), built from the painted layout (apps/dashboard/office/layout.json):
// rooms, desk seats (six assigned, the rest plain furniture), idle spots, the CEO chair and the walk graph.
// Pure data + helpers: no Phaser, no DOM. Tested in office.test.ts.
import { GRAPH, LAYOUT, PROJ, type Facing, type OfficeLayout, type WalkGraph, buildGraph, projection } from './layout';
import type { Pt } from './iso';

export type { Facing } from './layout';
export type RoomId = string;

export interface Room {
  id: RoomId; name: string;
  /** Where the room's sign sits, in picture pixels (1x). */
  label: { x: number; y: number };
}

export type DeskKind = 'standard' | 'dual' | 'designer' | 'qa' | 'board' | 'ceo';
/** A seat: (x, y) in tile coordinates is where the person sits, `face` is where they look (the desk). */
export interface Seat {
  id: string; x: number; y: number; face: Facing; kind: DeskKind; room: RoomId; via: number; screens: Pt[][];
  /** Sprite desk (furniture id) whose monitors show this seat's screen. */
  deskId?: string;
  /** An animated chair stands here. */
  chair: boolean;
}
/** A seat assigned to an agent. */
export interface Desk extends Seat { agentId: string }

export type SpotKind =
  | 'coffee' | 'lounge_sofa' | 'lobby' | 'ping_pong' | 'foosball' | 'chat'
  | 'boardroom' | 'boardroom_head' | 'qa_bench' | 'whiteboard' | 'ceo' | 'gym';
export type Pose = 'stand' | 'sit';
export interface Spot { id: string; kind: SpotKind; x: number; y: number; face: Facing; pose: Pose; pair?: string; room: RoomId; via?: number; loop?: string }

export interface OfficeMap {
  rooms: Room[];
  /** Every desk seat in the picture (the unassigned ones stay empty furniture). */
  seats: Seat[];
  /** Seats that belong to an agent. */
  desks: Desk[];
  spots: Spot[];
  /** Seat id → where the COO stands when handing that desk a task (tile coords). */
  visits: Map<string, Pt>;
  /** Where the CEO sits. */
  ceoSeat: Spot;
  /** Lobby entrance (tile coords): people coming online walk in from here. */
  entrance: Pt;
  graph: WalkGraph;
  /** Seat/spot tile point → graph node it joins at. */
  joins: Map<string, number>;
}

export const key = (x: number, y: number) => `${x.toFixed(3)},${y.toFixed(3)}`;

function seatKind(k: string): DeskKind {
  return (['standard', 'dual', 'designer', 'qa', 'board', 'ceo'] as const).find((x) => x === k) ?? 'standard';
}

/**
 * Build the map. `assign` maps agent id → seat id; it defaults to `layout.assignments`, and an agent's
 * own `desk.id` (agents table) overrides it, so a new hire gets a desk without a code change.
 */
export function buildOfficeMap(assign?: Record<string, string>, l: OfficeLayout = LAYOUT): OfficeMap {
  const p = l === LAYOUT ? PROJ : projection(l);
  const graph = l === LAYOUT ? GRAPH : buildGraph(l);
  const joins = new Map<string, number>();
  const node = (id: string) => {
    const i = graph.index.get(id);
    if (i === undefined) throw new Error(`layout.json: unknown graph node "${id}"`);
    return i;
  };
  const tile = ([x, y]: [number, number]) => p.toTile(x, y);

  const seats: Seat[] = l.desks.map((d) => {
    const t = tile(d.at);
    const s: Seat = {
      id: d.id, x: t.x, y: t.y, face: d.face, kind: seatKind(d.kind), room: d.room, via: node(d.via),
      screens: d.screens.map((q) => q.map(([x, y]) => ({ x, y }))),
      chair: d.chair ?? false,
      ...(d.desk ? { deskId: d.desk } : {}),
    };
    joins.set(key(t.x, t.y), s.via);
    return s;
  });
  const spots: Spot[] = l.spots.map((s) => {
    const t = tile(s.at);
    const spot: Spot = {
      id: s.id, kind: s.kind as SpotKind, x: t.x, y: t.y, face: s.face, pose: s.pose, room: s.room, via: node(s.via),
      ...(s.pair ? { pair: s.pair } : {}),
      ...(s.loop ? { loop: s.loop } : {}),
    };
    joins.set(key(t.x, t.y), spot.via!);
    return spot;
  });
  const bySeat = new Map(seats.map((s) => [s.id, s]));
  const wanted = assign ?? l.assignments;
  const desks: Desk[] = [];
  const used = new Set<string>();
  for (const [agentId, seatId] of Object.entries(wanted)) {
    const s = bySeat.get(seatId);
    if (!s || used.has(seatId)) continue;
    used.add(seatId);
    desks.push({ ...s, agentId });
  }
  const visits = new Map(Object.entries(l.visits).map(([id, xy]) => [id, tile(xy)]));
  const ceoSeat = spots.find((s) => s.kind === 'ceo');
  if (!ceoSeat) throw new Error('layout.json: no CEO chair spot');
  return {
    rooms: l.rooms.map((r) => ({ id: r.id, name: r.name, label: { x: r.label[0], y: r.label[1] } })),
    seats, desks, spots, visits, ceoSeat, entrance: tile(l.entrance), graph, joins,
  };
}

export const OFFICE: OfficeMap = buildOfficeMap();

/** Seat assignments for a snapshot: layout defaults, overridden by each agent's `desk.id`. */
export function assignmentsFor(agents: { id: string; desk?: { id?: string } | null }[], l: OfficeLayout = LAYOUT): Record<string, string> {
  const out: Record<string, string> = { ...l.assignments };
  const seatIds = new Set(l.desks.map((d) => d.id));
  for (const a of agents) {
    const id = a.desk?.id;
    if (id && seatIds.has(id)) {
      for (const [k, v] of Object.entries(out)) if (v === id && k !== a.id) delete out[k];
      out[a.id] = id;
    }
  }
  return out;
}

// ---------------------------------------------------------------- queries
export function deskFor(m: OfficeMap, agentId: string): Desk | undefined {
  return m.desks.find((d) => d.agentId === agentId);
}

export function spotsOf(m: OfficeMap, kind: SpotKind): Spot[] {
  return m.spots.filter((s) => s.kind === kind);
}

/** Unit step of a facing direction in tile space. */
export const FACING_STEP: Record<Facing, { dx: number; dy: number }> = {
  up: { dx: 0, dy: -1 }, down: { dx: 0, dy: 1 }, left: { dx: -1, dy: 0 }, right: { dx: 1, dy: 0 },
};

/** The facing that points most directly from (x, y) towards (tx, ty). */
export function facingTowards(x: number, y: number, tx: number, ty: number): Facing {
  const dx = tx - x;
  const dy = ty - y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}
