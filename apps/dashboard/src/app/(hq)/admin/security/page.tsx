import { SecurityCard } from '@/components/settings/SecurityCard';
import { PasswordCard } from '@/components/admin/PasswordCard';
import { loadSecurity } from '@/lib/data/settings';

export const metadata = { title: 'Security · RizeHub HQ' };

// Admin → Security (docs/06 §11, docs/09 "CEO password" + "Two-factor (TOTP)").
export default async function Page() {
  const s = await loadSecurity();
  const demo = s.mode === 'demo';
  return (
    <div className="flex flex-col gap-4 lg:gap-5">
      <h1 className="text-2xl font-semibold">Security</h1>
      <PasswordCard totpOn={s.security?.totp === 'on'} demo={demo} />
      <SecurityCard status={s.security} demo={demo} />
    </div>
  );
}
