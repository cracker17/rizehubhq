import { ToolLoginsView } from '@/components/admin/ToolLoginsView';
import { loadToolLogins } from '@/lib/data/vault';

export const metadata = { title: 'Tool logins · RizeHub HQ' };
export const dynamic = 'force-dynamic';

// Admin → Tool logins (docs/06 §11, docs/09 "Internal vault"): the agency's own accounts in the Client Vault.
export default async function Page() {
  const page = await loadToolLogins();
  return (
    <div className="flex flex-col gap-4 lg:gap-5">
      <h1 className="text-2xl font-semibold">Tool logins</h1>
      <ToolLoginsView page={page} />
    </div>
  );
}
