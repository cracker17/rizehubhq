// Logical office map (docs/07 §3). Shared by every view: rooms, walls/doors, desks per agent id,
// idle spots, boardroom seats, QA bench, Multimedia Studio (edit bay + vocal booth) and the CEO office.
// Pure data + helpers: no Phaser, no DOM. Tested in map.test.ts.

export type Facing = 'up' | 'down' | 'left' | 'right'; // up = -y, down = +y, left = -x, right = +x
export type Floor = 'oak' | 'oak_dark' | 'concrete' | 'concrete_dark' | 'carpet_blue' | 'carpet_warm' | 'epoxy' | 'marble' | 'rubber';
export type RoomId =
  | 'boardroom' | 'dev' | 'qa_lab' | 'ceo' | 'design' | 'growth' | 'content'
  | 'ops' | 'multimedia' | 'coffee' | 'game' | 'lobby';

export interface Room {
  id: RoomId; name: string; x: number; y: number; w: number; h: number; floor: Floor;
  /** Where the room's sign sits on the floor (free space near the middle of the room). */
  label: { x: number; y: number };
}

export type DeskKind = 'standard' | 'dual' | 'designer' | 'edit_bay' | 'booth' | 'qa' | 'ceo' | 'ops';
/** A desk: (x, y) is the chair tile, `face` is where the seated person looks (towards the desk). */
export interface Desk { agentId: string; x: number; y: number; face: Facing; kind: DeskKind; room: RoomId }

export type SpotKind =
  | 'coffee' | 'lounge_sofa' | 'lobby' | 'ping_pong' | 'foosball' | 'chat'
  | 'boardroom' | 'boardroom_head' | 'qa_bench' | 'whiteboard' | 'ceo';
export type Pose = 'stand' | 'sit';
export interface Spot { id: string; kind: SpotKind; x: number; y: number; face: Facing; pose: Pose; pair?: string; room: RoomId }

export type PropKind =
  | 'desk' | 'desk_ceo' | 'meeting_table' | 'tv_wall' | 'bar' | 'sofa' | 'couch' | 'armchair' | 'coffee_table'
  | 'pingpong' | 'foosball' | 'plant' | 'plant_small' | 'bookshelf' | 'whiteboard' | 'qa_bench' | 'mic'
  | 'reception' | 'rug' | 'server' | 'easel' | 'ring_light' | 'softbox' | 'tripod' | 'kanban' | 'beanbag'
  | 'water_cooler' | 'sales_board' | 'arcade' | 'foam';
export interface Prop {
  id: string; kind: PropKind; x: number; y: number; w: number; h: number;
  face?: Facing; block: boolean; variant?: string; room?: RoomId;
}

export interface Door { dir: 'h' | 'v'; x: number; y: number; len: number }

export interface OfficeMap {
  cols: number; rows: number;
  rooms: Room[];
  desks: Desk[];
  spots: Spot[];
  props: Prop[];
  /** Wall on the top edge of tile (x, y), i.e. between (x, y-1) and (x, y). Key "x,y". */
  hWalls: Set<string>;
  /** Wall on the left edge of tile (x, y), i.e. between (x-1, y) and (x, y). Key "x,y". */
  vWalls: Set<string>;
  /** Tiles furniture occupies (never walkable). */
  blocked: Set<string>;
  /** Seats (chairs, sofas): walkable only as the start or end of a path. */
  seats: Set<string>;
  /** Where the CEO avatar sits. */
  ceoSeat: Spot;
}

export const key = (x: number, y: number) => `${x},${y}`;

