'use client';
// /operator/setup (docs/17-OPERATOR.md "Setup wizard"): add a client and get it working in six short steps. Everything
// that lives in the database is saved here; the one server step (the client's own browser) is printed ready to paste.
// Logins are typed by you in the client's browser (live screen), never here; API tokens come from the Client Vault.
import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { ArrowLeft, ArrowRight, Check, Copy, ExternalLink, KeyRound, MonitorPlay, RefreshCw, X } from 'lucide-react';
import { useHq } from '@/lib/data/store';
import { btn, inputCls } from '@/components/clients/ui';
import { ago, isOnline, type OperatorClientRow } from '@/lib/operatorView';
import { LOGIN_PRESETS, serverSetup, setupChecklist, slugify, STEPS, viewerHostFor, viewerPort, type StepKey } from '@/lib/operatorSetup';
import type { OperatorSetupData } from '@/lib/data/operator';
import {
  addChannelAction, linkCredentialAction, requestLoginCheckAction, saveClientAction, setLoginSiteAction, setVercelTeamAction, setViewerUrlAction, type OperatorResult,
} from '@/app/operator-actions';
import { Pill } from './Pill';
import { Accounts, Posting } from './OperatorAccounts';

type Run = (fn: () => Promise<OperatorResult>, done: string) => void;
const NAMES = { webflow: 'Webflow', airtable: 'Airtable', github: 'GitHub', vercel: 'Vercel' } as const;

