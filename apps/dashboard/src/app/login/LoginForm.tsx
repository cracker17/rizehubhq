'use client';
import { useActionState } from 'react';
import { signInAction } from '@/app/actions';

const input = 'h-11 w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] px-4 text-[15px] outline-none placeholder:text-[var(--color-dim)] focus:border-[var(--color-line-active)]';

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signInAction, { error: null });
  return (
    <form action={action} className="mt-5 flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <label className="flex flex-col gap-1.5 text-sm text-[var(--color-muted)]">
        Email
        <input name="email" type="email" autoComplete="email" required className={input} placeholder="you@rizehub.ph" />
      </label>
      <label className="flex flex-col gap-1.5 text-sm text-[var(--color-muted)]">
        Password
        <input name="password" type="password" autoComplete="current-password" required className={input} />
      </label>
      {state.error && <p role="alert" className="text-sm text-[#ff8a8d]">{state.error}</p>}
      <button disabled={pending} className="h-11 rounded-xl bg-[var(--color-primary)] text-[15px] font-medium hover:bg-[var(--color-primary-hover)] disabled:opacity-50">
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
