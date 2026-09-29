'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { ADMIN_NAV, NAV, isActive, type NavItem } from '@/lib/nav';
import { useHq } from '@/lib/data/store';
import { money } from '@/lib/data/derive';

export function Sidebar() {
  const path = usePathname();
  const { kpis } = useHq();
  return (
    <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col border-r border-[var(--color-line)] px-4 py-6 lg:flex">
      <Link href="/" className="mb-8 flex items-center gap-2.5 px-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--color-primary)] text-sm font-bold">R</span>
        <span className="leading-tight">
          <span className="block text-[15px] font-semibold">RizeHub HQ</span>
          <span className="block text-xs text-[var(--color-muted)]">AI Virtual Office</span>
        </span>
      </Link>
      <nav className="scroll-thin flex flex-1 flex-col gap-1 overflow-y-auto" aria-label="Main">
        {NAV.map((item) => <SideLink key={item.href} item={item} path={path} badge={item.href === '/approvals' ? kpis.pendingApprovals : 0} />)}
        <p className="mb-1 mt-5 px-3 text-[11px] font-medium uppercase tracking-wider text-[var(--color-dim)]" id="nav-admin">Admin</p>
        <div role="group" aria-labelledby="nav-admin" className="flex flex-col gap-1">
          {ADMIN_NAV.map((item) => <SideLink key={item.href} item={item} path={path} badge={0} />)}
        </div>
      </nav>
      <p className="mt-4 px-3 text-xs text-[var(--color-dim)]">AI profile: <span className="text-[var(--color-muted)]">free</span> · spend today {money(kpis.spendToday)}</p>
    </aside>
  );
}

function SideLink({ item: { href, label, icon: Icon }, path, badge }: { item: NavItem; path: string; badge: number }) {
  const active = isActive(href, path);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] transition-colors',
        active
          ? 'border border-[var(--color-line-active)] bg-[var(--color-panel-2)] text-white'
          : 'border border-transparent text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-white',
      )}
    >
      <Icon size={18} strokeWidth={1.75} />
      <span className="flex-1">{label}</span>
      {badge > 0 && (
        <span className="rounded-md bg-[var(--color-primary)] px-1.5 text-xs font-semibold text-white" aria-label={`${badge} pending`}>{badge}</span>
      )}
    </Link>
  );
}
