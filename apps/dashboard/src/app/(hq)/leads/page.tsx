import { LeadsBoard } from '@/components/leads/LeadsBoard';
import { loadLeads } from '@/lib/data/rizehub';

export const metadata = { title: 'Leads · RizeHub HQ' };

export default async function Page() {
  return <LeadsBoard data={await loadLeads()} />;
}
