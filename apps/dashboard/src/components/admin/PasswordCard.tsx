'use client';
// Admin → Security: change the CEO password (docs/09 "CEO password"). Needs the current password and, with 2FA on, a
// code from the authenticator app. Every other session is signed out afterwards. Nothing typed here is kept.
import { useState, useTransition } from 'react';
import { KeyRound, Eye, EyeOff } from 'lucide-react';
import { changePasswordAction } from '@/app/security-actions';
import { PASSWORD_MIN, passwordProblem } from '@/lib/auth/password';
import { Field, btn, inputCls } from '@/components/clients/ui';

export function PasswordCard({ totpOn, demo }: { totpOn: boolean; demo: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [code, setCode] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  const problem = next ? passwordProblem(next, { current }) : null;
  const mismatch = again.length > 0 && again !== next;
  const ready = current && next && !problem && again === next && (!totpOn || code.replace(/\s/g, '').length === 6);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    start(async () => {
      setError(null);
      const r = await changePasswordAction({ current, next, totp: totpOn ? code : null });
      setCode('');
      if (!r.ok) { setError(r.error); return; }
      setCurrent(''); setNext(''); setAgain(''); setDone(true);
    });
  };

  const type = show ? 'text' : 'password';
  return (
    <section className="card flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="pw-title">
      <div>
        <h2 id="pw-title" className="text-lg font-semibold">CEO password</h2>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">
          Changing it signs out every other browser and device. Forgot it? Use &ldquo;Forgot password?&rdquo; on the sign-in page.
        </p>
      </div>
      {demo ? (
        <p className="item px-4 py-3 text-sm text-[var(--color-muted)]">Demo mode: there is no account password to change.</p>
      ) : (
        <form onSubmit={submit} className="grid max-w-3xl gap-3.5 sm:grid-cols-2" onChange={() => { setDone(false); setError(null); }}>
          <Field label="Current password" className="sm:col-span-2">
            <input className={inputCls} type={type} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </Field>
          <Field label="New password" hint={problem ?? `At least ${PASSWORD_MIN} characters. A few random words works well.`}>
            <input className={inputCls} type={type} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)}
              aria-invalid={Boolean(problem) || undefined} required />
          </Field>
          <Field label="New password again" hint={mismatch ? 'The two new passwords don’t match.' : undefined}>
            <input className={inputCls} type={type} autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)}
              aria-invalid={mismatch || undefined} required />
          </Field>
          {totpOn && (
            <Field label="2FA code" hint="From your authenticator app.">
              <input className={`${inputCls} max-w-[200px] text-center font-mono tracking-[0.35em]`} inputMode="numeric" autoComplete="one-time-code"
                pattern="[0-9 ]{6,7}" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required />
            </Field>
          )}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <button className={btn.primary} disabled={pending || !ready}><KeyRound size={16} aria-hidden />{pending ? 'Changing…' : 'Change password'}</button>
            <button type="button" className={btn.ghost} onClick={() => setShow((v) => !v)} aria-pressed={show}>
              {show ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}{show ? 'Hide' : 'Show'} passwords
            </button>
          </div>
          {error && <p role="alert" className="text-sm text-[#ff8a8d] sm:col-span-2">{error}</p>}
          {done && <p role="status" className="text-sm text-[color-mix(in_oklab,var(--color-success)_80%,white)] sm:col-span-2">Password changed. Other devices were signed out.</p>}
        </form>
      )}
    </section>
  );
}
