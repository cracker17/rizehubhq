'use client';
// Admin → API & AI (docs/14 "Dashboard settings", docs/06 §11): the model profile, budgets and per-role models, and the
// provider API keys, managed here instead of the server's .env. A value set here wins over .env; empty = use .env.
// Keys go straight to the worker (tested, encrypted, stored); the page only ever sees their last 4 characters.
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { Sparkles, KeyRound, RefreshCw, Trash2, ExternalLink, Cpu, Plus } from 'lucide-react';
import {
  AI_PROFILE_HELP, AI_PROFILES, MODEL_ROLES, PROVIDER_KEY_GROUPS, ROLE_LABEL, type AiProfile, type ModelRole,
} from '@rizehubhq/shared';
import type { ApiKeyView, ApiPage } from '@/lib/data/apiSettings';
import { formFromDashboard, KEY_STATE_LABEL, parseAiForm, usdOrNone, type AiFormInput, type KeyState } from '@/lib/apiSettings';
import {
  removeProviderKeyAction, saveAiSettingsAction, setProviderKeyAction, testProviderKeyAction, type ApiResult,
} from '@/app/api-settings-actions';
import { Dialog, Field, btn, inputCls, relTime } from '@/components/clients/ui';
import { StepUpDialog, type StepUpRequest } from '@/components/StepUpDialog';
import { useHq } from '@/lib/data/store';

type Run = (label: string, detail: string, call: (totp?: string) => Promise<ApiResult<{ message?: string }>>, done: string) => void;

const SOURCE_LABEL: Record<string, string> = { dashboard: 'set here', env: 'from .env', settings: 'older setting', default: 'default' };
const STATE_COLOR: Record<KeyState, string> = {
  dashboard: 'var(--color-success)', env: 'var(--color-teal)', missing: 'var(--color-dim)', unknown: 'var(--color-dim)', dashboard_unreadable: 'var(--color-danger)',
};
const profileName = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

function KeyPill({ k }: { k: ApiKeyView }) {
  const color = STATE_COLOR[k.state];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs"
      style={{ color: `color-mix(in oklab, ${color} 80%, white)`, borderColor: `color-mix(in oklab, ${color} 50%, transparent)` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} aria-hidden />
      {KEY_STATE_LABEL[k.state]}{k.state === 'dashboard' && k.last4 ? <span className="font-mono">&nbsp;••••{k.last4}</span> : null}
    </span>
  );
}

