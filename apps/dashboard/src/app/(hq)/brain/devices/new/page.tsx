import Link from 'next/link';
import { isLive } from '@/lib/env';
import { loadBrainPeople } from '@/lib/data/brain';
import { SetupWizard } from '@/components/brain/SetupWizard';

// Brain › Devices › Set up a computer (HQ Brain P1).
export const metadata = { title: 'Set up a computer · Brain · RizeHub HQ' };
export const dynamic = 'force-dynamic';

export default async function Page() {
  // joined, enabled people can get an HQ Sync PC (P3)
  const { data } = await loadBrainPeople();
  const people = data.people.filter((p) => p.joined_at && !p.disabled_at && p.role !== 'viewer').map((p) => ({ id: p.id, name: p.name }));
  return (
    <div className="flex flex-col gap-4">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[.12em] text-[var(--color-dim)]"><Link href="/brain" className="hover:text-[var(--color-ink)]">Brain</Link> › <Link href="/brain/devices" className="hover:text-[var(--color-ink)]">Devices</Link> › New</p>
        <h1 className="text-2xl font-semibold">Set up a computer</h1>
        <p className="max-w-[68ch] text-sm text-[var(--color-muted)]">One link for one computer. The checklist ticks itself as the installer reports each step, and the device counts as ready only after a test note makes the full trip.</p>
      </header>
      <SetupWizard demo={!isLive()} people={people} />
    </div>
  );
}
