'use client';
// Admin → Connectors → Apps (MCP), docs/15 §2–3: catalog cards → connect (sign in / token / own app) → review each
// tool: Allowed / Ask me / Off. Locked tools (money, contacting people) can't be Allowed; new or changed tools wait Off.
import { useEffect, useMemo, useState, useTransition } from 'react';
import clsx from 'clsx';
import { Blocks, Coins, ExternalLink, Lock, PhoneOff, Plus, RefreshCw, SlidersHorizontal, Trash2, Users, Wallet } from 'lucide-react';
import { MCP_CALLBACK_PATH, MCP_CATALOG, catalogEntry, defaultToolPolicy, type CatalogEntry } from '@rizehubhq/shared';
import type { ConnectorView, ConnectorsPage, ToolView } from '@/lib/data/connectors';
import {
  connectAppTokenAction, deleteConnectorAction, setConnectorAgentsAction, setToolPoliciesAction, startAppSignInAction, syncAppAction,
  type ConnectorResult,
} from '@/app/connector-actions';
import { Dialog, Field, btn, inputCls, relTime } from '@/components/clients/ui';

type Run = (label: string, detail: string, call: (totp?: string) => Promise<ConnectorResult>, done: string) => void;
type Policy = ToolView['policy'];
const POLICY_LABEL: Record<Policy, string> = { allow: 'Allowed', ask: 'Ask me', off: 'Off' };
const codeInput = `${inputCls} max-w-[200px] text-center font-mono tracking-[0.35em]`;

function Badges({ credits, money, contact }: { credits?: boolean; money?: boolean; contact?: boolean }) {
  return (
    <>
      {credits && <span className="inline-flex items-center gap-1 rounded-full border border-[color-mix(in_oklab,var(--color-warning)_50%,transparent)] px-2 py-0.5 text-[11px] text-[color-mix(in_oklab,var(--color-warning)_85%,white)]"><Coins size={11} aria-hidden />Uses credits</span>}
      {money && <span className="inline-flex items-center gap-1 rounded-full border border-[color-mix(in_oklab,var(--color-danger)_50%,transparent)] px-2 py-0.5 text-[11px] text-[#ffb3b5]"><Wallet size={11} aria-hidden />Can spend money</span>}
      {contact && <span className="inline-flex items-center gap-1 rounded-full border border-[color-mix(in_oklab,var(--color-danger)_50%,transparent)] px-2 py-0.5 text-[11px] text-[#ffb3b5]"><PhoneOff size={11} aria-hidden />Contacts people</span>}
    </>
  );
}

