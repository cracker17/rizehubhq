import { ApprovalsInbox } from '@/components/approvals/ApprovalsInbox';

export const metadata = { title: 'Approvals · RizeHub HQ' };

export default async function Page({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  return <ApprovalsInbox initialId={id} />;
}
