// External-action approvals: who carries the action out after the CEO approves.
// Only these types have a worker executor (apps/worker/src/rizehub/background.ts WORKER_EXECUTED_ACTIONS);
// every other approved action is a MANUAL step for the CEO. Agent-proposed actions carry spec.executor.
import type { ApprovalRow } from './types';

export const WORKER_EXECUTED_ACTIONS: readonly string[] = ['rizehub.report_publish', 'rizehub.invite_send', 'rizehub.onboarding', 'gmail.send', 'mcp.call'];

export interface ActionExecution {
  /** payload.action_type, e.g. "merge_pr" */
  actionType: string | null;
  /** 'worker' runs automatically after approval, 'manual' = the CEO does it. null = not an agent-proposed action (question, escalation…). */
  executor: 'worker' | 'manual' | null;
  /** What exactly should happen (the agent's spec). */
  spec: string | null;
}

export function actionExecution(ap: Pick<ApprovalRow, 'kind' | 'payload'>): ActionExecution {
  const p = (ap.payload ?? {}) as Record<string, unknown>;
  if (ap.kind !== 'external_action' || p.type !== 'external_action') return { actionType: null, executor: null, spec: null };
  const actionType = typeof p.action_type === 'string' && p.action_type ? p.action_type : null;
  const spec = (p.spec ?? {}) as Record<string, unknown>;
  const declared = spec.executor === 'worker' || spec.executor === 'manual' ? spec.executor : null;
  const executor = declared ?? (actionType && WORKER_EXECUTED_ACTIONS.includes(actionType) ? 'worker' : 'manual');
  const text = typeof spec.description === 'string' && spec.description.trim() ? spec.description : null;
  return { actionType, executor, spec: text };
}
