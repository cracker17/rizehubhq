'use client';
import { X, MonitorPlay, MessageSquare, ListChecks, CalendarDays, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { IDLE_LABEL, isToday, timeHM, type TileAgent as Agent } from '@/lib/data/derive';
import { useHq } from '@/lib/data/store';
import { STATUS_COLOR, STATUS_LABEL } from '@/lib/status';
import { Avatar } from './Avatar';

const TABS = [
  { id: 'screen', label: 'Screen', icon: MonitorPlay },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'task', label: 'Task', icon: ListChecks },
  { id: 'today', label: 'Today', icon: CalendarDays },
] as const;

function demoReply(a: Agent) {
  if (a.status === 'idle') return `I'm free right now (${a.idle ? IDLE_LABEL[a.idle].toLowerCase() : 'on a break'}). Send me something through the COO and I'll get on it.`;
  if (a.status === 'blocked') return `I'm stuck: ${a.task ?? 'waiting on something'}. I need that from you before I can continue.`;
  if (a.status === 'waiting') return `${a.task ?? 'My work'} is ready and waiting in your Approvals.`;
  if (a.status === 'offline') return `I'm switched off at the moment.`;
  const step = a.screen?.step_note ? ` Right now: ${a.screen.step_note.toLowerCase()}.` : '';
  return `${a.verb ?? 'Working'} ${a.task ? `"${a.task}"` : 'on my task'}. I'm about ${a.progress ?? 0}% done.${step} I'll send it to QA as soon as it's finished.`;
}

function Screen({ agent }: { agent: Agent }) {
  const s = agent.screen;
  const idle = agent.status === 'idle' || agent.status === 'offline' || !s || s.app === 'idle';
  const code = s?.app === 'editor' || s?.app === 'sheet';
  return (
    <div className="flex flex-col gap-3">
      <div className="item overflow-hidden">
        <div className="flex items-center gap-1.5 border-b border-[var(--color-line)] px-3 py-2">
          <span className="h-2.5 w-2.5 rounded-full bg-[#e5484d]" /><span className="h-2.5 w-2.5 rounded-full bg-[#f5a524]" /><span className="h-2.5 w-2.5 rounded-full bg-[#1f9d6b]" />
          <span className="ml-2 min-w-0 flex-1 truncate text-xs text-[var(--color-muted)]">{idle ? 'Screensaver' : s?.title ?? agent.task ?? s?.app}</span>
          {!idle && s && <span className="shrink-0 rounded bg-[#15133a]/55 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{s.app}</span>}
        </div>
        <div className="aspect-[16/10] overflow-hidden bg-[#0e0d26]">
          {idle ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-primary)] text-lg font-bold">R</span>
              <span className="text-sm text-[var(--color-dim)]">RizeHub · screen idle</span>
            </div>
          ) : s?.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={s.image_url} alt={`${agent.name}'s screen: ${s.title ?? s.app}`} className="h-full w-full object-cover object-top" />
          ) : s?.content ? (
            <pre className={clsx('scroll-thin h-full overflow-auto whitespace-pre-wrap break-words p-4 text-[13px] leading-relaxed', code ? 'font-mono text-[#c9c5f5]' : 'font-sans text-[var(--color-ink)]')}>{s.content}</pre>
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--color-muted)]">{s?.step_note ?? 'Working…'}</div>
          )}
        </div>
      </div>
      {!idle && s && (
        <div className="item p-3.5">
          <div className="mb-2 flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate">{s.step_note ?? 'Working'}</span>
            <span className="shrink-0 tabular-nums text-[var(--color-muted)]">{s.progress ?? 0}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-line)]" role="progressbar" aria-valuenow={s.progress ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label="Progress">
            <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${s.progress ?? 0}%`, background: STATUS_COLOR[agent.status] }} />
          </div>
          <p className="mt-2 text-xs text-[var(--color-dim)]" suppressHydrationWarning>Updated {timeHM(s.updated_at)}</p>
        </div>
      )}
    </div>
  );
}

interface Msg { from: 'ceo' | 'agent'; text: string; demo?: boolean }

function Chat({ agent }: { agent: Agent }) {
  const { ask, session } = useHq();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [waiting, setWaiting] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs.length, waiting]);

  const send = async (q: string) => {
    const question = q.trim();
    if (!question || waiting) return;
    setMsgs((m) => [...m, { from: 'ceo', text: question }]);
    setText('');
    setWaiting(true);
    const res = await ask(agent.id, question);
    setWaiting(false);
    if (!res) return;
    setMsgs((m) => [...m, res.live && res.answer ? { from: 'agent', text: res.answer } : { from: 'agent', text: demoReply(agent), demo: true }]);
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-1 flex-col gap-3">
        {msgs.length === 0 && (
          <button onClick={() => void send('What are you doing?')} className="self-end rounded-2xl rounded-br-md bg-[var(--color-primary)] px-4 py-2.5 text-[15px]">What are you doing?</button>
        )}
        {msgs.map((m, i) => (
          <p key={i} className={clsx('max-w-[90%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[15px]', m.from === 'ceo' ? 'self-end rounded-br-md bg-[var(--color-primary)]' : 'self-start rounded-bl-md bg-[#231f55]/65')}>
            {m.text}
          </p>
        ))}
        {waiting && <p className="self-start rounded-2xl rounded-bl-md bg-[#231f55]/65 px-4 py-2.5 text-[15px] text-[var(--color-muted)]">…</p>}
        {msgs.some((m) => m.demo) && (
          <p className="text-xs text-[var(--color-dim)]">
            {session.chatLive ? 'Demo reply (sign in to the live dashboard to reach the worker).' : 'Demo reply from the agent’s live state. Set HQ_WORKER_URL and HQ_INTERNAL_SECRET for real answers.'}
          </p>
        )}
        <div ref={end} />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); void send(text); }} className="sticky bottom-0 flex gap-2 bg-[var(--color-bg)] pt-1">
        <label htmlFor={`chat-${agent.id}`} className="sr-only">Message {agent.name}</label>
        <input id={`chat-${agent.id}`} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Ask ${agent.name}…`}
          className="h-11 min-w-0 flex-1 rounded-xl border border-[var(--color-line)] bg-[#231f55]/65 px-4 text-[15px] outline-none placeholder:text-[var(--color-dim)] focus:border-[var(--color-line-active)]" />
        <button disabled={!text.trim() || waiting} aria-label="Send" className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-primary)] disabled:opacity-40"><Send size={17} /></button>
      </form>
    </div>
  );
}

