'use client';
// Client Vault UI (docs/06 §7a): credentials with masked secrets, status, last use, grants, audit log,
// and the one-time client access links.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import {
  ChevronDown, Eye, KeyRound, Link2, Lock, Pencil, Plus, RefreshCw, ShieldCheck, ShieldOff, UserRound, Globe, Timer,
} from 'lucide-react';
import type { AccessLinkView, AccessLogView, ClientDetail, CredentialView } from '@/lib/data/vault';
import { cancelAccessLinkAction, reactivateCredentialAction } from '@/app/vault-actions';
import { useHq } from '@/lib/data/store';
import { AgentChips } from './AgentPicker';
import { CredentialForm } from './CredentialForm';
import { AccessLinkDialog, RevealDialog, RevokeDialog, RotateDialog } from './VaultDialogs';
import { PLATFORM_LABEL, PlatformChip, SECRET_TYPE_LABEL, StatusPill, TWOFA_LABEL, btn, relTime } from './ui';

function effectiveStatus(c: CredentialView, now = Date.now()) {
  if (c.status === 'active' && c.expires_at && new Date(c.expires_at).getTime() - now < 14 * 86400_000) return 'expiring' as const;
  return c.status;
}

const ACTION_TEXT: Record<string, string> = {
  store: 'stored', login: 'logged in', api_call: 'API call', reveal: 'revealed', failed_login: 'failed login', rotate: 'rotated',
  revoke: 'revoked', denied: 'denied', grants: 'changed grants', edit: 'edited', problem: 'reported a problem', twofa_request: 'asked for 2FA code',
  twofa: 'passed 2FA', list: 'listed',
};