// ---------------------------------------------------------------- rooms
const ROOMS: Room[] = [
  { id: 'boardroom', name: 'Boardroom', x: 0, y: 0, w: 12, h: 10, floor: 'carpet_blue', label: { x: 6, y: 8.3 } },
  { id: 'dev', name: 'Dev Team', x: 12, y: 0, w: 20, h: 10, floor: 'concrete', label: { x: 25, y: 4.5 } },
  { id: 'qa_lab', name: 'QA Lab', x: 32, y: 0, w: 12, h: 10, floor: 'epoxy', label: { x: 38.5, y: 7.5 } },
  { id: 'ceo', name: 'CEO Office', x: 44, y: 0, w: 12, h: 10, floor: 'oak_dark', label: { x: 47, y: 7.5 } },
  { id: 'design', name: 'Design Studio', x: 0, y: 10, w: 12, h: 10, floor: 'oak', label: { x: 6.5, y: 15.5 } },
  { id: 'growth', name: 'Growth & Sales', x: 12, y: 10, w: 20, h: 10, floor: 'concrete', label: { x: 26, y: 17.5 } },
  { id: 'content', name: 'Content Room', x: 32, y: 10, w: 24, h: 10, floor: 'oak', label: { x: 43, y: 16.5 } },
  { id: 'ops', name: 'Ops Desk', x: 0, y: 20, w: 12, h: 12, floor: 'carpet_warm', label: { x: 4.5, y: 30.3 } },
  { id: 'multimedia', name: 'Multimedia Studio', x: 12, y: 20, w: 20, h: 12, floor: 'concrete_dark', label: { x: 26.5, y: 28.5 } },
  { id: 'coffee', name: 'Coffee Lounge', x: 32, y: 20, w: 8, h: 12, floor: 'oak', label: { x: 37, y: 30.8 } },
  { id: 'game', name: 'Game Room', x: 40, y: 20, w: 8, h: 12, floor: 'rubber', label: { x: 43.8, y: 31.2 } },
  { id: 'lobby', name: 'Lobby', x: 48, y: 20, w: 8, h: 12, floor: 'marble', label: { x: 50.5, y: 29.5 } },
];

// Openings in the glass partitions (every room is reachable; coffee/game/lobby are open-plan).
const DOORS: Door[] = [
  { dir: 'h', x: 4, y: 10, len: 2 }, { dir: 'h', x: 20, y: 10, len: 3 }, { dir: 'h', x: 37, y: 10, len: 2 }, { dir: 'h', x: 49, y: 10, len: 2 },
  { dir: 'h', x: 5, y: 20, len: 2 }, { dir: 'h', x: 20, y: 20, len: 3 }, { dir: 'h', x: 38, y: 20, len: 2 },
  { dir: 'h', x: 43, y: 20, len: 2 }, { dir: 'h', x: 49, y: 20, len: 2 },
  { dir: 'v', x: 12, y: 4, len: 2 }, { dir: 'v', x: 12, y: 14, len: 2 }, { dir: 'v', x: 12, y: 25, len: 2 },
  { dir: 'v', x: 32, y: 5, len: 2 }, { dir: 'v', x: 32, y: 14, len: 3 }, { dir: 'v', x: 32, y: 29, len: 2 },
  { dir: 'v', x: 44, y: 4, len: 2 },
  { dir: 'v', x: 40, y: 22, len: 8 }, { dir: 'v', x: 48, y: 22, len: 8 },
];

