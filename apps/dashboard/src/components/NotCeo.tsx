import { ShieldAlert } from 'lucide-react';
import { signOutAction } from '@/app/actions';

/** Signed in, but not listed in ceo_users: RLS hides everything, so explain instead of showing an empty office. */
export function NotCeo({ email }: { email: string | null }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="card flex w-full max-w-md flex-col items-center gap-3 p-8 text-center">
        <ShieldAlert size={36} className="text-[var(--color-warning)]" aria-hidden />
        <h1 className="text-xl font-semibold">This account isn&apos;t the CEO</h1>
        <p className="text-[15px] text-[var(--color-muted)]">
          You&apos;re signed in as <span className="text-white">{email ?? 'an unknown user'}</span>, but only the CEO account can see the office.
          If this is you, add the account once in Supabase:
        </p>
        <code className="item w-full break-all p-3 text-left text-xs text-[var(--color-muted)]">
          insert into ceo_users (user_id) select id from auth.users where email = &apos;{email ?? 'you@example.com'}&apos;;
        </code>
        <form action={signOutAction} className="mt-2">
          <button className="h-10 rounded-[10px] bg-[var(--color-primary)] px-5 text-sm font-medium hover:bg-[var(--color-primary-hover)]">Sign out</button>
        </form>
      </div>
    </main>
  );
}
