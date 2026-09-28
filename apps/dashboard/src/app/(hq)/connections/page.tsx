import { ConnectionsView } from '@/components/connections/ConnectionsView';
import { loadConnections } from '@/lib/data/vault';

export const metadata = { title: 'Connections · RizeHub HQ' };
export const dynamic = 'force-dynamic';

export default async function Page() {
  const { data, error } = await loadConnections();
  return <ConnectionsView data={data} error={error} />;
}
