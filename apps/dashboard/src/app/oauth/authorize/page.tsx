import { redirect } from 'next/navigation';
import { decideAction } from './actions';
import { checkAuthorize, PARAM_NAMES, readParams } from './request';

// Brain connector consent page (OAuth authorization endpoint, docs/16-BRAIN.md "Connector"). Public route in the
// middleware so the OAuth request survives; this page does its own sign-in gate (HQ login + 2FA, CEO only).
export const metadata = { title: 'Connect the Brain · RizeHub HQ', robots: { index: false } };
export const dynamic = 'force-dynamic';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-primary)] text-base font-bold">R</span>
          <span className="leading-tight">
            <span className="block text-lg font-semibold">RizeHub HQ</span>
            <span className="block text-xs text-[var(--color-muted)]">HQ Brain</span>
          </span>
        </div>
        <div className="card p-6 sm:p-7">{children}</div>
      </div>
    </main>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const error = typeof sp.error === 'string' && !sp.client_id ? sp.error.slice(0, 300) : null;
  if (error) {
    return <Shell><h1 className="text-xl font-semibold">Can’t connect</h1><p role="alert" className="mt-3 text-sm text-[#ff8a8d]">{error}</p></Shell>;
  }
  const p = readParams((n) => sp[n]);
  const check = await checkAuthorize(p);
  if (check.kind === 'login') redirect(check.to);
  if (check.kind === 'client_error') redirect(check.redirect);
  if (check.kind === 'fatal') {
    return <Shell><h1 className="text-xl font-semibold">Can’t connect</h1><p role="alert" className="mt-3 text-sm text-[#ff8a8d]">{check.message}</p></Shell>;
  }
  const back = new URL(check.client.redirect_uri);
  return (
    <Shell>
      <h1 className="text-xl font-semibold">Connect {check.client.client_name} to your Brain?</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        It will be able to read your project memory, sessions and profile from the HQ Brain.
      </p>
      <form action={decideAction} className="mt-5 flex flex-col gap-4">
        {PARAM_NAMES.map((n) => p[n] && <input key={n} type="hidden" name={n} value={p[n]} />)}
        <label className="flex items-start gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3 text-sm">
          <input type="checkbox" name="write" defaultChecked={check.wantsWrite} className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]" />
          <span>
            <span className="block font-medium">Also allow saving</span>
            <span className="block text-[var(--color-muted)]">Save sessions, update memory and create projects. Every save is a commit in the vault, so it can be undone.</span>
          </span>
        </label>
        <p className="text-xs text-[var(--color-dim)]">
          Returns to <span className="font-mono">{back.host}</span>. You can revoke it any time. Secrets are never stored in the Brain.
        </p>
        <div className="flex gap-3">
          <button name="decision" value="deny" className="h-11 flex-1 rounded-xl border border-[var(--color-line)] text-[15px] hover:border-[var(--color-line-active)]">Deny</button>
          <button name="decision" value="approve" className="h-11 flex-1 rounded-xl bg-[var(--color-primary)] text-[15px] font-medium hover:bg-[var(--color-primary-hover)]">Connect</button>
        </div>
      </form>
    </Shell>
  );
}
