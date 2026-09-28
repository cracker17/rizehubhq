import { notFound } from 'next/navigation';
import { ClientDetailView, type ClientTab } from '@/components/clients/ClientDetailView';
import { loadClientDetail } from '@/lib/data/vault';

export const metadata = { title: 'Client · RizeHub HQ' };
export const dynamic = 'force-dynamic';

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; add?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const { data, error } = await loadClientDetail(id);
  if (!data) {
    if (error) return <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">Couldn&apos;t load this client: {error}</p>;
    notFound();
  }
  const tab: ClientTab = sp.tab === 'access' || sp.tab === 'requests' ? sp.tab : 'profile';
  return <ClientDetailView detail={data} tab={tab} add={tab === 'access' && sp.add === '1'} error={error} />;
}
