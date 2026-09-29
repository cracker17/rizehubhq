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
//
// The Claude runtime (claude/runner.ts) uses the same leases with a per-run bearer token instead of the static
// HQ_MCP_TOKEN_<AGENT>: issueRunToken() binds a random token to one lease (agent + task + run id), so the Claude Code
// process never passes task_id / run_id, and its token is worthless once the run ends (calls are refused).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeRunSessions } from '../vault/browser';
import type { RunState } from '../runner';

interface Lease {
  id: string;
  taskId: string;
  agentId: string;
  /** Runtime name used in refusals ("HQ ended this Claude run …"). */
  label: string;
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

/** Starts a Hermes (or Claude) attempt on a task: returns its run id. Replaces (revokes) any older lease on the same task. */
export async function acquireHermesLease(taskId: string, agentId: string, label = 'Hermes'): Promise<string> {
  const old = active.get(taskId);
  const l: Lease = { id: randomUUID(), taskId, agentId, label, state: { ended: null, costUsd: 0, overBudget: false, toolErrors: 0 }, inflight: 0, idle: [] };
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
export function enterHermesLease(taskId: string, agentId: string, runId: string | null, label = 'Hermes'): LeaseEntry | string {
  const stop = 'Stop working on this task and do not call HQ tools for it again.';
  const l = active.get(taskId);
  if (runId) {
    const gone = revoked.get(runId);
    if (gone && gone.taskId === taskId) return `HQ ended this ${label} run of task ${taskId} (${gone.reason}). ${stop}`;
  }
  if (!l || l.agentId !== agentId) {
    return `Task ${taskId} has no active ${label} run for ${agentId} (it runs on the built-in runner, has ended, or the worker restarted). ${stop}`;
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

// ---------- per-run bearer tokens (Claude runtime) ----------

export interface RunTokenBinding { agentId: string; taskId: string; runId: string; label: string }

/** sha256(token) → run. Kept after the run ends (bounded) so late calls get the clear "HQ ended this run" refusal. */
const runTokens = new Map<string, RunTokenBinding>();
const MAX_RUN_TOKENS = 500;
const tokenKey = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * A fresh random bearer token for the HQ MCP endpoint, bound to the task's ACTIVE lease with this run id: calls with it
 * act as that agent, on that task, under that run only. Throws when runId is not the task's active lease.
 */
export function issueRunToken(taskId: string, runId: string): string {
  const l = active.get(taskId);
  if (!l || l.id !== runId) throw new Error(`no active run ${runId} on task ${taskId}`);
  const token = randomBytes(32).toString('hex');
  runTokens.set(tokenKey(token), { agentId: l.agentId, taskId, runId, label: l.label });
  while (runTokens.size > MAX_RUN_TOKENS) runTokens.delete(runTokens.keys().next().value!);
  return token;
}

/** The run a per-run bearer token was issued for (Authorization header value), or null. */
export function runForToken(header: string | string[] | undefined): RunTokenBinding | null {
  const h = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h ?? '');
  if (!m) return null;
  return runTokens.get(tokenKey(m[1]!)) ?? null;
}

/** Drops every lease and run token (tests). */
export function resetHermesLeases(): void {
  active.clear();
  revoked.clear();
  runTokens.clear();
}
