import type { AgentStatus } from '@rizehubhq/shared';

export const STATUS_COLOR: Record<AgentStatus, string> = {
  working: 'var(--color-success)',
  idle: 'var(--color-warning)',
  waiting: 'var(--color-primary-hover)',
  blocked: 'var(--color-danger)',
  offline: 'var(--color-dim)',
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'Working',
  idle: 'On break',
  waiting: 'Needs you',
  blocked: 'Blocked',
  offline: 'Offline',
};
