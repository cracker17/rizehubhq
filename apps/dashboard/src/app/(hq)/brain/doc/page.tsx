import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { loadBrainDoc } from '@/lib/data/brain';
import { Markdown } from '@/components/brain/Markdown';

// One vault file, rendered (search hits, activity rows, a project's Files tab).
export const metadata = { title: 'File · Brain · RizeHub HQ' };
export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<{ path?: string | string[] }> }) {
  const raw = (await searchParams).path;
  const path = typeof raw === 'string' ? raw.slice(0, 400) : '';
  if (!path || !path.endsWith('.md') || path.includes('..')) notFound();
  const { data, error } = await loadBrainDoc(path);
  if (!data) {
    if (error) return <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">{error}</p>;
    notFound();
  }
  const back = data.project_slug ? `/brain/${data.project_slug}` : '/brain';
  return (
    <div className="flex flex-col gap-4">
      <Link href={back} className="inline-flex w-fit items-center gap-1.5 text-sm text-[var(--color-muted)] hover:text-white"><ArrowLeft size={15} aria-hidden />{data.project_slug ?? 'Brain'}</Link>
      <article className="card p-4 sm:p-6">
        <p className="mb-3 break-all font-mono text-[11px] text-[var(--color-dim)]">{data.path}{data.doc_date ? ` · ${data.doc_date}` : ''}</p>
        <Markdown source={data.body} />
      </article>
    </div>
  );
}
