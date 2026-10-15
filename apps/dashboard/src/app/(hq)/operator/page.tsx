import { demoOperator, loadOperatorHome } from '@/lib/data/operator';
import { OperatorHome } from '@/components/operator/OperatorHome';
import { OperatorDemoPlayer } from '@/components/operator/OperatorDemoPlayer';

// Julev Operator (docs/17-OPERATOR.md "Operator page"): live screen, step-by-step feed, inbox, watched chats.
export const metadata = { title: 'Operator · RizeHub HQ' };
export const dynamic = 'force-dynamic';

// ?demo=1 plays the scripted demo with fake data even on the live dashboard (nothing is written anywhere).
export default async function Page({ searchParams }: { searchParams: Promise<{ demo?: string }> }) {
  const { demo } = await searchParams;
  if (demo === '1') return <OperatorDemoPlayer base={demoOperator()} />;
  const { data, error } = await loadOperatorHome();
  return data.demo ? <OperatorDemoPlayer base={data} error={error} /> : <OperatorHome data={data} error={error} />;
}
