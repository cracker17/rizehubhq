'use client';
// /operator (docs/17-OPERATOR.md "Operator page"): watch the AI work. The client's real browser on the left (the same
// screen the operator drives; Take over pauses its sends while you use it), the live step-by-step feed on the right,
// then the inbox of client messages with what happened to each, and the chats being watched.
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import {
  Eye, EyeOff, ExternalLink, Maximize2, Minimize2, Hand, Keyboard, MessageSquareText, MonitorPlay, OctagonX, Play, Plus, Send, Sparkles, TriangleAlert, Undo2, UserRound,
} from 'lucide-react';
import { useHq } from '@/lib/data/store';
import { btn, inputCls } from '@/components/clients/ui';
import {
  ago, CHANNEL_KINDS, describeAction, INBOX_STATUS, isOnline, sendState, TONE_CLASS, visibleInbox,
  type ChannelKind, type OperatorActionRow, type OperatorClientRow, type OperatorHomeData, type Tone,
} from '@/lib/operatorView';
import {
  addChannelAction, setChannelEnabledAction, setClientPausedAction, setOperatorPausedAction, setViewerUrlAction, type OperatorResult,
} from '@/app/operator-actions';
import { useOperatorLive, type LiveState } from './useOperatorLive';
import { Pill } from './Pill';
import { OperatorJobs } from './OperatorJobs';
import { OperatorRules } from './OperatorRules';
import { Accounts, ChatPeople, Posting } from './OperatorAccounts';

const KIND_ICON = { read: MessageSquareText, think: Sparkles, type: Keyboard, send: Send, you: UserRound, warn: TriangleAlert } as const;
/** The kill switch: the one red solid button (destructive = red; it only ever stops sends). */
const STOP_BTN = 'inline-flex h-10 items-center justify-center gap-2 rounded-[10px] bg-[var(--color-danger)] px-4 text-sm font-medium text-white shadow-[inset_0_1px_0_rgb(255_255_255/.15)] transition-transform hover:bg-[#f0585d] active:scale-[.97] disabled:opacity-50';
const LIVE_LABEL: Record<LiveState, string> = { demo: 'Demo', connecting: 'Connecting…', live: 'Live', polling: 'Refreshing every 10 s' };

function Dot({ on }: { on: boolean }) {
  const c = on ? '#34d399' : '#6e6a9e';
  return (
    <span className="relative flex h-2 w-2" aria-hidden>
      {on && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-40" style={{ background: c }} />}
      <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: c }} />
    </span>
  );
}

/** The operator touched the browser within the last 40 s: show the "AI is working" overlay. */
function activeStep(actions: OperatorActionRow[], client: string, now: number): OperatorActionRow | null {
  const a = actions.find((x) => x.client_slug === client);
  if (!a || now - new Date(a.created_at).getTime() > 40_000) return null;
  return a.action.startsWith('browser.') || ['message.classified', 'message.new', 'job.progress', 'job.started', 'qa.run', 'action.done', 'send.done', 'update.done', 'action.requested', 'approval.requested', 'update.requested'].includes(a.action) ? a : null;
}

