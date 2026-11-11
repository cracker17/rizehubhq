'use client';
// /join/<code>: 1 password → 2 two-factor → 3 connect Claude. One screen, three short steps.
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Check, Loader2 } from 'lucide-react';
import { btn } from '@/components/clients/ui';
import { joinBrainAction } from '@/app/member-actions';
import { MemberTotp } from '@/components/brain/MemberTotp';

export function JoinFlow({ code, email }: { code: string; email: string }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pw.length < 12) { setError('Use at least 12 characters.'); return; }
    if (pw !== pw2) { setError('The two passwords are different.'); return; }
    start(async () => {
      const r = await joinBrainAction(code, pw);
      if (!r.ok) { setError(r.error); return; }
      setStep(2);
    });
  };

  const steps = ['Password', 'Two-factor', 'Connect Claude'];
  return (
    <div className="flex flex-col gap-5">
      <ol className="flex gap-2" aria-label="Steps">
        {steps.map((s, i) => {
          const n = i + 1; const done = n < step; const cur = n === step;
          return (
            <li key={s} aria-current={cur ? 'step' : undefined} className={`flex flex-1 items-center gap-2 rounded-xl border px-3 py-2 text-xs ${cur ? 'border-[var(--color-line-active)] bg-[var(--color-panel-2)]' : 'border-[var(--color-line)]'}`}>
              <span className={`flex h-5 w-5 items-center justify-center rounded-full font-mono ${done ? 'bg-[color-mix(in_oklab,#34d399_16%,transparent)] text-[#34d399]' : cur ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-panel-2)] text-[var(--color-muted)]'}`}>{done ? <Check size={11} aria-hidden /> : n}</span>{s}
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <p className="text-sm text-[var(--color-muted)]">Your HQ login is <strong className="text-[var(--color-ink)]">{email}</strong>. Choose a password (12+ characters).</p>
          <label className="flex flex-col gap-1.5 text-sm"><span className="font-medium">Password</span>
            <input id="join-pw" type="password" autoComplete="new-password" required minLength={12} value={pw} onChange={(e) => setPw(e.target.value)} className="h-10 rounded-[10px] border border-[var(--color-line)] bg-[#07061a] px-3" /></label>
          <label className="flex flex-col gap-1.5 text-sm"><span className="font-medium">Same password again</span>
            <input id="join-pw2" type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} className="h-10 rounded-[10px] border border-[var(--color-line)] bg-[#07061a] px-3" /></label>
          {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
          <button type="submit" className={`${btn.primary} self-start`} disabled={pending}>{pending && <Loader2 size={16} className="animate-spin" aria-hidden />}Create my login</button>
        </form>
      )}
      {step === 2 && <MemberTotp onDone={() => setStep(3)} />}
      {step === 3 && (
        <div className="flex flex-col gap-3 text-sm">
          <p className="flex items-center gap-2 font-semibold"><Check size={16} className="text-[#34d399]" aria-hidden />You&rsquo;re set up.</p>
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[var(--color-muted)]">
            <li>Open Claude (app or claude.ai) › Settings › Connectors.</li>
            <li>Find <strong className="text-[var(--color-ink)]">HQ Brain</strong> and tap Connect. (Not listed? Add a custom connector with <code className="font-mono text-[#99f6e4]">https://hq.rizehub.ph/mcp/brain</code>.)</li>
            <li>Approve it on the HQ page that opens, with your 2FA code.</li>
            <li>In a chat, say <strong className="text-[var(--color-ink)]">&ldquo;list my projects&rdquo;</strong>.</li>
          </ol>
          <Link href="/member" className={`${btn.ghost} self-start`}>See my access</Link>
        </div>
      )}
    </div>
  );
}