// ---------------------------------------------------------------- desks (ids from supabase/seed.sql)
const DESKS: Desk[] = [
  // Ops Desk
  { agentId: 'coo', x: 3, y: 23, face: 'up', kind: 'ops', room: 'ops' },
  { agentId: 'ea', x: 8, y: 23, face: 'up', kind: 'standard', room: 'ops' },
  { agentId: 'client-success', x: 3, y: 27, face: 'up', kind: 'standard', room: 'ops' },
  // Growth & Sales
  { agentId: 'pipeline', x: 15, y: 13, face: 'up', kind: 'standard', room: 'growth' },
  { agentId: 'prospector', x: 21, y: 13, face: 'up', kind: 'standard', room: 'growth' },
  { agentId: 'inbound', x: 15, y: 17, face: 'up', kind: 'standard', room: 'growth' },
  { agentId: 'job-scout', x: 21, y: 17, face: 'up', kind: 'standard', room: 'growth' },
  // Dev Team
  { agentId: 'shopify-dev', x: 15, y: 4, face: 'up', kind: 'dual', room: 'dev' },
  { agentId: 'webflow-dev', x: 21, y: 4, face: 'up', kind: 'dual', room: 'dev' },
  { agentId: 'wordpress-dev', x: 15, y: 8, face: 'up', kind: 'dual', room: 'dev' },
  { agentId: 'fullstack-dev', x: 21, y: 8, face: 'up', kind: 'dual', room: 'dev' },
  // Design Studio
  { agentId: 'uiux-1', x: 4, y: 13, face: 'left', kind: 'designer', room: 'design' },
  { agentId: 'uiux-2', x: 9, y: 13, face: 'left', kind: 'designer', room: 'design' },
  { agentId: 'graphic-1', x: 4, y: 17, face: 'left', kind: 'designer', room: 'design' },
  { agentId: 'graphic-2', x: 9, y: 17, face: 'left', kind: 'designer', room: 'design' },
  // Content Room
  { agentId: 'seo-1', x: 35, y: 13, face: 'up', kind: 'standard', room: 'content' },
  { agentId: 'seo-2', x: 40, y: 13, face: 'up', kind: 'standard', room: 'content' },
  { agentId: 'social-1', x: 47, y: 16, face: 'left', kind: 'standard', room: 'content' },
  { agentId: 'social-2', x: 52, y: 16, face: 'left', kind: 'standard', room: 'content' },
  // Multimedia Studio
  { agentId: 'video-editor', x: 16, y: 25, face: 'up', kind: 'edit_bay', room: 'multimedia' },
  { agentId: 'sound-engineer', x: 27, y: 21, face: 'down', kind: 'booth', room: 'multimedia' },
  // QA Lab
  { agentId: 'qa-lead', x: 35, y: 5, face: 'up', kind: 'qa', room: 'qa_lab' },
];

// ---------------------------------------------------------------- spots
const S = (id: string, kind: SpotKind, x: number, y: number, face: Facing, pose: Pose, room: RoomId, pair?: string): Spot =>
  ({ id, kind, x, y, face, pose, room, ...(pair ? { pair } : {}) });

const SPOTS: Spot[] = [
  // Coffee Lounge: espresso bar + sofa corner
  S('coffee-1', 'coffee', 34, 22, 'up', 'stand', 'coffee'),
  S('coffee-2', 'coffee', 36, 22, 'up', 'stand', 'coffee'),
  S('coffee-3', 'coffee', 38, 23, 'left', 'stand', 'coffee'),
  S('coffee-4', 'coffee', 37, 25, 'left', 'stand', 'coffee'),
  S('coffee-5', 'coffee', 35, 30, 'up', 'stand', 'coffee'),
  S('sofa-1', 'lounge_sofa', 32, 25, 'right', 'sit', 'coffee'),
  S('sofa-2', 'lounge_sofa', 32, 27, 'right', 'sit', 'coffee'),
  S('sofa-3', 'lounge_sofa', 35, 26, 'left', 'sit', 'coffee'),
  // Game Room: paired tables
  S('pp-a', 'ping_pong', 41, 24, 'right', 'stand', 'game', 'pp'),
  S('pp-b', 'ping_pong', 45, 23, 'left', 'stand', 'game', 'pp'),
  S('fb-a', 'foosball', 43, 27, 'down', 'stand', 'game', 'fb'),
  S('fb-b', 'foosball', 44, 29, 'up', 'stand', 'game', 'fb'),
  // Lobby
  S('lobby-1', 'lobby', 53, 21, 'down', 'sit', 'lobby'),
  S('lobby-2', 'lobby', 55, 21, 'down', 'sit', 'lobby'),
  S('lobby-3', 'lobby', 54, 25, 'up', 'stand', 'lobby'),
  S('lobby-4', 'lobby', 50, 25, 'right', 'stand', 'lobby'),
  S('lobby-5', 'lobby', 51, 28, 'left', 'stand', 'lobby'),
  S('lobby-6', 'lobby', 49, 23, 'down', 'stand', 'lobby'),
  // Chat pairs (standing, facing each other)
  S('chat-g-a', 'chat', 26, 14, 'right', 'stand', 'growth', 'cg'),
  S('chat-g-b', 'chat', 27, 14, 'left', 'stand', 'growth', 'cg'),
  S('chat-c-a', 'chat', 43, 12, 'right', 'stand', 'content', 'cc'),
  S('chat-c-b', 'chat', 44, 12, 'left', 'stand', 'content', 'cc'),
  S('chat-l-a', 'chat', 36, 28, 'right', 'stand', 'coffee', 'cl'),
  S('chat-l-b', 'chat', 37, 28, 'left', 'stand', 'coffee', 'cl'),
  // Boardroom
  S('board-head', 'boardroom_head', 2, 4, 'right', 'stand', 'boardroom'),
  S('board-1', 'boardroom', 4, 2, 'down', 'sit', 'boardroom'),
  S('board-2', 'boardroom', 6, 2, 'down', 'sit', 'boardroom'),
  S('board-3', 'boardroom', 8, 2, 'down', 'sit', 'boardroom'),
  S('board-4', 'boardroom', 4, 6, 'up', 'sit', 'boardroom'),
  S('board-5', 'boardroom', 6, 6, 'up', 'sit', 'boardroom'),
  S('board-6', 'boardroom', 8, 6, 'up', 'sit', 'boardroom'),
  S('board-7', 'boardroom', 9, 4, 'left', 'sit', 'boardroom'),
  // QA bench, COO whiteboard, CEO chair
  S('qa-bench', 'qa_bench', 40, 4, 'up', 'stand', 'qa_lab'),
  S('coo-board', 'whiteboard', 8, 28, 'up', 'stand', 'ops'),
  S('ceo-chair', 'ceo', 50, 4, 'down', 'sit', 'ceo'),
];

