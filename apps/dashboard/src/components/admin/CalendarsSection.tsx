'use client';
// Admin → Connectors → Calendars (docs/15 §5b): Google Calendar, read-only, through the calendar's "Secret address in
// iCal format". The address is a credential: typed into a password field, sent once to the worker (tested, sealed), never
// shown again. Agents then answer "what meetings do I have today?" with calendar_read instead of asking the CEO.
import { useState, useTransition } from 'react';
import clsx from 'clsx';
import { CalendarDays, ExternalLink, Plus, Power, RefreshCw, Trash2, Users } from 'lucide-react';
import type { ConnectorView, ConnectorsPage } from '@/lib/data/connectors';
import {
  addCalendarAction, deleteConnectorAction, setConnectorAgentsAction, setConnectorStatusAction, type ConnectorResult,
} from '@/app/connector-actions';
import { Dialog, Field, btn, inputCls, relTime } from '@/components/clients/ui';

type Run = (label: string, detail: string, call: (totp?: string) => Promise<ConnectorResult>, done: string) => void;
const codeInput = `${inputCls} max-w-[200px] text-center font-mono tracking-[0.35em]`;
const DEFAULT_AGENTS = ['coo'];

const STATUS: Record<ConnectorView['status'], { label: string; color: string }> = {
  active: { label: 'Connected', color: 'var(--color-success)' },
  needs_reauth: { label: 'Address stopped working', color: 'var(--color-danger)' },
  error: { label: 'Error', color: 'var(--color-warning)' },
  disabled: { label: 'Off', color: 'var(--color-dim)' },
};

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
      <legend className="mb-1.5 text-[13px] text-[var(--color-muted)]">Agents that may read it</legend>
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