// ---------- AI settings ----------
function AiCard({ page, run }: { page: ApiPage; run: Run }) {
  const [form, setForm] = useState<AiFormInput>(() => formFromDashboard(page.dashboard));
  const [error, setError] = useState<string | null>(null);
  const w = page.worker;
  const d = w?.defaults;
  const set = (patch: Partial<AiFormInput>) => { setForm((f) => ({ ...f, ...patch })); setError(null); };
  const setRole = (role: ModelRole, v: string) => set({ modelIds: { ...form.modelIds, [role]: v } });
  const shownProfile = (form.profile || d?.profile || '') as AiProfile | '';
  const overrides = MODEL_ROLES.filter((r) => form.modelIds[r]?.trim()).length;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseAiForm(form);
    if (!parsed.ok) { setError(parsed.error); return; }
    run('Save AI settings', 'Change the model profile, budgets or per-role models.',
      (totp) => saveAiSettingsAction({ ...form, totp }), 'AI settings saved.');
  };

  return (
    <section className="card flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="ai-title">
      <div className="min-w-0">
        <h2 id="ai-title" className="flex items-center gap-2 text-lg font-semibold"><Sparkles size={18} aria-hidden /> AI models and budgets</h2>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">
          A value set here wins over the server&apos;s .env; leave a field empty to use the .env value. The worker picks changes up within a minute, no restart.
        </p>
        {w && (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Running now: <b className="text-white">{profileName(w.ai.profile)}</b> ({SOURCE_LABEL[w.ai.profileSource]})
            {' · '}{usdOrNone(w.ai.monthlyBudgetUsd, '$0')}/month ({SOURCE_LABEL[w.ai.monthlySource]})
            {' · '}{w.ai.dailyBudgetUsd === null ? 'no daily cap' : `${usdOrNone(w.ai.dailyBudgetUsd, '')}/day`} ({SOURCE_LABEL[w.ai.dailySource]})
          </p>
        )}
        {w?.ai.warnings.map((m) => <p key={m} className="mt-1 text-sm text-[var(--color-warning)]">{m}</p>)}
      </div>

      <form onSubmit={save} className="flex flex-col gap-4">
        <div className="grid gap-3.5 sm:grid-cols-3">
          <Field label="Model profile" className="sm:col-span-3">
            <select className={inputCls} value={form.profile} onChange={(e) => set({ profile: e.target.value })}>
              <option value="">Use .env{d ? ` (${profileName(d.profile)})` : ''}</option>
              {AI_PROFILES.map((p) => <option key={p} value={p}>{profileName(p)}</option>)}
            </select>
            {shownProfile && AI_PROFILE_HELP[shownProfile as AiProfile] && <span className="text-xs text-[var(--color-dim)]">{AI_PROFILE_HELP[shownProfile as AiProfile]}</span>}
          </Field>
          <Field label="Monthly budget (USD)" hint="Paid models (Claude, OpenAI, Kimi, paid OpenRouter) only run above $0.">
            <input className={inputCls} inputMode="decimal" value={form.monthly} onChange={(e) => set({ monthly: e.target.value })}
              placeholder={d ? `.env: ${usdOrNone(d.monthlyBudgetUsd, '$0')}` : 'Use .env'} />
          </Field>
          <Field label="Daily AI budget (USD)" hint="0 = no daily cap. At the cap paid models stop until midnight Manila.">
            <input className={inputCls} inputMode="decimal" value={form.daily} onChange={(e) => set({ daily: e.target.value })}
              placeholder={d ? `.env: ${usdOrNone(d.dailyBudgetUsd, 'no cap')}` : 'Use .env'} />
          </Field>
        </div>

        <details className="group rounded-xl border border-[var(--color-line)] p-3.5">
          <summary className="cursor-pointer text-sm text-[var(--color-muted)] hover:text-white">
            Advanced: a specific model per role{overrides ? ` (${overrides} set)` : ''}
          </summary>
          <p className="mt-2 text-xs text-[var(--color-dim)]">
            Format provider:model, e.g. anthropic:claude-sonnet-5 or openai:gpt-5.5. Empty = the profile&apos;s models (or MODEL_ID_&lt;ROLE&gt; in .env).
            An agent with its own model on the Agents page keeps that one.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {MODEL_ROLES.map((role) => (
              <Field key={role} label={ROLE_LABEL[role]}>
                <input className={`${inputCls} font-mono text-[13px]`} value={form.modelIds[role] ?? ''} onChange={(e) => setRole(role, e.target.value)}
                  placeholder={d?.modelIds[role]?.spec ?? 'profile default'} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
              </Field>
            ))}
          </div>
        </details>

        {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {page.totpOn && <span className="mr-auto text-xs text-[var(--color-dim)]">Saving asks for your 2FA code.</span>}
          <button type="button" className={btn.ghost} onClick={() => set({ profile: '', monthly: '', daily: '', modelIds: {} })}>Use .env for all</button>
          <button className={btn.primary}>Save</button>
        </div>
      </form>
    </section>
  );
}

