import { notFound } from 'next/navigation';
import { isLive } from '@/lib/env';
import { loadBrainProject } from '@/lib/data/brain';
import { ProjectView } from '@/components/brain/ProjectView';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: `${slug} · Brain · RizeHub HQ` };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) notFound();
  const { data, error } = await loadBrainProject(slug);
  if (!data.bundle) {
    if (error) return <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">{error}</p>;
    notFound();
  }
  return <ProjectView bundle={data.bundle} events={data.events} demo={!isLive()} error={error} />;
}
