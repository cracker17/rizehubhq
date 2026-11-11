import Link from 'next/link';
import { Plus } from 'lucide-react';
import { loadBrainDevices } from '@/lib/data/brain';
import { DevicesView } from '@/components/brain/DevicesView';

// Brain › Devices (HQ Brain P1): computers + Claude apps with sync health, and the way in to "Set up a computer".
export const metadata = { title: 'Devices · Brain · RizeHub HQ' };
export const dynamic = 'force-dynamic';

export default async function Page() {
  const { data, error } = await loadBrainDevices();
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] uppercase tracking-[.12em] text-[var(--color-dim)]"><Link href="/brain" className="hover:text-[var(--color-ink)]">Brain</Link> › Devices</p>
          <h1 className="text-2xl font-semibold">Devices</h1>
          <p className="text-sm text-[var(--color-muted)]">Every computer and Claude app that can read or save to the Brain, and what it is doing right now.</p>
        </div>
        {/* btn.primary's classes inline: components/clients/ui is a client module, its constants don't reach server components */}
        <Link href="/brain/devices/new" className="inline-flex h-10 items-center justify-center gap-2 rounded-[10px] bg-[var(--color-primary)] px-4 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"><Plus size={16} aria-hidden />Set up a computer</Link>
      </header>
      <DevicesView devices={data.devices} connections={data.connections} health={data.health} demo={data.demo} error={error} />
    </div>
  );
}
