'use client';
// Client Vault UI (docs/06 §7a): the client's credentials (shared CredentialVault list: masked secrets, status,
// last use, grants, audit log) plus the one-time client access links.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { Link2 } from 'lucide-react';
import type { AccessLinkView, ClientDetail } from '@/lib/data/vault';
import { cancelAccessLinkAction } from '@/app/vault-actions';
import { useHq } from '@/lib/data/store';
import { CredentialVault } from './CredentialVault';
import { AccessLinkDialog } from './VaultDialogs';
import { PLATFORM_LABEL, btn, relTime } from './ui';

function linkState(l: AccessLinkView, now = Date.now()) {
  if (l.used_at) return { label: 'Used', color: 'var(--color-success)' };
  if (l.cancelled_at) return { label: 'Cancelled', color: 'var(--color-dim)' };
  if (new Date(l.expires_at).getTime() <= now) return { label: 'Expired', color: 'var(--color-dim)' };
  return { label: 'Open', color: 'var(--color-info)' };
}

export function AccessTab({ detail, startAdding }: { detail: ClientDetail; startAdding?: boolean }) {
  const router = useRouter();
  const { toast } = useHq();
  const [linkOpen, setLinkOpen] = useState(false);
  const [pending, start] = useTransition();
  const { client, credentials, log, links } = detail;
  const archived = client.status === 'archived';

  return (
    <div className="flex flex-col gap-4">
      <CredentialVault
        clientId={client.id} credentials={credentials} log={log} archived={archived} startAdding={startAdding}
        intro="Encrypted by the worker; agents use logins without ever seeing them."
        actions={<button className={btn.ghost} onClick={() => setLinkOpen(true)} disabled={archived}><Link2 size={16} aria-hidden />Request access from client</button>}
        notice={archived && <p className="item px-4 py-3 text-sm text-[var(--color-muted)]">This client is archived: every agent grant and open link was revoked automatically.</p>}
        emptyText={`No logins yet. Add one, or send ${client.name} a secure link so they enter it themselves.`}
        newTitle={`New login for ${client.name}`}
      />

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
                      onClick={() => start(async () => {
                        const r = await cancelAccessLinkAction({ id: l.id });
                        if (r.ok) { toast('Link cancelled', 'success'); router.refresh(); } else toast(r.error, 'error');
                      })}>Cancel link</button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <AccessLinkDialog client={client} open={linkOpen} onClose={() => setLinkOpen(false)} onCreated={() => router.refresh()} />
    </div>
  );
}
