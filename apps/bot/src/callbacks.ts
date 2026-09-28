// Inline button payloads (docs/08): `ap:<approval_id>:<approve|changes|reject>` (≤ 64 bytes).
import type { Decision } from './types';

const RE = /^ap:([0-9a-f-]{36}):(approve|changes|reject)$/i;

export function callbackData(approvalId: string, action: Decision): string {
  return `ap:${approvalId}:${action}`;
}

export function parseCallback(data: string | undefined | null): { approvalId: string; action: Decision } | null {
  const m = RE.exec(data ?? '');
  return m ? { approvalId: m[1]!.toLowerCase(), action: m[2]!.toLowerCase() as Decision } : null;
}
