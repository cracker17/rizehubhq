'use client';
import Link from 'next/link';
import { useActionState } from 'react';
import { requestPasswordResetAction } from '@/app/actions';

const input = 'h-11 w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] px-4 text-[15px] outline-none placeholder:text-[var(--color-dim)] focus:border-[var(--color-line-active)]';

/** "Forgot password?": asks Supabase Auth to email a reset link. Same answer whether or not the address has an account. */
export function ResetRequestForm() {
  const [state, action, pending] = useActionState(requestPasswordResetAction, { sent: false, error: null });
  if (state.sent) {
    return (
      <div className="mt-5 flex flex-col gap-4 text-sm text-[var(--color-muted)]">
        <p role="status">If that is the CEO login, a reset link is on its way. Open it in this browser within an hour.</p>
        <p className="text-xs text-[var(--color-dim)]">Nothing after a few minutes? Check spam, then the Supabase Auth email settings (docs/10).</p>
        <Link href="/login" className="text-center text-[var(--color-muted)] hover:text-white">Back to sign in</Link>
      </div>
    );
  }
  return (
    <form action={action} className="mt-5 flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm text-[var(--color-muted)]">
        Email
        <input name="email" type="email" autoComplete="email" required autoFocus className={input} placeholder="you@rizehub.ph" />
      </label>
      {state.error && <p role="alert" className="text-sm text-[#ff8a8d]">{state.error}</p>}
      <button disabled={pending} className="h-11 rounded-xl bg-[var(--color-primary)] text-[15px] font-medium hover:bg-[var(--color-primary-hover)] disabled:opacity-50">
        {pending ? 'Sending…' : 'Email me a reset link'}
      </button>
      <Link href="/login" className="text-center text-sm text-[var(--color-muted)] hover:text-white">Back to sign in</Link>
    </form>
  );
}
