import { ConnectorsView } from '@/components/admin/ConnectorsView';
import { loadConnectors } from '@/lib/data/connectors';

export const metadata = { title: 'Connectors · RizeHub HQ' };

// Admin → Connectors (docs/15, docs/06 §11).
export default async function Page({ searchParams }: { searchParams: Promise<{ connected?: string; storageConnected?: string; mcpError?: string }> }) {
  const [page, q] = await Promise.all([loadConnectors(), searchParams]);
  return (
    <div className="flex flex-col gap-4 lg:gap-5">
      <h1 className="text-2xl font-semibold">Connectors</h1>
      <ConnectorsView page={page} connected={q.connected ?? null} storageConnected={q.storageConnected ?? null} mcpError={q.mcpError?.slice(0, 300) ?? null} />
    </div>
  );
}
