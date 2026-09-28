'use client';
// Settings → Security: TOTP 2FA status and enrollment (docs/09 "Two-factor (TOTP)").
// The QR code and secret are shown once, in this component's state only; closing the setup forgets them.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Check, ShieldCheck, ShieldAlert, KeyRound } from 'lucide-react';
import { cancelTotpEnrollAction, confirmTotpEnrollAction, startTotpEnrollAction } from '@/app/security-actions';
import type { SecurityStatus } from '@/lib/data/settings';
import { Field, btn, inputCls, relTime } from '@/components/clients/ui';

type Enroll = { factorId: string; qr: string; secret: string };

export function SecurityCard({ status, demo }: { status: SecurityStatus | null; demo: boolean }) {
  const router = useRouter();
  const [enroll, setEnroll] = useState<Enroll | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const on = done || status?.totp === 'on';

  const begin = () => start(async () => {
    setError(null);
    const r = await startTotpEnrollAction();
    if (!r.ok) { setError(r.error); return; }
    setEnroll({ factorId: r.factorId, qr: r.qr, secret: r.secret });
  });
  const cancel = () => start(async () => {
    if (enroll) await cancelTotpEnrollAction({ factorId: enroll.factorId });
    setEnroll(null); setCode(''); setError(null); setShowSecret(false);
  });
  const confirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!enroll) return;
    start(async () => {
      const r = await confirmTotpEnrollAction({ factorId: enroll.factorId, code });
      setCode('');
      if (!r.ok) { setError(r.error); return; }
      setEnroll(null); setShowSecret(false); setDone(true); setError(null);
      router.refresh();
    });
  };
  const copy = async () => {
    if (!enroll) return;
    try { await navigator.clipboard.writeText(enroll.secret); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };

  return (
    <section className="card flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="sec-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="sec-title" className="text-lg font-semibold">Two-factor sign-in (TOTP)</h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">
            With 2FA on, signing in needs a code from your authenticator app, and so does approving anything that changes the
            outside world (publish, send, merge, deploy, spend), turning on an auto-approve rule and revealing a vault secret.
            Telegram can still reject those, but approving them moves to the dashboard.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
          style={on
            ? { color: 'color-mix(in oklab, var(--color-success) 80%, white)', borderColor: 'color-mix(in oklab, var(--color-success) 50%, transparent)', background: 'color-mix(in oklab, var(--color-success) 12%, transparent)' }
            : { color: 'color-mix(in oklab, var(--color-warning) 85%, white)', borderColor: 'color-mix(in oklab, var(--color-warning) 50%, transparent)', background: 'color-mix(in oklab, var(--color-warning) 12%, transparent)' }}>
          {on ? <ShieldCheck size={14} aria-hidden /> : <ShieldAlert size={14} aria-hidden />}
          {on ? '2FA on' : '2FA off'}
        </span>
      </div>

      {demo && <p className="item px-4 py-3 text-sm text-[var(--color-muted)]">Demo mode: 2FA needs a real Supabase project with MFA (TOTP) enabled.</p>}

      {!demo && on && !enroll && (
        <p className="text-sm text-[var(--color-muted)]" suppressHydrationWarning>
          Authenticator app linked{status?.since ? ` ${relTime(status.since)}` : ''}. Lost the phone? Reset it with the service role (docs/09), then set it up again here.
        </p>
      )}

      {!demo && !on && !enroll && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={btn.primary} onClick={begin} disabled={pending}><KeyRound size={16} aria-hidden />{pending ? 'Starting…' : 'Set up 2FA'}</button>
          <span className="text-xs text-[var(--color-dim)]">Google Authenticator, 1Password, Authy or any TOTP app.</span>
        </div>
      )}

      {enroll && (
        <form onSubmit={confirm} className="grid gap-5 md:grid-cols-[220px_1fr]">
          <div className="mx-auto flex w-full max-w-[220px] flex-col items-center gap-2">
            {/* Supabase returns the QR as an SVG data URL. */}
            <img src={enroll.qr} alt="QR code for your authenticator app" className="aspect-square w-full rounded-[14px] bg-white p-2" />
            <span className="text-xs text-[var(--color-dim)]">Shown once. Scan it now.</span>
          </div>
          <div className="flex min-w-0 flex-col gap-3.5">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-[var(--color-muted)]">
              <li>Scan the QR code with your authenticator app.</li>
              <li>Or type the setup key by hand.</li>
              <li>Enter the 6-digit code the app shows to turn 2FA on.</li>
            </ol>
            <div className="flex min-w-0 items-center gap-2">
              <code className="item min-w-0 flex-1 truncate px-3 py-2 font-mono text-sm">{showSecret ? enroll.secret : '•'.repeat(Math.min(enroll.secret.length, 32))}</code>
              <button type="button" className={btn.small} onClick={() => setShowSecret((v) => !v)}>{showSecret ? 'Hide' : 'Show'}</button>
              <button type="button" className={btn.small} onClick={copy} aria-label="Copy setup key">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
            </div>
            <Field label="Code from the app">
              <input className={`${inputCls} max-w-[200px] text-center font-mono tracking-[0.35em]`} inputMode="numeric" autoComplete="one-time-code"
                pattern="[0-9 ]{6,7}" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
            </Field>
            {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
            <div className="flex flex-wrap gap-2">
              <button className={btn.primary} disabled={pending || code.replace(/\s/g, '').length !== 6}>{pending ? 'Checking…' : 'Turn on 2FA'}</button>
              <button type="button" className={btn.ghost} onClick={cancel} disabled={pending}>Cancel</button>
            </div>
          </div>
        </form>
      )}
      {!enroll && error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
    </section>
  );
}
