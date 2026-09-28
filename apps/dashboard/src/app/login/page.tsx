import { redirect } from 'next/navigation';
import { isLive } from '@/lib/env';
import { LoginForm } from './LoginForm';

export const metadata = { title: 'Sign in · RizeHub HQ' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!isLive()) redirect('/'); // DEMO mode has no accounts
  const { next } = await searchParams;
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
          <h1 className="text-xl font-semibold">Sign in</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">CEO account only.</p>
          <LoginForm next={next ?? '/'} />
        </div>
      </div>
    </main>
  );
}
