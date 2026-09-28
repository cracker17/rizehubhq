import { ReportsView, type ReportsTab } from '@/components/reports/ReportsView';
import { isIsoDate, loadReports, manilaToday } from '@/lib/data/reports';

export const metadata = { title: 'Daily Reports · RizeHub HQ' };

export default async function Page({ searchParams }: { searchParams: Promise<{ date?: string; tab?: string }> }) {
  const sp = await searchParams;
  const today = manilaToday();
  const date = isIsoDate(sp.date) && sp.date <= today ? sp.date : today;
  const tab: ReportsTab = sp.tab === 'weekly' ? 'weekly' : 'daily';
  const reports = await loadReports(date);
  return <ReportsView reports={reports} tab={tab} />;
}
