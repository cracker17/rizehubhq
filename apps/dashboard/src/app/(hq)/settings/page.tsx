import Link from 'next/link';
import { AutoApproveCard } from '@/components/settings/AutoApproveCard';
import { loadSettings } from '@/lib/data/settings';

export const metadata = { title: 'Auto-approve · RizeHub HQ' };

export default async function Page() {
  const s = await loadSettings();
  return (
    <div className="flex flex-col gap-4 lg:gap-5">
      <h1 className="text-2xl font-semibold">Auto-approve</h1>
      {s.error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">Couldn&apos;t load everything: {s.error}</p>}
      <AutoApproveCard initial={s.rules} clients={s.clients} events={s.events} />
      <p className="text-sm text-[var(--color-dim)]">
        AI model profile and budgets: <Link href="/admin/api" className="text-[var(--color-muted)] underline underline-offset-4">Admin → API &amp; AI</Link>.
        Password and two-factor sign-in: <Link href="/admin/security" className="text-[var(--color-muted)] underline underline-offset-4">Admin → Security</Link>.
      </p>
    </div>
  );
}
