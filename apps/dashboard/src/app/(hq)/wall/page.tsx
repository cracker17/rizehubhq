import { loadOperatorHome } from '@/lib/data/operator';
import { WallView } from '@/components/wall/WallView';

// Live wall (docs/17-OPERATOR.md "Live wall"): every AI worker's screen at once, with replay.
export const metadata = { title: 'Live wall · RizeHub HQ' };
export const dynamic = 'force-dynamic';

export default async function Page() {
  // The operator part is optional: before its migration the wall still shows the six agents.
  const op = await loadOperatorHome();
  return <WallView operator={op.error ? null : op.data} />;
}