function AgentChecks({ page, value, onChange }: { page: ConnectorsPage; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-[13px] text-[var(--color-muted)]">Agents that may use it</legend>
      <div className="flex flex-wrap gap-2">
        {page.agents.map((a) => {
          const on = value.includes(a.id);
          return (
            <label key={a.id} className={clsx('flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm',
              on ? 'border-[var(--color-line-active)] bg-[var(--color-panel-2)] text-white' : 'border-[var(--color-line)] text-[var(--color-muted)]')}>
              <input type="checkbox" className="accent-[var(--color-primary)]" checked={on} onChange={() => onChange(on ? value.filter((x) => x !== a.id) : [...value, a.id])} />
              {a.name}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function ConnectDialog({ entry, custom, page, onClose, onConnected }: {
  entry: CatalogEntry | null; custom: boolean; page: ConnectorsPage; onClose: () => void; onConnected: (id: string) => void;
}) {
  const modes = entry?.auth ?? ['oauth', 'token'];
  const [mode, setMode] = useState(modes[0]!);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [projectRef, setProjectRef] = useState('');
  const [token, setToken] = useState('');
  const [header, setHeader] = useState('Authorization');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [agents, setAgents] = useState<string[]>((entry?.suggestedAgents ?? []).filter((a) => page.agents.some((x) => x.id === a)));
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const callback = typeof window !== 'undefined' ? `${window.location.origin}${MCP_CALLBACK_PATH}` : MCP_CALLBACK_PATH;
  const target = { catalogKey: entry?.key, url: custom ? url : undefined, name: name || undefined, agents, projectRef: projectRef || undefined };
  const totp = page.totpOn ? code : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      setError(null);
      if (mode === 'token') {
        const r = await connectAppTokenAction({ ...target, token, header: custom ? header : undefined, totp });
        setCode('');
        if (!r.ok) { setError(r.error); return; }
        setToken('');
        onConnected(r.id);
        return;
      }
      const r = await startAppSignInAction({ ...target, own: mode === 'own_app' ? { clientId, clientSecret } : undefined, totp });
      setCode('');
      if (!r.ok) { setError(r.error); return; }
      if (r.authorizeUrl) { window.location.assign(r.authorizeUrl); return; }
      if (r.id) onConnected(r.id);
    });
  };

  const title = entry ? `Connect ${entry.name}` : 'Connect a custom MCP server';
  return (
    <Dialog open onClose={onClose} title={title} wide>
      <form onSubmit={submit} className="flex flex-col gap-4" autoComplete="off">
        {entry && <p className="text-sm text-[var(--color-muted)]">{entry.blurb} <a className="text-white underline underline-offset-4" href={entry.docs} target="_blank" rel="noreferrer">Vendor docs<ExternalLink size={12} className="ml-1 inline" aria-hidden /></a></p>}
        {entry && <div className="flex flex-wrap gap-1.5"><Badges credits={entry.credits} money={entry.money} /></div>}
        {modes.length > 1 && (
          <div role="radiogroup" aria-label="How to connect" className="flex flex-wrap gap-2">
            {modes.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
                className={clsx('h-9 rounded-full border px-3.5 text-sm', mode === m ? 'border-[var(--color-line-active)] bg-[var(--color-panel-2)] text-white' : 'border-[var(--color-line)] text-[var(--color-muted)]')}>
                {m === 'oauth' ? 'Sign in' : m === 'token' ? 'Paste a token' : 'Your own app'}
              </button>
            ))}
          </div>
        )}
        {custom && (
          <Field label="Server URL" hint="The app's remote MCP URL, https only.">
            <input className={inputCls} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" required />
          </Field>
        )}
        <Field label="Name (optional)">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={entry?.name ?? 'My app'} maxLength={120} />
        </Field>
        {entry?.urlParam && (
          <Field label={entry.urlParam.label} hint={entry.urlParam.hint}>
            <input className={`${inputCls} font-mono`} value={projectRef} onChange={(e) => setProjectRef(e.target.value.trim())} pattern={entry.urlParam.pattern} />
          </Field>
        )}
        {mode === 'oauth' && <p className="item px-4 py-3 text-sm text-[var(--color-muted)]">You&apos;ll go to {entry?.name ?? 'the app'} to approve access, then come back here to choose what each tool may do. HQ never sees your password.</p>}
        {mode === 'token' && (
          <>
            {entry?.tokenHeader && <p className="text-sm text-[var(--color-muted)]">Create one at: {entry.tokenHeader.hint}. Start with read-only permissions.</p>}
            {custom && <Field label="Header"><input className={`${inputCls} font-mono`} value={header} onChange={(e) => setHeader(e.target.value)} pattern="[A-Za-z0-9-]{1,60}" /></Field>}
            <Field label="Token" hint="Stored encrypted; never shown again.">
              <input className={`${inputCls} font-mono`} type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} required data-1p-ignore data-lpignore="true" />
            </Field>
          </>
        )}
        {mode === 'own_app' && (
          <>
            <ol className="list-decimal space-y-1 rounded-xl border border-[var(--color-line)] p-4 pl-8 text-sm text-[var(--color-muted)]">
              {(entry?.ownAppSteps ?? ['Create an OAuth app at the vendor.', 'Add the redirect URL below.', 'Copy its client ID and secret here.']).map((s) => <li key={s}>{s}</li>)}
            </ol>
            <Field label="Redirect URL (copy into the app)"><input className={`${inputCls} font-mono`} value={callback} readOnly onFocus={(e) => e.currentTarget.select()} /></Field>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label="Client ID"><input className={`${inputCls} font-mono`} value={clientId} onChange={(e) => setClientId(e.target.value)} required /></Field>
              <Field label="Client secret"><input className={`${inputCls} font-mono`} type="password" autoComplete="new-password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} data-1p-ignore data-lpignore="true" /></Field>
            </div>
          </>
        )}
        <AgentChecks page={page} value={agents} onChange={setAgents} />
        {page.totpOn && (
          <Field label="2FA code" hint="Connecting an app gives agents access, so it needs your authenticator code.">
            <input className={codeInput} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required />
          </Field>
        )}
        {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={btn.ghost} onClick={onClose}>Cancel</button>
          <button className={btn.primary} disabled={pending}>{pending ? 'Connecting…' : mode === 'token' ? 'Connect' : 'Continue to sign in'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function ToolsDialog({ c, onClose, run }: { c: ConnectorView; onClose: () => void; run: Run }) {
  const [draft, setDraft] = useState<Record<string, Policy>>(() => Object.fromEntries(c.tools.map((t) => [t.name, t.policy])));
  const [q, setQ] = useState('');
  const changed = c.tools.filter((t) => draft[t.name] !== t.policy || t.review);
  const entry = catalogEntry(c.catalog);
  // Presets apply to the tools shown (so a search + preset changes just that group). Locked tools never become Allowed.
  const shown = c.tools.filter((t) => !q.trim() || `${t.name} ${t.description}`.toLowerCase().includes(q.trim().toLowerCase()));
  const apply = (pick: (t: ToolView) => Policy) => setDraft((d) => ({ ...d, ...Object.fromEntries(shown.map((t) => {
    const p = pick(t);
    return [t.name, t.locked && p === 'allow' ? 'ask' : p];
  })) }));
  const recommended = () => apply((t) => defaultToolPolicy({ name: t.name, description: t.description, annotations: t.annotations ?? null }, entry).policy);
  const allowAll = () => {
    if (!window.confirm(`Allow ${shown.filter((t) => !t.locked).length} tools? Agents will use them without asking you, including tools that create, change, delete or spend credits. Locked tools still ask.`)) return;
    apply(() => 'allow');
  };
  const counts = { allow: 0, ask: 0, off: 0 } as Record<Policy, number>;
  for (const t of c.tools) counts[draft[t.name] ?? t.policy]++;
  const save = () => {
    const policies = Object.fromEntries(changed.map((t) => [t.name, draft[t.name]!]));
    onClose();
    run('Save tool permissions', `Change what agents may do in ${c.name}.`, (totp) => setToolPoliciesAction({ id: c.id, policies, totp }), 'Tool permissions saved.');
  };
  return (
    <Dialog open onClose={onClose} title={`${c.name}: what may agents do?`} wide>
      <p className="mb-3 text-sm text-[var(--color-muted)]">
        <b className="text-white">Allowed</b>: the agent uses it on its own. <b className="text-white">Ask me</b>: each use waits in your Approvals with the exact details.
        <b className="text-white"> Off</b>: hidden. Locked tools can&apos;t be Allowed.
      </p>
      <div className="mb-3 flex flex-col gap-2.5">
        <input className={inputCls} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${c.tools.length} tools…`} aria-label="Search tools" />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[var(--color-dim)]">{q.trim() ? `Set the ${shown.length} shown:` : 'Set all:'}</span>
          <button type="button" className={clsx(btn.small, 'border-[var(--color-line-active)] text-white')} onClick={recommended}
            title="Read-only tools Allowed; anything that creates, changes or spends asks you; money and contact tools stay locked">★ Recommended</button>
          <button type="button" className={btn.small} onClick={allowAll}>Allow all</button>
          <button type="button" className={btn.small} onClick={() => apply(() => 'ask')}>Ask for all</button>
          <button type="button" className={btn.small} onClick={() => apply(() => 'off')}>Off for all</button>
          <span className="ml-auto text-[var(--color-dim)]">{counts.allow} allowed · {counts.ask} ask · {counts.off} off</span>
        </div>
      </div>
      {c.tools.length === 0 ? <p className="item px-4 py-6 text-center text-sm text-[var(--color-muted)]">The app lists no tools.</p> : (
        <ul className="flex max-h-[48vh] flex-col gap-2 overflow-y-auto pr-1">
          {shown.length === 0 && <li className="px-2 py-6 text-center text-sm text-[var(--color-muted)]">No tool matches “{q}”.</li>}
          {shown.map((t) => (
            <li key={t.name} className="item flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 font-mono text-[13px] text-white">
                  {t.locked && <Lock size={12} aria-label={`Locked: ${t.locked}`} />}{t.name}
                  {t.review && <span className="rounded-full bg-[var(--color-primary)] px-2 py-0.5 font-sans text-[11px] text-white">Review</span>}
                  <Badges credits={t.badges.includes('credits')} money={t.badges.includes('money')} contact={t.badges.includes('contact')} />
                </p>
                {t.description && <p className="mt-1 line-clamp-3 text-xs text-[var(--color-muted)]">{t.description}</p>}
              </div>
              <div role="radiogroup" aria-label={`${t.name} permission`} className="flex shrink-0 overflow-hidden rounded-lg border border-[var(--color-line)]">
                {(['allow', 'ask', 'off'] as const).map((p) => {
                  const disabled = p === 'allow' && Boolean(t.locked);
                  return (
                    <button key={p} type="button" role="radio" aria-checked={draft[t.name] === p} disabled={disabled}
                      title={disabled ? (t.locked === 'money' ? 'Can spend money: always asks you' : 'Contacts people: never automatic') : undefined}
                      onClick={() => setDraft((d) => ({ ...d, [t.name]: p }))}
                      className={clsx('min-h-9 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-35',
                        draft[t.name] === p ? (p === 'allow' ? 'bg-[color-mix(in_oklab,var(--color-success)_30%,transparent)] text-white' : p === 'ask' ? 'bg-[var(--color-panel-2)] text-white' : 'bg-[color-mix(in_oklab,var(--color-danger)_22%,transparent)] text-white') : 'text-[var(--color-muted)]')}>
                      {POLICY_LABEL[p]}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-xs text-[var(--color-dim)]">{changed.length ? `${changed.length} to save` : 'No changes'}</span>
        <button type="button" className={btn.ghost} onClick={onClose}>Cancel</button>
        <button type="button" className={btn.primary} onClick={save} disabled={!changed.length}>Save</button>
      </div>
    </Dialog>
  );
}

function AgentsDialog({ c, page, onClose, run }: { c: ConnectorView; page: ConnectorsPage; onClose: () => void; run: Run }) {
  const [agents, setAgents] = useState<string[]>(c.agents);
  return (
    <Dialog open onClose={onClose} title={`Agents: ${c.name}`}>
      <div className="flex flex-col gap-4">
        <AgentChecks page={page} value={agents} onChange={setAgents} />
        <div className="flex justify-end gap-2">
          <button type="button" className={btn.ghost} onClick={onClose}>Cancel</button>
          <button type="button" className={btn.primary} onClick={() => { onClose(); run('Save agents', `Change who can use ${c.name}.`, (totp) => setConnectorAgentsAction({ id: c.id, agents, totp }), 'Agents saved.'); }}>Save</button>
        </div>
      </div>
    </Dialog>
  );
}

export function AppsSection({ page, run, toast, refresh, openToolsFor }: {
  page: ConnectorsPage; run: Run; toast: (t: string, tone?: 'info' | 'success' | 'error') => void; refresh: () => void; openToolsFor: string | null;
}) {
  const apps = page.connectors.filter((c) => c.kind === 'mcp');
  const [connecting, setConnecting] = useState<{ entry: CatalogEntry | null; custom: boolean } | null>(null);
  const [toolsOf, setToolsOf] = useState<string | null>(openToolsFor);
  const [agentsOf, setAgentsOf] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const names = useMemo(() => new Map(page.agents.map((a) => [a.id, a.name])), [page.agents]);
  useEffect(() => { if (openToolsFor) setToolsOf(openToolsFor); }, [openToolsFor]);
  const toolsConn = apps.find((c) => c.id === toolsOf) ?? null;
  const agentsConn = apps.find((c) => c.id === agentsOf) ?? null;

  const sync = async (c: ConnectorView) => {
    setBusy(c.id);
    const r = await syncAppAction({ id: c.id });
    setBusy(null);
    if (!r.ok) toast(r.error, 'error'); else toast(r.message, r.working ? 'success' : 'error');
    refresh();
  };

  return (
    <section className="card flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="apps-title">
      <div>
        <h2 id="apps-title" className="flex items-center gap-2 text-lg font-semibold"><Blocks size={18} aria-hidden /> Apps (MCP)</h2>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">
          Connect an app, then decide tool by tool: <b className="text-white">Allowed</b>, <b className="text-white">Ask me</b> (each use waits in Approvals) or <b className="text-white">Off</b>.
          Read-only tools start Allowed; anything that creates, changes or spends starts at Ask me.
        </p>
      </div>

      {apps.length > 0 && (
        <ul className="flex flex-col gap-3">
          {apps.map((c) => {
            const e = catalogEntry(c.catalog);
            const review = c.tools.filter((t) => t.review).length;
            const on = c.tools.filter((t) => t.policy !== 'off' && !t.review).length;
            return (
              <li key={c.id} className="item flex flex-col gap-2.5 p-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="font-medium">{c.name}</span>
                  <span className={clsx('rounded-full border px-2.5 py-0.5 text-xs', c.status === 'active' ? 'border-[color-mix(in_oklab,var(--color-success)_50%,transparent)] text-[color-mix(in_oklab,var(--color-success)_80%,white)]' : 'border-[color-mix(in_oklab,var(--color-danger)_50%,transparent)] text-[#ffb3b5]')}>
                    {c.status === 'active' ? 'Connected' : c.status === 'needs_reauth' ? 'Sign in again' : c.status === 'disabled' ? 'Off' : 'Error'}
                  </span>
                  {review > 0 && <span className="rounded-full bg-[var(--color-primary)] px-2.5 py-0.5 text-xs text-white">{review} to review</span>}
                  {e && <Badges credits={e.credits} money={e.money} />}
                </div>
                <p className="text-sm text-[var(--color-muted)]" suppressHydrationWarning>
                  {on} of {c.tools.length} tools on · {c.agents.length ? c.agents.map((a) => names.get(a) ?? a).join(', ') : 'no agents yet'}
                  {' · '}{c.last_used_at ? `last used ${relTime(c.last_used_at)}` : 'not used yet'}
                </p>
                {c.last_error && <p className="text-sm text-[#ff8a8d]">{c.last_error}</p>}
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={btn.small} onClick={() => setToolsOf(c.id)}><SlidersHorizontal size={14} aria-hidden /> Tools</button>
                  <button type="button" className={btn.small} onClick={() => setAgentsOf(c.id)}><Users size={14} aria-hidden /> Agents</button>
                  <button type="button" className={btn.small} onClick={() => void sync(c)} disabled={busy === c.id}><RefreshCw size={14} aria-hidden className={clsx(busy === c.id && 'animate-spin')} /> Refresh tools</button>
                  <button type="button" className={btn.danger} onClick={() => {
                    if (!window.confirm(`Disconnect ${c.name}? Agents lose it now. Also revoke HQ's access in the app's own settings.`)) return;
                    run('Disconnect', '', () => deleteConnectorAction({ id: c.id }), 'Disconnected. Revoke HQ in the app too.');
                  }}><Trash2 size={14} aria-hidden /> Disconnect</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Apps you can connect">
        {MCP_CATALOG.map((e) => (
          <li key={e.key}>
            <button type="button" onClick={() => setConnecting({ entry: e, custom: false })}
              className="item flex h-full w-full flex-col gap-1.5 p-4 text-left hover:border-[var(--color-line-active)]">
              <span className="flex w-full items-center justify-between gap-2">
                <span className="font-medium">{e.name}</span>
                <span className="text-[11px] text-[var(--color-dim)]">{e.auth.includes('oauth') ? 'Sign in' : e.auth.includes('token') ? 'Token' : 'Your app'}</span>
              </span>
              <span className="text-xs text-[var(--color-muted)]">{e.blurb}</span>
              <span className="flex flex-wrap gap-1.5"><Badges credits={e.credits} money={e.money} /></span>
            </button>
          </li>
        ))}
        <li>
          <button type="button" onClick={() => setConnecting({ entry: null, custom: true })}
            className="item flex h-full w-full items-center gap-2 p-4 text-left text-sm text-[var(--color-muted)] hover:border-[var(--color-line-active)] hover:text-white">
            <Plus size={16} aria-hidden /> Any other MCP server (URL)
          </button>
        </li>
      </ul>
      <p className="text-xs text-[var(--color-dim)]">Not possible from a self-hosted HQ: Figma, Vercel and Canva only accept approved apps.</p>

      {connecting && page.mode === 'live' && (
        <ConnectDialog entry={connecting.entry} custom={connecting.custom} page={page} onClose={() => setConnecting(null)}
          onConnected={(id) => { setConnecting(null); toast('Connected. Choose what each tool may do.', 'success'); refresh(); setToolsOf(id); }} />
      )}
      {connecting && page.mode === 'demo' && (
        <Dialog open onClose={() => setConnecting(null)} title="Demo mode"><p className="text-sm text-[var(--color-muted)]">Connecting apps needs the live dashboard.</p></Dialog>
      )}
      {toolsConn && <ToolsDialog key={toolsConn.id} c={toolsConn} onClose={() => setToolsOf(null)} run={run} />}
      {agentsConn && <AgentsDialog key={agentsConn.id} c={agentsConn} page={page} onClose={() => setAgentsOf(null)} run={run} />}
    </section>
  );
}
