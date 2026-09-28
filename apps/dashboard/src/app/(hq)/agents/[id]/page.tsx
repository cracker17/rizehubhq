import { notFound } from 'next/navigation';
import { AgentDetailView } from '@/components/agents/AgentsView';
import { loadAgentDetail } from '@/lib/data/vault';

export const metadata = { title: 'Agent · RizeHub HQ' };
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data, error } = await loadAgentDetail(id);
  if (!data) {
    if (error) return <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">Couldn&apos;t load this agent: {error}</p>;
    notFound();
  }
  return <AgentDetailView detail={data} error={error} />;
}
