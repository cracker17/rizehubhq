'use client';
import { useActionState } from 'react';
import { signOutAction, verifySignInTotpAction } from '@/app/actions';

const input = 'h-12 w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] px-4 text-center font-mono text-xl tracking-[0.45em] outline-none placeholder:text-[var(--color-dim)] focus:border-[var(--color-line-active)]';

/** Second sign-in step when 2FA is on: the 6-digit code from the authenticator app (Supabase MFA challenge + verify). */
export function TotpForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(verifySignInTotpAction, { error: null });
  return (
    <div className="mt-5 flex flex-col gap-4">
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="next" value={next} />
        <label className="flex flex-col gap-1.5 text-sm text-[var(--color-muted)]">
          Authenticator code
          <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus
            className={input} placeholder="000000" aria-describedby="totp-hint" />
        </label>
        <p id="totp-hint" className="-mt-2 text-xs text-[var(--color-dim)]">Open your authenticator app and enter the current code for RizeHub HQ.</p>
        {state.error && <p role="alert" className="text-sm text-[#ff8a8d]">{state.error}</p>}
        <button disabled={pending} className="h-11 rounded-xl bg-[var(--color-primary)] text-[15px] font-medium hover:bg-[var(--color-primary-hover)] disabled:opacity-50">
          {pending ? 'Checking…' : 'Verify'}
        </button>
      </form>
      <form action={signOutAction}>
        <button className="w-full text-center text-sm text-[var(--color-muted)] hover:text-white">Use another account</button>
      </form>
      <p className="text-center text-xs text-[var(--color-dim)]">Lost your phone? 2FA can be reset with the service role (docs/09 &quot;Two-factor&quot;).</p>
    </div>
  );
}
