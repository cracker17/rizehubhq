import { CostsView } from '@/components/costs/CostsView';
import { loadCosts } from '@/lib/data/costs';

export const metadata = { title: 'Costs · RizeHub HQ' };

export default async function Page({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const sp = await searchParams;
  const { summary, mode, error } = await loadCosts(sp.range === '7' ? 7 : 30);
  return <CostsView summary={summary} mode={mode} error={error} />;
}
