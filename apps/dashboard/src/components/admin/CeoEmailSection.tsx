'use client';
// Admin → Connectors → Email me updates (docs/15 §5c, docs/06 §11): the worker emails the CEO a copy of new results,
// questions, plans and failures FROM one connected Gmail account TO one address. Saved through ceo_email_set(): a new
// address, or turning it on, asks for the 2FA code (the `run` helper of ConnectorsView opens the StepUpDialog).
// "Send test email" sends one email to the SAVED address from the SAVED account.
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, MailCheck, Send } from 'lucide-react';
import { CEO_EMAIL_EVENT_INFO, CEO_EMAIL_EVENTS } from '@rizehubhq/shared';
import type { ConnectorsPage } from '@/lib/data/connectors';
import { saveCeoEmailAction, testCeoEmailAction, type ConnectorResult } from '@/app/connector-actions';
import { Field, btn, inputCls, relTime } from '@/components/clients/ui';
import { ceoEmailDirty, ceoEmailProblem, ceoEmailSaveNeedsCode, initialCeoEmailForm, type CeoEmailForm, type GmailOption } from '@/lib/ceoEmailForm';

type Run = (label: string, detail: string, call: (totp?: string) => Promise<ConnectorResult>, done: string) => void;
type Toast = (m: string, kind?: 'success' | 'error' | 'info') => void;

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={clsx('relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50',
        on ? 'border-[var(--color-primary)] bg-[var(--color-primary)]' : 'border-[var(--color-line)] bg-[var(--color-panel-2)]')}>
      <span aria-hidden className={clsx('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform', on ? 'translate-x-[22px]' : 'translate-x-[3px]')} />
    </button>
  );
}

