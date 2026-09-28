'use client';
import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { AlertTriangle, ChevronRight, KeyRound, Link2, Plus, Search } from 'lucide-react';
import type { ClientSummary } from '@/lib/data/vault';
import { createClientAction } from '@/app/vault-actions';
import { useHq } from '@/lib/data/store';
import { Dialog, Field, PlatformChip, PLATFORM_LABEL, btn, inputCls, usd } from './ui';

const FILTERS = [{ id: 'active', label: 'Active' }, { id: 'attention', label: 'Needs attention' }, { id: 'archived', label: 'Archived' }, { id: 'all', label: 'All' }] as const;
type FilterId = (typeof FILTERS)[number]['id'];

function ClientCard({ c }: { c: ClientSummary }) {
  return (
    <li className="min-w-0">
      <Link href={`/clients/${c.id}`} className="item group flex h-full flex-col gap-3 p-4 transition-colors hover:border-[var(--color-line-active)]">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-panel)] text-sm font-semibold text-[var(--color-primary-hover)]" aria-hidden>
            {c.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-[15px] font-semibold leading-snug">
              <span className="truncate">{c.name}</span>
              {c.status !== 'active' && <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5 text-[11px] font-normal capitalize text-[var(--color-muted)]">{c.status}</span>}
            </p>
            <p className="truncate text-[13px] text-[var(--color-muted)]">{c.service_package ? c.service_package.replace(/-/g, ' ') : 'No package yet'}{c.website ? ` · ${c.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}` : ''}</p>
          </div>
          <ChevronRight size={18} className="mt-1 shrink-0 text-[var(--color-dim)] group-hover:text-white" aria-hidden />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {c.platforms.length ? c.platforms.map((p) => <PlatformChip key={p} platform={p} />) : <span className="text-xs text-[var(--color-dim)]">No platforms listed</span>}
        </div>
        <dl className="mt-auto grid grid-cols-3 gap-2 border-t border-[var(--color-line)] pt-3 text-center">
          <div><dt className="text-[11px] text-[var(--color-dim)]">Open requests</dt><dd className="text-lg font-semibold tabular-nums">{c.openRequests}</dd></div>
          <div><dt className="text-[11px] text-[var(--color-dim)]">Logins</dt><dd className="text-lg font-semibold tabular-nums">{c.credentials}</dd></div>
          <div><dt className="text-[11px] text-[var(--color-dim)]">Spend (month)</dt><dd className="text-lg font-semibold tabular-nums">{usd(c.spendMonth)}</dd></div>
        </dl>
        {(c.attention > 0 || c.openLinks > 0) && (
          <div className="flex flex-wrap gap-2 text-xs">
            {c.attention > 0 && <span className="inline-flex items-center gap-1 text-[#ffb35c]"><AlertTriangle size={13} aria-hidden />{c.attention} login{c.attention > 1 ? 's need' : ' needs'} attention</span>}
            {c.openLinks > 0 && <span className="inline-flex items-center gap-1 text-[var(--color-info)]"><Link2 size={13} aria-hidden />{c.openLinks} access link open</span>}
          </div>
        )}
      </Link>
    </li>
  );
}