export function OperatorHome({ data, error, scripted = false, liveScreen }: { data: OperatorHomeData; error?: string; scripted?: boolean; liveScreen?: React.ReactNode }) {
  const { toast } = useHq();
  const [pending, start] = useTransition();
  const { actions, live } = useOperatorLive(data.actions, data.demo, !scripted);
  const [clientSlug, setClientSlug] = useState(data.clients[0]?.slug ?? '');
  const client = data.clients.find((c) => c.slug === clientSlug) ?? data.clients[0] ?? null;
  const online = isOnline(data.heartbeatAt);
  const state = sendState(data);
  const inbox = useMemo(() => visibleInbox(data.inbox).filter((r) => !client || r.client_slug === client.slug).slice(0, 25), [data.inbox, client]);
  const channelName = useMemo(() => new Map(data.channels.map((c) => [c.id, c.name])), [data.channels]);
  const waiting = data.inbox.filter((r) => r.status === 'drafted').length;

  const run = (fn: () => Promise<OperatorResult>, done: string) => start(async () => {
    const r = await fn();
    if (!r.ok) toast(r.error, 'error'); else toast(done, 'success');
  });

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 lg:gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Operator</h1>
          <p className="text-sm text-[var(--color-muted)]">Watches your client chats, drafts replies with the project&apos;s memory, and posts only what the rules or you allow.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/operator/setup" className={btn.ghost}><Plus size={16} aria-hidden />Add client</Link>
          {client && <Link href={`/operator/setup?client=${client.slug}&step=check`} className={btn.ghost}>Set up {client.name}</Link>}
          <Pill tone={online ? 'success' : 'muted'}><Dot on={online} />{online ? 'Online' : 'Offline'}</Pill>
          <Pill tone={state.tone}>{state.label}</Pill>
          {waiting > 0 && <Link href="/approvals" className="contents"><Pill tone="warning">{waiting} waiting for you</Pill></Link>}
          {data.killSwitch
            ? <button className={btn.primary} disabled={pending} onClick={() => run(() => setOperatorPausedAction(false), 'Sends resumed')}><Play size={16} aria-hidden />Resume sends</button>
            : <button className={STOP_BTN} disabled={pending}
                onClick={() => run(() => setOperatorPausedAction(true), 'All sends stopped')}><OctagonX size={16} aria-hidden />Stop all sends</button>}
        </div>
      </div>
      <p className="-mt-2 text-xs text-[var(--color-dim)]">{state.detail}{!online && ' The operator process is not running (OPERATOR_ENABLED, or the container is down).'}</p>
      {error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">{error}</p>}

      {data.clients.length > 1 && (
        <div role="tablist" aria-label="Clients" className="flex gap-1 overflow-x-auto">
          {data.clients.map((c) => (
            <button key={c.slug} role="tab" aria-selected={c.slug === client?.slug} onClick={() => setClientSlug(c.slug)}
              className={clsx('h-8 rounded-full px-3 text-[13px]', c.slug === client?.slug ? 'bg-[color-mix(in_oklab,var(--color-primary)_22%,transparent)] text-[#d6ccff]' : 'text-[var(--color-muted)] hover:text-white')}>
              {c.name}{c.paused && ' · paused'}
            </button>
          ))}
        </div>
      )}

      <div className={clsx('grid min-w-0 gap-4 lg:gap-5', scripted ? '2xl:grid-cols-[minmax(0,1fr)_340px]' : 'lg:grid-cols-[minmax(0,1fr)_360px]')}>
        <div className="flex min-w-0 flex-col gap-4 lg:gap-5">
          {client ? <LiveScreen client={client} actions={actions} pending={pending} run={run} demo={data.demo} drawn={liveScreen} />
            : <section className="card p-6 text-sm text-[var(--color-muted)]">No client is set up yet. <Link href="/operator/setup" className="text-[#c4b5ff] hover:underline">Add a client</Link>: a short wizard for its browser, logins, apps and API tokens.</section>}

          {client && <OperatorJobs data={data} client={client} pending={pending} run={run} />}

          <section aria-label="Inbox" className="card min-w-0 p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold">Inbox</h2>
              <Link href="/approvals" className="text-[13px] text-[#c4b5ff] hover:underline">Decide in Approvals</Link>
            </div>
            {inbox.length === 0
              ? <p className="py-6 text-center text-sm text-[var(--color-muted)]">No new client messages yet. The first read of each chat is stored as history; replies start with the next message.</p>
              : (
                <ul className="flex flex-col gap-2">
                  {inbox.map((r) => {
                    const st = INBOX_STATUS[r.status];
                    return (
                      <li key={r.id} className="item px-3.5 py-3" style={{ animation: 'brain-in .3s ease-out' }}>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                          <span className="font-medium">{r.sender_name || 'Someone'}</span>
                          <span className="text-[var(--color-dim)]">in {channelName.get(r.channel_id) ?? r.space_name ?? 'a chat'} · {ago(r.created_at)}</span>
                          <Pill tone={st.tone} className="ml-auto">{st.label}{r.status === 'sent' && r.mode === 'auto' ? ' · auto' : ''}</Pill>
                        </div>
                        <p className="mt-1.5 line-clamp-3 whitespace-pre-line text-[13px] text-[var(--color-ink)]">{r.body}</p>
                        {(r.final_text || r.draft) && r.status !== 'fyi' && (
                          <blockquote className="mt-2 border-l-2 border-[var(--color-line-active)] pl-3 text-[13px] text-[var(--color-muted)]">
                            {r.final_text ?? r.draft}
                          </blockquote>
                        )}
                        {r.error && (r.status === 'failed' || r.status === 'approved') && <p className="mt-1.5 text-xs text-[#ff9a9d]">{r.error}</p>}
                        {r.status === 'drafted' && r.approval_id && (
                          <Link href={`/approvals?id=${r.approval_id}`} className={clsx(btn.small, 'mt-2')}>Review the reply</Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
          </section>
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:gap-5">
          <Feed actions={actions} live={live} client={client?.slug ?? null} />
          <Chats data={data} client={client} pending={pending} run={run} />
          <OperatorRules data={data} client={client} pending={pending} run={run} />
        </div>
      </div>
    </div>
  );
}

function LiveScreen({ client, actions, pending, run, demo, drawn }: {
  client: OperatorClientRow; actions: OperatorActionRow[]; pending: boolean; demo: boolean; drawn?: React.ReactNode;
  run: (fn: () => Promise<OperatorResult>, done: string) => void;
}) {
  const [show, setShow] = useState(true);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(client.viewer_url ?? '');
  const screenRef = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === screenRef.current && !!screenRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) { void document.exitFullscreen().catch(() => undefined); return; }
    void screenRef.current?.requestFullscreen?.().catch(() => undefined);
  };
  const step = activeStep(actions, client.slug, Date.now());
  // Live: through HQ, which signs a short-lived viewer token for you (HQ login + 2FA); the viewer has no password prompt.
  const href = demo || !client.viewer_url ? client.viewer_url : `/api/operator/viewer?client=${encodeURIComponent(client.slug)}`;
  const working = !!step && !client.paused;
  const takeOver = () => {
    if (href) window.open(href, `ws-${client.slug}`, 'noopener');
    run(() => setClientPausedAction(client.slug, true), `You have ${client.name}'s browser: the operator won't post there until you hand it back`);
  };

  return (
    <section aria-label="Live screen" className={clsx('card min-w-0 overflow-hidden p-0 transition-shadow', working && 'shadow-[0_0_0_1px_var(--color-line-active),0_0_40px_rgba(124,92,255,.35)]')}>
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-3">
        <MonitorPlay size={18} className="text-[#c4b5ff]" aria-hidden />
        <h2 className="text-base font-semibold">Live screen · {client.name}</h2>
        {client.paused ? <Pill tone="warning">You have control</Pill> : working ? <Pill tone="brand"><Dot on />AI is working</Pill> : <Pill tone="muted">Idle</Pill>}
        <div className="ml-auto flex flex-wrap gap-2">
          {(drawn || (client.viewer_url && show)) && <button className={btn.small} onClick={toggleFull} aria-pressed={full}>{full ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}{full ? 'Exit full screen' : 'Full screen'}</button>}
          {client.viewer_url && <button className={btn.small} onClick={() => setShow((v) => !v)} aria-pressed={show}>{show ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}{show ? 'Hide' : 'Show'}</button>}
          {href && <a className={btn.small} href={href} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden />New tab</a>}
          {client.paused
            ? <button className={btn.small} disabled={pending} onClick={() => run(() => setClientPausedAction(client.slug, false), 'Handed back to the operator')}><Undo2 size={14} aria-hidden />Hand back</button>
            : <button className={btn.small} disabled={pending} onClick={takeOver}><Hand size={14} aria-hidden />Take over</button>}
        </div>
      </div>

      {drawn ? (
        <div ref={screenRef} className={clsx('relative', full && 'flex items-center justify-center bg-black [&>div:first-child]:max-h-full [&>div:first-child]:w-auto [&>div:first-child]:h-full')}>
          {drawn}
          {working && step && (
            <div className="pointer-events-none absolute right-3 top-10 flex max-w-[70%] items-center gap-2 rounded-xl px-3 py-1.5 text-[12px] glass">
              <Sparkles size={14} className="text-[#c4b5ff]" aria-hidden />
              <span className="truncate">{describeAction(step).text}</span>
            </div>
          )}
        </div>
      ) : client.viewer_url && show ? (
        <div ref={screenRef} className="relative aspect-[16/10] w-full bg-black">
          <iframe title={`${client.name} browser`} src={href ?? undefined} className="absolute inset-0 h-full w-full border-0" allow="clipboard-read; clipboard-write; fullscreen" />
          {working && step && (
            <div className="pointer-events-none absolute bottom-3 left-3 right-3 flex items-center gap-2 rounded-xl px-3 py-2 text-[13px] glass">
              <Sparkles size={15} className="text-[#c4b5ff]" aria-hidden />
              <span className="truncate">{describeAction(step).text}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <MonitorPlay size={34} className="text-[var(--color-dim)]" aria-hidden />
          {client.viewer_url
            ? <p className="text-sm text-[var(--color-muted)]">Live screen hidden.</p>
            : <>
                <p className="max-w-md text-sm text-[var(--color-muted)]">
                  {demo ? 'In the live dashboard the client\'s real browser shows here, and you can watch every click and keystroke.'
                    : 'Add the address of this client\'s browser viewer (deploy/workspace) to watch the AI work here and take over with your own mouse.'}
                </p>
                {!demo && !editing && <button className={btn.small} onClick={() => setEditing(true)}><Plus size={14} aria-hidden />Add live screen address</button>}
              </>}
          {editing && (
            <form className="flex w-full max-w-md flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); run(() => setViewerUrlAction(client.slug, url), 'Live screen saved'); setEditing(false); }}>
              <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://ws.rizehub.ph/" inputMode="url" aria-label="Live screen address" />
              <button className={btn.primary} disabled={pending}>Save</button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}

function Feed({ actions, live, client }: { actions: OperatorActionRow[]; live: LiveState; client: string | null }) {
  const rows = actions.filter((a) => !client || !a.client_slug || a.client_slug === client).slice(0, 40);
  return (
    <section aria-label="Live activity" className="card min-w-0 p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">What it&apos;s doing</h2>
        <span className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]"><Dot on={live === 'live' || live === 'demo'} />{LIVE_LABEL[live]}</span>
      </div>
      {rows.length === 0
        ? <p className="py-6 text-center text-sm text-[var(--color-muted)]">Nothing yet. Steps show up here the moment the operator reads, drafts, types or sends.</p>
        : (
          <ol className="scroll-thin flex max-h-[520px] flex-col gap-1 overflow-y-auto pr-1">
            {rows.map((a) => {
              const d = describeAction(a);
              const Icon = KIND_ICON[d.kind];
              return (
                <li key={a.id} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[var(--color-panel-2)]" style={{ animation: 'brain-in .3s ease-out' }}>
                  <span className={clsx('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full', TONE_CLASS[d.tone])}><Icon size={13} aria-hidden /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] leading-snug">{d.text}</span>
                    <span className="text-[11px] text-[var(--color-dim)]">{a.actor === 'ceo' ? 'You' : 'Operator'} · {ago(a.created_at)}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
    </section>
  );
}

function Chats({ data, client, pending, run }: {
  data: OperatorHomeData; client: OperatorClientRow | null; pending: boolean; run: (fn: () => Promise<OperatorResult>, done: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<ChannelKind>('google_chat');
  const [phoneId, setPhoneId] = useState('');
  const meta = CHANNEL_KINDS.find((k) => k.kind === kind)!;
  const chats = data.channels.filter((c) => !client || c.client_slug === client.slug);
  return (
    <section aria-label="Watched chats" className="card min-w-0 p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">Watched chats</h2>
        {client && !adding && !data.demo && <button className={btn.small} onClick={() => setAdding(true)}><Plus size={14} aria-hidden />Add chat</button>}
      </div>
      {chats.length === 0 && !adding && <p className="py-3 text-sm text-[var(--color-muted)]">No chats yet. Add the Google Chat, Slack or Teams chats and Gmail labels the operator should read.</p>}
      <ul className="flex flex-col gap-2">
        {chats.map((c) => (
          <li key={c.id} className="item flex items-center gap-2 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className={clsx('block truncate text-[13px] font-medium', !c.enabled && 'text-[var(--color-dim)]')}>{c.name}
                {c.kind && c.kind !== 'google_chat' && <span className="ml-1.5 text-[11px] font-normal text-[var(--color-dim)]">{CHANNEL_KINDS.find((k) => k.kind === c.kind)?.label}{c.kind !== 'whatsapp' && ' · read only'}</span>}
                {c.auto_discovered && <span className="ml-1.5 text-[11px] font-normal text-[var(--color-dim)]">· found by the sweep</span>}
              </span>
              <span className={clsx('block truncate text-[11px]', c.last_error ? 'text-[#ff9a9d]' : 'text-[var(--color-dim)]')}>
                {c.last_error ? c.last_error : c.enabled ? `Read ${ago(c.last_polled_at)}` : 'Not watched'}
              </span>
            </span>
            {!data.demo && (
              <button className={btn.small} disabled={pending} onClick={() => run(() => setChannelEnabledAction(c.id, !c.enabled), c.enabled ? `Stopped watching ${c.name}` : `Watching ${c.name}`)}>
                {c.enabled ? 'Stop' : 'Watch'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {client && <ChatPeople data={data} client={client} pending={pending} run={run} />}
      {client && <Accounts data={data} client={client} pending={pending} run={run} />}
      {client && <Posting data={data} client={client} pending={pending} run={run} />}
      {adding && client && (
        <form className="mt-3 flex flex-col gap-2" onSubmit={(e) => {
          e.preventDefault();
          run(async () => { const r = await addChannelAction(client.slug, name, url, kind, phoneId); if (r.ok) { setAdding(false); setName(''); setUrl(''); setPhoneId(''); } return r; }, `Watching ${name}`);
        }}>
          <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as ChannelKind)} aria-label="Kind of chat">
            {CHANNEL_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}{k.sends ? '' : ' (read + draft; you post)'}</option>)}
          </select>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder='Name, e.g. "Alex, Riley"' aria-label="Chat name" />
          <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={meta.placeholder} inputMode={kind === 'whatsapp' ? 'tel' : 'url'} aria-label={kind === 'whatsapp' ? 'Business number' : 'Chat address'} />
          {kind === 'whatsapp' && <input className={inputCls} value={phoneId} onChange={(e) => setPhoneId(e.target.value)} placeholder="Phone number ID (Meta)" inputMode="numeric" aria-label="Phone number ID" />}
          <div className="flex gap-2">
            <button className={btn.primary} disabled={pending}>Watch this chat</button>
            <button type="button" className={btn.ghost} onClick={() => setAdding(false)}>Cancel</button>
          </div>
          <p className="text-xs text-[var(--color-dim)]">{meta.hint} The first read is stored as history; only newer messages get replies.{!meta.sends && ` The operator drafts replies for ${meta.label}; once you approve one, Telegram gives you the exact text to post.`}</p>
        </form>
      )}
    </section>
  );
}
