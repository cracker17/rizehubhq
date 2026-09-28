import { redirect } from 'next/navigation';
import { isLive } from '@/lib/env';
import { safeNext } from '@/lib/auth/stepUp';
import { LoginForm } from './LoginForm';
import { TotpForm } from './TotpForm';

export const metadata = { title: 'Sign in · RizeHub HQ' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; step?: string }> }) {
  if (!isLive()) redirect('/'); // DEMO mode has no accounts
  const { next, step } = await searchParams;
  // step=totp: the middleware only shows it to a password-signed-in session whose 2FA step is still open.
  const totp = step === 'totp';
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-primary)] text-base font-bold">R</span>
          <span className="leading-tight">
            <span className="block text-lg font-semibold">RizeHub HQ</span>
            <span className="block text-xs text-[var(--color-muted)]">AI Virtual Office</span>
          </span>
        </div>
        <div className="card p-6 sm:p-7">
          <h1 className="text-xl font-semibold">{totp ? 'Two-factor check' : 'Sign in'}</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">{totp ? 'Password accepted. One more step.' : 'CEO account only.'}</p>
          {totp ? <TotpForm next={safeNext(next)} /> : <LoginForm next={next ?? '/'} />}
        </div>
      </div>
    </main>
  );
}
