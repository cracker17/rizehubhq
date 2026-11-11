'use client';
// Devices & accounts (docs/16-BRAIN.md "UI" §10): every Claude app connected to the brain (from the connector's OAuth
// approvals), with revoke, and the steps for a new computer or Claude account.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check, Copy, Laptop, MessageSquare, Monitor, Plus, Terminal } from 'lucide-react';
import { btn } from '@/components/clients/ui';
import { deviceHealth, type BrainDevice } from '@/lib/brainDevices';
import { HealthPill } from './HealthPill';
import { useHq } from '@/lib/data/store';
import { revokeBrainConnectionAction } from '@/app/brain-actions';
import { ago, type BrainConnection, type BrainHealth } from '@/lib/brainView';

const CONNECTOR_URL = 'https://hq.rizehub.ph/mcp/brain';
const CLI = `claude mcp add --scope user --transport http hq-brain ${CONNECTOR_URL}`;

export function CopyLine({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-xl border border-[var(--color-line)] bg-[#07061a] py-1.5 pl-3 pr-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-[#99f6e4]" title={value}>{value}</code>
      <button aria-label={`Copy ${label}`} className={btn.small} onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
        {done ? <Check size={14} /> : <Copy size={14} />}{done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function DevicesPanel({ connections, health, demo, devices = [] }: { connections: BrainConnection[]; health: BrainHealth | null; demo: boolean; devices?: BrainDevice[] }) {
  const router = useRouter();
  const { toast } = useHq();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const revoke = (id: string) => start(async () => {
    const r = await revokeBrainConnectionAction(id);
    setConfirm(null);
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast('Access revoked', 'success');
    router.refresh();
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-3">
        <h3 className="text-sm font-semibold">Connected apps</h3>
        {connections.length === 0 && <p className="item px-4 py-3 text-sm text-[var(--color-muted)]">Nothing connected yet. Use the steps on the right.</p>}
        <ul className="flex flex-col gap-2">
          {connections.map((c) => {
            const loopback = (c.redirect_uris ?? []).some((u) => /^http:\/\/(localhost|127\.0\.0\.1)/.test(u));
            const Icon = loopback ? Terminal : MessageSquare;
            return (
              <li key={c.family_id} className="item flex min-w-0 flex-wrap items-center gap-3 px-4 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-panel-2)]"><Icon size={17} className="text-[#5eead4]" aria-hidden /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{c.client_name ?? 'Connector'}</span>
                  <span className="block text-xs text-[var(--color-muted)]">
                    {c.scopes.includes('brain:write') ? 'Read + save' : 'Read only'} · approved {ago(c.approved_at)} · used {ago(c.last_used_at)}
                  </span>
                </span>
                {confirm === c.family_id
                  ? <span className="flex gap-2"><button className={btn.small} onClick={() => setConfirm(null)} disabled={pending}>Keep</button><button className={btn.danger} onClick={() => revoke(c.family_id)} disabled={pending}>{pending ? 'Revoking…' : 'Revoke'}</button></span>
                  : <button className={btn.danger} onClick={() => setConfirm(c.family_id)} disabled={demo}>Revoke</button>}
              </li>
            );
          })}
        </ul>
        <h3 className="mt-2 text-sm font-semibold">This PC’s vault</h3>
        <p className="item flex items-center gap-3 px-4 py-3 text-sm">
          <Laptop size={17} className="shrink-0 text-[var(--color-muted)]" aria-hidden />
          <span className="min-w-0">Last push from a PC reached the brain <strong>{ago(health?.last_webhook_at ?? null)}</strong>. The PC syncs every 15 minutes.</span>
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <h3 className="text-sm font-semibold">Computers</h3>
        {devices.length === 0 && <p className="item px-4 py-3 text-sm text-[var(--color-muted)]">No computers set up through HQ yet.</p>}
        <ul className="flex flex-col gap-2">
          {devices.slice(0, 4).map((d) => {
            const h = deviceHealth(d);
            return (
              <li key={d.id} className="item flex min-w-0 items-center gap-3 px-4 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-panel-2)]">{d.kind === 'pc' ? <Monitor size={17} className="text-[var(--color-muted)]" aria-hidden /> : <MessageSquare size={17} className="text-[#5eead4]" aria-hidden />}</span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{d.name}</span><span className="block truncate text-xs text-[var(--color-muted)]">{h.why}</span></span>
                <HealthPill level={h.level} label={h.label} />
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Link href="/brain/devices/new" className={btn.primary}><Plus size={16} aria-hidden />Set up a computer</Link>
          <Link href="/brain/devices" className={btn.ghost}>All devices</Link>
          <Link href="/brain/people" className={btn.ghost}>People &amp; access</Link>
        </div>
        <details className="text-sm text-[var(--color-muted)]">
          <summary className="cursor-pointer select-none">Manual steps (Claude Code command, connector URL)</summary>
          <div className="mt-3 flex flex-col gap-3">
            <span><strong className="text-[var(--color-ink)]">Claude Code</strong>: run once, then <code className="font-mono text-[#99f6e4]">/mcp</code> › hq-brain › Authenticate.</span>
            <CopyLine value={CLI} label="Claude Code command" />
            <span><strong className="text-[var(--color-ink)]">Claude app</strong>: on your Team plan HQ Brain is already listed; tap Connect. Otherwise add this URL as a custom connector.</span>
            <CopyLine value={CONNECTOR_URL} label="connector URL" />
          </div>
        </details>
      </div>
    </div>
  );
}
