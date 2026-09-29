'use client';
import { useActionState } from 'react';
import { setRecoveredPasswordAction } from '@/app/actions';
import { PASSWORD_MIN } from '@/lib/auth/password';

const input = 'h-11 w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] px-4 text-[15px] outline-none focus:border-[var(--color-line-active)]';

export function NewPasswordForm() {
  const [state, action, pending] = useActionState(setRecoveredPasswordAction, { error: null });
  return (
    <form action={action} className="mt-5 flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm text-[var(--color-muted)]">
        New password
        <input name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required autoFocus className={input} />
        <span className="text-xs text-[var(--color-dim)]">At least {PASSWORD_MIN} characters. A few random words works well.</span>
      </label>
      <label className="flex flex-col gap-1.5 text-sm text-[var(--color-muted)]">
        New password again
        <input name="again" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required className={input} />
      </label>
      {state.error && <p role="alert" className="text-sm text-[#ff8a8d]">{state.error}</p>}
      <button disabled={pending} className="h-11 rounded-xl bg-[var(--color-primary)] text-[15px] font-medium hover:bg-[var(--color-primary-hover)] disabled:opacity-50">
        {pending ? 'Saving…' : 'Save new password'}
      </button>
    </form>
  );
}
