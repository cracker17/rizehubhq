import { JobsView } from '@/components/jobs/JobsView';
import { loadJobs } from '@/lib/data/rizehub';

export const metadata = { title: 'Jobs · RizeHub HQ' };

export default async function Page({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const [{ job }, data] = await Promise.all([searchParams, loadJobs()]);
  return <JobsView data={data} initialJobId={typeof job === 'string' ? job : null} />;
}
