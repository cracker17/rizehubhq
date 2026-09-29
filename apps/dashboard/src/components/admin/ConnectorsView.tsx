'use client';
// Admin → Connectors (docs/15, docs/06 §11): Gmail accounts now; MCP apps (sign-in wizard) next.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { Mail, Plus, RefreshCw, KeyRound, Pencil, Power, Trash2, ExternalLink, Blocks } from 'lucide-react';
import type { ConnectorView, ConnectorsPage, GmailMode } from '@/lib/data/connectors';
import {
  addGmailAction, deleteConnectorAction, replaceGmailPasswordAction, setConnectorAgentsAction, setConnectorStatusAction,
  testConnectorAction, updateConnectorAction, type ConnectorResult,
} from '@/app/connector-actions';
import { Dialog, Field, btn, inputCls, relTime } from '@/components/clients/ui';
import { StepUpDialog, type StepUpRequest } from '@/components/StepUpDialog';
import { useHq } from '@/lib/data/store';

const STATUS: Record<ConnectorView['status'], { label: string; color: string }> = {
  active: { label: 'Connected', color: 'var(--color-success)' },
  needs_reauth: { label: 'Needs a new App Password', color: 'var(--color-danger)' },
  error: { label: 'Error', color: 'var(--color-warning)' },
  disabled: { label: 'Off', color: 'var(--color-dim)' },
};
const MODE_LABEL: Record<GmailMode, string> = { read: 'Read only', read_draft: 'Read + save drafts', read_draft_send: 'Read + drafts + send (asks you)' };
const MODE_HELP: Record<GmailMode, string> = {
  read: 'Search and read mail. Nothing is marked as read.',
  read_draft: 'Also save replies in your Drafts folder for you to review and send.',
  read_draft_send: 'Agents may also ask to send. Every email appears in your Approvals, word for word, and is sent only after you approve it.',
};
const DEFAULT_AGENTS = ['coo', 'sales'];

function Pill({ status }: { status: ConnectorView['status'] }) {
  const s = STATUS[status];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs"
      style={{ color: `color-mix(in oklab, ${s.color} 80%, white)`, borderColor: `color-mix(in oklab, ${s.color} 50%, transparent)` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} aria-hidden />{s.label}
    </span>
  );
}

