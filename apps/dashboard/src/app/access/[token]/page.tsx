// Public, one-time "secure access link" page for clients (docs/09 "Clients & consent").
// No sidebar, no session. The token is checked by the worker (hash, unused, unexpired); this page only
// shows the form while the link is open. Nothing about the agency's other clients is exposed.
import type { Metadata } from 'next';
import { Clock, Lock, ShieldCheck } from 'lucide-react';
import { loadAccessLinkState } from '@/lib/data/vault';
import { AccessForm } from './AccessForm';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Secure access · RizeHub',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center px-4 py-8 sm:py-14">
      <div className="w-full max-w-xl">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-primary)] text-base font-bold">R</span>
          <span className="leading-tight">
            <span className="block text-lg font-semibold">RizeHub</span>
            <span className="block text-xs text-[var(--color-muted)]">Secure access link</span>
          </span>
        </div>
        {children}
        <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-[var(--color-dim)]">
          <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden />
          Your details are encrypted as soon as you submit and are only used for the work you agreed with RizeHub.
          A person approves every change that goes live, and you can revoke this access at any time.
        </p>
      </div>
    </main>
  );
}

const CLOSED: Record<string, { title: string; text: string }> = {
  used: { title: 'This link was already used', text: 'Thanks, we already received the access details. If something changed, ask us for a new link.' },
  expired: { title: 'This link has expired', text: 'Secure links work for 72 hours. Ask us for a new one and we will send it right away.' },
  invalid: { title: 'This link is not valid', text: 'Check that you copied the whole link, or ask us for a new one.' },
};

export default async function AccessPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const link = await loadAccessLinkState(token);
  if (link.state !== 'open') {
    const c = CLOSED[link.state] ?? CLOSED.invalid!;
    return (
      <Shell>
        <div className="card flex flex-col items-center gap-3 p-8 text-center">
          <Clock size={28} className="text-[var(--color-warning)]" aria-hidden />
          <h1 className="text-xl font-semibold">{c.title}</h1>
          <p className="max-w-sm text-sm text-[var(--color-muted)]">{c.text}</p>
        </div>
      </Shell>
    );
  }
  return (
    <Shell>
      <div className="card p-5 sm:p-7">
        <h1 className="text-xl font-semibold sm:text-2xl">Share access with RizeHub</h1>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">
          {link.client_name ? <>For <b className="text-white">{link.client_name}</b>. </> : null}
          Best practice: create a separate staff or collaborator account for us instead of sharing your own login.
        </p>
        {link.note && <p className="item mt-4 px-4 py-3 text-sm text-[var(--color-ink)]">{link.note}</p>}
        {link.expires_at && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-[var(--color-dim)]">
            <Lock size={12} aria-hidden />One-time link · expires {new Date(link.expires_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC
          </p>
        )}
        <AccessForm token={token} platforms={link.platforms ?? ['other']} />
      </div>
    </Shell>
  );
}