export function CeoEmailSection({ page, run, toast }: { page: ConnectorsPage; run: Run; toast: Toast }) {
  const saved = page.ceoEmail.settings;
  const gmail: GmailOption[] = useMemo(() => page.connectors.filter((c) => c.kind === 'gmail' && c.account_email)
    .map((c) => ({ id: c.id, email: c.account_email!, status: c.status })), [page.connectors]);
  const [form, setForm] = useState<CeoEmailForm>(() => initialCeoEmailForm(saved, gmail));
  const [testing, setTesting] = useState(false);
  const dirty = ceoEmailDirty(saved, form);
  const problem = ceoEmailProblem(form, gmail);
  const needsCode = dirty && ceoEmailSaveNeedsCode(saved, form);
  const set = (patch: Partial<CeoEmailForm>) => setForm((f) => ({ ...f, ...patch }));
  const savedAccount = gmail.find((g) => g.id === saved.connector_id);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (problem) { toast(problem, 'error'); return; }
    const to = form.to.trim().toLowerCase();
    run('Email me updates', `Send HQ updates to ${to || 'nobody'}.`, (totp) => saveCeoEmailAction({ ...form, to, totp }),
      form.enabled ? `Saved. New updates go to ${to}.` : 'Saved. Emails are off.');
  };
  const test = async () => {
    setTesting(true);
    const r = await testCeoEmailAction();
    setTesting(false);
    if (!r.ok) toast(r.error, 'error'); else toast(r.message, r.sent ? 'success' : page.mode === 'demo' ? 'info' : 'error');
  };

  return (
    <section className="card flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="ceo-email-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="ceo-email-title" className="flex items-center gap-2 text-lg font-semibold"><MailCheck size={18} aria-hidden /> Email me updates</h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">
            A copy of every result in your inbox: the full content and file links of each deliverable that passes QA, plus questions
            and failures. Approving still happens here or on Telegram; the emails have no approve buttons.
          </p>
        </div>
        <span className={clsx('mt-1 shrink-0 rounded-full border px-2.5 py-0.5 text-xs',
          saved.enabled ? 'border-[color-mix(in_oklab,var(--color-success)_50%,transparent)] text-[color-mix(in_oklab,var(--color-success)_80%,white)]' : 'border-[var(--color-line)] text-[var(--color-dim)]')}>
          {saved.enabled ? 'On' : 'Off'}
        </span>
      </div>

      {gmail.length === 0 ? (
        <p className="item px-4 py-5 text-sm text-[var(--color-muted)]">
          Add a Gmail account above first. HQ sends these emails from that account (with its App Password) to the address you choose here.
        </p>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-4" noValidate>
          <div className="item flex items-center justify-between gap-3 px-4 py-3">
            <span className="min-w-0 text-sm">
              <span className="block text-white">Send these emails</span>
              <span className="text-xs text-[var(--color-muted)]">
                {saved.enabled && saved.enabled_at ? <span suppressHydrationWarning>On since {relTime(saved.enabled_at)}. Only updates from then on are emailed.</span>
                  : 'Turning on asks for your 2FA code. Nothing from before is emailed.'}
              </span>
            </span>
            <Switch on={form.enabled} onChange={(v) => set({ enabled: v })} label="Send these emails" />
          </div>

          <div className="grid gap-3.5 sm:grid-cols-2">
            <Field label="Send from" hint="One of your connected Gmail accounts.">
              <select className={inputCls} value={form.connectorId} onChange={(e) => {
                const next = gmail.find((g) => g.id === e.target.value);
                // Still the previous account's own address? Follow the new account.
                const prev = gmail.find((g) => g.id === form.connectorId);
                set({ connectorId: e.target.value, ...(next && (!form.to.trim() || form.to.trim().toLowerCase() === prev?.email) ? { to: next.email } : {}) });
              }}>
                {!form.connectorId && <option value="">Pick an account</option>}
                {gmail.map((g) => <option key={g.id} value={g.id}>{g.email}{g.status === 'active' ? '' : ` (${g.status === 'disabled' ? 'off' : 'needs attention'})`}</option>)}
              </select>
            </Field>
            <Field label="Send to" hint="Only this address ever gets these emails. Changing it asks for your 2FA code.">
              <input className={inputCls} type="email" inputMode="email" autoComplete="email" maxLength={254} value={form.to}
                onChange={(e) => set({ to: e.target.value })} placeholder="you@gmail.com" />
            </Field>
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-[13px] text-[var(--color-muted)]">What to email</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {CEO_EMAIL_EVENTS.map((k) => {
                const on = form.events[k];
                return (
                  <label key={k} className={clsx('flex min-h-11 cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-sm',
                    on ? 'border-[var(--color-line-active)] bg-[var(--color-panel-2)]' : 'border-[var(--color-line)]')}>
                    <input type="checkbox" className="mt-0.5 accent-[var(--color-primary)]" checked={on}
                      onChange={() => set({ events: { ...form.events, [k]: !on } })} />
                    <span className="min-w-0">
                      <span className="block text-white">{CEO_EMAIL_EVENT_INFO[k].label}</span>
                      <span className="text-xs text-[var(--color-muted)]">{CEO_EMAIL_EVENT_INFO[k].help}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {dirty && problem && <p role="alert" className="text-sm text-[#ff8a8d]">{problem}</p>}
          {needsCode && !problem && page.totpOn && <p className="text-xs text-[var(--color-dim)]">Saving asks for your 2FA code (a new address, or turning the emails on).</p>}

          <div className="flex flex-wrap items-center gap-2">
            <button className={btn.primary} disabled={!dirty || !!problem}>Save</button>
            <button type="button" className={btn.ghost} onClick={() => void test()} disabled={testing || dirty || !saved.to || !saved.connector_id}
              title={dirty ? 'Save first: the test goes to the saved address.' : undefined}>
              <Send size={15} aria-hidden className={clsx(testing && 'animate-pulse')} /> {testing ? 'Sending…' : 'Send test email'}
            </button>
            {dirty && <span className="text-xs text-[var(--color-dim)]">Unsaved changes. The test email uses the saved address.</span>}
            {!dirty && saved.to && savedAccount && (
              <span className="min-w-0 break-all text-xs text-[var(--color-dim)]">From {savedAccount.email} to {saved.to}</span>
            )}
          </div>
        </form>
      )}

      {page.ceoEmail.recent.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] text-[var(--color-muted)]">Last emails</h3>
          <ul className="flex flex-col gap-1.5">
            {page.ceoEmail.recent.map((r) => (
              <li key={r.key} className="item flex items-start gap-2.5 px-3 py-2 text-sm">
                {r.ok ? <CheckCircle2 size={16} aria-label="Sent" className="mt-0.5 shrink-0 text-[var(--color-success)]" />
                  : <AlertTriangle size={16} aria-label="Not sent" className="mt-0.5 shrink-0 text-[var(--color-warning)]" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.title}</span>
                  {!r.ok && r.error && <span className="block text-xs text-[#ff8a8d]">{r.error}{r.attempts > 1 ? ` (${r.attempts} tries)` : ''}</span>}
                </span>
                <span className="shrink-0 text-xs text-[var(--color-dim)]" suppressHydrationWarning>{relTime(r.sent_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
