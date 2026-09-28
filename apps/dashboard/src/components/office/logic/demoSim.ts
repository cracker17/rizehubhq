// DEMO-mode office simulator: every 20–40 s a few agents change state (tasks start and finish,
// QA passes or bounces work, breaks change, the COO holds a planning meeting) so the office feels alive.
// It never touches the store: it keeps an *overlay* of row patches that is applied on top of whatever
// the store snapshot currently is, so CEO actions in the dashboard still flow through unchanged.
import type { IdleActivity } from '@rizehubhq/shared';
import type { AgentRow, AgentScreenRow, HqSnapshot, RequestRow, TaskRow } from '../../../lib/data/types';

export interface SimOverlay {
  agents: Record<string, Partial<AgentRow>>;
  tasks: Record<string, Partial<TaskRow>>;
  newTasks: TaskRow[];
  screens: Record<string, AgentScreenRow>;
  requests: Record<string, Partial<RequestRow>>;
  newRequests: RequestRow[];
  step: number;
}

export const emptyOverlay = (): SimOverlay => ({ agents: {}, tasks: {}, newTasks: [], screens: {}, requests: {}, newRequests: [], step: 0 });

export function applyOverlay(base: HqSnapshot, o: SimOverlay): HqSnapshot {
  const tasks = base.tasks.map((t) => (o.tasks[t.id] ? { ...t, ...o.tasks[t.id] } : t));
  const baseTaskIds = new Set(base.tasks.map((t) => t.id));
  for (const t of o.newTasks) if (!baseTaskIds.has(t.id)) tasks.push(o.tasks[t.id] ? { ...t, ...o.tasks[t.id] } : t);
  const screenIds = new Set(base.screens.map((s) => s.agent_id));
  const screens = base.screens.map((s) => o.screens[s.agent_id] ?? s);
  for (const s of Object.values(o.screens)) if (!screenIds.has(s.agent_id)) screens.push(s);
  const reqIds = new Set(base.requests.map((r) => r.id));
  const requests = [
    ...o.newRequests.filter((r) => !reqIds.has(r.id)).map((r) => (o.requests[r.id] ? { ...r, ...o.requests[r.id] } : r)),
    ...base.requests.map((r) => (o.requests[r.id] ? { ...r, ...o.requests[r.id] } : r)),
  ];
  return {
    ...base,
    agents: base.agents.map((a) => (o.agents[a.id] ? { ...a, ...o.agents[a.id] } : a)),
    tasks, screens, requests,
  };
}

// ---------------------------------------------------------------- content for synthetic work
const WORK: Record<string, { title: string; work_type: string; app: string; steps: string[] }[]> = {
  dev: [
    { title: 'Product page speed fixes', work_type: 'shopify-section', app: 'editor', steps: ['Deferring app scripts', 'Lazy-loading below the fold', 'Checking CLS at 375px'] },
    { title: 'Footer newsletter block', work_type: 'webflow-cms', app: 'editor', steps: ['Binding CMS fields', 'Styling the mobile layout'] },
  ],
  design: [
    { title: 'Instagram carousel (5 slides)', work_type: 'social-graphics', app: 'browser', steps: ['Blocking out the grid', 'Picking brand colours', 'Exporting 1080×1350'] },
    { title: 'Checkout wireframe', work_type: 'wireframe', app: 'browser', steps: ['Mapping the flow', 'Mobile layout'] },
  ],
  content: [
    { title: 'Product descriptions (8)', work_type: 'landing-copy', app: 'doc', steps: ['Reading brand.md', 'Writing drafts', 'Adding keywords'] },
    { title: 'Weekly captions pack', work_type: 'captions', app: 'doc', steps: ['Drafting hooks', 'Adding hashtags'] },
  ],
  growth: [
    { title: 'Follow-up emails (6 leads)', work_type: 'proposal', app: 'doc', steps: ['Checking the CRM', 'Drafting follow-ups'] },
    { title: 'Lead Finder: NZ Shopify stores', work_type: 'lead-research', app: 'leads', steps: ['Scoring stores', 'Measuring LCP'] },
  ],
  ops: [
    { title: 'Inbox triage', work_type: 'report', app: 'doc', steps: ['Sorting the inbox', 'Drafting replies'] },
  ],
  multimedia: [
    { title: 'Testimonial cut (30s)', work_type: 'reel', app: 'browser', steps: ['Syncing the voiceover', 'Colour grading', 'Rendering'] },
    { title: 'Voiceover: product teaser', work_type: 'voiceover', app: 'browser', steps: ['Recording take 3', 'Cleaning noise', 'Mixing to −14 LUFS'] },
  ],
};
const MEETINGS = ['Brisbane Coffee Co onboarding', 'Vinyl Icons Q4 SEO plan', 'LvlUp site refresh', 'IO holiday campaign'];
const ACTIVITIES: [IdleActivity, number][] = [['coffee', 30], ['lounge_sofa', 20], ['lobby', 15], ['ping_pong', 10], ['foosball', 10], ['chat', 15]];
const PAIRED: IdleActivity[] = ['ping_pong', 'foosball', 'chat'];
const PROTECTED = new Set(['coo']); // the COO's day is driven by planning, not random breaks

