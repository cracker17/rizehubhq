'use client';
// /operator → Watched chats → Accounts (docs/17-OPERATOR.md "Unread sweep"): the apps logged in in this client's
// browser that the operator scans for unread conversations (Slack, Google Chat, Teams, Gmail). Unread conversations
// it finds show up in the chats list as "found by the sweep"; Stop on one keeps it stopped.
import { useState } from 'react';
import clsx from 'clsx';
import { Plus, Radar } from 'lucide-react';
import { btn, inputCls } from '@/components/clients/ui';
import { ACCOUNT_KINDS, ago, type OperatorClientRow, type OperatorHomeData, type SweepKind } from '@/lib/operatorView';
import { addAccountAction, requestSendTestAction, setAccountEnabledAction, setPostingAction, type OperatorResult } from '@/app/operator-actions';

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

const POST_KINDS = [['slack', 'Slack'], ['teams', 'Teams'], ['gmail', 'Gmail']] as const;
const TEST_LABEL = { none: 'Not tested', requested: 'Test queued…', running: 'Testing…', passed: 'Test passed', failed: 'Test failed' } as const;

/** Posting in Slack / Teams / Gmail: a send test on this client's browser, then the switch (SQL refuses without a pass). */
export function Posting({ data, client, pending, run }: { data: OperatorHomeData; client: OperatorClientRow; pending: boolean; run: Run }) {
  const [testing, setTesting] = useState<'gmail' | 'slack' | 'teams' | null>(null);
  const [url, setUrl] = useState('');
  return (
    <div className="mt-4 border-t border-[var(--color-line)] pt-3">
      <h3 className="mb-1 text-[13px] font-semibold">Posting</h3>
      <p className="mb-2 text-xs text-[var(--color-muted)]">Google Chat and WhatsApp post by themselves. Slack, Teams and Gmail post only after a send test passes here and you switch them on; until then you post approved replies yourself.</p>
      <ul className="flex flex-col gap-1.5">
        {POST_KINDS.map(([k, label]) => {
          const p = data.posting.find((x) => x.client_slug === client.slug && x.kind === k);
          const st = p?.test_state ?? 'none';
          return (
            <li key={k} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--color-panel-2)]">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px]">{label}</span>
                <span className={clsx('block truncate text-[11px]', st === 'failed' ? 'text-[#ff9a9d]' : 'text-[var(--color-dim)]')}>
                  {TEST_LABEL[st]}{p?.tested_at && st === 'passed' ? ` ${ago(p.tested_at)}` : ''}{st === 'failed' && p?.test_detail ? `: ${p.test_detail}` : ''}
                </span>
              </span>
              {!data.demo && <button className={btn.small} disabled={pending || st === 'requested' || st === 'running'} onClick={() => { setTesting(k); setUrl(p?.test_url ?? ''); }}>Send test</button>}
              <button role="switch" aria-checked={!!p?.enabled} aria-label={`Post in ${label}`} disabled={pending || data.demo || st !== 'passed'}
                title={st !== 'passed' ? 'Run a send test first' : undefined}
                onClick={() => run(() => setPostingAction(client.slug, k, !p?.enabled), p?.enabled ? `${label}: you post replies yourself` : `${label}: the operator posts approved replies`)}
                className={clsx('relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40', p?.enabled ? 'bg-[var(--color-success)]' : 'bg-[var(--color-panel-2)] ring-1 ring-inset ring-[var(--color-line-active)]')}>
                <span className={clsx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', p?.enabled ? 'translate-x-[22px]' : 'translate-x-0.5')} />
              </button>
            </li>
          );
        })}
      </ul>
      {testing && (
        <form className="mt-2 flex flex-col gap-2" onSubmit={(e) => {
          e.preventDefault();
          run(async () => { const r = await requestSendTestAction(client.slug, testing, url); if (r.ok) setTesting(null); return r; }, 'Send test queued: Telegram tells you the result');
        }}>
          <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" aria-label="Test conversation address"
            placeholder={testing === 'gmail' ? 'An email thread with yourself (https://mail.google.com/mail/u/0/#inbox/…)' : 'A DM to yourself or a test channel'} />
          <p className="text-xs text-[var(--color-dim)]">The operator types a short &quot;HQ operator send test&quot; message there in {client.name}&apos;s browser, sends it and reads it back.</p>
          <div className="flex gap-2">
            <button className={btn.primary} disabled={pending}>Run send test</button>
            <button type="button" className={btn.ghost} onClick={() => setTesting(null)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
