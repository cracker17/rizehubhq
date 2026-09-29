'use client';
// Reveal (re-auth, 30 s), Rotate, Revoke and "Request access from client" dialogs.
import { useEffect, useRef, useState, useTransition } from 'react';
import clsx from 'clsx';
import { Copy, Check, ShieldAlert, Link2 } from 'lucide-react';
import type { CredentialView, VaultClient } from '@/lib/data/vault';
import { createAccessLinkAction, revealSecretAction, revokeCredentialAction, rotateSecretAction } from '@/app/vault-actions';
import { Dialog, Field, PLATFORM_LABEL, btn, inputCls, platformLabel } from './ui';

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  return { copied, copy };
}

export function RevealDialog({ cred, demo, onClose, onRevealed }: { cred: CredentialView | null; demo: boolean; onClose: () => void; onRevealed: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { copied, copy } = useCopy();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const reset = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setSecret(null); setPassword(''); setCode(''); setNeedCode(false); setError(null); setLeft(0);
  };
  const close = () => { reset(); onClose(); };
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  useEffect(() => { if (!cred) reset(); }, [cred]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cred) return;
    start(async () => {
      const r = await revealSecretAction({ id: cred.id, password, totp: needCode ? code : null });
      setCode('');
      // 2FA on: keep the password and ask for the authenticator code too.
      if (!r.ok && r.stepUp) { setNeedCode(true); setError(needCode ? r.error : null); return; }
      setPassword('');
      if (!r.ok) { setError(r.error); return; }
      setSecret(r.secret);
      onRevealed();
      const until = Date.now() + r.showMs;
      setLeft(Math.ceil(r.showMs / 1000));
      timer.current = setInterval(() => {
        const s = Math.ceil((until - Date.now()) / 1000);
        if (s <= 0) { reset(); onClose(); } else setLeft(s);
      }, 250);
    });
  };

  return (
    <Dialog open={Boolean(cred)} onClose={close} title="Reveal secret">
      {cred && !secret && (
        <form onSubmit={submit} className="flex flex-col gap-3.5">
          <p className="text-sm text-[var(--color-muted)]">Re-enter your password to see <b className="text-white">{cred.label}</b> for 30 seconds. This is logged.</p>
          <Field label="Your password" hint={demo ? 'Demo mode: any password works; the value shown is a fake placeholder.' : undefined}>
            <input className={inputCls} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
          </Field>
          {needCode && (
            <Field label="2FA code" hint="The 6-digit code from your authenticator app.">
              <input className={inputCls} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} value={code}
                onChange={(e) => setCode(e.target.value)} required autoFocus />
            </Field>
          )}
          {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
          <div className="flex justify-end gap-2"><button type="button" className={btn.ghost} onClick={close}>Cancel</button><button className={btn.primary} disabled={pending}>{pending ? 'Checking…' : 'Reveal'}</button></div>
        </form>
      )}
      {cred && secret && (
        <div className="flex flex-col gap-3">
          <p className="flex items-center gap-2 text-sm text-[#ffb35c]"><ShieldAlert size={16} aria-hidden />Hidden again in {left}s. Don&apos;t paste it into chats or tickets.</p>
          <div className="item break-all p-3 font-mono text-sm" aria-live="polite">{secret}</div>
          <div className="h-1 overflow-hidden rounded-full bg-[var(--color-line)]"><div className="h-full bg-[var(--color-warning)] transition-[width] duration-200" style={{ width: `${(left / 30) * 100}%` }} /></div>
          <div className="flex justify-end gap-2">
            <button type="button" className={btn.ghost} onClick={() => copy(secret)}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Copied' : 'Copy'}</button>
            <button type="button" className={btn.primary} onClick={close}>Hide now</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function RotateDialog({ cred, onClose, onDone }: { cred: CredentialView | null; onClose: () => void; onDone: (msg: string) => void }) {
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const close = () => { setSecret(''); setError(null); onClose(); };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cred) return;
    start(async () => {
      const r = await rotateSecretAction({ id: cred.id, secret });
      setSecret('');
      if (!r.ok) { setError(r.error); return; }
      close();
      onDone('Secret rotated. Status reset to active.');
    });
  };
  return (
    <Dialog open={Boolean(cred)} onClose={close} title="Rotate secret">
      {cred && (
        <form onSubmit={submit} className="flex flex-col gap-3.5" autoComplete="off">
          <p className="text-sm text-[var(--color-muted)]">Change it at the platform first, then paste the new value for <b className="text-white">{cred.label}</b>. This also clears &quot;check needed&quot;.</p>
          <Field label="New password / token">
            <input className={`${inputCls} font-mono`} type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} required autoFocus data-1p-ignore data-lpignore="true" />
          </Field>
          {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
          <div className="flex justify-end gap-2"><button type="button" className={btn.ghost} onClick={close}>Cancel</button><button className={btn.primary} disabled={pending}>{pending ? 'Encrypting…' : 'Rotate'}</button></div>
        </form>
      )}
    </Dialog>
  );
}

export function RevokeDialog({ cred, onClose, onDone }: { cred: CredentialView | null; onClose: () => void; onDone: (msg: string) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const close = () => { setReason(''); setError(null); onClose(); };
  const submit = () => {
    if (!cred) return;
    start(async () => {
      const r = await revokeCredentialAction({ id: cred.id, reason });
      if (!r.ok) { setError(r.error); return; }
      close();
      onDone(`Revoked. Now revoke it at ${platformLabel(cred.platform)} too.`);
    });
  };
  return (
    <Dialog open={Boolean(cred)} onClose={close} title="Revoke access">
      {cred && (
        <div className="flex flex-col gap-3.5">
          <p className="text-sm text-[var(--color-muted)]">All agents lose <b className="text-white">{cred.label}</b> immediately. The encrypted value stays for the audit trail.</p>
          <ol className="item list-decimal space-y-1 py-3 pl-8 pr-3 text-[13px] text-[var(--color-muted)]">
            <li>Revoke here (agents stop right away).</li>
            <li>Remove the collaborator / delete the token at {platformLabel(cred.platform)}.</li>
          </ol>
          <Field label="Reason (optional)"><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Project ended" /></Field>
          {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={btn.ghost} onClick={close}>Cancel</button>
            <button type="button" onClick={submit} disabled={pending} className={clsx(btn.primary, 'bg-[var(--color-danger)] hover:bg-[#f06368]')}>{pending ? 'Revoking…' : 'Revoke'}</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function AccessLinkDialog({ client, open, onClose, onCreated }: { client: VaultClient; open: boolean; onClose: () => void; onCreated: () => void }) {
  const [platforms, setPlatforms] = useState<string[]>(client.platforms.length ? client.platforms.filter((p) => p in PLATFORM_LABEL) : ['shopify']);
  const [note, setNote] = useState('');
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { copied, copy } = useCopy();
  const close = () => { setLink(null); setError(null); setNote(''); onClose(); };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await createAccessLinkAction({ clientId: client.id, platforms, note });
      if (!r.ok) { setError(r.error); return; }
      setLink({ url: r.url, expiresAt: r.expiresAt });
      onCreated();
    });
  };
  return (
    <Dialog open={open} onClose={close} title="Request access from client">
      {!link ? (
        <form onSubmit={submit} className="flex flex-col gap-3.5">
          <p className="text-sm text-[var(--color-muted)]">Creates a one-time secure link (valid 72 h). {client.name} enters the login themselves and it goes straight into the vault. You then choose which agents may use it.</p>
          <fieldset>
            <legend className="mb-1.5 text-[13px] text-[var(--color-muted)]">What do you need?</legend>
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(PLATFORM_LABEL).map((p) => (
                <button type="button" key={p} aria-pressed={platforms.includes(p)} onClick={() => setPlatforms((x) => (x.includes(p) ? x.filter((y) => y !== p) : [...x, p]))}
                  className={clsx('rounded-full border px-2.5 py-1 text-xs', platforms.includes(p) ? 'border-[var(--color-line-active)] bg-[var(--color-panel-2)] text-white' : 'border-[var(--color-line)] text-[var(--color-muted)]')}>
                  {PLATFORM_LABEL[p]}
                </button>
              ))}
            </div>
          </fieldset>
          <Field label="Note for the client (optional)">
            <textarea className={`${inputCls} h-20 py-2`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
              placeholder="Please add team@rizehub.ph as a collaborator rather than sharing your own login." />
          </Field>
          {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
          <div className="flex justify-end gap-2"><button type="button" className={btn.ghost} onClick={close}>Cancel</button><button className={btn.primary} disabled={pending || !platforms.length}><Link2 size={16} aria-hidden />{pending ? 'Creating…' : 'Create link'}</button></div>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--color-muted)]">Send this to {client.name}. It works once and expires {new Date(link.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. It won&apos;t be shown again.</p>
          <div className="item break-all p-3 font-mono text-[13px]">{link.url}</div>
          <div className="flex justify-end gap-2">
            <button type="button" className={btn.ghost} onClick={() => copy(link.url)}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Copied' : 'Copy link'}</button>
            <button type="button" className={btn.primary} onClick={close}>Done</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
