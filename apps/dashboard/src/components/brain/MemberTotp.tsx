'use client';
// 2FA (TOTP) setup for invited people: scan the QR, type the 6-digit code. Shared by /join and /member.
import { useState, useTransition } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { btn } from '@/components/clients/ui';
import { memberConfirmTotpAction, memberStartTotpAction } from '@/app/member-actions';

export function MemberTotp({ onDone }: { onDone: () => void }) {
  const [enroll, setEnroll] = useState<{ factorId: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const begin = () => start(async () => {
    setError(null);
    const r = await memberStartTotpAction();
    if (!r.ok) { setError(r.error); return; }
    setEnroll(r);
  });
  const confirm = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      if (!enroll) return;
      const r = await memberConfirmTotpAction(enroll.factorId, code);
      if (!r.ok) { setError(r.error); return; }
      onDone();
    });
  };

  if (!enroll) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--color-muted)]">You need an authenticator app (Google Authenticator, 1Password, Microsoft Authenticator…). The Brain holds client work, so every connection needs a second step.</p>
        {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
        <button type="button" className={`${btn.primary} self-start`} onClick={begin} disabled={pending}>
          {pending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <ShieldCheck size={16} aria-hidden />}Set up 2FA
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={confirm} className="flex flex-col gap-3">
      <p className="text-sm">Scan this with your authenticator app, then type the 6-digit code it shows.</p>
      {/* Supabase returns the QR as an SVG data URI */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={enroll.qr} alt="2FA QR code" width={176} height={176} className="rounded-xl bg-white p-2" />
      <p className="break-all text-xs text-[var(--color-muted)]">Can&rsquo;t scan? Enter this key: <code className="font-mono text-[var(--color-ink)]">{enroll.secret}</code></p>
      <label className="flex flex-col gap-1.5 text-sm"><span className="font-medium">6-digit code</span>
        <input id="totp-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required value={code} onChange={(e) => setCode(e.target.value)}
          className="h-10 w-40 rounded-[10px] border border-[var(--color-line)] bg-[#07061a] px-3 font-mono tracking-[.2em]" /></label>
      {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
      <button type="submit" className={`${btn.primary} self-start`} disabled={pending}>{pending && <Loader2 size={16} className="animate-spin" aria-hidden />}Turn on 2FA</button>
    </form>
  );
}
