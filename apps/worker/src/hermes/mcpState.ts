// Per-task tool state for HQ MCP calls from Hermes (the same RunState object the built-in runner passes to its
// tools, so submit_output/ask_ceo "already ended" guards and vault_login browser sessions work across calls).
// The Hermes runner releases it when the run ends (vault sessions closed, cookies wiped).
import { closeRunSessions } from '../vault/browser';
import type { RunState } from '../runner';

const states = new Map<string, { agentId: string; state: RunState }>();

export function mcpTaskState(taskId: string, agentId: string): RunState {
  let e = states.get(taskId);
  if (!e || e.agentId !== agentId) {
    e = { agentId, state: { ended: null, costUsd: 0, overBudget: false, toolErrors: 0 } };
    states.set(taskId, e);
  }
  return e.state;
}

export async function releaseMcpTaskState(taskId: string): Promise<void> {
  const e = states.get(taskId);
  if (!e) return;
  states.delete(taskId);
  await closeRunSessions(e.state);
}

/** Releases every state of an agent except the given task (its previous tasks' sessions). */
export async function releaseOtherMcpStates(agentId: string, keepTaskId: string): Promise<void> {
  for (const [id, e] of [...states]) if (e.agentId === agentId && id !== keepTaskId) await releaseMcpTaskState(id);
}