function pickWeighted(rng: () => number): IdleActivity {
  const total = ACTIVITIES.reduce((n, [, w]) => n + w, 0);
  let r = rng() * total;
  for (const [a, w] of ACTIVITIES) { r -= w; if (r <= 0) return a; }
  return 'coffee';
}
const pick = <T,>(rng: () => number, list: T[]): T | undefined => (list.length ? list[Math.floor(rng() * list.length)] : undefined);

/**
 * One simulator step. Returns a new overlay (the input is not mutated).
 * `view` must be applyOverlay(base, overlay).
 */
export function simStep(view: HqSnapshot, overlay: SimOverlay, rng: () => number, nowMs: number): SimOverlay {
  const o: SimOverlay = {
    agents: { ...overlay.agents }, tasks: { ...overlay.tasks }, newTasks: [...overlay.newTasks],
    screens: { ...overlay.screens }, requests: { ...overlay.requests }, newRequests: [...overlay.newRequests], step: overlay.step + 1,
  };
  const now = new Date(nowMs).toISOString();
  const agents = new Map(view.agents.map((a) => [a.id, { ...a, ...o.agents[a.id] }]));
  const tasks = new Map(view.tasks.map((t) => [t.id, { ...t, ...o.tasks[t.id] }]));
  const screens = new Map(view.screens.map((s) => [s.agent_id, o.screens[s.agent_id] ?? s]));
  const patchAgent = (id: string, p: Partial<AgentRow>) => {
    o.agents[id] = { ...o.agents[id], ...p, updated_at: now };
    agents.set(id, { ...agents.get(id)!, ...p });
  };
  const patchTask = (id: string, p: Partial<TaskRow>) => {
    o.tasks[id] = { ...o.tasks[id], ...p, updated_at: now };
    tasks.set(id, { ...tasks.get(id)!, ...p });
  };
  const setScreen = (s: AgentScreenRow) => { o.screens[s.agent_id] = s; screens.set(s.agent_id, s); };
  const idle = () => [...agents.values()].filter((a) => a.enabled && a.status === 'idle' && !PROTECTED.has(a.id));
  const working = () => [...agents.values()].filter((a) => a.enabled && a.status === 'working' && !PROTECTED.has(a.id) && a.id !== 'qa-lead');

  // 1) progress ticks for everyone working
  for (const a of agents.values()) {
    if (a.status !== 'working') continue;
    const s = screens.get(a.id);
    if (s) setScreen({ ...s, progress: Math.min(95, (s.progress ?? 0) + 3 + Math.floor(rng() * 9)), updated_at: now });
  }

  const goOnBreak = (a: AgentRow) => {
    let act = pickWeighted(rng);
    if (PAIRED.includes(act)) {
      const partner = pick(rng, idle().filter((x) => x.id !== a.id && !PAIRED.includes(x.idle_activity as IdleActivity)));
      if (partner) patchAgent(partner.id, { idle_activity: act, idle_since: now });
      else act = 'coffee';
    }
    patchAgent(a.id, { status: 'idle', current_task_id: null, idle_activity: act, idle_since: now });
    const s = screens.get(a.id);
    if (s) setScreen({ ...s, app: 'idle', progress: null, step_note: null, updated_at: now });
  };

  const actions = 1 + (rng() < 0.6 ? 1 : 0);
  for (let i = 0; i < actions; i++) {
    const r = rng();
    if (r < 0.3) {
      // finish a task → done gesture → break
      const a = pick(rng, working().filter((x) => (screens.get(x.id)?.progress ?? 0) >= 40));
      if (a) {
        if (a.current_task_id && tasks.has(a.current_task_id)) patchTask(a.current_task_id, { status: 'qa_pending' });
        goOnBreak(a);
      }
    } else if (r < 0.6) {
      // start work: back to the desk
      const a = pick(rng, idle());
      if (a) {
        const open = [...tasks.values()].find((t) => t.agent_id === a.id && ['queued', 'pending', 'revision'].includes(t.status));
        let taskId = open?.id;
        const menu = WORK[a.department] ?? WORK.content;
        const w = menu[Math.floor(rng() * menu.length)];
        if (!taskId) {
          const t: TaskRow = {
            id: `sim-${o.step}-${i}-${a.id}`, request_id: 'sim', client_id: null, agent_id: a.id, title: w.title, instructions: w.title,
            work_type: w.work_type, acceptance_criteria: [], depends_on: [], status: 'working', revision_count: 0, max_revisions: 3,
            output: null, claimed_at: now, started_at: now, completed_at: null, cost_usd: 0, created_at: now, updated_at: now,
          };
          o.newTasks.push(t);
          if (o.newTasks.length > 40) o.newTasks.shift();
          tasks.set(t.id, t);
          taskId = t.id;
        } else patchTask(taskId, { status: 'working', started_at: now });
        const title = tasks.get(taskId)!.title;
        patchAgent(a.id, { status: 'working', current_task_id: taskId, idle_activity: null, idle_since: null });
        setScreen({
          agent_id: a.id, task_id: taskId, app: w.app, title, content: null, image_url: null,
          step_note: w.steps[Math.floor(rng() * w.steps.length)], progress: 5 + Math.floor(rng() * 10), updated_at: now,
        });
      }
    } else if (r < 0.8) {
      // change break activity (pairs for games and chats)
      const a = pick(rng, idle());
      if (a) {
        let act = pickWeighted(rng);
        if (act === a.idle_activity) act = 'coffee';
        if (PAIRED.includes(act)) {
          const partner = pick(rng, idle().filter((x) => x.id !== a.id));
          if (partner) patchAgent(partner.id, { idle_activity: act, idle_since: now });
          else act = 'lounge_sofa';
        }
        patchAgent(a.id, { idle_activity: act, idle_since: now });
      }
    } else {
      // QA Lead resolves a review (nod on pass, head-scratch on fail) and picks the next one
      const qa = agents.get('qa-lead');
      if (qa && qa.enabled && qa.status !== 'offline') {
        const reviewing = [...tasks.values()].find((t) => t.status === 'qa_reviewing' && t.agent_id !== 'qa-lead');
        if (reviewing) patchTask(reviewing.id, { status: rng() < 0.75 ? 'awaiting_ceo' : 'revision' });
        const next = [...tasks.values()].find((t) => t.status === 'qa_pending');
        if (next) {
          patchTask(next.id, { status: 'qa_reviewing' });
          patchAgent('qa-lead', { status: 'working', current_task_id: next.id, idle_activity: null, idle_since: null });
          const s = screens.get('qa-lead');
          setScreen({
            agent_id: 'qa-lead', task_id: next.id, app: 'review', title: next.title, content: null, image_url: null,
            step_note: 'Checking acceptance criteria', progress: 10, updated_at: now, ...(s ? { image_url: s.image_url } : {}),
          });
        }
      }
    }
  }

  // 2) planning meetings: a synthetic request is planned for ~45–70 s, then sent for review.
  const planning = view.requests.find((x) => x.status === 'planning' && !(o.requests[x.id]?.status && o.requests[x.id]!.status !== 'planning'));
  if (planning) {
    const started = new Date(planning.updated_at).getTime();
    if (nowMs - started > 45_000 + rng() * 25_000) o.requests[planning.id] = { ...o.requests[planning.id], status: 'plan_review', updated_at: now };
  } else if (rng() < 0.25) {
    const title = MEETINGS[o.step % MEETINGS.length];
    o.newRequests.unshift({
      id: `sim-req-${o.step}`, source: 'dashboard', raw_text: title, client_id: null, title, brief: null, priority: 'normal',
      due_date: null, status: 'planning', cost_usd: 0, created_at: now, updated_at: now,
    });
    if (o.newRequests.length > 6) o.newRequests.pop();
  }
  return o;
}
