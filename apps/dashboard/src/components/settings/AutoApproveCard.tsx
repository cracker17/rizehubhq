'use client';
// Settings → Auto-approve rules (docs/05 "[3] Auto-approve rules"). Default: no rules, every plan asks the CEO.
// The database applies the rules when the COO submits a plan; this screen edits them. Turning a rule on needs a
// fresh 2FA code when 2FA is on (StepUpDialog).
import { useState, useTransition } from 'react';
import clsx from 'clsx';
import { Plus, Pencil, Trash2, Zap, Lock } from 'lucide-react';
import { AUTO_APPROVE_INTERNAL_WORK_TYPES, describeRule, type AutoApproveRule, type AutoApproveRuleInput, type ClientScope } from '@rizehubhq/shared';
import { deleteAutoApproveRuleAction, saveAutoApproveRuleAction } from '@/app/security-actions';
import type { AutoApproveEvent } from '@/lib/data/settings';
import { StepUpDialog, type StepUpRequest } from '@/components/StepUpDialog';
import { Dialog, Field, btn, inputCls, relTime } from '@/components/clients/ui';

type Draft = { id: string | null; name: string; enabled: boolean; max_cost_usd: string; max_tasks: string; work_types: string[]; client_scope: ClientScope; client_slugs: string[] };

const EMPTY: Draft = { id: null, name: '', enabled: true, max_cost_usd: '1.00', max_tasks: '3', work_types: [], client_scope: 'none', client_slugs: [] };

function toDraft(r: AutoApproveRule): Draft {
  return { id: r.id, name: r.name, enabled: r.enabled, max_cost_usd: Number(r.max_cost_usd).toFixed(2), max_tasks: r.max_tasks == null ? '' : String(r.max_tasks),
    work_types: [...r.work_types], client_scope: r.client_scope, client_slugs: [...r.client_slugs] };
}
function toInput(d: Draft): AutoApproveRuleInput {
  return { id: d.id, name: d.name, enabled: d.enabled, max_cost_usd: Number(d.max_cost_usd), max_tasks: d.max_tasks.trim() ? Number(d.max_tasks) : null,
    work_types: d.work_types as AutoApproveRuleInput['work_types'], client_scope: d.client_scope, client_slugs: d.client_slugs };
}

const GUARDS = [
  'Only plans; external actions (publish, send, merge, deploy, spend) always wait for you',
  'Every task must be internal-only work (drafts, designs, research, reports); any Web Developer task means you decide',
  'No questions for you in the plan, and a cost estimate is present',
  'Wording like publish, send, email to, deploy, merge, pay, buy, delete anywhere in the plan blocks it',
];

function Chip({ on, children, onClick }: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={clsx('rounded-full border px-2.5 py-1 text-[13px]', on
        ? 'border-[var(--color-line-active)] bg-[color-mix(in_oklab,var(--color-primary)_22%,transparent)] text-white'
        : 'border-[var(--color-line)] text-[var(--color-muted)] hover:border-[var(--color-line-active)]')}>
      {children}
    </button>
  );
}

