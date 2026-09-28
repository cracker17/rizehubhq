'use client';
import { X, MonitorPlay, MessageSquare, ListChecks, CalendarDays } from 'lucide-react';
import { useState } from 'react';
import clsx from 'clsx';
import type { Agent } from '@/lib/mock';
import { IDLE_LABEL } from '@/lib/mock';
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
  if (a.status === 'blocked') return `I'm stuck: ${a.task}. I need that from you before I can continue.`;
  if (a.status === 'waiting') return `${a.task}. Everything is ready; it's waiting in your Approvals.`;
  return `${a.verb ?? 'Working'} right now: ${a.task}. I'm about ${a.progress}% done and I'll send it to QA as soon as it's finished.`;
}

export function AgentPanel({ agent, onClose }: { agent: Agent | null; onClose: () => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('screen');
  const [asked, setAsked] = useState(false);
  if (!agent) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <aside role="dialog" aria-modal aria-label={`${agent.name} details`} onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-[520px] flex-col border-l border-[var(--color-line)] bg-[var(--color-bg)] p-5 sm:p-6">
        <div className="mb-5 flex items-center gap-3">
          <Avatar name={agent.name} color={agent.color} status={agent.status} size={52} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold">{agent.name}</h2>
            <p className="text-sm" style={{ color: STATUS_COLOR[agent.status] }}>{STATUS_LABEL[agent.status]}{agent.progress && agent.status === 'working' ? ` · ${agent.progress}%` : ''}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-[var(--color-muted)] hover:text-white"><X size={22} /></button>
        </div>
        <div className="mb-4 flex gap-1 rounded-xl bg-[var(--color-panel)] p-1" role="tablist">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={clsx('flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm', tab === id ? 'bg-[var(--color-panel-2)] text-white' : 'text-[var(--color-muted)]')}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto">
          {tab === 'screen' && (
            <div className="item overflow-hidden">
              <div className="flex items-center gap-1.5 border-b border-[var(--color-line)] px-3 py-2">
                <span className="h-2.5 w-2.5 rounded-full bg-[#e5484d]" /><span className="h-2.5 w-2.5 rounded-full bg-[#f5a524]" /><span className="h-2.5 w-2.5 rounded-full bg-[#1f9d6b]" />
                <span className="ml-2 truncate text-xs text-[var(--color-muted)]">{agent.status === 'idle' ? 'Screensaver' : agent.task}</span>
              </div>
              <div className="flex aspect-[16/10] items-center justify-center bg-[#0e0d26] p-6 text-center text-sm text-[var(--color-muted)]">
                {agent.status === 'idle'
                  ? 'RizeHub · screen idle'
                  : 'Live screen (code, browser, doc, leads or review) streams here once the worker is connected (milestone M8).'}
              </div>
            </div>
          )}
          {tab === 'chat' && (
            <div className="flex flex-col gap-3">
              <button onClick={() => setAsked(true)} className="self-end rounded-2xl rounded-br-md bg-[var(--color-primary)] px-4 py-2.5 text-[15px]">What are you doing?</button>
              {asked && <p className="max-w-[90%] rounded-2xl rounded-bl-md bg-[var(--color-panel-2)] px-4 py-2.5 text-[15px]">{demoReply(agent)}</p>}
              {!asked && <p className="text-sm text-[var(--color-dim)]">Tap the question to try it. Live answers come from the agent's real state in M8.</p>}
            </div>
          )}
          {tab === 'task' && <p className="text-[15px] text-[var(--color-muted)]">{agent.task ?? 'No task right now.'}</p>}
          {tab === 'today' && <p className="text-[15px] text-[var(--color-muted)]">Standup and stats appear here in M7.</p>}
        </div>
      </aside>
    </div>
  );
}
