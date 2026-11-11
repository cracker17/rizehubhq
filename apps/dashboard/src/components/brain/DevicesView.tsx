'use client';
// Brain › Devices (P1): every computer and Claude app that can read or save to the brain, with its health in plain
// words and a fix button; stale connector approvals are flagged; the brain service card says what the index is doing.
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MessageSquare, Monitor, Plus, RefreshCw, Terminal } from 'lucide-react';
import { btn } from '@/components/clients/ui';
import { useHq } from '@/lib/data/store';
import { revokeBrainConnectionAction, revokeBrainDeviceAction } from '@/app/brain-actions';
import { ago, type BrainConnection, type BrainHealth } from '@/lib/brainView';
import { deviceHealth, staleConnection, type BrainDevice, type DeviceHealth } from '@/lib/brainDevices';
import { HealthPill } from './HealthPill';

const fmt = (n: number) => n.toLocaleString('en-US');

export function serviceHealth(h: BrainHealth | null): DeviceHealth & { pct: number } {
  if (!h) return { level: 'bad', label: 'Unknown', why: 'Could not read the brain status just now.', pct: 0 };
  const pct = h.chunks ? Math.round((h.embedded / h.chunks) * 100) : 100;
  const failed = (h as BrainHealth & { failed?: Array<{ path: string }> }).failed ?? [];
  if (h.status === 'error') return { level: 'bad', label: 'Needs a look', why: h.error ?? 'The last sync failed.', pct };
  if (failed.length) return { level: 'warn', label: 'Partly behind', why: `${failed.length} file${failed.length === 1 ? '' : 's'} could not be indexed; they are retried every run.`, pct };
  if (pct < 99) return { level: 'warn', label: 'Catching up', why: 'New notes are still being made searchable by meaning. Keyword search and project loading already work.', pct };
  return { level: 'ok', label: 'Up to date', why: 'Every file is indexed and searchable.', pct };
}

