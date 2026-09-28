'use client';
// "Confirm with your 2FA code" (docs/09 "Two-factor (TOTP)"): shown when a server action answers { stepUp: true },
// e.g. approving a high-risk external action or turning on an auto-approve rule.
import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Dialog, Field, btn, inputCls } from '@/components/clients/ui';

export interface StepUpRequest {
  title: string;
  /** What approving will do, e.g. "Approve: Publish theme 'Bundle v2' on madammuse.co". */
  detail: string;
  /** Returns an error to show (wrong code) or null when done. */
  submit: (code: string) => Promise<string | null>;
  cancel: () => void;
}

export function StepUpDialog({ request }: { request: StepUpRequest | null }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => { setCode(''); setError(null); setPending(false); }, [request]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!request || pending) return;
    setPending(true);
    const err = await request.submit(code);
    setPending(false);
    setCode('');
    if (err) setError(err);
  };

  return (
    <Dialog open={Boolean(request)} onClose={() => request?.cancel()} title={request?.title ?? 'Confirm with 2FA'}>
      {request && (
        <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
          <p className="flex items-start gap-2 text-sm text-[var(--color-muted)]">
            <ShieldCheck size={18} className="mt-0.5 shrink-0 text-[var(--color-teal)]" aria-hidden />
            <span>{request.detail}</span>
          </p>
          <Field label="Authenticator code" hint="6 digits from your authenticator app. Valid for 5 minutes of approvals.">
            <input className={`${inputCls} text-center font-mono text-lg tracking-[0.4em]`} inputMode="numeric" autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus aria-label="6-digit code" />
          </Field>
          {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={btn.ghost} onClick={request.cancel}>Cancel</button>
            <button className={btn.primary} disabled={pending || code.replace(/\s/g, '').length !== 6}>{pending ? 'Checking…' : 'Confirm'}</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