function AddClient({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { toast } = useHq();
  const [pending, start] = useTransition();
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [pkg, setPkg] = useState('');
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await createClientAction({ name, website, platforms, service_package: pkg });
      if (!r.ok) { setError(r.error); return; }
      toast(`${name} added`, 'success');
      onClose();
      router.push(`/clients/${r.id}?tab=access`);
    });
  };
  return (
    <Dialog open={open} onClose={onClose} title="Add client">
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label="Company name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus /></Field>
        <Field label="Website"><input className={inputCls} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" inputMode="url" /></Field>
        <Field label="Service package"><input className={inputCls} value={pkg} onChange={(e) => setPkg(e.target.value)} placeholder="e.g. shopify-growth, seo-retainer" /></Field>
        <fieldset className="flex flex-col gap-1.5 text-[13px] text-[var(--color-muted)]">
          <legend className="mb-1.5">Platforms</legend>
          <div className="flex flex-wrap gap-1.5">
            {Object.keys(PLATFORM_LABEL).map((p) => (
              <button type="button" key={p} aria-pressed={platforms.includes(p)} onClick={() => setPlatforms((x) => (x.includes(p) ? x.filter((y) => y !== p) : [...x, p]))}
                className={clsx('rounded-full border px-2.5 py-1 text-xs', platforms.includes(p) ? 'border-[var(--color-line-active)] bg-[var(--color-panel-2)] text-white' : 'border-[var(--color-line)] text-[var(--color-muted)]')}>
                {PLATFORM_LABEL[p]}
              </button>
            ))}
          </div>
        </fieldset>
        {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className={btn.ghost} onClick={onClose}>Cancel</button><button className={btn.primary} disabled={pending}>{pending ? 'Adding…' : 'Add client'}</button></div>
      </form>
    </Dialog>
  );
}

export function ClientsView({ clients, error }: { clients: ClientSummary[]; error?: string }) {
  const [filter, setFilter] = useState<FilterId>('active');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return clients.filter((c) => {
      if (needle && !`${c.name} ${c.slug} ${c.service_package ?? ''} ${c.platforms.join(' ')}`.toLowerCase().includes(needle)) return false;
      if (filter === 'active') return c.status !== 'archived';
      if (filter === 'attention') return c.attention > 0 || c.openLinks > 0;
      if (filter === 'archived') return c.status === 'archived';
      return true;
    });
  }, [clients, filter, q]);
  const totals = useMemo(() => ({
    active: clients.filter((c) => c.status === 'active').length,
    logins: clients.reduce((s, c) => s + c.credentials, 0),
    attention: clients.reduce((s, c) => s + c.attention, 0),
    spend: clients.reduce((s, c) => s + c.spendMonth, 0),
  }), [clients]);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Clients</h1>
          <p className="text-sm text-[var(--color-muted)]">Profiles, requests and the Client Vault: logins your AI team may use.</p>
        </div>
        <button className={btn.primary} onClick={() => setAdding(true)}><Plus size={16} aria-hidden />Add client</button>
      </div>
      {error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">Couldn&apos;t load clients: {error}</p>}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Totals">
        {[['Active clients', String(totals.active)], ['Logins in vault', String(totals.logins)], ['Need attention', String(totals.attention)], ['Spend this month', usd(totals.spend)]].map(([l, v], i) => (
          <div key={l} className="card px-4 py-3">
            <p className="text-[13px] text-[var(--color-muted)]">{l}</p>
            <p className="mt-0.5 text-2xl font-semibold tabular-nums" style={i === 2 && totals.attention ? { color: 'var(--color-warning)' } : undefined}>{v}</p>
          </div>
        ))}
      </section>
      <section className="card p-4 sm:p-5" aria-label="Client list">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="relative min-w-0 flex-1 sm:max-w-xs">
            <span className="sr-only">Search clients</span>
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-dim)]" aria-hidden />
            <input className={clsx(inputCls, 'pl-9')} placeholder="Search clients or platforms" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            {FILTERS.map((f) => (
              <button key={f.id} onClick={() => setFilter(f.id)} aria-pressed={filter === f.id}
                className={clsx('rounded-full border px-3 py-1 text-[13px]', filter === f.id ? 'border-[var(--color-line-active)] bg-[var(--color-panel-2)] text-white' : 'border-[var(--color-line)] text-[var(--color-muted)]')}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {list.length === 0 ? (
          <div className="item flex flex-col items-center gap-2 p-8 text-center">
            <KeyRound size={24} className="text-[var(--color-primary-hover)]" aria-hidden />
            <p className="text-[15px] text-[var(--color-muted)]">{clients.length ? 'No clients match.' : 'No clients yet. Add your first one.'}</p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{list.map((c) => <ClientCard key={c.id} c={c} />)}</ul>
        )}
      </section>
      <AddClient open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