// ---------------------------------------------------------------- props
let pid = 0;
const P = (kind: PropKind, x: number, y: number, w = 1, h = 1, o: Partial<Prop> = {}): Prop =>
  ({ id: `${kind}-${++pid}`, kind, x, y, w, h, block: true, ...o });

function deskProps(d: Desk): Prop[] {
  // The desk top is centred on the chair and 3 tiles long across the person's view.
  if (d.kind === 'booth') return [P('mic', d.x, d.y + 1, 1, 1, { face: 'up', room: d.room })];
  const variant = d.kind;
  switch (d.face) {
    case 'up': return [P('desk', d.x - 1, d.y - 1, 3, 1, { face: 'up', variant, room: d.room, id: `desk-${d.agentId}` })];
    case 'down': return [P('desk', d.x - 1, d.y + 1, 3, 1, { face: 'down', variant, room: d.room, id: `desk-${d.agentId}` })];
    case 'left': return [P('desk', d.x - 1, d.y - 1, 1, 3, { face: 'left', variant, room: d.room, id: `desk-${d.agentId}` })];
    case 'right': return [P('desk', d.x + 1, d.y - 1, 1, 3, { face: 'right', variant, room: d.room, id: `desk-${d.agentId}` })];
  }
}

function buildProps(): Prop[] {
  pid = 0;
  const flat = { block: false };
  return [
    // rugs first (flat, drawn on the floor)
    P('rug', 13, 2, 11, 8, { ...flat, variant: 'grey' }),
    P('rug', 1, 1, 10, 7, { ...flat, variant: 'navy' }),
    P('rug', 47, 2, 7, 6, { ...flat, variant: 'warm' }),
    P('rug', 32, 24, 5, 5, { ...flat, variant: 'sage' }),
    P('rug', 50, 22, 6, 5, { ...flat, variant: 'cream' }),
    P('rug', 14, 23, 5, 4, { ...flat, variant: 'grey' }),
    P('rug', 1, 11, 10, 8, { ...flat, variant: 'cream' }),
    // desks
    ...DESKS.flatMap(deskProps),
    { ...P('desk_ceo', 49, 5, 3, 1, { face: 'down', room: 'ceo' }), id: 'desk-ceo' },
    // Boardroom
    P('meeting_table', 3, 3, 6, 3, { room: 'boardroom' }),
    P('tv_wall', 0, 3, 1, 3, { ...flat, face: 'right', room: 'boardroom' }),
    P('plant', 11, 9, 1, 1, { room: 'boardroom' }),
    P('plant', 0, 9, 1, 1, { room: 'boardroom' }),
    P('plant_small', 11, 0, 1, 1, { room: 'boardroom' }),
    // Dev Team
    P('kanban', 24, 0, 4, 1, { ...flat, room: 'dev' }),
    P('server', 29, 0, 2, 1, { room: 'dev' }),
    P('plant', 31, 9, 1, 1, { room: 'dev' }),
    P('plant', 12, 0, 1, 1, { room: 'dev' }),
    P('beanbag', 27, 6, 1, 1, { room: 'dev', variant: '#e0913a' }),
    P('beanbag', 28, 7, 1, 1, { room: 'dev', variant: '#5b7bd5' }),
    P('water_cooler', 31, 3, 1, 1, { room: 'dev' }),
    // QA Lab
    P('qa_bench', 39, 3, 3, 1, { room: 'qa_lab' }),
    P('bookshelf', 32, 0, 2, 1, { room: 'qa_lab', variant: 'devices' }),
    P('plant', 43, 9, 1, 1, { room: 'qa_lab' }),
    P('plant_small', 43, 0, 1, 1, { room: 'qa_lab' }),
    // CEO Office
    P('bookshelf', 46, 0, 3, 1, { room: 'ceo' }),
    P('plant', 55, 0, 1, 1, { room: 'ceo' }),
    P('plant', 44, 9, 1, 1, { room: 'ceo' }),
    P('armchair', 54, 7, 1, 1, { face: 'left', room: 'ceo', variant: '#8a5a3b' }),
    P('coffee_table', 53, 7, 1, 1, { room: 'ceo' }),
    // Design Studio
    P('easel', 1, 19, 1, 1, { room: 'design' }),
    P('plant', 11, 19, 1, 1, { room: 'design' }),
    P('plant_small', 0, 10, 1, 1, { room: 'design' }),
    P('bookshelf', 6, 10, 3, 1, { room: 'design', variant: 'swatches' }),
    // Growth & Sales
    P('sales_board', 24, 10, 3, 1, { room: 'growth' }),
    P('water_cooler', 12, 19, 1, 1, { room: 'growth' }),
    P('plant', 31, 10, 1, 1, { room: 'growth' }),
    P('plant', 31, 19, 1, 1, { room: 'growth' }),
    // Content Room
    P('bookshelf', 32, 10, 2, 1, { room: 'content' }),
    P('ring_light', 46, 14, 1, 1, { room: 'content' }),
    P('ring_light', 51, 14, 1, 1, { room: 'content' }),
    P('plant', 55, 10, 1, 1, { room: 'content' }),
    P('plant', 55, 19, 1, 1, { room: 'content' }),
    P('plant_small', 41, 19, 1, 1, { room: 'content' }),
    // Ops Desk
    P('whiteboard', 7, 27, 2, 1, { face: 'down', room: 'ops' }),
    P('bookshelf', 0, 20, 2, 1, { room: 'ops' }),
    P('plant', 0, 31, 1, 1, { room: 'ops' }),
    P('plant', 11, 21, 1, 1, { room: 'ops' }),
    // Multimedia Studio
    P('foam', 25, 20, 4, 1, { ...flat, room: 'multimedia' }),
    P('softbox', 19, 27, 1, 1, { room: 'multimedia' }),
    P('softbox', 24, 29, 1, 1, { room: 'multimedia' }),
    P('tripod', 21, 29, 1, 1, { room: 'multimedia' }),
    P('plant', 13, 31, 1, 1, { room: 'multimedia' }),
    P('plant', 31, 21, 1, 1, { room: 'multimedia' }),
    P('bookshelf', 13, 20, 2, 1, { room: 'multimedia', variant: 'gear' }),
    // Coffee Lounge
    P('bar', 33, 21, 4, 1, { room: 'coffee' }),
    P('sofa', 32, 25, 1, 3, { ...flat, face: 'right', room: 'coffee', variant: '#6f8f7a' }),
    P('armchair', 35, 26, 1, 1, { ...flat, face: 'left', room: 'coffee', variant: '#c98a5a' }),
    P('coffee_table', 34, 26, 1, 1, { room: 'coffee' }),
    P('plant', 39, 31, 1, 1, { room: 'coffee' }),
    P('plant_small', 33, 31, 1, 1, { room: 'coffee' }),
    // Game Room
    P('pingpong', 42, 23, 3, 2, { room: 'game' }),
    P('foosball', 43, 28, 2, 1, { room: 'game' }),
    P('arcade', 47, 20, 1, 1, { room: 'game' }),
    P('beanbag', 46, 31, 1, 1, { room: 'game', variant: '#d0584f' }),
    P('beanbag', 41, 31, 1, 1, { room: 'game', variant: '#4f9fd0' }),
    // Lobby
    P('couch', 53, 21, 3, 1, { ...flat, face: 'down', room: 'lobby', variant: '#39485e' }),
    P('coffee_table', 54, 23, 1, 1, { room: 'lobby' }),
    P('reception', 52, 30, 3, 1, { face: 'up', room: 'lobby' }),
    P('plant', 48, 21, 1, 1, { room: 'lobby' }),
    P('plant', 55, 31, 1, 1, { room: 'lobby' }),
    P('plant', 48, 31, 1, 1, { room: 'lobby' }),
  ];
}