export function OperatorSetup({ data, error, initialStep }: { data: OperatorSetupData; error?: string; initialStep?: string }) {
  const { toast } = useHq();
  const router = useRouter();
  const [pending, start] = useTransition();
  const c = data.client;
  const [step, setStep] = useState<StepKey>(c && STEPS.some((s) => s.key === initialStep) ? (initialStep as StepKey) : 'client');
  const idx = STEPS.findIndex((s) => s.key === step);
  const run: Run = (fn, done) => start(async () => { const r = await fn(); if (!r.ok) toast(r.error, 'error'); else toast(done, 'success'); });
  const homeClient = c ? (data.home.clients.find((x) => x.slug === c.slug) as OperatorClientRow | undefined) ?? null : null;
  const checklist = useMemo(() => setupChecklist({
    client: c, logins: data.logins, accounts: data.home.accounts.filter((a) => a.client_slug === c?.slug).length,
    channels: data.home.channels.filter((x) => x.client_slug === c?.slug && x.kind !== 'whatsapp').length,
    whatsapp: data.home.channels.some((x) => x.client_slug === c?.slug && x.kind === 'whatsapp'),
    webflowLinked: !!c?.webflow_credential, airtableLinked: !!c?.airtable_credential, githubLinked: !!c?.github_credential, vercelLinked: !!c?.vercel_credential, online: isOnline(data.home.heartbeatAt),
  }), [c, data]);
  const missing = checklist.filter((i) => !i.done && !i.optional).length;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Link href="/operator" className={clsx(btn.ghost, 'self-start')}><ArrowLeft size={16} aria-hidden />Operator</Link>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-[240px]">
          <h1 className="text-2xl font-semibold">{c ? `Set up ${c.name}` : 'Add a client'}</h1>
          <p className="text-sm text-[var(--color-muted)]">Each client gets its own browser: its logins and sessions stay there, so you log in once.</p>
        </div>
        {c && <Pill tone={missing ? 'warning' : 'success'}>{missing ? `${missing} step${missing === 1 ? '' : 's'} left` : 'Ready'}</Pill>}
      </div>
      {error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">{error}</p>}

      <ol className="flex gap-1 overflow-x-auto" aria-label="Steps">
        {STEPS.map((s, i) => {
          const done = checklist.filter((x) => x.step === s.key && !x.optional).every((x) => x.done) && !!c;
          return (
            <li key={s.key}>
              <button disabled={!c && s.key !== 'client'} onClick={() => setStep(s.key)} aria-current={s.key === step ? 'step' : undefined}
                className={clsx('flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] disabled:opacity-40',
                  s.key === step ? 'bg-[color-mix(in_oklab,var(--color-primary)_22%,transparent)] text-[#d6ccff]' : 'text-[var(--color-muted)] hover:text-white')}>
                <span className={clsx('grid h-5 w-5 place-items-center rounded-full text-[11px]', done ? 'bg-[color-mix(in_oklab,var(--color-success)_25%,transparent)] text-[#6ee7b7]' : 'bg-[var(--color-panel-2)]')}>
                  {done ? <Check size={12} aria-hidden /> : i + 1}
                </span>
                {s.label}
              </button>
            </li>
          );
        })}
      </ol>

      <section className="card min-w-0 p-4 sm:p-5" style={{ animation: 'brain-in .25s ease-out' }} key={step}>
        {step === 'client' && <ClientStep data={data} pending={pending} demo={data.home.demo}
          save={(input) => start(async () => {
            const r = await saveClientAction(input);
            if (!r.ok) { toast(r.error, 'error'); return; }
            toast('Client saved', 'success');
            router.push(`/operator/setup?client=${r.slug}&step=browser`);
            setStep('browser');
          })} />}
        {c && step === 'browser' && <BrowserStep data={data} pending={pending} run={run} />}
        {c && step === 'logins' && <LoginsStep data={data} pending={pending} run={run} />}
        {c && step === 'apps' && homeClient && <AppsStep data={data} client={homeClient} pending={pending} run={run} />}
        {c && step === 'apis' && <ApisStep data={data} pending={pending} />}
        {c && step === 'check' && (
          <div className="flex flex-col gap-2">
            <h2 className="text-base font-semibold">Ready?</h2>
            <ul className="flex flex-col gap-1.5">
              {checklist.map((i) => (
                <li key={i.label} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--color-panel-2)]">
                  <span className={clsx('grid h-5 w-5 shrink-0 place-items-center rounded-full', i.done ? 'bg-[color-mix(in_oklab,var(--color-success)_25%,transparent)] text-[#6ee7b7]' : i.optional ? 'bg-[var(--color-panel-2)] text-[var(--color-dim)]' : 'bg-[color-mix(in_oklab,var(--color-warning)_22%,transparent)] text-[#fcd34d]')}>
                    {i.done ? <Check size={12} aria-hidden /> : <X size={12} aria-hidden />}
                  </span>
                  <span className="min-w-0 flex-1 text-[13px]">{i.label}{i.optional && <span className="text-[var(--color-dim)]"> · optional</span>}</span>
                  {!i.done && <button className={btn.small} onClick={() => setStep(i.step)}>Fix</button>}
                </li>
              ))}
            </ul>
            {!missing && <p className="mt-2 text-sm text-[#6ee7b7]">All set. The operator reads {c.name}&apos;s chats, drafts replies and works on tasks; you approve on Telegram.</p>}
          </div>
        )}
      </section>

      {c && (
        <div className="flex justify-between">
          <button className={btn.ghost} disabled={idx <= 0} onClick={() => setStep(STEPS[idx - 1]!.key)}><ArrowLeft size={16} aria-hidden />Back</button>
          {idx < STEPS.length - 1 && <button className={btn.primary} onClick={() => setStep(STEPS[idx + 1]!.key)}>Next<ArrowRight size={16} aria-hidden /></button>}
        </div>
      )}
    </div>
  );
}

// ---------- 1. client ----------
function ClientStep({ data, pending, demo, save }: { data: OperatorSetupData; pending: boolean; demo: boolean; save: (i: { slug: string; name: string; brainProject: string; myNames: string; rules: string }) => void }) {
  const c = data.client;
  const [name, setName] = useState(c?.name ?? '');
  const [slug, setSlug] = useState(c?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(!!c);
  const [brain, setBrain] = useState(c?.brain_project ?? '');
  const [names, setNames] = useState((c?.my_names ?? ['Julev', 'Julev Ajeto']).join(', '));
  const [rules, setRules] = useState(c?.rules ?? '');
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save({ slug: slug || slugify(name), name, brainProject: brain, myNames: names, rules }); }}>
      <h2 className="text-base font-semibold">Client</h2>
      <label className="flex flex-col gap-1 text-[13px]" htmlFor="su-name">Name
        <input id="su-name" className={inputCls} value={name} onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value)); }} placeholder="Madam Muse" required />
      </label>
      <label className="flex flex-col gap-1 text-[13px]" htmlFor="su-slug">Short name <span className="text-xs text-[var(--color-dim)]">its browser profile; can&apos;t change later</span>
        <input id="su-slug" className={inputCls} value={slug} disabled={!!c} onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); }} placeholder="madam-muse" required />
      </label>
      <label className="flex flex-col gap-1 text-[13px]" htmlFor="su-brain">Project memory <span className="text-xs text-[var(--color-dim)]">the HQ Brain project slug (what the operator knows about this client)</span>
        <input id="su-brain" className={inputCls} value={brain} onChange={(e) => setBrain(e.target.value)} placeholder="madam-muse" />
      </label>
      <label className="flex flex-col gap-1 text-[13px]" htmlFor="su-names">How you appear in their chats <span className="text-xs text-[var(--color-dim)]">comma-separated</span>
        <input id="su-names" className={inputCls} value={names} onChange={(e) => setNames(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-[13px]" htmlFor="su-rules">Rules for replies <span className="text-xs text-[var(--color-dim)]">one per line; always followed</span>
        <textarea id="su-rules" className={clsx(inputCls, 'min-h-[96px] py-2')} value={rules} onChange={(e) => setRules(e.target.value)} placeholder={'- Never share prices without Julev\n- Reply in English'} />
      </label>
      <button className={clsx(btn.primary, 'self-start')} disabled={pending || demo || !name.trim()}>{c ? 'Save' : 'Add client'}<ArrowRight size={16} aria-hidden /></button>
      {demo && <p className="text-xs text-[var(--color-dim)]">Demo: saving works on the live dashboard.</p>}
    </form>
  );
}

