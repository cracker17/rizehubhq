// Hermes run leases + per-run tool state for HQ MCP calls (docs/05 "Hermes runtime", "Run lease").
//
// Every Hermes attempt on a task holds one lease (run id). HQ MCP tool calls must name it (`run_id`) and are refused
// once the lease is revoked: when the run falls back to the built-in runner, ends, or a newer attempt replaces it. The
// Hermes container may keep working after our request timed out (its non-streaming chat API has no stop), so without
// this a late submit_output / request_external_action could race the built-in runner on the same task.
//
// In memory on purpose: the MCP endpoint (routes/mcp.ts) is served by the same worker process that runs the task
// (one hq-worker container), and a lease only has to live as long as that run. A worker restart drops every lease,
// which is the safe direction: stale Hermes calls are refused, never accepted.
//
// Each lease also carries the RunState the built-in tools share across calls (submit_output / ask_ceo "already ended"
// guards, vault_login browser sessions); revoking a lease closes those sessions (cookies wiped).
import { randomUUID } from 'node:crypto';
import { closeRunSessions } from '../vault/browser';
import type { RunState } from '../runner';

interface Lease {
  id: string;
  taskId: string;
  agentId: string;
  state: RunState;
  /** Tool calls currently executing under this lease. */
  inflight: number;
  idle: (() => void)[];
}

/** Active lease per task id. */
const active = new Map<string, Lease>();
/** Recently revoked leases (id → reason), for a clear error to late callers. Bounded. */
const revoked = new Map<string, { taskId: string; reason: string }>();
const MAX_REVOKED = 500;

function remember(l: Lease, reason: string): void {
  revoked.set(l.id, { taskId: l.taskId, reason });
  while (revoked.size > MAX_REVOKED) revoked.delete(revoked.keys().next().value!);
}

function waitIdle(l: Lease, timeoutMs: number): Promise<boolean> {
  if (l.inflight === 0) return Promise.resolve(true);
  if (timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    t.unref?.();
    l.idle.push(() => { clearTimeout(t); resolve(true); });
  });
}

async function close(l: Lease, drainMs: number): Promise<boolean> {
  const drained = await waitIdle(l, drainMs);
  await closeRunSessions(l.state).catch(() => undefined);
  return drained;
}

/** Starts a Hermes attempt on a task: returns its run id. Replaces (revokes) any older lease on the same task. */
export async function acquireHermesLease(taskId: string, agentId: string): Promise<string> {
  const old = active.get(taskId);
  const l: Lease = { id: randomUUID(), taskId, agentId, state: { ended: null, costUsd: 0, overBudget: false, toolErrors: 0 }, inflight: 0, idle: [] };
  active.set(taskId, l);
  if (old) { remember(old, 'superseded by a newer HQ run'); await close(old, 0); }
  return l.id;
}

/**
 * Revokes a lease: from now on its tool calls are refused. Waits up to drainMs for calls already executing under it
 * to finish (so nothing it started can land after the caller moves on). Resolves true when none were left running.
 * Never throws; unknown or already revoked leases resolve true.
 */
export async function revokeHermesLease(taskId: string, runId: string, reason: string, drainMs = 0): Promise<boolean> {
  const l = active.get(taskId);
  if (!l || l.id !== runId) return true;
  active.delete(taskId);
  remember(l, reason);
  return close(l, drainMs);
}

/** The active run id of a task, or null (tests / diagnostics). */
export function activeHermesLease(taskId: string): string | null {
  return active.get(taskId)?.id ?? null;
}

export interface LeaseEntry { runId: string; state: RunState; done: () => void }

/**
 * Admits one MCP tool call on a task: the task must hold an active lease of this agent and the call must name it.
 * Returns the lease's tool state plus done() (call it when the tool finished), or the refusal text for the caller.
 */
export function enterHermesLease(taskId: string, agentId: string, runId: string | null): LeaseEntry | string {
  const stop = 'Stop working on this task and do not call HQ tools for it again.';
  const l = active.get(taskId);
  if (runId) {
    const gone = revoked.get(runId);
    if (gone && gone.taskId === taskId) return `HQ ended this Hermes run of task ${taskId} (${gone.reason}). ${stop}`;
  }
  if (!l || l.agentId !== agentId) {
    return `Task ${taskId} has no active Hermes run for ${agentId} (it runs on the built-in runner, has ended, or the worker restarted). ${stop}`;
  }
  if (!runId) return `Missing run_id: pass the run_id given in your HQ task prompt with every HQ tool call (next to task_id).`;
  if (runId !== l.id) return `run_id ${runId} is not the current HQ run of task ${taskId}. ${stop}`;
  l.inflight++;
  let finished = false;
  return {
    runId: l.id,
    state: l.state,
    done: () => {
      if (finished) return;
      finished = true;
      l.inflight--;
      if (l.inflight === 0) for (const w of l.idle.splice(0)) w();
    },
  };
}

/** Drops every lease (tests). */
export function resetHermesLeases(): void {
  active.clear();
  revoked.clear();
}