export function AutoApproveCard({ initial, clients, events }: { initial: AutoApproveRule[]; clients: { slug: string; name: string }[]; events: AutoApproveEvent[] }) {
  const [rules, setRules] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null);
  const [pending, start] = useTransition();

  const save = (input: AutoApproveRuleInput, after?: () => void) => start(async () => {
    setError(null);
    const r = await saveAutoApproveRuleAction(input);
    if (r.ok) { setRules(r.rules); after?.(); return; }
    if (!r.stepUp) { setError(r.error); return; }
    setStepUp({
      title: 'Confirm with 2FA',
      detail: `Turning on “${input.name}” lets matching plans start without asking you. Enter your authenticator code to confirm.`,
      submit: async (code) => {
        const again = await saveAutoApproveRuleAction(input, code);
        if (!again.ok) return again.error;
        setStepUp(null); setRules(again.rules); after?.();
        return null;
      },
      cancel: () => { setStepUp(null); setError('Not saved: turning a rule on needs your 2FA code.'); },
    });
  });
  const remove = (r: AutoApproveRule) => {
    if (!window.confirm(`Delete the rule “${r.name}”? Matching plans will ask you again.`)) return;
    start(async () => {
      const res = await deleteAutoApproveRuleAction({ id: r.id });
      if (res.ok) setRules(res.rules); else setError(res.error);
    });
  };
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const toggle = (k: 'work_types' | 'client_slugs', v: string) =>
    setDraft((d) => (d ? { ...d, [k]: d[k].includes(v) ? d[k].filter((x) => x !== v) : [...d[k], v] } : d));

  return (
    <section className="card flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="aa-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="aa-title" className="text-lg font-semibold">Auto-approve rules</h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">
            Let small internal plans start without waiting for you. With no rules (the default) every plan asks.
            The first matching rule approves the plan and the approval history names it.
          </p>
        </div>
        <button type="button" className={btn.primary} onClick={() => { setError(null); setDraft({ ...EMPTY }); }}><Plus size={16} aria-hidden />Add rule</button>
      </div>

      <div className="item p-4">
        <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--color-muted)]"><Lock size={15} aria-hidden />Always, whatever the rules say</p>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-snug text-[var(--color-muted)]">{GUARDS.map((g) => <li key={g}>{g}</li>)}</ul>
      </div>

      {error && !draft && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}

      {rules.length === 0 ? (
        <p className="text-sm text-[var(--color-dim)]">No rules. Every plan waits for your approval.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {rules.map((r) => (
            <li key={r.id} className="item flex flex-wrap items-center gap-3 p-3.5">
              <label className="flex shrink-0 cursor-pointer items-center" title={r.enabled ? 'Turn off' : 'Turn on'}>
                <input type="checkbox" className="peer sr-only" checked={r.enabled} disabled={pending}
                  onChange={() => save({ ...toInput(toDraft(r)), enabled: !r.enabled })} aria-label={`${r.name}: ${r.enabled ? 'on' : 'off'}`} />
                <span className="relative h-6 w-11 rounded-full bg-[var(--color-line)] transition-colors peer-checked:bg-[var(--color-success)] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--color-line-active)]
                  after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-5" aria-hidden />
              </label>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{r.name}{!r.enabled && <span className="ml-2 text-xs font-normal text-[var(--color-dim)]">off</span>}</p>
                <p className="text-[13px] text-[var(--color-muted)]">{describeRule(r)}</p>
              </div>
              <div className="flex gap-2">
                <button type="button" className={btn.small} onClick={() => { setError(null); setDraft(toDraft(r)); }} aria-label={`Edit ${r.name}`}><Pencil size={14} aria-hidden />Edit</button>
                <button type="button" className={btn.danger} onClick={() => remove(r)} disabled={pending} aria-label={`Delete ${r.name}`}><Trash2 size={14} aria-hidden /></button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {events.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-muted)]">Recent</h3>
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {events.map((e, i) => (
              <li key={i} className="flex items-start gap-2" suppressHydrationWarning>
                <Zap size={14} className={clsx('mt-0.5 shrink-0', e.action === 'plan.auto_approved' ? 'text-[var(--color-warning)]' : 'text-[var(--color-dim)]')} aria-hidden />
                <span className="min-w-0 text-[var(--color-muted)]">
                  {e.action === 'plan.auto_approved' ? <>Approved by <b className="font-medium text-[var(--color-ink)]">{e.ruleName}</b></> : <>Asked you: {e.reason}</>}
                  <span className="text-[var(--color-dim)]"> · {relTime(e.at)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Dialog open={Boolean(draft)} onClose={() => setDraft(null)} title={draft?.id ? 'Edit rule' : 'New auto-approve rule'} wide>
        {draft && (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(toInput(draft), () => setDraft(null)); }}>
            <Field label="Name"><input className={inputCls} value={draft.name} onChange={(e) => set('name', e.target.value)} maxLength={80} required placeholder="Small internal drafts" autoFocus /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Max estimated cost (USD)" hint="The COO's estimate for the whole plan.">
                <input className={inputCls} type="number" min={0} max={100} step={0.01} value={draft.max_cost_usd} onChange={(e) => set('max_cost_usd', e.target.value)} required />
              </Field>
              <Field label="Max tasks" hint="Leave empty for no limit.">
                <input className={inputCls} type="number" min={1} max={20} step={1} value={draft.max_tasks} onChange={(e) => set('max_tasks', e.target.value)} />
              </Field>
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 text-[13px] text-[var(--color-muted)]">Work types <span className="text-[var(--color-dim)]">(none picked = any internal work type)</span></legend>
              <div className="flex flex-wrap gap-1.5">
                {AUTO_APPROVE_INTERNAL_WORK_TYPES.map((w) => <Chip key={w} on={draft.work_types.includes(w)} onClick={() => toggle('work_types', w)}>{w}</Chip>)}
              </div>
            </fieldset>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 text-[13px] text-[var(--color-muted)]">Clients</legend>
              <div className="flex flex-wrap gap-1.5">
                {([['none', 'Internal only (no client)'], ['any', 'Any client'], ['listed', 'Only these clients']] as const).map(([v, l]) =>
                  <Chip key={v} on={draft.client_scope === v} onClick={() => set('client_scope', v)}>{l}</Chip>)}
              </div>
              {draft.client_scope === 'listed' && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {clients.length === 0 && <span className="text-[13px] text-[var(--color-dim)]">No clients yet.</span>}
                  {clients.map((c) => <Chip key={c.slug} on={draft.client_slugs.includes(c.slug)} onClick={() => toggle('client_slugs', c.slug)}>{c.name}</Chip>)}
                </div>
              )}
            </fieldset>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} className="h-4 w-4 accent-[var(--color-primary)]" />
              Rule is on
            </label>
            {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className={btn.ghost} onClick={() => setDraft(null)}>Cancel</button>
              <button className={btn.primary} disabled={pending}>{pending ? 'Saving…' : 'Save rule'}</button>
            </div>
          </form>
        )}
      </Dialog>
      <StepUpDialog request={stepUp} />
    </section>
  );
}