function LogLine({ l }: { l: AccessLogView }) {
  const { idx } = useHq();
  const who = l.agent_id === 'ceo' ? 'You' : l.agent_id === 'client' ? 'Client (link)' : l.agent_id === 'system' ? 'System' : idx.agentById.get(l.agent_id ?? '')?.name ?? l.agent_id ?? '—';
  const d = l.detail ?? {};
  const extra = [d.method && d.path ? `${d.method} ${d.path}` : null, d.status ? `→ ${d.status}` : null, d.reason ? String(d.reason) : null, d.host && !d.path ? String(d.host) : null]
    .filter(Boolean).join(' ');
  return (
    <li className="flex items-start gap-2 text-[13px]" suppressHydrationWarning>
      <span className={clsx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', l.success ? 'bg-[var(--color-success)]' : 'bg-[var(--color-danger)]')} aria-hidden />
      <span className="min-w-0 flex-1"><b className="font-medium text-white">{who}</b> <span className="text-[var(--color-muted)]">{ACTION_TEXT[l.action] ?? l.action}</span>{extra && <span className="break-all text-[var(--color-dim)]"> · {extra}</span>}</span>
      <span className="shrink-0 text-xs text-[var(--color-dim)]">{relTime(l.created_at)}</span>
    </li>
  );
}

function CredentialCard({ c, log, onReveal, onEdit, onRotate, onRevoke, onReactivate, busy }: {
  c: CredentialView; log: AccessLogView[]; busy: boolean;
  onReveal: () => void; onEdit: () => void; onRotate: () => void; onRevoke: () => void; onReactivate: () => void;
}) {
  const { idx } = useHq();
  const [open, setOpen] = useState(false);
  const status = effectiveStatus(c);
  const revoked = c.status === 'revoked';
  const lastBy = c.last_used_by === 'ceo' ? 'you' : idx.agentById.get(c.last_used_by ?? '')?.name ?? c.last_used_by;
  return (
    <li className={clsx('item flex flex-col gap-3 p-4', revoked && 'opacity-70')}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <PlatformChip platform={c.platform} />
            <StatusPill status={status} failedLogins={c.failed_login_count} />
            {c.created_by === 'client_link' && <span className="rounded-md bg-[color-mix(in_oklab,var(--color-info)_18%,transparent)] px-1.5 py-0.5 text-[11px] text-[var(--color-info)]">added by client</span>}
          </div>
          <p className="text-[15px] font-semibold leading-snug">{c.label}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {!revoked && <button className={btn.small} onClick={onReveal} disabled={busy}><Eye size={14} aria-hidden />Reveal</button>}
          {!revoked && <button className={btn.small} onClick={onEdit} disabled={busy}><Pencil size={14} aria-hidden />Edit</button>}
          {!revoked && <button className={btn.small} onClick={onRotate} disabled={busy}><RefreshCw size={14} aria-hidden />Rotate</button>}
          {c.status === 'check_needed' && <button className={btn.small} onClick={onReactivate} disabled={busy}><ShieldCheck size={14} aria-hidden />Mark fixed</button>}
          {!revoked && <button className={btn.danger} onClick={onRevoke} disabled={busy}><ShieldOff size={14} aria-hidden />Revoke</button>}
        </div>
      </div>
      <dl className="grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-2 xl:grid-cols-3">
        <div className="flex min-w-0 items-center gap-2"><dt className="sr-only">Login URL</dt><Globe size={14} className="shrink-0 text-[var(--color-dim)]" aria-hidden />
          <dd className="truncate text-[var(--color-muted)]">{c.login_url ? <a className="hover:text-white hover:underline" href={c.login_url} target="_blank" rel="noreferrer noopener">{c.login_url.replace(/^https:\/\//, '')}</a> : 'No login URL'}</dd></div>
        <div className="flex min-w-0 items-center gap-2"><dt className="sr-only">Username</dt><UserRound size={14} className="shrink-0 text-[var(--color-dim)]" aria-hidden />
          <dd className="truncate text-[var(--color-muted)]">{c.username ?? '—'}</dd></div>
        <div className="flex min-w-0 items-center gap-2"><dt className="sr-only">Secret</dt><Lock size={14} className="shrink-0 text-[var(--color-dim)]" aria-hidden />
          <dd className="truncate text-[var(--color-muted)]"><span className="font-mono tracking-wider">••••••••••</span> · {SECRET_TYPE_LABEL[c.secret_type]}</dd></div>
        <div className="flex min-w-0 items-center gap-2"><dt className="sr-only">2FA</dt><KeyRound size={14} className="shrink-0 text-[var(--color-dim)]" aria-hidden />
          <dd className="truncate text-[var(--color-muted)]">{TWOFA_LABEL[c.twofa_method]}</dd></div>
        <div className="flex min-w-0 items-center gap-2" suppressHydrationWarning><dt className="sr-only">Last used</dt><Timer size={14} className="shrink-0 text-[var(--color-dim)]" aria-hidden />
          <dd className="truncate text-[var(--color-muted)]">{c.last_used_at ? `Last used by ${lastBy} · ${relTime(c.last_used_at)}` : 'Not used yet'}</dd></div>
        {c.expires_at && <div className="flex min-w-0 items-center gap-2" suppressHydrationWarning><dt className="sr-only">Expires</dt><Timer size={14} className="shrink-0 text-[var(--color-dim)]" aria-hidden />
          <dd className={clsx('truncate', status === 'expiring' ? 'text-[#ffb35c]' : 'text-[var(--color-muted)]')}>Expires {new Date(c.expires_at).toLocaleDateString([], { dateStyle: 'medium' })} ({relTime(c.expires_at)})</dd></div>}
      </dl>
      <div className="flex flex-col gap-1.5 text-[13px]">
        <div className="flex flex-wrap items-center gap-2"><span className="text-[var(--color-dim)]">Agents:</span><AgentChips ids={c.grants} /></div>
        {c.scope_notes && <p className="text-[var(--color-muted)]"><span className="text-[var(--color-dim)]">Scope: </span>{c.scope_notes}</p>}
        {c.url_allowlist.length > 0 && <p className="break-all font-mono text-xs text-[var(--color-dim)]">{c.url_allowlist.join('  ·  ')}</p>}
        {c.url_allowlist.length > 0 && (
          <p className="break-all text-xs text-[var(--color-dim)]">
            API writes: {c.write_allowlist?.length ? <span className="font-mono">{c.write_allowlist.join('  ·  ')}</span> : 'none (read-only)'}
          </p>
        )}
        {c.status === 'check_needed' && (
          <p className="rounded-lg bg-[color-mix(in_oklab,var(--color-danger)_14%,transparent)] px-3 py-2 text-[#ff8a8d]">
            {c.failed_login_count >= 2 ? 'Login failed twice, so agents stopped trying (so the client\'s account doesn\'t lock).' : 'An agent reported a problem.'} Fix it at {PLATFORM_LABEL[c.platform] ?? c.platform}, then Rotate or Mark fixed.
          </p>
        )}
      </div>
      <div>
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 text-[13px] text-[var(--color-muted)] hover:text-white">
          <ChevronDown size={14} className={clsx('transition-transform', open && 'rotate-180')} aria-hidden />Access log ({log.length})
        </button>
        {open && (log.length ? <ul className="mt-2 flex flex-col gap-1.5 border-l border-[var(--color-line)] pl-3">{log.slice(0, 12).map((l) => <LogLine key={l.id} l={l} />)}</ul>
          : <p className="mt-2 text-xs text-[var(--color-dim)]">No activity yet.</p>)}
      </div>
    </li>
  );
}

function linkState(l: AccessLinkView, now = Date.now()) {
  if (l.used_at) return { label: 'Used', color: 'var(--color-success)' };
  if (l.cancelled_at) return { label: 'Cancelled', color: 'var(--color-dim)' };
  if (new Date(l.expires_at).getTime() <= now) return { label: 'Expired', color: 'var(--color-dim)' };
  return { label: 'Open', color: 'var(--color-info)' };
}

export function AccessTab({ detail, startAdding }: { detail: ClientDetail; startAdding?: boolean }) {
  const router = useRouter();
  const { toast, session } = useHq();
  const [adding, setAdding] = useState(Boolean(startAdding));
  const [editing, setEditing] = useState<CredentialView | null>(null);
  const [reveal, setReveal] = useState<CredentialView | null>(null);
  const [rotate, setRotate] = useState<CredentialView | null>(null);
  const [revoke, setRevoke] = useState<CredentialView | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [pending, start] = useTransition();
  const { client, credentials, log, links } = detail;
  const archived = client.status === 'archived';
  const done = (msg: string) => { toast(msg, 'success'); setAdding(false); setEditing(null); router.refresh(); };
  const active = credentials.filter((c) => c.status !== 'revoked');
  const revoked = credentials.filter((c) => c.status === 'revoked');

  const cardFor = (c: CredentialView) => (
    <CredentialCard key={c.id} c={c} log={log.filter((l) => l.credential_id === c.id)} busy={pending}
      onReveal={() => setReveal(c)} onEdit={() => { setAdding(false); setEditing(c); }} onRotate={() => setRotate(c)} onRevoke={() => setRevoke(c)}
      onReactivate={() => start(async () => { const r = await reactivateCredentialAction({ id: c.id }); if (r.ok) done('Marked fixed; agents may use it again.'); else toast(r.error, 'error'); })} />
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto flex min-w-0 items-center gap-2 text-sm text-[var(--color-muted)]">
          <Lock size={15} className="shrink-0 text-[var(--color-teal)]" aria-hidden />
          Encrypted by the worker; agents use logins without ever seeing them.
        </p>
        <button className={btn.ghost} onClick={() => setLinkOpen(true)} disabled={archived}><Link2 size={16} aria-hidden />Request access from client</button>
        <button className={btn.primary} onClick={() => { setEditing(null); setAdding(true); }} disabled={archived}><Plus size={16} aria-hidden />Add login</button>
      </div>
      {archived && <p className="item px-4 py-3 text-sm text-[var(--color-muted)]">This client is archived: every agent grant and open link was revoked automatically.</p>}

      {(adding || editing) && (
        <section className="card border-[var(--color-line-active)] p-4 sm:p-5" aria-label={editing ? 'Edit credential' : 'Add credential'}>
          <h3 className="mb-4 text-base font-semibold">{editing ? `Edit · ${editing.label}` : `New login for ${client.name}`}</h3>
          <CredentialForm key={editing?.id ?? 'new'} clientId={client.id} initial={editing ?? undefined} onDone={done} onCancel={() => { setAdding(false); setEditing(null); }} />
        </section>
      )}

      {active.length === 0 && !adding ? (
        <div className="item flex flex-col items-center gap-2 p-8 text-center">
          <KeyRound size={24} className="text-[var(--color-primary-hover)]" aria-hidden />
          <p className="text-[15px] text-[var(--color-muted)]">No logins yet. Add one, or send {client.name} a secure link so they enter it themselves.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">{active.map(cardFor)}</ul>
      )}
      {revoked.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm text-[var(--color-muted)] hover:text-white">Revoked ({revoked.length})</summary>
          <ul className="mt-3 flex flex-col gap-3">{revoked.map(cardFor)}</ul>
        </details>
      )}

      <section className="item p-4" aria-labelledby="links-h">
        <h3 id="links-h" className="mb-3 flex items-center gap-2 text-sm font-semibold"><Link2 size={15} aria-hidden />Secure access links</h3>
        {links.length === 0 ? <p className="text-sm text-[var(--color-dim)]">None sent yet. Links work once and expire after 72 hours.</p> : (
          <ul className="flex flex-col gap-2">
            {links.map((l) => {
              const s = linkState(l);
              return (
                <li key={l.id} className="flex flex-wrap items-center gap-2 text-[13px]" suppressHydrationWarning>
                  <span className="rounded-full border px-2 py-0.5 text-xs" style={{ color: s.color, borderColor: `color-mix(in oklab, ${s.color} 50%, transparent)` }}>{s.label}</span>
                  <span className="text-white">{l.platforms.map((p) => PLATFORM_LABEL[p] ?? p).join(', ')}</span>
                  <span className="text-[var(--color-dim)]">sent {relTime(l.created_at)}{s.label === 'Open' ? ` · expires ${relTime(l.expires_at)}` : ''}{l.used_at ? ` · used ${relTime(l.used_at)}` : ''}</span>
                  {s.label === 'Open' && (
                    <button className={clsx(btn.small, 'ml-auto')} disabled={pending}
                      onClick={() => start(async () => { const r = await cancelAccessLinkAction({ id: l.id }); if (r.ok) done('Link cancelled'); else toast(r.error, 'error'); })}>Cancel link</button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <RevealDialog cred={reveal} demo={session.mode === 'demo'} onClose={() => setReveal(null)} onRevealed={() => router.refresh()} />
      <RotateDialog cred={rotate} onClose={() => setRotate(null)} onDone={done} />
      <RevokeDialog cred={revoke} onClose={() => setRevoke(null)} onDone={done} />
      <AccessLinkDialog client={client} open={linkOpen} onClose={() => setLinkOpen(false)} onCreated={() => router.refresh()} />
    </div>
  );
}
