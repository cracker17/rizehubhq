import { loadBrainHome } from '@/lib/data/brain';
import { BrainHome } from '@/components/brain/BrainHome';

// HQ Brain (docs/16-BRAIN.md "UI"): the animated core, search, projects, activity, devices.
export const metadata = { title: 'Brain · RizeHub HQ' };
export const dynamic = 'force-dynamic';

export default async function Page() {
  const { data, error } = await loadBrainHome();
  return <BrainHome data={data} error={error} />;
}
