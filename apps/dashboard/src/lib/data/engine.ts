// DEMO-mode mirror of the workflow RPCs (supabase/migrations/20260928010000_workflow_engine.sql):
// create_request, decide_approval and refresh_agent_status. Pure functions on a snapshot so the
// dashboard behaves the same without a database. LIVE mode never uses this — it calls the RPCs.
import type { AgentStatus } from '@rizehubhq/shared';
import type { ActivityRow, ApprovalRow, Decision, HqSnapshot, Priority, RequestRow, TaskRow } from './types';
import { asPlan } from './derive';

const uid = () => (globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}`);
let actSeq = 1_000_000;

function log(s: HqSnapshot, actor: string, action: string, request_id: string | null, task_id: string | null, detail: Record<string, unknown>): ActivityRow[] {
  const row: ActivityRow = { id: ++actSeq, actor, action, request_id, task_id, client_id: null, detail, cost_usd: 0, created_at: new Date().toISOString() };
  return [row, ...s.activity];
}

export function refreshAgentStatus(s: HqSnapshot, agentId: string): HqSnapshot {
  const a = s.agents.find((x) => x.id === agentId);
  if (!a) return s;
  const busy = s.tasks.filter((t) => t.agent_id === agentId && (t.status === 'working' || t.status === 'qa_reviewing'));
  const status: AgentStatus =
    !a.enabled ? 'offline'
    : busy.length ? 'working'
    : s.approvals.some((p) => p.agent_id === agentId && p.status === 'pending') ? 'waiting'
    : s.tasks.some((t) => t.agent_id === agentId && t.status === 'failed' && s.requests.find((r) => r.id === t.request_id)?.status === 'in_progress') ? 'blocked'
    : 'idle';
  const next = {
    ...a, status, current_task_id: busy[0]?.id ?? null,
    idle_activity: status === 'idle' ? a.idle_activity ?? 'coffee' : null,
    idle_since: status === 'idle' ? a.idle_since ?? new Date().toISOString() : null, updated_at: new Date().toISOString(),
  };
  return { ...s, agents: s.agents.map((x) => (x.id === agentId ? next : x)) };
}

export function demoCreateRequest(s: HqSnapshot, input: { text: string; priority: Priority; dueDate: string | null; clientSlug: string | null }): { snapshot: HqSnapshot; id: string } {
  const text = input.text.trim();
  if (!text) throw new Error('request text is empty');
  const id = uid();
  const now = new Date().toISOString();
  const client = input.clientSlug ? s.clients.find((c) => c.slug === input.clientSlug) : undefined;
  const row: RequestRow = {
    id, source: 'dashboard', raw_text: text, client_id: client?.id ?? null, title: null, brief: null, priority: input.priority,
    due_date: input.dueDate, status: 'staged', cost_usd: 0, created_at: now, updated_at: now,
  };
  const next = { ...s, requests: [row, ...s.requests] };
  return { id, snapshot: { ...next, activity: log(next, 'ceo', 'request.created', id, null, { source: 'dashboard', client_slug: input.clientSlug }) } };
}

/** Demo only: the COO "claims" a staged request a moment after it is created. */
export function demoStartPlanning(s: HqSnapshot, requestId: string): HqSnapshot {
  return {
    ...s,
    requests: s.requests.map((r) => (r.id === requestId && r.status === 'staged' ? { ...r, status: 'planning', updated_at: new Date().toISOString() } : r)),
  };
}

function releaseReady(tasks: TaskRow[], requestId: string): TaskRow[] {
  return tasks.map((t) => {
    if (t.request_id !== requestId || t.status !== 'pending') return t;
    const ready = t.depends_on.every((d) => tasks.find((x) => x.id === d)?.status === 'done');
    return ready ? { ...t, status: 'queued' } : t;
  });
}

export function demoDecide(s: HqSnapshot, approvalId: string, decision: Decision, note: string | null): { snapshot: HqSnapshot; result: string } {
  if (decision === 'changes' && !note?.trim()) throw new Error('Say what should change');
  const ap = s.approvals.find((a) => a.id === approvalId);
  if (!ap) throw new Error('approval not found');
  if (ap.status !== 'pending') return { snapshot: s, result: `already_${ap.status}` };
  const now = new Date().toISOString();
  const newStatus: ApprovalRow['status'] = decision === 'approve' ? 'approved' : decision === 'changes' ? 'changes_requested' : 'rejected';
  let next: HqSnapshot = {
    ...s,
    approvals: s.approvals.map((a) => (a.id === ap.id ? { ...a, status: newStatus, ceo_note: note, decided_at: now, decided_via: 'dashboard' } : a)),
  };
  let tasks = next.tasks;
  let requests = next.requests;
  let result = '';
  const setReq = (id: string | null, patch: Partial<RequestRow>) => { requests = requests.map((r) => (r.id === id ? { ...r, ...patch, updated_at: now } : r)); };
  const setTask = (id: string | null, patch: Partial<TaskRow>) => { tasks = tasks.map((t) => (t.id === id ? { ...t, ...patch, updated_at: now } : t)); };
  const task = ap.task_id ? tasks.find((t) => t.id === ap.task_id) : undefined;

  if (ap.kind === 'plan') {
    const rq = requests.find((r) => r.id === ap.request_id);
    if (decision === 'approve' && rq) {
      const plan = asPlan(ap);
      const keymap = new Map((plan.tasks ?? []).map((t) => [t.key, uid()]));
      const created: TaskRow[] = (plan.tasks ?? []).map((t) => ({
        id: keymap.get(t.key)!, request_id: rq.id, client_id: rq.client_id, agent_id: t.agent_id, title: t.title,
        instructions: t.instructions ?? '', work_type: t.work_type, acceptance_criteria: t.acceptance_criteria ?? [],
        depends_on: (t.depends_on ?? []).map((k) => keymap.get(k)!).filter(Boolean), status: 'pending', revision_count: 0,
        max_revisions: 3, output: null, claimed_at: null, started_at: null, completed_at: null, cost_usd: 0, created_at: now, updated_at: now,
      }));
      tasks = releaseReady([...tasks, ...created], rq.id);
      setReq(rq.id, { status: 'in_progress', title: rq.title ?? plan.title });
      result = 'plan_approved';
    } else if (decision === 'changes') {
      setReq(ap.request_id, { status: 'staged' });
      result = 'replan';
    } else {
      setReq(ap.request_id, { status: 'rejected' });
      result = 'plan_rejected';
    }
  } else if (ap.kind === 'deliverable' && task) {
    if (decision === 'approve') { setTask(task.id, { status: 'done', completed_at: now }); tasks = releaseReady(tasks, task.request_id); result = 'task_done'; }
    else if (decision === 'changes') { setTask(task.id, { status: 'queued', revision_count: task.revision_count + 1 }); result = 'task_revision'; }
    else { setTask(task.id, { status: 'cancelled' }); result = 'task_cancelled'; }
    const open = tasks.filter((t) => t.request_id === task.request_id && t.status !== 'done' && t.status !== 'cancelled');
    if (!open.length) {
      const anyDone = tasks.some((t) => t.request_id === task.request_id && t.status === 'done');
      requests = requests.map((r) => (r.id === task.request_id && r.status === 'in_progress' ? { ...r, status: anyDone ? 'done' : 'cancelled', updated_at: now } : r));
    }
  } else {
    if (task && (task.status === 'awaiting_ceo' || task.status === 'failed')) {
      const escalation = (ap.payload as { type?: string }).type === 'qa_escalation';
      setTask(task.id, { status: decision === 'reject' && escalation ? 'cancelled' : 'queued' });
    }
    result = `action_${newStatus}`;
  }

  next = { ...next, tasks, requests };
  if (ap.agent_id) next = refreshAgentStatus(next, ap.agent_id);
  if (task && task.agent_id !== ap.agent_id) next = refreshAgentStatus(next, task.agent_id);
  next = { ...next, activity: log(next, 'ceo', `approval.${newStatus}`, ap.request_id, ap.task_id, { approval_id: ap.id, kind: ap.kind, via: 'dashboard', note }) };
  return { snapshot: next, result };
}
