'use client';
// Connections (docs/06 §9): every login / token from the Client Vault in one place, per client × platform,
// with status, last use and Revoke. Secrets are never shown here (reveal lives on the client's Access tab).
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { KeyRound, Search, ServerCog, ShieldOff } from 'lucide-react';
import type { ConnectionsData, CredentialView } from '@/lib/data/vault';
import { useHq } from '@/lib/data/store';
import { AgentChips } from '../clients/AgentPicker';
import { RevokeDialog } from '../clients/VaultDialogs';
import { PLATFORM_LABEL, PlatformChip, StatusPill, btn, inputCls, relTime } from '../clients/ui';

type Cred = ConnectionsData['credentials'][number];
type Shown = 'active' | 'expiring' | 'check_needed' | 'revoked';
const FILTERS: { id: 'all' | Shown; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'active', label: 'Active' }, { id: 'expiring', label: 'Expiring' }, { id: 'check_needed', label: 'Check needed' }, { id: 'revoked', label: 'Revoked' },
];
const RANK: Record<Shown | 'missing', number> = { check_needed: 0, expiring: 1, active: 2, revoked: 3, missing: 4 };
const CELL: Record<Shown | 'missing', { color: string; label: string }> = {
  active: { color: 'var(--color-success)', label: 'active' }, expiring: { color: 'var(--color-warning)', label: 'expiring' },
  check_needed: { color: 'var(--color-danger)', label: 'check' }, revoked: { color: 'var(--color-dim)', label: 'revoked' },
  missing: { color: 'var(--color-line)', label: 'missing' },
};

function shown(c: Pick<CredentialView, 'status' | 'expires_at'>, now = Date.now()): Shown {
  if (c.status === 'active' && c.expires_at && new Date(c.expires_at).getTime() - now < 14 * 86400_000) return 'expiring';
  return c.status;
}