// ---------- 2. browser ----------
function CodeBlock({ title, text }: { title: string; text: string }) {
  const { toast } = useHq();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-[var(--color-muted)]">
        <span>{title}</span>
        <button type="button" className={btn.small} onClick={() => navigator.clipboard?.writeText(text).then(() => toast('Copied', 'success'), () => toast('Select the text and copy it', 'error'))}><Copy size={13} aria-hidden />Copy</button>
      </div>
      <pre className="scroll-thin overflow-x-auto rounded-lg bg-[var(--color-panel-2)] p-3 text-[12px] leading-relaxed">{text}</pre>
    </div>
  );
}

function BrowserStep({ data, pending, run }: { data: OperatorSetupData; pending: boolean; run: Run }) {
  const c = data.client!;
  const slugs = data.home.clients.map((x) => x.slug);
  const s = serverSetup(c.slug, viewerPort(c.slug, slugs));
  const [url, setUrl] = useState(c.viewer_url ?? `https://${viewerHostFor(c.slug)}/`);
  const online = isOnline(data.home.heartbeatAt);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{c.name}&apos;s browser</h2>
        <Pill tone={online ? 'success' : 'muted'}>{online ? 'Operator running' : 'Operator not running'}</Pill>
      </div>
      <div className="item flex flex-col gap-1.5 px-3 py-2.5 text-[13px]">
        <p className="font-medium">How it works</p>
        <p className="text-[var(--color-muted)]">The operator uses a real Chrome browser that runs on your server, one for each client. You sign in to {c.name}&apos;s apps (Google, Slack, Webflow…) in it <b>once</b>; it stays signed in, even after restarts, and never mixes with another client.</p>
        <p className="text-[var(--color-muted)]">You see that browser on the Operator page (the <b>live screen</b>) and use it there yourself: to sign in, or to take over.</p>
      </div>

      <h3 className="mt-1 text-[13px] font-semibold">A · Create the browser (once, on the server)</h3>
      <p className="text-xs text-[var(--color-muted)]">For you or whoever runs the server. Copy each block into the place named above it. Skip this if {c.name} already has a browser.</p>
      <CodeBlock title="1 · Add to deploy/workspace/docker-compose.yml, under services:" text={s.compose} />
      <CodeBlock title="2 · Add to the HQ .env file" text={s.env} />
      <CodeBlock title="3 · Run on the server" text={s.commands} />
      <p className="text-xs text-[var(--color-dim)]">4 · Its web address: make a copy of deploy/workspace/nginx-ws.rizehub.ph.conf and set {s.nginx}.</p>

      <h3 className="mt-1 text-[13px] font-semibold">B · Tell HQ where to show it</h3>
      <p className="text-xs text-[var(--color-muted)]">The web address of that browser&apos;s screen (from step A). Usually you can keep the suggestion.</p>
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); run(() => setViewerUrlAction(c.slug, url), 'Saved: the live screen shows on the Operator page'); }}>
        <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" aria-label="Browser screen address" />
        <button className={btn.primary} disabled={pending || data.home.demo}>Save</button>
      </form>
    </div>
  );
}

