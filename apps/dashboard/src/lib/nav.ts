import {
  Building2, CheckCircle2, ListTodo, Inbox, FileBarChart, ShieldCheck, Target, Briefcase,
  Users, Bot, Plug, Settings, CircleDollarSign, LockKeyhole, Cable, KeyRound, type LucideIcon,
} from 'lucide-react';

export interface NavItem { href: string; label: string; icon: LucideIcon; milestone?: string; description?: string }

export const NAV: NavItem[] = [
  { href: '/', label: 'Office', icon: Building2 },
  { href: '/approvals', label: 'Approvals', icon: CheckCircle2, milestone: 'M5' },
  { href: '/tasks', label: 'Tasks', icon: ListTodo, milestone: 'M5' },
  { href: '/requests', label: 'Requests', icon: Inbox, milestone: 'M4' },
  { href: '/reports', label: 'Daily Reports', icon: FileBarChart, milestone: 'M7' },
  { href: '/qa', label: 'QA Center', icon: ShieldCheck, milestone: 'M6' },
  { href: '/leads', label: 'Leads', icon: Target, milestone: 'M9b' },
  { href: '/jobs', label: 'Jobs', icon: Briefcase, milestone: 'M9b' },
  { href: '/clients', label: 'Clients', icon: Users, milestone: 'M9a' },
  { href: '/agents', label: 'Agents', icon: Bot, milestone: 'M10' },
  { href: '/costs', label: 'Costs', icon: CircleDollarSign },
];

/** Admin section (docs/06 §11): account security, keys, logins and connectors. Hub page: /admin. */
export const ADMIN_NAV: NavItem[] = [
  { href: '/admin/security', label: 'Security', icon: LockKeyhole, description: 'CEO password and two-factor sign-in.' },
  { href: '/admin/connectors', label: 'Connectors', icon: Cable, description: 'Gmail accounts and apps your agents may use.' },
  { href: '/admin/logins', label: 'Tool logins', icon: KeyRound, description: 'RizeHub\'s own tool accounts (Semrush, Canva…) agents may use.' },
  { href: '/connections', label: 'Connections', icon: Plug, milestone: 'M9', description: 'Every client login and token, by platform.' },
  { href: '/settings', label: 'Settings', icon: Settings, milestone: 'M3', description: 'Plan auto-approve rules.' },
];

export const isActive = (href: string, path: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));
