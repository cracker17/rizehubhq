// Public join page for people invited to the HQ Brain (P2). No sidebar, no session needed. The brain service checks the
// one-time code (hash, unused, 7 days); nothing about other projects or people is shown here.
import type { Metadata } from 'next';
import { callBrain } from '@/lib/brainCall';
import { JoinFlow } from './JoinFlow';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Join HQ Brain · RizeHub', robots: { index: false, follow: false }, referrer: 'no-referrer' };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center px-4 py-8 sm:py-14">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-primary)] text-base font-bold">R</span>
          <span className="leading-tight"><span className="block text-lg font-semibold">RizeHub HQ Brain</span><span className="block text-xs text-[var(--color-muted)]">Invitation</span></span>
        </div>
        <div className="card p-5 sm:p-6">{children}</div>
      </div>
    </main>
  );
}

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const valid = /^[0-9a-f]{40}$/.test(code);
  const r = valid ? await callBrain<{ name: string; email: string; role: string; projects: number }>(`/people/invite?code=${code}`, { timeoutMs: 15_000 }) : null;
  if (!r || r.status !== 200 || !('email' in r.body)) {
    return <Shell><h1 className="text-xl font-semibold">This invite can&rsquo;t be used</h1><p className="mt-2 text-sm text-[var(--color-muted)]">It has expired (invites last 7 days) or was already used. Ask Julev to send you a new one. Already joined? <a href="/login" className="text-[#5eead4] underline">Sign in</a>.</p></Shell>;
  }
  const inv = r.body;
  return (
    <Shell>
      <h1 className="text-xl font-semibold">Hi {inv.name.split(' ')[0]}, welcome to the HQ Brain</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        Julev gave you {inv.role === 'admin' ? 'admin access' : `${inv.role === 'viewer' ? 'read-only ' : ''}access to ${inv.projects} project${inv.projects === 1 ? '' : 's'}`}.
        You&rsquo;ll use it from Claude: load a project&rsquo;s memory before you work on it{inv.role === 'viewer' ? '' : ', and save what you did when you finish'}.
      </p>
      <div className="mt-5"><JoinFlow code={code} email={inv.email} /></div>
    </Shell>
  );
}
