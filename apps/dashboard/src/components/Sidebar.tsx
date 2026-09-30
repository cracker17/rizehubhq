'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import { NAV_GROUPS, NAV_OPEN_KEY, PINNED_NAV, groupOf, isActive, openGroups, type NavGroup, type NavItem } from '@/lib/nav';
import { useHq } from '@/lib/data/store';
import { money } from '@/lib/data/derive';

/**
 * Desktop sidebar: Office + Approvals pinned, everything else in collapsible categories (RizeHub dashboard pattern).
 * The current page's category opens by itself; which ones the CEO leaves open is remembered in this browser.
 */
export function Sidebar() {
  const path = usePathname();
  const { kpis } = useHq();
  // Server render + first paint: only the current page's category (no storage on the server, no hydration mismatch).
  const [open, setOpen] = useState<string[]>(() => openGroups(path, null));
  // No slide animation until the saved state is applied, so a page load doesn't animate groups open.
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    let saved: string | null = null;
    try { saved = window.localStorage.getItem(NAV_OPEN_KEY); } catch { /* storage blocked */ }
    setOpen(openGroups(path, saved));
  }, [path]);
  useEffect(() => { // two frames: the saved state has painted before transitions switch on
    let id = requestAnimationFrame(() => { id = requestAnimationFrame(() => setAnimate(true)); });
    return () => cancelAnimationFrame(id);
  }, []);

  const toggle = (id: string) => setOpen((cur) => {
    const next = cur.includes(id) ? cur.filter((g) => g !== id) : [...cur, id];
    try { window.localStorage.setItem(NAV_OPEN_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
    return next;
  });

  const badges: Record<string, number> = { '/approvals': kpis.pendingApprovals };
  const active = groupOf(path);
  const firstAdmin = NAV_GROUPS.find((g) => g.admin)?.id;

  return (
    <aside className="sticky top-0 hidden h-screen w-[240px] shrink-0 flex-col border-r border-[var(--color-line)] px-3 py-5 lg:flex">
      <Link href="/" className="mb-5 flex items-center gap-2.5 px-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--color-primary)] text-sm font-bold">R</span>
        <span className="leading-tight">
          <span className="block text-[15px] font-semibold">RizeHub HQ</span>
          <span className="block text-xs text-[var(--color-muted)]">AI Virtual Office</span>
        </span>
      </Link>
      <nav className="scroll-thin -mr-1 flex flex-1 flex-col gap-0.5 overflow-y-auto pr-1" aria-label="Main">
        {PINNED_NAV.map((item) => <SideLink key={item.href} item={item} path={path} badge={badges[item.href] ?? 0} />)}
        {NAV_GROUPS.map((g) => (
          <Group
            key={g.id} group={g} path={path} badges={badges}
            open={open.includes(g.id)} current={active === g.id} onToggle={() => toggle(g.id)}
            adminStart={g.id === firstAdmin} animate={animate}
          />
        ))}
      </nav>
      <Link href="/admin/api" className="mt-3 rounded-lg px-3 py-1.5 text-xs text-[var(--color-dim)] hover:bg-[var(--color-panel)] hover:text-[var(--color-muted)]">
        AI settings · spend today <span className="text-[var(--color-muted)]">{money(kpis.spendToday)}</span>
      </Link>
    </aside>
  );
}

function Group({ group, path, badges, open, current, onToggle, adminStart, animate }: {
  group: NavGroup; path: string; badges: Record<string, number>; open: boolean; current: boolean; onToggle: () => void; adminStart: boolean; animate: boolean;
}) {
  const motion = animate ? 'duration-200 motion-reduce:transition-none' : 'transition-none';
  const panel = `nav-${group.id}`;
  // A collapsed category still shows what is waiting inside it.
  const hidden = open ? 0 : group.items.reduce((n, i) => n + (badges[i.href] ?? 0), 0);
  return (
    <div className={clsx('flex flex-col', adminStart ? 'mt-3 border-t border-[var(--color-line)] pt-3' : 'mt-2')}>
      <button
        type="button" onClick={onToggle} aria-expanded={open} aria-controls={panel}
        className={clsx(
          'flex items-center gap-2 rounded-lg px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider transition-colors hover:bg-[var(--color-panel)]',
          current && !open ? 'text-[var(--color-muted)]' : 'text-[var(--color-dim)] hover:text-[var(--color-muted)]',
        )}
      >
        <span className="flex-1 text-left">{group.label}</span>
        {hidden > 0 && <span className="rounded-md bg-[var(--color-primary)] px-1.5 text-[10px] font-semibold normal-case tracking-normal text-white" aria-label={`${hidden} waiting`}>{hidden}</span>}
        <ChevronDown size={14} aria-hidden className={clsx('transition-transform', motion, open ? 'rotate-0' : '-rotate-90')} />
      </button>
      <div id={panel} className={clsx('grid transition-[grid-template-rows]', motion, open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="flex min-h-0 flex-col gap-0.5 overflow-hidden" inert={!open}>
          <div className="h-0.5 shrink-0" />
          {group.items.map((item) => <SideLink key={item.href} item={item} path={path} badge={badges[item.href] ?? 0} />)}
        </div>
      </div>
    </div>
  );
}

function SideLink({ item: { href, label, icon: Icon }, path, badge }: { item: NavItem; path: string; badge: number }) {
  const active = isActive(href, path);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'flex items-center gap-3 rounded-xl px-3 py-2 text-[14px] transition-colors',
        active
          ? 'border border-[var(--color-line-active)] bg-[var(--color-panel-2)] text-white'
          : 'border border-transparent text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-white',
      )}
    >
      <Icon size={17} strokeWidth={1.75} aria-hidden />
      <span className="flex-1">{label}</span>
      {badge > 0 && (
        <span className="rounded-md bg-[var(--color-primary)] px-1.5 text-xs font-semibold text-white" aria-label={`${badge} pending`}>{badge}</span>
      )}
    </Link>
  );
}