// ---------------------------------------------------------------- walls
function buildWalls(rooms: Room[], doors: Door[]) {
  const hWalls = new Set<string>();
  const vWalls = new Set<string>();
  for (const r of rooms) {
    if (r.y > 0) for (let x = r.x; x < r.x + r.w; x++) hWalls.add(key(x, r.y));
    if (r.x > 0) for (let y = r.y; y < r.y + r.h; y++) vWalls.add(key(r.x, y));
  }
  // Vocal booth: glass box inside the Multimedia Studio, x 25..28, y 20..23, door at (26, 24).
  for (let y = 20; y <= 23; y++) { vWalls.add(key(25, y)); vWalls.add(key(29, y)); }
  for (const x of [25, 27, 28]) hWalls.add(key(x, 24));
  for (const d of doors) {
    for (let i = 0; i < d.len; i++) {
      if (d.dir === 'h') hWalls.delete(key(d.x + i, d.y));
      else vWalls.delete(key(d.x, d.y + i));
    }
  }
  return { hWalls, vWalls };
}

export function buildOfficeMap(): OfficeMap {
  const cols = 56;
  const rows = 32;
  const props = buildProps();
  const { hWalls, vWalls } = buildWalls(ROOMS, DOORS);
  const blocked = new Set<string>();
  const seats = new Set<string>();
  for (const p of props) {
    if (!p.block) continue;
    for (let x = p.x; x < p.x + p.w; x++) for (let y = p.y; y < p.y + p.h; y++) blocked.add(key(x, y));
  }
  for (const p of props) {
    if (p.kind !== 'sofa' && p.kind !== 'couch' && p.kind !== 'armchair') continue;
    for (let x = p.x; x < p.x + p.w; x++) for (let y = p.y; y < p.y + p.h; y++) seats.add(key(x, y));
  }
  for (const d of DESKS) seats.add(key(d.x, d.y));
  for (const s of SPOTS) if (s.pose === 'sit') seats.add(key(s.x, s.y));
  const ceoSeat = SPOTS.find((s) => s.kind === 'ceo')!;
  return { cols, rows, rooms: ROOMS, desks: DESKS, spots: SPOTS, props, hWalls, vWalls, blocked, seats, ceoSeat };
}

export const OFFICE: OfficeMap = buildOfficeMap();

// ---------------------------------------------------------------- queries
export function roomAt(m: OfficeMap, x: number, y: number): Room | undefined {
  // Later rooms never overlap earlier ones, so the first hit is the room.
  return m.rooms.find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}

export function inBounds(m: OfficeMap, x: number, y: number) {
  return x >= 0 && y >= 0 && x < m.cols && y < m.rows;
}

/** True when a wall separates two orthogonally adjacent tiles. */
export function wallBetween(m: OfficeMap, ax: number, ay: number, bx: number, by: number): boolean {
  if (ax === bx) return m.hWalls.has(key(ax, Math.max(ay, by)));
  return m.vWalls.has(key(Math.max(ax, bx), ay));
}

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
