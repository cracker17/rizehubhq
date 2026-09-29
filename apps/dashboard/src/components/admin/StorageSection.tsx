'use client';
// Admin → Connectors → Storage (docs/15 §6): Google Drive / Dropbox through the CEO's own OAuth app. Agents save files
// here with save_file and QA-passed deliverables are saved automatically, into RizeHub HQ/<client or Internal>/<request>/.
// Files stay private to the CEO: HQ never makes a public or shared link.
import { useState, useTransition } from 'react';
import clsx from 'clsx';
import { Check, Copy, ExternalLink, HardDrive, RefreshCw, Star, Trash2 } from 'lucide-react';
import { MCP_CALLBACK_PATH, STORAGE_INFO, STORAGE_ROOT_FOLDER, type StorageProvider } from '@rizehubhq/shared';
import type { ConnectorView, ConnectorsPage } from '@/lib/data/connectors';
import { deleteConnectorAction, setDefaultStorageAction, startStorageSignInAction, testStorageAction, type ConnectorResult } from '@/app/connector-actions';
import { Dialog, Field, btn, inputCls, relTime } from '@/components/clients/ui';

type Run = (label: string, detail: string, call: (totp?: string) => Promise<ConnectorResult>, done: string) => void;
const codeInput = `${inputCls} max-w-[200px] text-center font-mono tracking-[0.35em]`;
const STATUS: Record<ConnectorView['status'], { label: string; color: string }> = {
  active: { label: 'Connected', color: 'var(--color-success)' },
  needs_reauth: { label: 'Sign in again', color: 'var(--color-danger)' },
  error: { label: 'Error', color: 'var(--color-warning)' },
  disabled: { label: 'Off', color: 'var(--color-dim)' },
};

function Pill({ status }: { status: ConnectorView['status'] }) {
  const s = STATUS[status];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs"
      style={{ color: `color-mix(in oklab, ${s.color} 80%, white)`, borderColor: `color-mix(in oklab, ${s.color} 50%, transparent)` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} aria-hidden />{s.label}
    </span>
  );
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* select instead */ }
  };
  return (
    <div className="flex min-w-0 gap-2">
      <input className={`${inputCls} font-mono text-[13px]`} value={value} readOnly onFocus={(e) => e.currentTarget.select()} aria-label="Redirect URL" />
      <button type="button" className={clsx(btn.small, 'shrink-0')} onClick={() => void copy()} aria-label="Copy the redirect URL">
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function ConnectStorageDialog({ provider, page, onClose }: { provider: StorageProvider; page: ConnectorsPage; onClose: () => void }) {
  const info = STORAGE_INFO[provider];
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [name, setName] = useState('');
  const [appFolder, setAppFolder] = useState(STORAGE_ROOT_FOLDER);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const callback = page.callbackUrl ?? (typeof window !== 'undefined' ? `${window.location.origin}${MCP_CALLBACK_PATH}` : MCP_CALLBACK_PATH);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      setError(null);
      const r = await startStorageSignInAction({ provider, clientId, clientSecret, name, appFolder: provider === 'dropbox' ? appFolder : undefined, totp: page.totpOn ? code : null });
      setCode('');
      if (!r.ok) { setError(r.error); return; }
      setClientSecret('');
      window.location.assign(r.authorizeUrl);
    });
  };

  return (
    <Dialog open onClose={onClose} title={`Connect ${info.name}`} wide>
      <form onSubmit={submit} className="flex flex-col gap-4" autoComplete="off">
        <p className="text-sm text-[var(--color-muted)]">{info.blurb}</p>
        <ol className="list-decimal space-y-1.5 rounded-xl border border-[var(--color-line)] p-4 pl-8 text-sm text-[var(--color-muted)]">
          {info.steps.map((s) => <li key={s}>{s}</li>)}
        </ol>
        <p className="text-sm">
          <a className="text-white underline underline-offset-4" href={info.console} target="_blank" rel="noreferrer">
            Open the {provider === 'drive' ? 'Google Cloud Console' : 'Dropbox App Console'}<ExternalLink size={12} className="ml-1 inline" aria-hidden />
          </a>
          <span className="text-[var(--color-dim)]"> · </span>
          <a className="text-[var(--color-muted)] underline underline-offset-4" href={info.docs} target="_blank" rel="noreferrer">Vendor docs</a>
        </p>
        <Field label="Redirect URL (copy into the app, exactly)"><CopyField value={callback} /></Field>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label={provider === 'drive' ? 'Client ID' : 'App key'}>
            <input className={`${inputCls} font-mono`} value={clientId} onChange={(e) => setClientId(e.target.value)} required minLength={8} />
          </Field>
          <Field label={provider === 'drive' ? 'Client secret' : 'App secret'} hint="Stored encrypted; never shown again.">
            <input className={`${inputCls} font-mono`} type="password" autoComplete="new-password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
              required minLength={8} data-1p-ignore data-lpignore="true" />
          </Field>
          <Field label="Label (optional)">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={info.name} maxLength={120} />
          </Field>
          {provider === 'dropbox' && (
            <Field label="App folder name" hint="Your Dropbox app's name (Dropbox → Apps → this folder). Used for links.">
              <input className={inputCls} value={appFolder} onChange={(e) => setAppFolder(e.target.value)} maxLength={100} required />
            </Field>
          )}
        </div>
        {page.totpOn && (
          <Field label="2FA code" hint="Connecting storage lets HQ write files there, so it needs your authenticator code.">
            <input className={codeInput} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required />
          </Field>
        )}
        {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={btn.ghost} onClick={onClose}>Cancel</button>
          <button className={btn.primary} disabled={pending || !clientId || !clientSecret}>{pending ? 'Starting…' : `Continue to ${provider === 'drive' ? 'Google' : 'Dropbox'}`}</button>
        </div>
      </form>
    </Dialog>
  );
}

