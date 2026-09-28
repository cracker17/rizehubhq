import { ClipboardList, FileCheck2, Zap } from 'lucide-react';

export const KIND = {
  plan: { label: 'Plan', icon: ClipboardList, color: 'var(--color-primary-hover)' },
  deliverable: { label: 'Deliverable', icon: FileCheck2, color: 'var(--color-teal)' },
  external_action: { label: 'Action', icon: Zap, color: 'var(--color-warning)' },
} as const;