function Matrix({ data }: { data: ConnectionsData }) {
  const platforms = useMemo(() => {
    const set = new Set<string>();
    for (const c of data.credentials) set.add(c.platform);
    for (const c of data.clients) for (const p of c.platforms) set.add(p);
    return Object.keys(PLATFORM_LABEL).filter((p) => set.has(p)).concat([...set].filter((p) => !(p in PLATFORM_LABEL)));
  }, [data]);
  const clients = data.clients.filter((c) => c.status !== 'archived');
  const cell = (clientId: string, platform: string, listed: boolean): Shown | 'missing' | null => {
    const list = data.credentials.filter((c) => c.client_id === clientId && c.platform === platform).map((c) => shown(c));
    if (!list.length) return listed ? 'missing' : null;
    return list.sort((a, b) => RANK[a] - RANK[b])[0]!;
  };
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full min-w-[560px] border-separate border-spacing-1 text-[13px]">
        <thead>
          <tr><th className="text-left text-xs font-medium text-[var(--color-dim)]">Client</th>
            {platforms.map((p) => <th key={p} className="px-1 text-center text-xs font-medium text-[var(--color-dim)]">{PLATFORM_LABEL[p] ?? p}</th>)}</tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.id}>
              <td className="whitespace-nowrap pr-2"><Link href={`/clients/${c.id}?tab=access`} className="hover:underline">{c.name}</Link></td>
              {platforms.map((p) => {
                const s = cell(c.id, p, c.platforms.includes(p));
                return (
                  <td key={p} className="text-center">
                    {s ? (
                      <span className="inline-flex h-7 w-full min-w-[64px] items-center justify-center rounded-lg text-[11px]"
                        style={{ background: s === 'missing' ? 'transparent' : `color-mix(in oklab, ${CELL[s].color} 18%, transparent)`, color: s === 'missing' ? 'var(--color-dim)' : `color-mix(in oklab, ${CELL[s].color} 80%, white)`, border: `1px ${s === 'missing' ? 'dashed' : 'solid'} color-mix(in oklab, ${CELL[s].color} 45%, transparent)` }}>
                        {CELL[s].label}
                      </span>
                    ) : <span className="text-[var(--color-line)]">·</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CredRow({ c, onRevoke }: { c: Cred; onRevoke: () => void }) {
  const { idx } = useHq();
  const by = c.last_used_by === 'ceo' ? 'you' : idx.agentById.get(c.last_used_by ?? '')?.name ?? c.last_used_by;
  return (
    <li className={clsx('item grid gap-2 p-3.5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center', c.status === 'revoked' && 'opacity-65')}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><PlatformChip platform={c.platform} /><StatusPill status={shown(c)} failedLogins={c.failed_login_count} /></div>
        <p className="mt-1 truncate text-[14px] font-medium">{c.label}</p>
        <Link href={`/clients/${c.client_id}?tab=access`} className="text-xs text-[var(--color-muted)] hover:text-white hover:underline">{c.client_name}</Link>
      </div>
      <div className="min-w-0 text-[13px]"><AgentChips ids={c.grants} /></div>
      <div className="min-w-0 text-[13px] text-[var(--color-muted)]" suppressHydrationWarning>
        {c.last_used_at ? <>Used {relTime(c.last_used_at)}<span className="text-[var(--color-dim)]"> · {by}</span></> : 'Not used yet'}
        {c.scope_notes && <p className="truncate text-xs text-[var(--color-dim)]" title={c.scope_notes}>{c.scope_notes}</p>}
      </div>
      <div className="flex justify-end">
        {c.status !== 'revoked' ? <button className={btn.danger} onClick={onRevoke}><ShieldOff size={14} aria-hidden />Revoke</button>
          : <span className="text-xs text-[var(--color-dim)]">revoked {relTime(c.revoked_at ?? null)}</span>}
      </div>
    </li>
  );
}

export function ConnectionsView({ data, error }: { data: ConnectionsData; error?: string }) {
  const router = useRouter();
  const { toast } = useHq();
  const [filter, setFilter] = useState<'all' | Shown>('all');
  const [q, setQ] = useState('');
  const [revoke, setRevoke] = useState<Cred | null>(null);
  const list = useMemo(() => data.credentials
    .filter((c) => (filter === 'all' ? true : shown(c) === filter))
    .filter((c) => !q.trim() || `${c.label} ${c.client_name} ${c.platform}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => RANK[shown(a)] - RANK[shown(b)] || a.client_name.localeCompare(b.client_name)), [data, filter, q]);
  const count = (s: Shown) => data.credentials.filter((c) => shown(c) === s).length;

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Connections</h1>
        <p className="text-sm text-[var(--color-muted)]">Every client login and token in one place. Add or reveal them on the client&apos;s Access tab.</p>
      </div>
      {error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">Couldn&apos;t load connections: {error}</p>}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Totals">
        {([['active', 'Active'], ['expiring', 'Expiring soon'], ['check_needed', 'Check needed'], ['revoked', 'Revoked']] as [Shown, string][]).map(([s, l]) => (
          <div key={s} className="card px-4 py-3">
            <p className="text-[13px] text-[var(--color-muted)]">{l}</p>
            <p className="mt-0.5 text-2xl font-semibold tabular-nums" style={{ color: count(s) && s !== 'active' && s !== 'revoked' ? CELL[s].color : undefined }}>{count(s)}</p>
          </div>
        ))}
      </section>
      <section className="card p-4 sm:p-5" aria-labelledby="matrix-h">
        <h2 id="matrix-h" className="mb-3 text-lg font-semibold">Client × platform</h2>
        <Matrix data={data} />
      </section>
      <section className="card p-4 sm:p-5" aria-labelledby="list-h">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 id="list-h" className="text-lg font-semibold">All credentials</h2>
          <label className="relative w-full min-w-0 sm:ml-auto sm:w-auto sm:max-w-xs sm:flex-1">
            <span className="sr-only">Search</span>
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-dim)]" aria-hidden />
            <input className={clsx(inputCls, 'pl-9')} placeholder="Search client, label, platform" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="scroll-thin flex w-full gap-2 overflow-x-auto pb-1">
            {FILTERS.map((f) => (
              <button key={f.id} onClick={() => setFilter(f.id)} aria-pressed={filter === f.id}
                className={clsx('shrink-0 rounded-full border px-3 py-1 text-[13px]', filter === f.id ? 'border-[var(--color-line-active)] bg-[var(--color-panel-2)] text-white' : 'border-[var(--color-line)] text-[var(--color-muted)]')}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {list.length === 0 ? (
          <div className="item flex flex-col items-center gap-2 p-8 text-center"><KeyRound size={22} className="text-[var(--color-primary-hover)]" aria-hidden /><p className="text-sm text-[var(--color-muted)]">Nothing here.</p></div>
        ) : <ul className="flex flex-col gap-2">{list.map((c) => <CredRow key={c.id} c={c} onRevoke={() => setRevoke(c)} />)}</ul>}
      </section>
      <section className="card p-4 sm:p-5" aria-labelledby="sys-h">
        <h2 id="sys-h" className="mb-1 flex items-center gap-2 text-lg font-semibold"><ServerCog size={18} aria-hidden />System keys</h2>
        <p className="mb-3 text-sm text-[var(--color-muted)]">Live in the worker&apos;s env file on the VPS; only the variable name is stored here.</p>
        {data.systemKeys.length === 0 ? <p className="text-sm text-[var(--color-dim)]">None registered.</p> : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {data.systemKeys.map((k) => (
              <li key={k.secret_ref} className="item flex items-center gap-3 px-3.5 py-2.5 text-[13px]" suppressHydrationWarning>
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{k.label}</span><code className="text-xs text-[var(--color-dim)]">{k.secret_ref}</code></span>
                <span className="text-right text-xs text-[var(--color-muted)]"><span className="block capitalize" style={{ color: k.status === 'active' ? 'var(--color-success)' : k.status === 'expiring' ? 'var(--color-warning)' : 'var(--color-danger)' }}>{k.status}</span>{k.last_used_at ? relTime(k.last_used_at) : 'unused'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <RevokeDialog cred={revoke} onClose={() => setRevoke(null)} onDone={(m) => { toast(m, 'success'); router.refresh(); }} />
    </>
  );
}