function AgentPicker({ agents, value, onChange }: { agents: ConnectorsPage['agents']; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-[13px] text-[var(--color-muted)]">Agents that may use it</legend>
      <div className="flex flex-wrap gap-2">
        {agents.map((a) => {
          const on = value.includes(a.id);
          return (
            <label key={a.id} className={clsx('flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm',
              on ? 'border-[var(--color-line-active)] bg-[var(--color-panel-2)] text-white' : 'border-[var(--color-line)] text-[var(--color-muted)]')}>
              <input type="checkbox" className="accent-[var(--color-primary)]" checked={on}
                onChange={() => onChange(on ? value.filter((x) => x !== a.id) : [...value, a.id])} />
              {a.name}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function ModePicker({ value, onChange }: { value: GmailMode; onChange: (m: GmailMode) => void }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-[13px] text-[var(--color-muted)]">What agents may do</legend>
      {(['read', 'read_draft', 'read_draft_send'] as const).map((m) => (
        <label key={m} className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-[var(--color-line)] p-3 text-sm has-[:checked]:border-[var(--color-line-active)]">
          <input type="radio" name="gmail-mode" className="mt-0.5 accent-[var(--color-primary)]" checked={value === m} onChange={() => onChange(m)} />
          <span>
            <span className="block text-white">{MODE_LABEL[m]}</span>
            <span className="text-xs text-[var(--color-muted)]">{MODE_HELP[m]}</span>
          </span>
        </label>
      ))}
      <p className="text-xs text-[var(--color-dim)]">No email is ever sent without your approval of that exact email.</p>
    </fieldset>
  );
}

const codeInput = `${inputCls} max-w-[200px] text-center font-mono tracking-[0.35em]`;

function AddGmailDialog({ open, onClose, page, onAdded }: { open: boolean; onClose: () => void; page: ConnectorsPage; onAdded: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [name, setName] = useState('');
  const [agents, setAgents] = useState<string[]>(DEFAULT_AGENTS.filter((a) => page.agents.some((x) => x.id === a)));
  const [mode, setMode] = useState<GmailMode>('read');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const close = () => { setPass(''); setCode(''); setError(null); onClose(); };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      setError(null);
      const r = await addGmailAction({ email, appPassword: pass, name, agents, mode, totp: page.totpOn ? code : null });
      setCode('');
      if (!r.ok) { setError(r.error); return; }
      setPass(''); setEmail(''); setName('');
      onAdded(email.trim().toLowerCase());
      close();
    });
  };
  return (
    <Dialog open={open} onClose={close} title="Add a Gmail account" wide>
      <form onSubmit={submit} className="flex flex-col gap-4" autoComplete="off">
        <ol className="list-decimal space-y-1.5 rounded-xl border border-[var(--color-line)] p-4 pl-8 text-sm text-[var(--color-muted)]">
          <li>Turn on <a className="text-white underline underline-offset-4" href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noreferrer">2-Step Verification<ExternalLink size={12} className="ml-1 inline" aria-hidden /></a> for that Google account.</li>
          <li>Create an <a className="text-white underline underline-offset-4" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">App Password<ExternalLink size={12} className="ml-1 inline" aria-hidden /></a> named &ldquo;RizeHub HQ&rdquo;.</li>
          <li>Paste the 16-letter code below. HQ tests it with Google before saving it (encrypted).</li>
        </ol>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Gmail address">
            <input className={inputCls} type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com" required autoFocus />
          </Field>
          <Field label="App Password" hint="16 letters. Not your normal Gmail password.">
            <input className={`${inputCls} font-mono`} type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)}
              placeholder="abcd efgh ijkl mnop" required data-1p-ignore data-lpignore="true" />
          </Field>
          <Field label="Label (optional)" className="sm:col-span-2">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Job alerts inbox" maxLength={120} />
          </Field>
        </div>
        <AgentPicker agents={page.agents} value={agents} onChange={setAgents} />
        <ModePicker value={mode} onChange={setMode} />
        {page.totpOn && (
          <Field label="2FA code" hint="Adding a mailbox gives agents access, so it needs your authenticator code.">
            <input className={codeInput} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required />
          </Field>
        )}
        {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={btn.ghost} onClick={close}>Cancel</button>
          <button className={btn.primary} disabled={pending || !email || !pass}>{pending ? 'Testing with Google…' : 'Connect'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function EditDialog({ c, page, onClose, run }: {
  c: ConnectorView | null; page: ConnectorsPage; onClose: () => void;
  run: (label: string, detail: string, call: (totp?: string) => Promise<ConnectorResult>, done: string) => void;
}) {
  const [agents, setAgents] = useState<string[]>(c?.agents ?? []);
  const [mode, setMode] = useState<GmailMode>(c?.mode ?? 'read');
  const [name, setName] = useState(c?.name ?? '');
  if (!c) return null;
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    onClose();
    run('Save access', `Change who can use ${c.account_email} and what they may do.`, async (totp) => {
      const a = await setConnectorAgentsAction({ id: c.id, agents, totp });
      if (!a.ok) return a;
      return updateConnectorAction({ id: c.id, name, mode, totp });
    }, 'Access saved.');
  };
  return (
    <Dialog open onClose={onClose} title={`Access: ${c.account_email}`} wide>
      <form onSubmit={save} className="flex flex-col gap-4">
        <Field label="Label"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        <AgentPicker agents={page.agents} value={agents} onChange={setAgents} />
        <ModePicker value={mode} onChange={setMode} />
        <div className="flex justify-end gap-2"><button type="button" className={btn.ghost} onClick={onClose}>Cancel</button><button className={btn.primary}>Save</button></div>
      </form>
    </Dialog>
  );
}

function ReplaceDialog({ c, onClose, run }: {
  c: ConnectorView | null; onClose: () => void;
  run: (label: string, detail: string, call: (totp?: string) => Promise<ConnectorResult>, done: string) => void;
}) {
  const [pass, setPass] = useState('');
  if (!c) return null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = pass;
    setPass('');
    onClose();
    run('Replace App Password', `Store a new App Password for ${c.account_email}.`, (totp) => replaceGmailPasswordAction({ id: c.id, appPassword: p, totp }), 'App Password replaced and tested.');
  };
  return (
    <Dialog open onClose={onClose} title="Replace App Password">
      <form onSubmit={submit} className="flex flex-col gap-3.5" autoComplete="off">
        <p className="text-sm text-[var(--color-muted)]">Create a new App Password for <b className="text-white">{c.account_email}</b> at{' '}
          <a className="text-white underline underline-offset-4" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords</a>, then paste it here.</p>
        <Field label="New App Password">
          <input className={`${inputCls} font-mono`} type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} required autoFocus data-1p-ignore data-lpignore="true" />
        </Field>
        <div className="flex justify-end gap-2"><button type="button" className={btn.ghost} onClick={onClose}>Cancel</button><button className={btn.primary} disabled={!pass}>Test and save</button></div>
      </form>
    </Dialog>
  );
}

export function ConnectorsView({ page }: { page: ConnectorsPage }) {
  const router = useRouter();
  const { toast } = useHq();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ConnectorView | null>(null);
  const [replacing, setReplacing] = useState<ConnectorView | null>(null);
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const names = new Map(page.agents.map((a) => [a.id, a.name]));
  const gmail = page.connectors.filter((c) => c.kind === 'gmail');

  // Runs an action; when it needs a fresh 2FA code, asks for it and retries with the code.
  const run = (label: string, detail: string, call: (totp?: string) => Promise<ConnectorResult>, done: string) => {
    void (async () => {
      const r = await call(undefined);
      if (r.ok) { toast(done, 'success'); router.refresh(); return; }
      if (!r.stepUp) { toast(r.error, 'error'); return; }
      setStepUp({
        title: 'Confirm with 2FA', detail: `${detail} Enter your authenticator code to confirm.`,
        submit: async (code) => {
          const again = await call(code);
          if (!again.ok) return again.error;
          setStepUp(null); toast(done, 'success'); router.refresh();
          return null;
        },
        cancel: () => { setStepUp(null); toast(`${label}: not saved without your 2FA code.`, 'info'); },
      });
    })();
  };

  const test = async (c: ConnectorView) => {
    setBusy(c.id);
    const r = await testConnectorAction({ id: c.id });
    setBusy(null);
    if (!r.ok) toast(r.error, 'error'); else toast(r.message, r.working ? 'success' : 'error');
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-4 lg:gap-5">
      {page.error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">Couldn&apos;t load everything: {page.error}</p>}
      {page.mode === 'demo' && <p className="item px-4 py-3 text-sm text-[var(--color-muted)]">Demo mode: sample data. Connecting accounts needs the live dashboard.</p>}

      <section className="card flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="gmail-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="gmail-title" className="flex items-center gap-2 text-lg font-semibold"><Mail size={18} aria-hidden /> Gmail accounts</h2>
            <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">
              Agents can search and read the accounts you give them (job alerts, lead replies, client mail). If you allow it they
              save draft replies, or ask to send: each email waits in your Approvals and goes out only after you approve it.
            </p>
          </div>
          <button type="button" className={btn.primary} onClick={() => setAdding(true)}><Plus size={16} aria-hidden /> Add Gmail account</button>
        </div>

        {gmail.length === 0 ? (
          <p className="item px-4 py-6 text-center text-sm text-[var(--color-muted)]">No Gmail account connected yet. Agents asking for inbox access will be blocked until you add one.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {gmail.map((c) => (
              <li key={c.id} className="item flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="min-w-0 break-all font-medium">{c.account_email}</span>
                  <Pill status={c.status} />
                  <span className="rounded-full border border-[var(--color-line)] px-2.5 py-0.5 text-xs text-[var(--color-muted)]">{MODE_LABEL[c.mode]}</span>
                  {c.name !== c.account_email && <span className="text-sm text-[var(--color-muted)]">{c.name}</span>}
                </div>
                <p className="text-sm text-[var(--color-muted)]" suppressHydrationWarning>
                  {c.agents.length ? `Used by ${c.agents.map((a) => names.get(a) ?? a).join(', ')}` : 'No agent can use it yet'}
                  {' · '}{c.last_used_at ? `last used ${relTime(c.last_used_at)}` : 'not used yet'}
                </p>
                {c.last_error && <p className="text-sm text-[#ff8a8d]">{c.last_error}</p>}
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={btn.small} onClick={() => void test(c)} disabled={busy === c.id}><RefreshCw size={14} aria-hidden className={clsx(busy === c.id && 'animate-spin')} /> Test</button>
                  <button type="button" className={btn.small} onClick={() => setEditing(c)}><Pencil size={14} aria-hidden /> Access</button>
                  <button type="button" className={btn.small} onClick={() => setReplacing(c)}><KeyRound size={14} aria-hidden /> Replace password</button>
                  <button type="button" className={btn.small} onClick={() => run(c.status === 'disabled' ? 'Turn on' : 'Turn off',
                    `${c.status === 'disabled' ? 'Let agents use' : 'Stop agents using'} ${c.account_email}.`,
                    (totp) => setConnectorStatusAction({ id: c.id, status: c.status === 'disabled' ? 'active' : 'disabled', totp }),
                    c.status === 'disabled' ? 'Turned on.' : 'Turned off: agents can no longer use it.')}>
                    <Power size={14} aria-hidden /> {c.status === 'disabled' ? 'Turn on' : 'Turn off'}
                  </button>
                  <button type="button" className={btn.danger} onClick={() => {
                    if (!window.confirm(`Remove ${c.account_email}? Agents lose access now. Also revoke the App Password in your Google account.`)) return;
                    run('Remove', '', () => deleteConnectorAction({ id: c.id }), 'Removed. Revoke the App Password in Google too.');
                  }}><Trash2 size={14} aria-hidden /> Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card flex flex-col gap-2 p-5 sm:p-6" aria-labelledby="mcp-title">
        <h2 id="mcp-title" className="flex items-center gap-2 text-lg font-semibold"><Blocks size={18} aria-hidden /> Apps (MCP)</h2>
        <p className="max-w-2xl text-sm text-[var(--color-muted)]">
          Coming in the next update: sign in to Notion, Linear, Supabase, Magnific, Higgsfield and ElevenLabs, or paste a GitHub
          token, then choose per tool what agents may do on their own and what asks you first (docs/15).
        </p>
      </section>

      <AddGmailDialog open={adding} onClose={() => setAdding(false)} page={page} onAdded={(email) => { toast(`${email} connected and tested.`, 'success'); router.refresh(); }} />
      {editing && <EditDialog key={editing.id} c={editing} page={page} onClose={() => setEditing(null)} run={run} />}
      {replacing && <ReplaceDialog key={replacing.id} c={replacing} onClose={() => setReplacing(null)} run={run} />}
      <StepUpDialog request={stepUp} />
    </div>
  );
}
