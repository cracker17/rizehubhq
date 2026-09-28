import {
  Building2, CheckCircle2, ListTodo, Inbox, FileBarChart, ShieldCheck, Target, Briefcase,
  Users, Bot, Plug, Settings, type LucideIcon,
} from 'lucide-react';

export interface NavItem { href: string; label: string; icon: LucideIcon; milestone?: string }

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
  { href: '/connections', label: 'Connections', icon: Plug, milestone: 'M9' },
  { href: '/settings', label: 'Settings', icon: Settings, milestone: 'M3' },
];