function ModelsNow({ page }: { page: ApiPage }) {
  const w = page.worker;
  if (!w) return null;
  return (
    <section className="card flex flex-col gap-3 p-5 sm:p-6" aria-labelledby="models-title">
      <h2 id="models-title" className="flex items-center gap-2 text-lg font-semibold"><Cpu size={18} aria-hidden /> Model each role gets now</h2>
      {w.paidBlocked && <p className="text-sm text-[var(--color-warning)]">Today&apos;s AI budget is used up: paid models are off until midnight Manila time.</p>}
      <ul className="divide-y divide-[var(--color-line)]">
        {MODEL_ROLES.map((role) => {
          const m = w.models[role];
          return (
            <li key={role} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-4">
              <span className="text-sm sm:w-48 sm:shrink-0">{ROLE_LABEL[role]}</span>
              {m && 'provider' in m
                ? <span className="min-w-0 break-all font-mono text-[13px] text-white">{m.provider}:{m.modelId}</span>
                : <span className="min-w-0 break-words text-[13px] text-[#ff8a8d]">{m?.error ? m.error.replace(/^No model available for role "\w+": /, 'None available: ').slice(0, 220) : 'unknown'}</span>}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-[var(--color-dim)]">First usable model: key set, free quota left, and budget left for paid models.</p>
    </section>
  );
}

// ---------- keys ----------
function KeyDialog({ k, onClose, run }: { k: ApiKeyView | null; onClose: () => void; run: Run }) {
  const [value, setValue] = useState('');
  const [test, setTest] = useState(true);
  if (!k) return null;
  const testable = k.name !== 'PAGESPEED_API_KEY';
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = value;
    setValue('');
    onClose();
    run('Save key', `Store a new ${k.label} key.`, (totp) => setProviderKeyAction({ name: k.name, value: v, test: testable && test, totp }), `${k.label} key saved.`);
  };
  return (
    <Dialog open onClose={onClose} title={`${k.state === 'dashboard' ? 'Replace' : 'Add'} ${k.label} key`}>
      <form onSubmit={submit} className="flex flex-col gap-3.5" autoComplete="off">
        <p className="text-sm text-[var(--color-muted)]">
          {k.hint}{' '}
          <a className="text-white underline underline-offset-4" href={k.docs} target="_blank" rel="noreferrer">Get a key<ExternalLink size={12} className="ml-1 inline" aria-hidden /></a>
        </p>
        <Field label={k.name} hint="Encrypted on the server. You'll only see its last 4 characters here.">
          <input className={`${inputCls} font-mono`} type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)}
            required autoFocus data-1p-ignore data-lpignore="true" spellCheck={false} />
        </Field>
        {testable
          ? (
            <label className="flex items-start gap-2.5 text-sm text-[var(--color-muted)]">
              <input type="checkbox" className="mt-0.5 accent-[var(--color-primary)]" checked={test} onChange={(e) => setTest(e.target.checked)} />
              <span>Test it with {k.label} before saving (a key that fails is not saved).</span>
            </label>
          )
          : <p className="text-xs text-[var(--color-dim)]">This key can&apos;t be tested cheaply: it is checked the first time an agent uses it.</p>}
        {k.alsoInEnv && <p className="text-xs text-[var(--color-dim)]">The server&apos;s .env also has this key: the one you save here wins.</p>}
        <div className="flex justify-end gap-2"><button type="button" className={btn.ghost} onClick={onClose}>Cancel</button><button className={btn.primary} disabled={!value.trim()}>Save</button></div>
      </form>
    </Dialog>
  );
}

function KeysCard({ page, run, onEdit }: { page: ApiPage; run: Run; onEdit: (k: ApiKeyView) => void }) {
  const router = useRouter();
  const { toast } = useHq();
  const [busy, setBusy] = useState<string | null>(null);
  const test = async (k: ApiKeyView) => {
    setBusy(k.name);
    const r = await testProviderKeyAction({ name: k.name });
    setBusy(null);
    if (!r.ok) toast(r.error, 'error'); else toast(r.message, r.working === false ? 'error' : 'success');
    router.refresh();
  };
  return (
    <section className="card flex flex-col gap-5 p-5 sm:p-6" aria-labelledby="keys-title">
      <div className="min-w-0">
        <h2 id="keys-title" className="flex items-center gap-2 text-lg font-semibold"><KeyRound size={18} aria-hidden /> API keys</h2>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">
          Keys stored here are encrypted and override the same key in the server&apos;s .env. Server secrets (database, vault, Telegram) stay in .env and can&apos;t be set here.
        </p>
      </div>
      {PROVIDER_KEY_GROUPS.map((g) => (
        <div key={g.id} className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-[var(--color-muted)]">{g.label}</h3>
          <ul className="flex flex-col gap-3">
            {page.keys.filter((k) => k.group === g.id).map((k) => (
              <li key={k.name} className="item flex flex-col gap-2.5 p-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="min-w-0 font-medium">{k.label}</span>
                  <KeyPill k={k} />
                </div>
                <p className="break-all font-mono text-xs text-[var(--color-dim)]">{k.name}</p>
                <p className="text-sm text-[var(--color-muted)]">{k.hint}</p>
                {k.state === 'dashboard_unreadable' && (
                  <p className="text-sm text-[#ff8a8d]">The worker can&apos;t decrypt this key (the vault master key changed). Replace it; until then the .env value is used.</p>
                )}
                {k.state === 'dashboard' && (
                  <p className="text-xs text-[var(--color-dim)]" suppressHydrationWarning>
                    Saved {relTime(k.updated_at)}
                    {k.last_test_at ? ` · tested ${relTime(k.last_test_at)}: ${k.last_test_ok ? 'working' : 'failed'}` : ' · not tested yet'}
                    {k.alsoInEnv ? ' · overrides the .env value' : ''}
                  </p>
                )}
                {k.last_test_ok === false && k.last_error && <p className="text-sm text-[#ff8a8d]">{k.last_error}</p>}
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={btn.small} onClick={() => onEdit(k)}>
                    {k.state === 'dashboard' || k.state === 'dashboard_unreadable' ? <><KeyRound size={14} aria-hidden /> Replace</> : <><Plus size={14} aria-hidden /> Add key</>}
                  </button>
                  {k.state !== 'missing' && (
                    <button type="button" className={btn.small} onClick={() => void test(k)} disabled={busy === k.name}>
                      <RefreshCw size={14} aria-hidden className={clsx(busy === k.name && 'animate-spin')} /> Test
                    </button>
                  )}
                  {(k.state === 'dashboard' || k.state === 'dashboard_unreadable') && (
                    <button type="button" className={btn.danger} onClick={() => {
                      if (!window.confirm(`Remove the ${k.label} key stored here? Agents fall back to the .env value, if the server has one.`)) return;
                      run('Remove key', `Remove the ${k.label} key.`, (totp) => removeProviderKeyAction({ name: k.name, totp }), 'Key removed.');
                    }}><Trash2 size={14} aria-hidden /> Remove</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

export function ApiSettingsView({ page }: { page: ApiPage }) {
  const router = useRouter();
  const { toast } = useHq();
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null);
  const [editing, setEditing] = useState<ApiKeyView | null>(null);
  // The form restarts from the saved values after each refresh (key = saved state).
  const aiKey = useMemo(() => JSON.stringify(page.dashboard), [page.dashboard]);

  // Runs an action; when it needs a fresh 2FA code, asks for it and retries with the code.
  const run: Run = (label, detail, call, done) => {
    void (async () => {
      const r = await call(undefined);
      if (r.ok) { toast(r.message ?? done, 'success'); router.refresh(); return; }
      if (!r.stepUp) { toast(r.error, 'error'); return; }
      setStepUp({
        title: 'Confirm with 2FA', detail: `${detail} Enter your authenticator code to confirm.`,
        submit: async (code) => {
          const again = await call(code);
          if (!again.ok) return again.error;
          setStepUp(null); toast(again.message ?? done, 'success'); router.refresh();
          return null;
        },
        cancel: () => { setStepUp(null); toast(`${label}: not saved without your 2FA code.`, 'info'); },
      });
    })();
  };

  return (
    <div className="flex flex-col gap-4 lg:gap-5">
      {page.error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">Couldn&apos;t load everything: {page.error}</p>}
      {page.mode === 'demo' && <p className="item px-4 py-3 text-sm text-[var(--color-muted)]">Demo mode: sample data. Saving keys and settings needs the live dashboard.</p>}
      {page.mode === 'live' && !page.worker && (
        <p className="item px-4 py-3 text-sm text-[var(--color-warning)]">
          The worker didn&apos;t answer ({page.workerError ?? 'offline'}), so this page can&apos;t show which keys are in .env or which models run. Saving still works; the worker applies it when it&apos;s back.
        </p>
      )}
      <AiCard key={aiKey} page={page} run={run} />
      <ModelsNow page={page} />
      <KeysCard page={page} run={run} onEdit={setEditing} />
      {editing && <KeyDialog key={editing.name} k={editing} onClose={() => setEditing(null)} run={run} />}
      <StepUpDialog request={stepUp} />
    </div>
  );
}