// ---------- 3. logins ----------
function LoginsStep({ data, pending, run }: { data: OperatorSetupData; pending: boolean; run: Run }) {
  const c = data.client!;
  const tone = (st: string) => (st === 'ok' ? 'success' : st === 'signed_out' ? 'danger' : st === 'error' ? 'warning' : 'muted') as 'success' | 'danger' | 'warning' | 'muted';
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">Logins</h2>
      <p className="text-[13px] text-[var(--color-muted)]">Tick the sites {c.name} uses, then log in to each once in their browser (you type the password and the 2FA code; HQ never sees them). The operator checks every 6 hours that you are still logged in and tells you on Telegram if a login is lost.</p>
      <ul className="flex flex-col gap-1.5">
        {LOGIN_PRESETS.map((p) => {
          const l = data.logins.find((x) => x.site === p.site);
          const on = !!l?.enabled;
          return (
            <li key={p.site} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--color-panel-2)]">
              <input id={`su-login-${p.site}`} type="checkbox" checked={on} disabled={pending || data.home.demo} className="h-4 w-4 accent-[var(--color-primary)]"
                onChange={() => run(() => setLoginSiteAction(c.slug, p.site, p.label, l?.check_url ?? p.url, !on), on ? `${p.label}: not checked any more` : `${p.label}: checked for you`)} />
              <label htmlFor={`su-login-${p.site}`} className="min-w-0 flex-1 text-[13px]">{p.label}</label>
              {l?.enabled && <Pill tone={tone(l.state)}>{l.state === 'ok' ? 'Logged in' : l.state === 'signed_out' ? 'Signed out' : l.state === 'unknown' ? 'Not checked yet' : 'Check failed'}{l.last_checked_at ? ` · ${ago(l.last_checked_at)}` : ''}</Pill>}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        {c.viewer_url
          ? <a className={btn.primary} href={data.home.demo ? c.viewer_url : `/api/operator/viewer?client=${encodeURIComponent(c.slug)}`} target="_blank" rel="noopener noreferrer"><MonitorPlay size={16} aria-hidden />Open {c.name}&apos;s browser to log in</a>
          : <span className="text-xs text-[#fcd34d]">Set the live screen address in step 2 first.</span>}
        <button className={btn.ghost} disabled={pending || data.home.demo} onClick={() => run(() => requestLoginCheckAction(c.slug), 'Checking the logins now (about a minute)')}><RefreshCw size={14} aria-hidden />Check now</button>
      </div>
    </div>
  );
}

// ---------- 4. apps ----------
function AppsStep({ data, client, pending, run }: { data: OperatorSetupData; client: OperatorClientRow; pending: boolean; run: Run }) {
  const [num, setNum] = useState('');
  const [pid, setPid] = useState('');
  const wa = data.home.channels.filter((x) => x.client_slug === client.slug && x.kind === 'whatsapp');
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-base font-semibold">Apps to watch</h2>
      <p className="text-[13px] text-[var(--color-muted)]">The operator checks these for unread chats in {client.name}&apos;s browser and answers what is meant for you. Single chats can also be added on the Operator page.</p>
      <Accounts data={data.home} client={client} pending={pending} run={run} />
      <Posting data={data.home} client={client} pending={pending} run={run} />
      <div className="mt-4 border-t border-[var(--color-line)] pt-3">
        <h3 className="mb-1 text-[13px] font-semibold">WhatsApp Business</h3>
        {wa.length
          ? <p className="text-xs text-[#6ee7b7]">Connected: {wa.map((w) => w.name).join(', ')}</p>
          : (
            <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); run(() => addChannelAction(client.slug, `${client.name} WhatsApp`, num, 'whatsapp', pid), 'WhatsApp connected'); }}>
              <input className={inputCls} value={num} onChange={(e) => setNum(e.target.value)} placeholder="Business number, +63 917…" inputMode="tel" aria-label="WhatsApp business number" />
              <input className={inputCls} value={pid} onChange={(e) => setPid(e.target.value)} placeholder="Phone number ID (Meta)" inputMode="numeric" aria-label="Phone number ID" />
              <button className={btn.small} disabled={pending || data.home.demo || !num || !pid}>Connect</button>
            </form>
          )}
        <p className="mt-1 text-xs text-[var(--color-dim)]">Optional. Needs the Meta app keys in .env (docs/17 &quot;WhatsApp Business&quot;).</p>
      </div>
    </div>
  );
}

