'use client';
// /operator → Reply rules (docs/17-OPERATOR.md "Tiers", "Phase 3"): per client, what kind of reply posts by itself,
// asks you, or is never sent. "All clients" edits the defaults; a client's own rule wins over them ("Default" removes
// it). Risky types can't be set to post by themselves (operator_set_autonomy refuses it too). Auto-send is the master
// switch: off = every reply asks, whatever the rules say.
import { useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import { btn } from '@/components/clients/ui';
import {
  ACTION_TYPES, allowedModes, autonomyFor, MODE_LABEL,
  type AutonomyMode, type OperatorClientRow, type OperatorHomeData,
} from '@/lib/operatorView';
import { setAutonomyAction, setAutoSendAction, setDigestTimesAction, setReplyWhenAction, type OperatorResult } from '@/app/operator-actions';
import { Pill } from './Pill';

type Run = (fn: () => Promise<OperatorResult>, done: string) => void;
const MODE_TONE: Record<AutonomyMode, 'success' | 'warning' | 'danger'> = { auto: 'success', approve: 'warning', never: 'danger' };
const SEG_ON: Record<AutonomyMode, string> = {
  auto: 'bg-[color-mix(in_oklab,var(--color-success)_22%,transparent)] text-[#6ee7b7]',
  approve: 'bg-[color-mix(in_oklab,var(--color-warning)_22%,transparent)] text-[#fcd34d]',
  never: 'bg-[color-mix(in_oklab,var(--color-danger)_22%,transparent)] text-[#ff9a9d]',
};
const SHORT: Record<AutonomyMode, string> = { auto: 'Auto', approve: 'Ask', never: 'Never' };

export function OperatorRules({ data, client, pending, run }: { data: OperatorHomeData; client: OperatorClientRow | null; pending: boolean; run: Run }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<'client' | 'all'>('client');
  const target = scope === 'all' || !client ? '*' : client.slug;
  const rules = autonomyFor(data.autonomy, target);
  const autoCount = rules.filter((r) => r.mode === 'auto').length;
  const readOnly = data.demo;

  return (
    <section aria-label="Reply rules" className="card min-w-0 p-4 sm:p-5">
      <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ShieldCheck size={18} className="text-[#c4b5ff]" aria-hidden />
        <h2 className="text-base font-semibold">Reply rules</h2>
        <Pill tone={data.autoSend ? 'success' : 'muted'} className="ml-auto">{data.autoSend ? `Auto-send on · ${autoCount} types` : 'Every reply asks'}</Pill>
        <ChevronDown size={16} className={clsx('text-[var(--color-dim)] transition-transform', open && 'rotate-180')} aria-hidden />
      </button>

      {open && (
        <div className="mt-3 flex flex-col gap-3" style={{ animation: 'brain-in .25s ease-out' }}>
          <div className="item flex items-center gap-3 px-3 py-2.5">
            <span className="min-w-0 flex-1 text-[13px]">
              <span className="block font-medium">Auto-send</span>
              <span className="block text-xs text-[var(--color-muted)]">{data.autoSend ? 'Replies marked "Auto" post by themselves when the AI is at least 75% sure.' : 'Off: every reply waits for you, whatever the rules below say.'}</span>
            </span>
            <button role="switch" aria-checked={data.autoSend} aria-label="Auto-send" disabled={pending || readOnly}
              onClick={() => run(() => setAutoSendAction(!data.autoSend), data.autoSend ? 'Auto-send off: every reply asks' : 'Auto-send on')}
              className={clsx('relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50', data.autoSend ? 'bg-[var(--color-success)]' : 'bg-[var(--color-panel-2)]')}>
              <span className={clsx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', data.autoSend ? 'translate-x-[22px]' : 'translate-x-0.5')} />
            </button>
          </div>

          <Digests data={data} pending={pending} run={run} />

          {client && (
            <div role="tablist" aria-label="Rules for" className="flex gap-1">
              {([['client', client.name], ['all', 'All clients (default)']] as const).map(([k, label]) => (
                <button key={k} role="tab" aria-selected={scope === k} onClick={() => setScope(k)}
                  className={clsx('h-8 rounded-full px-3 text-[13px]', scope === k ? 'bg-[color-mix(in_oklab,var(--color-primary)_22%,transparent)] text-[#d6ccff]' : 'text-[var(--color-muted)] hover:text-white')}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {target !== '*' && client && (
            <div className="item flex flex-wrap items-center gap-3 px-3 py-2.5">
              <span className="min-w-[160px] flex-1 text-[13px]">
                <span className="block font-medium">Answer</span>
                <span className="block text-xs text-[var(--color-muted)]">{(client.reply_when ?? 'addressed') === 'addressed'
                  ? 'Only messages meant for you: DMs, @mentions and questions to you. The rest is kept as FYI.'
                  : 'Anything that needs a reply from you, even when nobody named you.'}</span>
              </span>
              <span role="radiogroup" aria-label="Answer" className="inline-flex rounded-lg bg-[var(--color-panel-2)] p-0.5">
                {([['addressed', 'Meant for me'], ['all', 'Anything']] as const).map(([m, label]) => (
                  <button key={m} role="radio" aria-checked={(client.reply_when ?? 'addressed') === m} disabled={pending || readOnly || (client.reply_when ?? 'addressed') === m}
                    onClick={() => run(() => setReplyWhenAction(client.slug, m), m === 'addressed' ? 'Answers only messages meant for you' : 'Answers anything that needs a reply')}
                    className={clsx('h-7 rounded-md px-2.5 text-xs font-medium active:scale-[.97] disabled:cursor-default',
                      (client.reply_when ?? 'addressed') === m ? 'bg-[color-mix(in_oklab,var(--color-primary)_22%,transparent)] text-[#d6ccff]' : 'text-[var(--color-muted)] hover:text-white')}>
                    {label}
                  </button>
                ))}
              </span>
            </div>
          )}

          <ul className="flex flex-col gap-1.5">
            {rules.map((r) => {
              const meta = ACTION_TYPES.find((a) => a.type === r.type)!;
              const modes = allowedModes(r.type);
              return (
                <li key={r.type} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--color-panel-2)]">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px]">{meta.label}{target !== '*' && !r.own && <span className="text-[var(--color-dim)]"> · default</span>}</span>
                    <span className="block text-[11px] text-[var(--color-dim)]">{meta.hint}</span>
                  </span>
                  {modes.length === 1
                    ? <Pill tone={MODE_TONE[r.mode]}>{MODE_LABEL[r.mode]}</Pill>
                    : (
                      <span role="radiogroup" aria-label={`${meta.label} rule`} className="inline-flex rounded-lg bg-[var(--color-panel-2)] p-0.5">
                        {modes.map((m) => (
                          <button key={m} role="radio" aria-checked={r.mode === m} disabled={pending || readOnly || r.mode === m}
                            title={MODE_LABEL[m]}
                            onClick={() => run(() => setAutonomyAction(target, r.type, m), `${meta.label}: ${MODE_LABEL[m].toLowerCase()}${target === '*' ? ' (all clients)' : ''}`)}
                            className={clsx('h-7 min-w-[52px] rounded-md px-2 text-xs font-medium transition-colors active:scale-[.97] disabled:cursor-default',
                              r.mode === m ? SEG_ON[m] : 'text-[var(--color-muted)] hover:text-white')}>
                            {SHORT[m]}
                          </button>
                        ))}
                      </span>
                    )}
                  {target !== '*' && r.own && !readOnly && (
                    <button className={btn.small} disabled={pending} onClick={() => run(() => setAutonomyAction(target, r.type, 'inherit'), `${meta.label}: back to the default`)}>Default</button>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-[var(--color-dim)]">
            A reply can be several types; the strictest rule wins. Deadlines, commitments, publishing, money, new people and deleting always ask (or never); logins and keys are never sent.
            {readOnly && ' Demo: changes work on the live dashboard.'}
          </p>
        </div>
      )}
    </section>
  );
}

/** Morning / evening digest times on Telegram (empty = off). */
function Digests({ data, pending, run }: { data: OperatorHomeData; pending: boolean; run: Run }) {
  const [m, setM] = useState(data.digestTimes.morning ?? '');
  const [e, setE] = useState(data.digestTimes.evening ?? '');
  const changed = m !== (data.digestTimes.morning ?? '') || e !== (data.digestTimes.evening ?? '');
  return (
    <form className="item flex flex-wrap items-end gap-3 px-3 py-2.5"
      onSubmit={(ev) => { ev.preventDefault(); run(() => setDigestTimesAction(m, e), 'Digest times saved'); }}>
      <span className="min-w-[140px] flex-1 text-[13px]">
        <span className="block font-medium">Digests on Telegram</span>
        <span className="block text-xs text-[var(--color-muted)]">What came in, what was sent, jobs, what waits for you. Clear a time to turn it off.</span>
      </span>
      <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]" htmlFor="op-digest-m">Morning
        <input id="op-digest-m" type="time" className="h-8 rounded-md bg-[var(--color-panel-2)] px-2 text-[13px] text-white" value={m} onChange={(x) => setM(x.target.value)} disabled={data.demo} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]" htmlFor="op-digest-e">Evening
        <input id="op-digest-e" type="time" className="h-8 rounded-md bg-[var(--color-panel-2)] px-2 text-[13px] text-white" value={e} onChange={(x) => setE(x.target.value)} disabled={data.demo} />
      </label>
      {changed && !data.demo && <button className={btn.small} disabled={pending}>Save</button>}
    </form>
  );
}
