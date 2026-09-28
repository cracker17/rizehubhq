import { ClientsView } from '@/components/clients/ClientsView';
import { loadClientSummaries } from '@/lib/data/vault';

export const metadata = { title: 'Clients · RizeHub HQ' };
export const dynamic = 'force-dynamic';

export default async function Page() {
  const { data, error } = await loadClientSummaries();
  return <ClientsView clients={data} error={error} />;
}
