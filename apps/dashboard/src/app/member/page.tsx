// Home for invited people (HQ Brain P2): what they can see, 2FA status, how to connect Claude. The middleware sends every
// signed-in non-CEO here; the rest of HQ stays the CEO's.
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { totpState } from '@/lib/auth/mfaServer';
import { memberSignOutAction } from '@/app/member-actions';
import { MemberTwoFactor } from './MemberTwoFactor';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'My HQ Brain access · RizeHub', robots: { index: false, follow: false } };

interface MyAccess { name: string; email: string; role: string; projects: Array<{ slug: string; name: string; access: string }> }

export default async function Page() {
  if (!supabaseEnv()) redirect('/brain');
  const db = await createSupabaseServer();
  if (!db) redirect('/login');
  const { data: { user } } = await db.auth.getUser();
  if (!user) redirect('/login?next=/member');
  const ceo = await db.from('ceo_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (ceo.data) redirect('/brain/people');
  const { data } = await db.rpc('brain_my_access');
  const me = data as MyAccess | null;
  const state = await totpState(db);

  return (
    <main className="flex min-h-screen flex-col items-center px-4 py-8 sm:py-14">
      <div className="flex w-full max-w-lg flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-primary)] text-base font-bold">R</span>
          <span className="leading-tight"><span className="block text-lg font-semibold">RizeHub HQ Brain</span><span className="block text-xs text-[var(--color-muted)]">{user.email}</span></span>
          <form action={async () => { 'use server'; await memberSignOutAction(); redirect('/login'); }} className="ml-auto">
            <button type="submit" className="text-xs text-[var(--color-muted)] underline">Sign out</button>
          </form>
        </div>
        {!me ? (
          <section className="card p-5 text-sm"><h1 className="text-lg font-semibold">No Brain access</h1><p className="mt-2 text-[var(--color-muted)]">This login has no projects in the HQ Brain. Ask Julev for an invite.</p></section>
        ) : (
          <>
            <section className="card p-5">
              <h1 className="text-lg font-semibold">Hi {me.name.split(' ')[0]}</h1>
              <p className="mt-1 text-sm text-[var(--color-muted)]">{me.role === 'admin' ? 'You can see every project (admin).' : `You can see ${me.projects.length} project${me.projects.length === 1 ? '' : 's'}${me.role === 'viewer' ? ', read-only' : ''}.`}</p>
              {me.role !== 'admin' && me.projects.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {me.projects.map((p) => (
                    <li key={p.slug} className="flex justify-between gap-3 rounded-lg bg-[var(--color-panel-2)] px-3 py-2 text-sm">
                      <span className="min-w-0 truncate">{p.name}</span><span className={`font-mono text-xs ${p.access === 'write' ? 'text-[#b9a6ff]' : 'text-[#5eead4]'}`}>{p.access === 'write' ? 'edit' : 'read'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card p-5">
              <h2 className="font-semibold">Two-factor sign-in</h2>
              <div className="mt-2">{state?.factorId ? <p className="text-sm text-[#34d399]">On. You can connect Claude.</p> : <MemberTwoFactor />}</div>
            </section>
            <section className="card p-5 text-sm">
              <h2 className="font-semibold">Connect Claude</h2>
              <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-[var(--color-muted)]">
                <li>Claude › Settings › Connectors › <strong className="text-[var(--color-ink)]">HQ Brain</strong> › Connect.</li>
                <li>Approve it on the HQ page that opens (2FA code).</li>
                <li>Say &ldquo;list my projects&rdquo;, then &ldquo;load &lt;project&gt;&rdquo; before you start work.</li>
              </ol>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
