'use client';
import { useActionState, useRef, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, Lock } from 'lucide-react';
import { submitAccessAction, type AccessFormState } from '@/app/vault-actions';

const LABEL: Record<string, string> = {
  shopify: 'Shopify', webflow: 'Webflow', wordpress: 'WordPress', github: 'GitHub', figma: 'Figma', ga4: 'Google Analytics / Search Console',
  gmail: 'Google Workspace', hosting: 'Hosting', ftp: 'FTP / SFTP', halaxy: 'Halaxy', other: 'Other',
};
const input = 'h-11 w-full min-w-0 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3.5 text-[15px] outline-none placeholder:text-[var(--color-dim)] focus:border-[var(--color-line-active)]';

export function AccessForm({ token, platforms }: { token: string; platforms: string[] }) {
  const [state, action, pending] = useActionState<AccessFormState, FormData>(submitAccessAction, { status: 'idle' });
  const [show, setShow] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  if (state.status === 'ok') {
    return (
      <div className="mt-6 flex flex-col items-center gap-3 rounded-[14px] border border-[color-mix(in_oklab,var(--color-success)_45%,transparent)] bg-[color-mix(in_oklab,var(--color-success)_10%,transparent)] p-6 text-center" role="status">
        <CheckCircle2 size={30} className="text-[var(--color-success)]" aria-hidden />
        <p className="text-lg font-semibold">Thank you, it&apos;s safely stored.</p>
        <p className="max-w-sm text-sm text-[var(--color-muted)]">The details were encrypted and this link is now closed. You can close this page.</p>
      </div>
    );
  }
  if (state.status === 'closed') {
    return <p role="alert" className="mt-6 rounded-[14px] border border-[var(--color-line)] p-4 text-sm text-[var(--color-muted)]">This link has expired or was already used. Ask RizeHub for a new one.</p>;
  }

  return (
    <form ref={form} action={action} className="mt-6 flex flex-col gap-4" autoComplete="off">
      <input type="hidden" name="token" value={token} />
      <label className="flex flex-col gap-1.5 text-sm text-[var(--color-muted)]">
        Platform
        <select name="platform" className={input} defaultValue={platforms[0]} required>
          {platforms.map((p) => <option key={p} value={p}>{LABEL[p] ?? p}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1.5 text-sm text-[var(--color-muted)]">
        Login page URL
        <input name="loginUrl" className={input} placeholder="https://yourstore.myshopify.com/admin" inputMode="url" maxLength={2000} />
      </label>
      <label className="flex flex-col gap-1.5 text-sm text-[var(--color-muted)]">
        Username or email
        <input name="username" className={input} maxLength={200} autoComplete="off" />
      </label>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
        <label className="flex min-w-0 flex-col gap-1.5 text-sm text-[var(--color-muted)]">
          Password or API token
          <span className="relative">
            <input name="secret" type={show ? 'text' : 'password'} className={`${input} pr-11 font-mono`} required maxLength={8000}
              autoComplete="new-password" spellCheck={false} data-1p-ignore data-lpignore="true" />
            <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide' : 'Show'}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-[var(--color-muted)] hover:text-white">{show ? <EyeOff size={17} /> : <Eye size={17} />}</button>
          </span>
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-[var(--color-muted)]">
          It is a…
          <select name="secretType" className={input} defaultValue="password">
            <option value="password">Password</option><option value="api_token">API token</option>
            <option value="app_password">App password</option><option value="other">Other</option>
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1.5 text-sm text-[var(--color-muted)]">
        Two-factor login
        <select name="twofaMethod" className={input} defaultValue="none">
          <option value="none">No two-factor</option><option value="sms">Code by SMS</option><option value="email">Code by email</option>
          <option value="app">Authenticator app</option><option value="collaborator">It&apos;s a collaborator account with its own 2FA</option>
        </select>
      </label>
      <label className="flex flex-col gap-1.5 text-sm text-[var(--color-muted)]">
        Notes (optional)
        <textarea name="notes" rows={3} maxLength={2000} placeholder="Permissions you gave us, anything we should not touch…"
          className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3.5 py-2.5 text-[15px] outline-none placeholder:text-[var(--color-dim)] focus:border-[var(--color-line-active)]" />
      </label>
      {state.status === 'error' && <p role="alert" className="text-sm text-[#ff8a8d]">{state.error}</p>}
      <button disabled={pending} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] text-[15px] font-medium hover:bg-[var(--color-primary-hover)] disabled:opacity-50">
        <Lock size={16} aria-hidden />{pending ? 'Encrypting…' : 'Send securely'}
      </button>
    </form>
  );
}
