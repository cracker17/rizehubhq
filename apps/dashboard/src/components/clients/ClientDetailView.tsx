'use client';
// Client page: Profile · Access (Client Vault) · Requests (docs/06 §7, §7a).
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { Archive, ArrowLeft, ExternalLink, Save } from 'lucide-react';
import type { ClientDetail } from '@/lib/data/vault';
import { archiveClientAction, updateClientAction } from '@/app/vault-actions';
import { useHq } from '@/lib/data/store';
import { clip, relDay } from '@/lib/data/derive';
import { AccessTab } from './AccessTab';
import { Dialog, Field, PLATFORM_LABEL, PlatformChip, btn, inputCls, textareaCls, usd } from './ui';

export type ClientTab = 'profile' | 'access' | 'requests';
const TABS: { id: ClientTab; label: string }[] = [{ id: 'profile', label: 'Profile' }, { id: 'access', label: 'Access' }, { id: 'requests', label: 'Requests' }];

function ProfileTab({ detail }: { detail: ClientDetail }) {
  const c = detail.client;
  const router = useRouter();
  const { toast } = useHq();
  const [pending, start] = useTransition();
  const [name, setName] = useState(c.name);
  const [website, setWebsite] = useState(c.website ?? '');
  const [pkg, setPkg] = useState(c.service_package ?? '');
  const [ws, setWs] = useState(c.rizehub_workspace_id ?? '');
  const [notes, setNotes] = useState(c.notes ?? '');
  const [platforms, setPlatforms] = useState<string[]>(c.platforms);
  const [status, setStatus] = useState<'active' | 'paused'>(c.status === 'paused' ? 'paused' : 'active');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const archived = c.status === 'archived';
  const missing = platforms.filter((p) => !detail.credentials.some((x) => x.platform === p && x.status !== 'revoked'));

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await updateClientAction({ id: c.id, name, website, platforms, service_package: pkg, notes, rizehub_workspace_id: ws, status });
      if (r.ok) { toast('Profile saved', 'success'); router.refresh(); } else toast(r.error, 'error');
    });
  };
  const archive = () => start(async () => {
    const r = await archiveClientAction({ id: c.id });
    setConfirmArchive(false);
    if (r.ok) { toast(`${c.name} archived; all agent access revoked`, 'success'); router.refresh(); } else toast(r.error, 'error');
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <form onSubmit={save} className="item flex flex-col gap-3.5 p-4 sm:p-5">
        <fieldset disabled={archived || pending} className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Company"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></Field>
          <Field label="Website"><input className={inputCls} value={website} onChange={(e) => setWebsite(e.target.value)} inputMode="url" placeholder="https://" /></Field>
          <Field label="Service package"><input className={inputCls} value={pkg} onChange={(e) => setPkg(e.target.value)} placeholder="shopify-growth" /></Field>
          <Field label="RizeHub workspace id"><input className={inputCls} value={ws} onChange={(e) => setWs(e.target.value)} placeholder="Set by the COO during onboarding" /></Field>
          <Field label="Status">
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'paused')}>
              <option value="active">Active</option><option value="paused">Paused</option>
            </select>
          </Field>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1.5 text-[13px] text-[var(--color-muted)]">Platforms</legend>
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(PLATFORM_LABEL).map((p) => (
                <button type="button" key={p} aria-pressed={platforms.includes(p)} onClick={() => setPlatforms((x) => (x.includes(p) ? x.filter((y) => y !== p) : [...x, p]))}
                  className={clsx('rounded-full border px-2.5 py-1 text-xs', platforms.includes(p) ? 'border-[var(--color-line-active)] bg-[var(--color-panel)] text-white' : 'border-[var(--color-line)] text-[var(--color-muted)]')}>
                  {PLATFORM_LABEL[p]}
                </button>
              ))}
            </div>
          </fieldset>
          <Field label="Notes & contacts (no passwords here: use Access)" className="sm:col-span-2">
            <textarea className={textareaCls} rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} />
          </Field>
        </fieldset>
        {!archived && (
          <div className="flex flex-wrap justify-between gap-2">
            <button type="button" className={btn.ghost} onClick={() => setConfirmArchive(true)}><Archive size={16} aria-hidden />Archive client</button>
            <button className={btn.primary} disabled={pending}><Save size={16} aria-hidden />{pending ? 'Saving…' : 'Save profile'}</button>
          </div>
        )}
      </form>
      <aside className="flex flex-col gap-4">
        <section className="item p-4">
          <h3 className="mb-2 text-sm font-semibold">Access checklist</h3>
          {platforms.length === 0 ? <p className="text-sm text-[var(--color-dim)]">Add platforms to see what access is missing.</p> : (
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {platforms.map((p) => (
                <li key={p} className="flex items-center justify-between gap-2">
                  <PlatformChip platform={p} />
                  {missing.includes(p) ? <span className="text-[#ffb35c]">missing</span> : <span className="text-[var(--color-success)]">in vault</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="item p-4 text-[13px] text-[var(--color-muted)]">
          <h3 className="mb-2 text-sm font-semibold text-white">Brain</h3>
          <p>Profile and brand notes for agents live in <code className="text-[var(--color-ink)]">brain/clients/{c.slug}/</code>.</p>
        </section>
      </aside>
      <Dialog open={confirmArchive} onClose={() => setConfirmArchive(false)} title={`Archive ${c.name}?`}>
        <p className="text-sm text-[var(--color-muted)]">Every agent grant on this client&apos;s logins is revoked and open access links are cancelled. Remember to remove RizeHub&apos;s access at each platform too.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button className={btn.ghost} onClick={() => setConfirmArchive(false)}>Cancel</button>
          <button className={clsx(btn.primary, 'bg-[var(--color-danger)] hover:bg-[#f06368]')} onClick={archive} disabled={pending}>Archive</button>
        </div>
      </Dialog>
    </div>
  );
}

const REQ_COLOR: Record<string, string> = { done: 'var(--color-success)', in_progress: 'var(--color-info)', plan_review: 'var(--color-primary-hover)', awaiting_ceo: 'var(--color-primary-hover)', failed: 'var(--color-danger)', rejected: 'var(--color-danger)' };

function RequestsTab({ detail }: { detail: ClientDetail }) {
  if (!detail.requests.length) return <p className="item p-6 text-center text-[15px] text-[var(--color-muted)]">No requests for {detail.client.name} yet.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {detail.requests.map((r) => (
        <li key={r.id} className="item flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3" suppressHydrationWarning>
          <p className="min-w-0 flex-1 text-[14px] font-medium">{r.title ?? clip(r.raw_text, 100)}</p>
          <span className="rounded-full border px-2 py-0.5 text-xs capitalize" style={{ color: REQ_COLOR[r.status] ?? 'var(--color-muted)', borderColor: 'var(--color-line)' }}>{r.status.replace(/_/g, ' ')}</span>
          <span className="text-xs text-[var(--color-dim)]">{relDay(r.created_at)}{r.due_date ? ` · due ${relDay(r.due_date)}` : ''}{r.cost_usd ? ` · ${usd(r.cost_usd)}` : ''}</span>
        </li>
      ))}
    </ul>
  );
}

export function ClientDetailView({ detail, tab, add, error }: { detail: ClientDetail; tab: ClientTab; add?: boolean; error?: string }) {
  const router = useRouter();
  const c = detail.client;
  const counts: Record<ClientTab, number | null> = {
    profile: null, access: detail.credentials.filter((x) => x.status !== 'revoked').length,
    requests: detail.requests.filter((r) => ['staged', 'planning', 'plan_review', 'in_progress', 'awaiting_ceo'].includes(r.status)).length,
  };
  return (
    <>
      <div className="flex flex-col gap-3">
        <Link href="/clients" className="inline-flex w-fit items-center gap-1 text-sm text-[var(--color-muted)] hover:text-white"><ArrowLeft size={15} aria-hidden />Clients</Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
              {c.name}
              {c.status !== 'active' && <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5 text-xs font-normal capitalize text-[var(--color-muted)]">{c.status}</span>}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-[var(--color-muted)]">
              {c.service_package && <span className="capitalize">{c.service_package.replace(/-/g, ' ')}</span>}
              {c.website && <a href={c.website} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:text-white">{c.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}<ExternalLink size={12} aria-hidden /></a>}
              {c.platforms.map((p) => <PlatformChip key={p} platform={p} />)}
            </p>
          </div>
          <div className="flex gap-1 rounded-xl bg-[var(--color-panel)] p-1" role="tablist" aria-label="Client sections">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => router.push(`/clients/${c.id}${t.id === 'profile' ? '' : `?tab=${t.id}`}`, { scroll: false })}
                className={clsx('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm', tab === t.id ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--color-muted)] hover:text-white')}>
                {t.label}
                {counts[t.id] ? <span className={clsx('rounded-md px-1.5 text-xs', tab === t.id ? 'bg-white/20' : 'bg-[var(--color-panel-2)]')}>{counts[t.id]}</span> : null}
              </button>
            ))}
          </div>
        </div>
      </div>
      {error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">{error}</p>}
      <section className="card p-4 sm:p-5" role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>
        {tab === 'profile' && <ProfileTab key={c.id} detail={detail} />}
        {tab === 'access' && <AccessTab detail={detail} startAdding={add} />}
        {tab === 'requests' && <RequestsTab detail={detail} />}
      </section>
    </>
  );
}
