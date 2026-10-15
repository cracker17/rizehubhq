import { loadOperatorSetup } from '@/lib/data/operator';
import { OperatorSetup } from '@/components/operator/OperatorSetup';

// Operator setup wizard (docs/17-OPERATOR.md "Setup wizard"): add a client or finish one's setup: browser, logins,
// apps to watch, APIs, then a "Ready?" checklist.
export const metadata = { title: 'Set up a client · Operator · RizeHub HQ' };
export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<{ client?: string; step?: string }> }) {
  const { client, step } = await searchParams;
  const slug = client && /^[a-z0-9][a-z0-9-]{0,63}$/.test(client) ? client : null;
  const { data, error } = await loadOperatorSetup(slug);
  return <OperatorSetup data={data} error={error} initialStep={step} />;
}