function AddCalendarDialog({ open, onClose, page, onAdded }: {
  open: boolean; onClose: () => void; page: ConnectorsPage; onAdded: (name: string, events: number) => void;
}) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [agents, setAgents] = useState<string[]>(DEFAULT_AGENTS.filter((a) => page.agents.some((x) => x.id === a)));
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const close = () => { setUrl(''); setCode(''); setError(null); onClose(); };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      setError(null);
      const r = await addCalendarAction({ url, name, agents, totp: page.totpOn ? code : null });
      setCode('');
      if (!r.ok) { setError(r.error); return; }
      setUrl(''); setName('');
      onAdded(r.name, r.events);
      close();
    });
  };
  return (
    <Dialog open={open} onClose={close} title="Add a calendar" wide>
      <form onSubmit={submit} className="flex flex-col gap-4" autoComplete="off">
        <ol className="list-decimal space-y-1.5 rounded-xl border border-[var(--color-line)] p-4 pl-8 text-sm text-[var(--color-muted)]">
          <li>Open <a className="text-white underline underline-offset-4" href="https://calendar.google.com/calendar/r/settings" target="_blank" rel="noreferrer">Google Calendar settings<ExternalLink size={12} className="ml-1 inline" aria-hidden /></a> on a computer (the phone app doesn&apos;t show this).</li>
          <li>On the left, under <b className="text-white">Settings for my calendars</b>, click the calendar you want agents to read.</li>
          <li>Click <b className="text-white">Integrate calendar</b>.</li>
          <li>Find <b className="text-white">Secret address in iCal format</b>, click the copy button, and paste it below. It ends in <span className="font-mono">basic.ics</span>.</li>
        </ol>
        <p className="text-xs text-[var(--color-dim)]">
          This address lets anyone who has it read that calendar, so HQ stores it encrypted and never shows it again. Agents can
          only read: they can&apos;t add, change or accept events. To cut access later, click <b>Reset</b> next to the secret address in
          Google Calendar and remove the calendar here.
        </p>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Secret address in iCal format" hint="Not the public address or the embed link." className="sm:col-span-2">
            <input className={`${inputCls} font-mono`} type="password" autoComplete="new-password" spellCheck={false} value={url}
              onChange={(e) => setUrl(e.target.value)} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" required autoFocus
              data-1p-ignore data-lpignore="true" />
          </Field>
          <Field label="Name (optional)" hint="Defaults to the calendar's own name." className="sm:col-span-2">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CEO meetings" maxLength={120} />
          </Field>
        </div>
        <AgentPicker agents={page.agents} value={agents} onChange={setAgents} />
        {page.totpOn && (
          <Field label="2FA code" hint="Adding a calendar gives agents access, so it needs your authenticator code.">
            <input className={codeInput} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required />
          </Field>
        )}
        {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={btn.ghost} onClick={close}>Cancel</button>
          <button className={btn.primary} disabled={pending || !url}>{pending ? 'Reading the calendar…' : 'Connect'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function AgentsDialog({ c, page, onClose, run }: { c: ConnectorView; page: ConnectorsPage; onClose: () => void; run: Run }) {
  const [agents, setAgents] = useState<string[]>(c.agents);
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    onClose();
    run('Save agents', `Change which agents can read ${c.name}.`, (totp) => setConnectorAgentsAction({ id: c.id, agents, totp }), 'Agents saved.');
  };
  return (
    <Dialog open onClose={onClose} title={`Agents: ${c.name}`}>
      <form onSubmit={save} className="flex flex-col gap-4">
        <AgentPicker agents={page.agents} value={agents} onChange={setAgents} />
        <div className="flex justify-end gap-2"><button type="button" className={btn.ghost} onClick={onClose}>Cancel</button><button className={btn.primary}>Save</button></div>
      </form>
    </Dialog>
  );
}

export function CalendarsSection({ page, run, test, busy, toast, refresh }: {
  page: ConnectorsPage; run: Run; test: (c: ConnectorView) => Promise<void>; busy: string | null;
  toast: (m: string, kind?: 'success' | 'error' | 'info') => void; refresh: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ConnectorView | null>(null);
  const names = new Map(page.agents.map((a) => [a.id, a.name]));
  const calendars = page.connectors.filter((c) => c.kind === 'ical');
  return (
    <section className="card flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="calendars-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="calendars-title" className="flex items-center gap-2 text-lg font-semibold"><CalendarDays size={18} aria-hidden /> Calendars</h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">
            Agents read your Google Calendar (meetings, times, Meet/Zoom links, guests) instead of asking you. Read-only: they
            can&apos;t add, move or answer invites.
          </p>
        </div>
        <button type="button" className={btn.primary} onClick={() => setAdding(true)}><Plus size={16} aria-hidden /> Add a calendar</button>
      </div>

      {calendars.length === 0 ? (
        <p className="item px-4 py-6 text-center text-sm text-[var(--color-muted)]">No calendar connected yet. Agents asking about your meetings will say the calendar needs connecting.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {calendars.map((c) => (
            <li key={c.id} className="item flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="min-w-0 break-words font-medium">{c.name}</span>
                <Pill status={c.status} />
                {c.calendar?.calendarName && c.calendar.calendarName !== c.name && <span className="text-sm text-[var(--color-muted)]">{c.calendar.calendarName}</span>}
              </div>
              <p className="text-sm text-[var(--color-muted)]" suppressHydrationWarning>
                {c.agents.length ? `Read by ${c.agents.map((a) => names.get(a) ?? a).join(', ')}` : 'No agent can read it yet'}
                {' · '}{c.last_used_at ? `last read ${relTime(c.last_used_at)}` : 'not read yet'}
                {c.calendar?.timezone ? ` · times in ${c.calendar.timezone}` : ''}
              </p>
              {c.last_error && <p className="text-sm text-[#ff8a8d]">{c.last_error}</p>}
              <div className="flex flex-wrap gap-2">
                <button type="button" className={btn.small} onClick={() => void test(c)} disabled={busy === c.id}><RefreshCw size={14} aria-hidden className={clsx(busy === c.id && 'animate-spin')} /> Test</button>
                <button type="button" className={btn.small} onClick={() => setEditing(c)}><Users size={14} aria-hidden /> Agents</button>
                <button type="button" className={btn.small} onClick={() => run(c.status === 'disabled' ? 'Turn on' : 'Turn off',
                  `${c.status === 'disabled' ? 'Let agents read' : 'Stop agents reading'} ${c.name}.`,
                  (totp) => setConnectorStatusAction({ id: c.id, status: c.status === 'disabled' ? 'active' : 'disabled', totp }),
                  c.status === 'disabled' ? 'Turned on.' : 'Turned off: agents can no longer read it.')}>
                  <Power size={14} aria-hidden /> {c.status === 'disabled' ? 'Turn on' : 'Turn off'}
                </button>
                <button type="button" className={btn.danger} onClick={() => {
                  if (!window.confirm(`Remove ${c.name}? Agents lose access now. To make the old address useless too, click Reset next to the secret address in Google Calendar.`)) return;
                  run('Remove', '', () => deleteConnectorAction({ id: c.id }), 'Removed. Reset the secret address in Google Calendar too.');
                }}><Trash2 size={14} aria-hidden /> Remove</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AddCalendarDialog open={adding} onClose={() => setAdding(false)} page={page}
        onAdded={(name, events) => { toast(`${name} connected: ${events} event(s) read.`, 'success'); refresh(); }} />
      {editing && <AgentsDialog key={editing.id} c={editing} page={page} onClose={() => setEditing(null)} run={run} />}
    </section>
  );
}
