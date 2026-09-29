import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { ADMIN_NAV, NAV } from '@/lib/nav';

export const metadata = { title: 'Admin · RizeHub HQ' };

// Admin hub (docs/06 §11). On phones the bottom bar's "More" opens this page, so it also lists every other page.
export default function Page() {
  const others = NAV.filter((i) => !['/', '/approvals', '/requests', '/reports'].includes(i.href));
  return (
    <div className="flex flex-col gap-4 lg:gap-5">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <section aria-labelledby="admin-tools" className="flex flex-col gap-3">
        <h2 id="admin-tools" className="sr-only">Admin tools</h2>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {ADMIN_NAV.map(({ href, label, icon: Icon, description }) => (
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
      <section aria-labelledby="admin-pages" className="lg:hidden">
        <h2 id="admin-pages" className="mb-2 text-sm font-medium text-[var(--color-muted)]">All pages</h2>
        <ul className="card divide-y divide-[var(--color-line)]">
          {others.map(({ href, label, icon: Icon }) => (
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
    </div>
  );
}