function TaskTab({ agent }: { agent: Agent }) {
  const t = agent.currentTask;
  if (!t) return <p className="text-[15px] text-[var(--color-muted)]">{agent.task ?? 'No task right now.'}</p>;
  return (
    <div className="flex flex-col gap-3">
      <div className="item p-4">
        <p className="text-[15px] font-medium">{t.title}</p>
        <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.work_type} · {t.status.replace('_', ' ')}{t.revision_count ? ` · revision ${t.revision_count}` : ''}</p>
        {t.instructions && t.instructions !== t.title && <p className="mt-3 whitespace-pre-wrap text-sm text-[var(--color-muted)]">{t.instructions}</p>}
      </div>
      {t.acceptance_criteria?.length > 0 && (
        <div className="item p-4">
          <p className="mb-2 text-sm font-medium">Acceptance criteria</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-[var(--color-muted)]">{t.acceptance_criteria.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function TodayTab({ agent }: { agent: Agent }) {
  const { snap } = useHq();
  const done = snap.tasks.filter((t) => t.agent_id === agent.id && t.status === 'done' && isToday(t.completed_at ?? t.updated_at));
  const queue = snap.tasks.filter((t) => t.agent_id === agent.id && ['pending', 'queued', 'revision'].includes(t.status));
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="item p-4">
        <p className="mb-2 font-medium">Done today ({done.length})</p>
        {done.length ? <ul className="flex flex-col gap-1 text-[var(--color-muted)]">{done.map((t) => <li key={t.id}>{t.title}</li>)}</ul> : <p className="text-[var(--color-dim)]">Nothing finished yet.</p>}
      </div>
      <div className="item p-4">
        <p className="mb-2 font-medium">Queue ({queue.length})</p>
        {queue.length ? <ul className="flex flex-col gap-1 text-[var(--color-muted)]">{queue.map((t) => <li key={t.id}>{t.title}</li>)}</ul> : <p className="text-[var(--color-dim)]">Queue is empty.</p>}
      </div>
      <p className="text-xs text-[var(--color-dim)]">Standups arrive in M7.</p>
    </div>
  );
}

export function AgentPanel({ agent, onClose }: { agent: Agent | null; onClose: () => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('screen');
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!agent) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [agent, onClose]);
  if (!agent) return null;
  const headline = agent.status === 'working' ? `${agent.verb ?? 'Working'}${agent.task ? ` · ${agent.task}` : ''}` : agent.status === 'idle' && agent.idle ? IDLE_LABEL[agent.idle] : STATUS_LABEL[agent.status];
  return (
    <div className="glass-scrim fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <aside role="dialog" aria-modal aria-label={`${agent.name} details`} onClick={(e) => e.stopPropagation()}
        className="glass flex h-full w-full max-w-[520px] flex-col border-y-0 border-r-0 p-5 sm:p-6">
        <div className="mb-5 flex items-center gap-3">
          <Avatar id={agent.id} name={agent.name} color={agent.color} status={agent.status} size={52} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold">{agent.name}</h2>
            <p className="truncate text-sm" style={{ color: STATUS_COLOR[agent.status] }}>{headline}{agent.progress && agent.status === 'working' ? ` · ${agent.progress}%` : ''}</p>
          </div>
          <button ref={closeRef} onClick={onClose} aria-label="Close" className="text-[var(--color-muted)] hover:text-white"><X size={22} /></button>
        </div>
        <div className="mb-4 flex gap-1 rounded-xl bg-[#15133a]/55 p-1" role="tablist">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={clsx('flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm', tab === id ? 'bg-[#231f55]/65 text-white' : 'text-[var(--color-muted)]')}>
              <Icon size={15} aria-hidden /> {label}
            </button>
          ))}
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto" role="tabpanel">
          {tab === 'screen' && <Screen agent={agent} />}
          {tab === 'chat' && <Chat agent={agent} />}
          {tab === 'task' && <TaskTab agent={agent} />}
          {tab === 'today' && <TodayTab agent={agent} />}
        </div>
      </aside>
    </div>
  );
}
