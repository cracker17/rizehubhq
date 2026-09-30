import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { NAV_GROUPS } from '@/lib/nav';

export const metadata = { title: 'Admin · RizeHub HQ' };

// Admin hub (docs/06 §11), grouped like the sidebar. On phones the bottom bar's "More" opens this page, so it also
// lists every page the bar has no room for, under the same categories.
const IN_BOTTOM_BAR = ['/', '/approvals', '/requests', '/reports'];

export default function Page() {
  const admin = NAV_GROUPS.filter((g) => g.admin);
  const others = NAV_GROUPS.filter((g) => !g.admin)
    .map((g) => ({ ...g, items: g.items.filter((i) => !IN_BOTTOM_BAR.includes(i.href)) }))
    .filter((g) => g.items.length);
  return (
    <div className="flex flex-col gap-4 lg:gap-5">
      <h1 className="order-first text-2xl font-semibold">Admin</h1>
      {admin.map((g) => (
        <section key={g.id} aria-labelledby={`admin-${g.id}`} className="flex flex-col gap-2">
          <h2 id={`admin-${g.id}`} className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-dim)]">{g.label}</h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {g.items.map(({ href, label, icon: Icon, description }) => (
              <li key={href}>
                <Link href={href} className="card flex h-full items-center gap-4 p-4 hover:border-[var(--color-line-active)] sm:p-5">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-panel-2)]"><Icon size={20} strokeWidth={1.75} aria-hidden /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{label}</span>
                    {description && <span className="mt-0.5 block text-sm text-[var(--color-muted)]">{description}</span>}
                  </span>
                  <ChevronRight size={18} className="shrink-0 text-[var(--color-dim)]" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {/* Phones: the everyday pages first (this is the bottom bar's "More"), the admin cards after. */}
      <div className="order-first flex flex-col gap-4 lg:hidden">
        {others.map((g) => (
          <section key={g.id} aria-labelledby={`pages-${g.id}`}>
            <h2 id={`pages-${g.id}`} className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-dim)]">{g.label}</h2>
            <ul className="card divide-y divide-[var(--color-line)]">
              {g.items.map(({ href, label, icon: Icon }) => (
                <li key={href}>
                  <Link href={href} className="flex min-h-12 items-center gap-3 px-4 py-3">
                    <Icon size={18} strokeWidth={1.75} aria-hidden className="text-[var(--color-muted)]" />
                    <span className="flex-1">{label}</span>
                    <ChevronRight size={16} className="text-[var(--color-dim)]" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
