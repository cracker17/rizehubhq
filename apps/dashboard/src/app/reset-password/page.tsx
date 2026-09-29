import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isLive } from '@/lib/env';
import { createSupabaseServer } from '@/lib/supabase/server';
import { recoveryFresh } from '@/lib/auth/password';
import type { AmrClaim } from '@/lib/auth/stepUp';
import { NewPasswordForm } from './NewPasswordForm';

export const metadata = { title: 'New password · RizeHub HQ' };
export const dynamic = 'force-dynamic';

// Reached from the reset email via /auth/confirm (and the 2FA step when on). Only a fresh 'recovery' sign-in may set a
// password without the current one; any other session is sent to Admin → Security.
export default async function Page() {
  if (!isLive()) redirect('/');
  const db = (await createSupabaseServer())!;
  const { data: { user } } = await db.auth.getUser();
  if (!user) redirect('/login');
  const { data: aal } = await db.auth.mfa.getAuthenticatorAssuranceLevel();
  const fresh = recoveryFresh((aal?.currentAuthenticationMethods ?? []) as AmrClaim, Math.floor(Date.now() / 1000));
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-sm p-6 sm:p-7">
        <h1 className="text-xl font-semibold">Set a new password</h1>
        {fresh ? (
          <NewPasswordForm />
        ) : (
          <p className="mt-3 text-sm text-[var(--color-muted)]">
            This page only works right after opening a reset link. To change your password while signed in, go to{' '}
            <Link href="/admin/security" className="text-white underline underline-offset-4">Admin → Security</Link>.
          </p>
        )}
      </div>
    </main>
  );
}
