import { ApiSettingsView } from '@/components/admin/ApiSettingsView';
import { loadApiSettings } from '@/lib/data/apiSettings';

export const metadata = { title: 'API & AI · RizeHub HQ' };

// Admin → API & AI (docs/14 "Dashboard settings", docs/06 §11): model profile, budgets, per-role models and provider keys.
export default async function Page() {
  const page = await loadApiSettings();
  return (
    <div className="flex flex-col gap-4 lg:gap-5">
      <h1 className="text-2xl font-semibold">API &amp; AI</h1>
      <ApiSettingsView page={page} />
    </div>
  );
}
