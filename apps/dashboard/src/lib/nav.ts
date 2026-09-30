import {
  Building2, CheckCircle2, ListTodo, Inbox, FileBarChart, ShieldCheck, Target, Briefcase,
  Users, Bot, Plug, CircleDollarSign, LockKeyhole, Cable, KeyRound, Sparkles, ListChecks, type LucideIcon,
} from 'lucide-react';

export interface NavItem { href: string; label: string; icon: LucideIcon; milestone?: string; description?: string }
export interface NavGroup { id: string; label: string; items: NavItem[]; admin?: boolean }

/** Always visible at the top of the sidebar (the CEO's two daily stops). */
export const PINNED_NAV: NavItem[] = [
  { href: '/', label: 'Office', icon: Building2 },
  { href: '/approvals', label: 'Approvals', icon: CheckCircle2, milestone: 'M5' },
];

/**
 * The sidebar's collapsible categories (same pattern as the RizeHub dashboard). `admin` groups are the Admin section
 * (docs/06 §11), listed as cards on the /admin hub with their descriptions.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'work', label: 'Work', items: [
      { href: '/requests', label: 'Requests', icon: Inbox, milestone: 'M4' },
      { href: '/tasks', label: 'Tasks', icon: ListTodo, milestone: 'M5' },
      { href: '/qa', label: 'QA Center', icon: ShieldCheck, milestone: 'M6' },
      { href: '/reports', label: 'Daily Reports', icon: FileBarChart, milestone: 'M7' },
    ],
  },
  {
    id: 'sales', label: 'Sales', items: [
      { href: '/leads', label: 'Leads', icon: Target, milestone: 'M9b' },
      { href: '/clients', label: 'Clients', icon: Users, milestone: 'M9a' },
      { href: '/jobs', label: 'Jobs', icon: Briefcase, milestone: 'M9b' },
    ],
  },
  {
    id: 'team', label: 'Team', items: [
      { href: '/agents', label: 'Agents', icon: Bot, milestone: 'M10' },
      { href: '/costs', label: 'Costs', icon: CircleDollarSign },
    ],
  },
  {
    id: 'integrations', label: 'Integrations', admin: true, items: [
      { href: '/admin/connectors', label: 'Connectors', icon: Cable, description: 'Gmail, calendars, storage and apps your agents may use.' },
      { href: '/admin/logins', label: 'Tool logins', icon: KeyRound, description: 'RizeHub\'s own tool accounts (Semrush, Canva…) agents may use.' },
      { href: '/connections', label: 'Connections', icon: Plug, milestone: 'M9', description: 'Every client login and token, by platform.' },
    ],
  },
  {
    id: 'system', label: 'System', admin: true, items: [
      { href: '/admin/security', label: 'Security', icon: LockKeyhole, description: 'CEO password and two-factor sign-in.' },
      { href: '/admin/api', label: 'API & AI', icon: Sparkles, description: 'AI model profile, budgets and provider API keys.' },
      { href: '/settings', label: 'Auto-approve', icon: ListChecks, milestone: 'M3', description: 'Rules that approve routine plans without asking you.' },
    ],
  },
];

/** Every non-admin page (pinned first). */
export const NAV: NavItem[] = [...PINNED_NAV, ...NAV_GROUPS.filter((g) => !g.admin).flatMap((g) => g.items)];
/** The Admin section's pages (hub page: /admin). */
export const ADMIN_NAV: NavItem[] = NAV_GROUPS.filter((g) => g.admin).flatMap((g) => g.items);

export const isActive = (href: string, path: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));

/** The category holding the current page, or null (pinned pages, the /admin hub). */
export function groupOf(path: string, groups: NavGroup[] = NAV_GROUPS): string | null {
  return groups.find((g) => g.items.some((i) => isActive(i.href, path)))?.id ?? null;
}

/** Local storage key for which categories the CEO left open. */
export const NAV_OPEN_KEY = 'hq.nav.open';

/**
 * Open categories: the ones saved in this browser (unknown ids dropped), plus the current page's category so the
 * active link is never hidden. Nothing saved (first visit, or storage blocked): only the current page's category,
 * which keeps the menu compact.
 */
export function openGroups(path: string, saved: string | null, groups: NavGroup[] = NAV_GROUPS): string[] {
  const ids = groups.map((g) => g.id);
  let open: string[] = [];
  if (saved !== null) {
    try {
      const parsed: unknown = JSON.parse(saved);
      if (Array.isArray(parsed)) open = ids.filter((id) => parsed.includes(id));
    } catch { /* corrupt value: treat as nothing saved */ }
  }
  const active = groupOf(path, groups);
  return active && !open.includes(active) ? [...open, active] : open;
}
