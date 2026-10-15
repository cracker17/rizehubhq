'use client';
// /operator → Watched chats → Accounts (docs/17-OPERATOR.md "Unread sweep"): the apps logged in in this client's
// browser that the operator scans for unread conversations (Slack, Google Chat, Teams, Gmail). Unread conversations
// it finds show up in the chats list as "found by the sweep"; Stop on one keeps it stopped.
import { useState } from 'react';
import clsx from 'clsx';
import { Plus, Radar } from 'lucide-react';
import { btn, inputCls } from '@/components/clients/ui';
import { ACCOUNT_KINDS, ago, type OperatorClientRow, type OperatorHomeData, type SweepKind } from '@/lib/operatorView';
import { addAccountAction, setAccountEnabledAction, type OperatorResult } from '@/app/operator-actions';

type Run = (fn: () => Promise<OperatorResult>, done: string) => void;

export function Accounts({ data, client, pending, run }: { data: OperatorHomeData; client: OperatorClientRow; pending: boolean; run: Run }) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<SweepKind>('slack');
  const meta = ACCOUNT_KINDS.find((k) => k.kind === kind)!;
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const accounts = data.accounts.filter((a) => a.client_slug === client.slug);

  return (
    <div className="mt-4 border-t border-[var(--color-line)] pt-3">
      <div className="mb-2 flex items-center gap-2">
        <Radar size={15} className="text-[#c4b5ff]" aria-hidden />
        <h3 className="text-[13px] font-semibold">Unread sweep</h3>
        {!adding && !data.demo && <button className={clsx(btn.small, 'ml-auto')} onClick={() => { setAdding(true); setUrl(meta.home.includes('…') ? '' : meta.home); }}><Plus size={14} aria-hidden />Add account</button>}
      </div>
      {accounts.length === 0 && !adding && (
        <p className="text-xs text-[var(--color-muted)]">Add the apps logged in in {client.name}&apos;s browser; the operator checks them for unread chats every poll and reads those by itself.</p>
      )}
      <ul className="flex flex-col gap-1.5">
        {accounts.map((a) => (
          <li key={a.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--color-panel-2)]">
            <span className="min-w-0 flex-1">
              <span className={clsx('block truncate text-[13px]', !a.enabled && 'text-[var(--color-dim)]')}>{a.label}<span className="text-[11px] text-[var(--color-dim)]"> · {ACCOUNT_KINDS.find((k) => k.kind === a.kind)?.label}</span></span>
              <span className={clsx('block truncate text-[11px]', a.last_error ? 'text-[#ff9a9d]' : 'text-[var(--color-dim)]')}>
                {a.last_error ?? (a.enabled ? `Checked ${ago(a.last_swept_at)}${a.last_found ? ` · ${a.last_found} unread` : ''}` : 'Not checked')}
              </span>
            </span>
            {!data.demo && (
              <button className={btn.small} disabled={pending} onClick={() => run(() => setAccountEnabledAction(a.id, !a.enabled), a.enabled ? `Stopped checking ${a.label}` : `Checking ${a.label}`)}>
                {a.enabled ? 'Stop' : 'Check'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {adding && (
        <form className="mt-2 flex flex-col gap-2" onSubmit={(e) => {
          e.preventDefault();
          run(async () => { const r = await addAccountAction(client.slug, kind, label, url); if (r.ok) { setAdding(false); setLabel(''); setUrl(''); } return r; }, `Checking ${label || meta.label} for unread chats`);
        }}>
          <select className={inputCls} value={kind} aria-label="App" onChange={(e) => {
            const k = e.target.value as SweepKind; setKind(k);
            const home = ACCOUNT_KINDS.find((x) => x.kind === k)!.home; setUrl(home.includes('…') ? '' : home);
          }}>
            {ACCOUNT_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
          </select>
          <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`Name, e.g. "${client.name} ${meta.label}"`} aria-label="Account name" />
          <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={meta.home} inputMode="url" aria-label="App address" />
          <p className="text-xs text-[var(--color-dim)]">{meta.hint} Log in to it once in the client&apos;s browser. Reading a chat marks it read in that account.</p>
          <div className="flex gap-2">
            <button className={btn.primary} disabled={pending}>Check for unread chats</button>
            <button type="button" className={btn.ghost} onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
