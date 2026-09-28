'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { NAV } from '@/lib/nav';
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
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === '/' ? path === '/' : path.startsWith(href);
          return (
            <Link
              key={href}
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
              {href === '/approvals' && kpis.pendingApprovals > 0 && (
                <span className="rounded-md bg-[var(--color-primary)] px-1.5 text-xs font-semibold text-white" aria-label={`${kpis.pendingApprovals} pending`}>{kpis.pendingApprovals}</span>
              )}
            </Link>
          );
        })}
      </nav>
      <p className="mt-4 px-3 text-xs text-[var(--color-dim)]">AI profile: <span className="text-[var(--color-muted)]">free</span> · spend today {money(kpis.spendToday)}</p>
    </aside>
  );
}