export function StorageSection({ page, run, toast, refresh }: {
  page: ConnectorsPage; run: Run; toast: (t: string, tone?: 'info' | 'success' | 'error') => void; refresh: () => void;
}) {
  const list = page.connectors.filter((c) => c.kind === 'storage');
  const [connecting, setConnecting] = useState<StorageProvider | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const test = async (c: ConnectorView) => {
    setBusy(c.id);
    const r = await testStorageAction({ id: c.id });
    setBusy(null);
    if (!r.ok) toast(r.error, 'error'); else toast(r.message, r.working ? 'success' : 'error');
    refresh();
  };

  return (
    <section className="card flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="storage-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="storage-title" className="flex items-center gap-2 text-lg font-semibold"><HardDrive size={18} aria-hidden /> Storage</h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">
            Where agents save files and where every deliverable that passes QA is saved automatically, in
            <span className="text-white"> {STORAGE_ROOT_FOLDER} / client (or Internal) / request</span>. Files stay private to you: HQ never makes a public or shared link.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn.primary} onClick={() => setConnecting('drive')}>Connect Google Drive</button>
          <button type="button" className={btn.ghost} onClick={() => setConnecting('dropbox')}>Connect Dropbox</button>
        </div>
      </div>

      {list.length === 0 ? (
        <p className="item px-4 py-6 text-center text-sm text-[var(--color-muted)]">No storage connected yet. Deliverables stay in HQ until you connect one.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.map((c) => {
            const info = STORAGE_INFO[c.provider ?? 'drive'];
            return (
              <li key={c.id} className="item flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="min-w-0 break-all font-medium">{c.name}</span>
                  <Pill status={c.status} />
                  {c.isDefault && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-primary)] px-2.5 py-0.5 text-xs text-white"><Star size={11} aria-hidden />Default</span>
                  )}
                  {c.name !== info.name && <span className="text-sm text-[var(--color-muted)]">{info.name}</span>}
                </div>
                <p className="text-sm text-[var(--color-muted)]" suppressHydrationWarning>
                  {c.account_email ? `${c.account_email} · ` : ''}{c.last_used_at ? `last saved ${relTime(c.last_used_at)}` : 'nothing saved yet'}
                </p>
                {c.last_error && <p className="text-sm text-[#ff8a8d]">{c.last_error}</p>}
                <div className="flex flex-wrap gap-2">
                  {!c.isDefault && c.status === 'active' && (
                    <button type="button" className={btn.small} onClick={() => run('Make default', '', () => setDefaultStorageAction({ id: c.id }), `${c.name} is now the default storage.`)}>
                      <Star size={14} aria-hidden /> Make default
                    </button>
                  )}
                  <button type="button" className={btn.small} onClick={() => void test(c)} disabled={busy === c.id}>
                    <RefreshCw size={14} aria-hidden className={clsx(busy === c.id && 'animate-spin')} /> Test
                  </button>
                  {c.status === 'needs_reauth' && (
                    <button type="button" className={btn.small} onClick={() => setConnecting(c.provider ?? 'drive')}>Reconnect</button>
                  )}
                  <button type="button" className={btn.danger} onClick={() => {
                    if (!window.confirm(`Remove ${c.name}? HQ stops saving there now. Files already saved stay. Also remove HQ's access at ${info.revoke}.`)) return;
                    run('Remove', '', () => deleteConnectorAction({ id: c.id }), `Removed. Also revoke HQ at ${info.revoke.replace(/^https:\/\//, '')}.`);
                  }}><Trash2 size={14} aria-hidden /> Remove</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {connecting && page.mode === 'live' && <ConnectStorageDialog key={connecting} provider={connecting} page={page} onClose={() => setConnecting(null)} />}
      {connecting && page.mode === 'demo' && (
        <Dialog open onClose={() => setConnecting(null)} title="Demo mode"><p className="text-sm text-[var(--color-muted)]">Connecting storage needs the live dashboard.</p></Dialog>
      )}
    </section>
  );
}
