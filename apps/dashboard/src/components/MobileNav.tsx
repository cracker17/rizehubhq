'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { Building2, CheckCircle2, Plus, FileBarChart, Menu } from 'lucide-react';
import { useHq } from '@/lib/data/store';

const ITEMS = [
  { href: '/', label: 'Office', icon: Building2 },
  { href: '/approvals', label: 'Approvals', icon: CheckCircle2 },
  { href: '/requests', label: 'New', icon: Plus },
  { href: '/reports', label: 'Reports', icon: FileBarChart },
  { href: '/settings', label: 'More', icon: Menu },
];

export function MobileNav() {
  const path = usePathname();
  const { kpis } = useHq();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--color-line)] bg-[var(--color-bg)]/95 backdrop-blur lg:hidden" aria-label="Mobile">
      {ITEMS.map(({ href, label, icon: Icon }) => {
        const active = href === '/' ? path === '/' : path.startsWith(href);
        return (
          <Link key={href} href={href} aria-label={label === 'New' ? 'New request' : undefined} aria-current={active ? 'page' : undefined} className={clsx('relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px]', active ? 'text-white' : 'text-[var(--color-muted)]')}>
            {label === 'New' ? (
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-primary)] text-white"><Icon size={18} /></span>
            ) : (
              <Icon size={20} strokeWidth={1.75} />
            )}
            {label !== 'New' && label}
            {href === '/approvals' && kpis.pendingApprovals > 0 && <span className="absolute right-[26%] top-1.5 rounded bg-[var(--color-primary)] px-1 text-[10px] font-semibold text-white">{kpis.pendingApprovals}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