// ---------- 5. APIs ----------
function ApisStep({ data, pending }: { data: OperatorSetupData; pending: boolean }) {
  const { toast } = useHq();
  const [busy, start] = useTransition();
  const [code, setCode] = useState('');
  const [askCode, setAskCode] = useState(false);
  const c = data.client!;
  const link = (platform: 'webflow' | 'airtable' | 'github' | 'vercel', id: string | null) => start(async () => {
    const r = await linkCredentialAction(c.slug, platform, id, code || null);
    if (!r.ok) { if (r.stepUp) setAskCode(true); toast(r.error, 'error'); return; }
    setCode(''); setAskCode(false);
    toast(id ? `${NAMES[platform]} token linked` : 'Unlinked', 'success');
  });
  const rows: ['webflow' | 'airtable' | 'github' | 'vercel', string, string | null][] = [['webflow', 'Webflow', c.webflow_credential], ['airtable', 'Airtable', c.airtable_credential],
    ['github', 'GitHub', c.github_credential ?? null], ['vercel', 'Vercel', c.vercel_credential ?? null]];
  const [team, setTeam] = useState(c.vercel_team ?? '');
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">APIs</h2>
      <p className="text-[13px] text-[var(--color-muted)]">With an API token the operator reads Webflow, Airtable, GitHub and Vercel directly (faster, and no browser session to flag), and proposes changes there for your ✅. Tokens stay encrypted in the Client Vault; the AI never sees them.</p>
      {!c.client_id && <p className="text-xs text-[#fcd34d]">This operator client is not linked to a client in HQ (Clients), so there are no vault tokens to pick. Add the client in HQ with the same short name, or use the env fallback (docs/17).</p>}
      {rows.map(([p, label, linked]) => {
        const options = data.credentials.filter((x) => x.platform.toLowerCase() === p && x.status !== 'revoked');
        return (
          <div key={p} className="item flex flex-wrap items-center gap-2 px-3 py-2.5">
            <KeyRound size={15} className="text-[#c4b5ff]" aria-hidden />
            <span className="min-w-0 flex-1 text-[13px]">{label}{linked && <span className="text-[#6ee7b7]"> · linked</span>}</span>
            <select className={clsx(inputCls, 'sm:max-w-[240px]')} aria-label={`${label} token`} value={linked ?? ''} disabled={pending || busy || data.home.demo}
              onChange={(e) => link(p, e.target.value || null)}>
              <option value="">{options.length ? 'Not linked' : 'No token in the vault'}</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}{o.secret_type !== 'api_token' ? ` (${o.secret_type})` : ''}</option>)}
            </select>
          </div>
        );
      })}
      <form className="item flex flex-wrap items-center gap-2 px-3 py-2.5" onSubmit={(e) => { e.preventDefault(); start(async () => { const r = await setVercelTeamAction(c.slug, team); toast(r.ok ? 'Vercel team saved' : r.error, r.ok ? 'success' : 'error'); }); }}>
        <label htmlFor="su-vteam" className="min-w-0 flex-1 text-[13px]">Vercel team <span className="text-xs text-[var(--color-dim)]">id (team_...) or slug; empty = personal account</span></label>
        <input id="su-vteam" className={clsx(inputCls, 'sm:max-w-[200px]')} value={team} onChange={(e) => setTeam(e.target.value)} placeholder="team_..." />
        <button className={btn.small} disabled={busy || data.home.demo || team === (c.vercel_team ?? '')}>Save</button>
      </form>
      {askCode && (
        <label className="flex items-center gap-2 text-[13px]" htmlFor="su-totp">Your 2FA code
          <input id="su-totp" className={clsx(inputCls, 'max-w-[140px]')} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" autoComplete="one-time-code" />
          <span className="text-xs text-[var(--color-dim)]">then pick the token again</span>
        </label>
      )}
      {c.client_id
        ? <Link href={`/clients/${c.client_id}?tab=access&add=1`} className={clsx(btn.ghost, 'self-start')}><ExternalLink size={14} aria-hidden />Add a token in {c.name}&apos;s Client Vault</Link>
        : <p className="text-xs text-[var(--color-muted)]">Tokens are saved in the Client Vault: <Link href="/clients" className="text-[#c4b5ff] hover:underline">Clients</Link> → {c.name} → Access → Add. (Link this operator client to an HQ client with the same short name first.)</p>}
    </div>
  );
}
