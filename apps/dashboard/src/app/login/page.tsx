import { redirect } from 'next/navigation';
import { isLive } from '@/lib/env';
import { safeNext } from '@/lib/auth/stepUp';
import { LoginForm } from './LoginForm';
import { TotpForm } from './TotpForm';
import { ResetRequestForm } from './ResetRequestForm';

export const metadata = { title: 'Sign in · RizeHub HQ' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; step?: string; reset?: string }> }) {
  if (!isLive()) redirect('/'); // DEMO mode has no accounts
  const { next, step, reset } = await searchParams;
  // step=totp: the middleware only shows it to a signed-in session whose 2FA step is still open (after the password,
  // or after a reset link). step=reset: "Forgot password?" (docs/09 "CEO password").
  const totp = step === 'totp';
  const forgot = !totp && step === 'reset';
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
          <h1 className="text-xl font-semibold">{totp ? 'Two-factor check' : forgot ? 'Reset password' : 'Sign in'}</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {totp ? 'One more step.' : forgot ? 'We’ll email you a link to set a new password.' : 'CEO account only.'}
          </p>
          {reset === 'expired' && forgot && (
            <p role="alert" className="mt-4 text-sm text-[#ff8a8d]">That reset link is invalid or expired. Ask for a new one.</p>
          )}
          {totp ? <TotpForm next={safeNext(next)} /> : forgot ? <ResetRequestForm /> : <LoginForm next={next ?? '/'} />}
        </div>
      </div>
    </main>
  );
}