export function DevicesView({ devices, connections, health, demo, error }: { devices: BrainDevice[]; connections: BrainConnection[]; health: BrainHealth | null; demo: boolean; error?: string }) {
  const router = useRouter();
  const { toast } = useHq();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const now = Date.now();

  const rows = devices.map((d) => ({ d, h: deviceHealth(d, now) }));
  const order = { bad: 0, warn: 1, setup: 2, ok: 3 } as const;
  rows.sort((a, b) => order[a.h.level] - order[b.h.level]);
  // connector approvals that no device row explains (older approvals, Claude Code entries)
  const loose = connections.filter((c) => c.subject === 'ceo');
  const stale = loose.filter((c) => staleConnection(c, now));
  const count = (l: DeviceHealth['level']) => rows.filter((r) => r.h.level === l).length;
  const svc = serviceHealth(health);

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => start(async () => {
    const r = await fn();
    setConfirm(null);
    if (!r.ok) { toast(r.error ?? 'That did not work.', 'error'); return; }
    toast(done, 'success');
    router.refresh();
  });

  return (
    <div className="flex flex-col gap-4">
      {error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">{error}</p>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([['Devices', rows.length + loose.length, ''], ['Healthy', count('ok'), '#34d399'], ['Need a look', count('warn') + count('setup') + stale.length, '#fbbf24'], ['Not syncing', count('bad'), '#ff8a8d']] as const).map(([label, n, color]) => (
          <div key={label} className="card px-4 py-3">
            <div className="font-mono text-[11px] uppercase tracking-[.1em] text-[var(--color-dim)]">{label}</div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums" style={color ? { color } : undefined}>{n}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] lg:items-start">
        <section className="card p-4 sm:p-5" aria-labelledby="dev-list">
          <div className="mb-2 flex items-center gap-2"><h2 id="dev-list" className="font-semibold">Computers and apps</h2><span className="ml-auto font-mono text-[11px] text-[var(--color-dim)]">sorted by attention</span></div>
          {rows.length + loose.length === 0 && (
            <div className="flex flex-col items-start gap-3 py-6 text-sm text-[var(--color-muted)]">
              <p>No devices yet. Set up your first computer and it shows here with its sync health.</p>
              <Link href="/brain/devices/new" className={btn.primary}><Plus size={16} aria-hidden />Set up a computer</Link>
            </div>
          )}
          <ul className="flex flex-col">
            {rows.map(({ d, h }) => (
              <li key={d.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-t border-[var(--color-line)] py-3.5 first:border-t-0">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--color-panel-2)] text-[var(--color-muted)]">{d.kind === 'pc' ? <Monitor size={17} aria-hidden /> : <MessageSquare size={17} aria-hidden />}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{d.name}</span>
                  <span className="block break-words text-[13px] text-[var(--color-muted)]">{d.kind === 'pc' ? `Windows · ${d.info?.vault_path ?? 'setting up'}` : 'Claude app · connector'} · {d.owner_label}</span>
                  <span className="mt-1 block text-[13px] text-[var(--color-muted)]">{h.why}</span>
                </span>
                <span className="flex flex-col items-end gap-2">
                  <HealthPill level={h.level} label={h.label} />
                  {confirm === d.id
                    ? <span className="flex gap-2"><button className={btn.small} onClick={() => setConfirm(null)} disabled={pending}>Keep</button><button className={btn.danger} onClick={() => act(() => revokeBrainDeviceAction(d.id), `${d.name} removed`)} disabled={pending}>Remove</button></span>
                    : <span className="flex gap-2">
                        {d.kind === 'pc' && !d.ready_at && <Link href="/brain/devices/new" className={btn.small}><RefreshCw size={13} aria-hidden />Set up again</Link>}
                        <button className={btn.small} onClick={() => setConfirm(d.id)} disabled={demo}>Remove</button>
                      </span>}
                </span>
              </li>
            ))}
            {loose.map((c) => {
              const isStale = staleConnection(c, now);
              const loopback = (c.redirect_uris ?? []).some((u) => /^http:\/\/(localhost|127\.0\.0\.1)/.test(u));
              return (
                <li key={c.family_id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-t border-[var(--color-line)] py-3.5 first:border-t-0">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--color-panel-2)] text-[#5eead4]">{loopback ? <Terminal size={17} aria-hidden /> : <MessageSquare size={17} aria-hidden />}</span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{c.client_name ?? 'Connector'}</span>
                    <span className="block text-[13px] text-[var(--color-muted)]">{c.scopes.includes('brain:write') ? 'Read + save' : 'Read only'} · approved {ago(c.approved_at, now)} · used {ago(c.last_used_at, now)}</span>
                    {isStale && <span className="mt-1 block text-[13px] text-[var(--color-muted)]">Approved over a week ago and never used. Remove it if you don&rsquo;t recognise it.</span>}
                  </span>
                  <span className="flex flex-col items-end gap-2">
                    <HealthPill level={isStale ? 'warn' : 'ok'} label={isStale ? 'Unused' : 'Connected'} />
                    {confirm === c.family_id
                      ? <span className="flex gap-2"><button className={btn.small} onClick={() => setConfirm(null)} disabled={pending}>Keep</button><button className={btn.danger} onClick={() => act(() => revokeBrainConnectionAction(c.family_id), 'Access revoked')} disabled={pending}>Revoke</button></span>
                      : <button className={isStale ? btn.danger : btn.small} onClick={() => setConfirm(c.family_id)} disabled={demo}>Revoke</button>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="card flex flex-col gap-3 p-4 sm:p-5" aria-labelledby="svc">
          <div className="flex items-center gap-2"><h2 id="svc" className="font-semibold">Brain service</h2><span className="ml-auto"><HealthPill level={svc.level} label={svc.label} /></span></div>
          {health && (
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-[var(--color-muted)]">Files indexed</dt><dd className="font-mono tabular-nums">{fmt(health.documents)}</dd>
              <dt className="text-[var(--color-muted)]">Searchable by meaning</dt><dd className="font-mono tabular-nums">{fmt(health.embedded)} / {fmt(health.chunks)}</dd>
              <dt className="text-[var(--color-muted)]">Last vault pull</dt><dd className="font-mono">{ago(health.last_pull_at, now)}</dd>
              <dt className="text-[var(--color-muted)]">Last complete index</dt><dd className="font-mono">{ago(health.last_index_at, now)}</dd>
            </dl>
          )}
          <span className="h-1.5 overflow-hidden rounded-full bg-[var(--color-panel-2)]" aria-hidden><span className="block h-full rounded-full bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-teal)]" style={{ width: `${svc.pct}%` }} /></span>
          <p className="rounded-xl bg-[var(--color-panel-2)] px-3 py-2.5 text-[13px] text-[var(--color-muted)]">{svc.why}</p>
          <p className="text-[12.5px] text-[var(--color-dim)]">If indexing falls more than an hour behind the vault, HQ sends you a Telegram message with the reason.</p>
        </section>
      </div>
    </div>
  );
}
