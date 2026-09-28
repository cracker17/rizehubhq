import { AgentsView } from '@/components/agents/AgentsView';
import { loadRoster } from '@/lib/data/vault';

export const metadata = { title: 'Agents · RizeHub HQ' };
export const dynamic = 'force-dynamic';

export default async function Page() {
  const { data, error } = await loadRoster();
  return <AgentsView agents={data} error={error} />;
}
