import Link from 'next/link';
import { loadBrainPeople } from '@/lib/data/brain';
import { PeopleView } from '@/components/brain/PeopleView';

// Brain › People (HQ Brain P2): who can see which projects.
export const metadata = { title: 'People · Brain · RizeHub HQ' };
export const dynamic = 'force-dynamic';

export default async function Page() {
  const { data, error } = await loadBrainPeople();
  return (
    <div className="flex flex-col gap-4">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[.12em] text-[var(--color-dim)]"><Link href="/brain" className="hover:text-[var(--color-ink)]">Brain</Link> › People</p>
        <h1 className="text-2xl font-semibold">People &amp; access</h1>
        <p className="max-w-[68ch] text-sm text-[var(--color-muted)]">Each person sees only the projects you switch on. Your profile, guides, scheduled tasks and the secrets index are never shared.</p>
      </header>
      <PeopleView people={data.people} projects={data.projects} demo={data.demo} error={error} />
    </div>
  );
}
