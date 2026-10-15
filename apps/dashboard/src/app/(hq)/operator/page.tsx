import { loadOperatorHome } from '@/lib/data/operator';
import { OperatorHome } from '@/components/operator/OperatorHome';

// Julev Operator (docs/17-OPERATOR.md "Operator page"): live screen, step-by-step feed, inbox, watched chats.
export const metadata = { title: 'Operator · RizeHub HQ' };
export const dynamic = 'force-dynamic';

export default async function Page() {
  const { data, error } = await loadOperatorHome();
  return <OperatorHome data={data} error={error} />;
}
