import { SecurityCard } from '@/components/settings/SecurityCard';
import { AutoApproveCard } from '@/components/settings/AutoApproveCard';
import { loadSettings } from '@/lib/data/settings';

export const metadata = { title: 'Settings · RizeHub HQ' };

export default async function Page() {
  const s = await loadSettings();
  return (
    <div className="flex flex-col gap-4 lg:gap-5">
      <h1 className="text-2xl font-semibold">Settings</h1>
      {s.error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">Couldn&apos;t load everything: {s.error}</p>}
      <SecurityCard status={s.security} demo={s.mode === 'demo'} />
      <AutoApproveCard initial={s.rules} clients={s.clients} events={s.events} />
      <p className="text-sm text-[var(--color-dim)]">Budgets, AI profile, digest times and QA thresholds arrive in a later milestone.</p>
    </div>
  );
}
