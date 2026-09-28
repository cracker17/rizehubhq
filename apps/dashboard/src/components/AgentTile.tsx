import { Coffee, Hand, AlertTriangle } from 'lucide-react';
import { IDLE_LABEL, type TileAgent as Agent } from '@/lib/data/derive';
import { STATUS_COLOR, STATUS_LABEL } from '@/lib/status';
import { Avatar } from './Avatar';

export function AgentTile({ agent, onOpen }: { agent: Agent; onOpen: (a: Agent) => void }) {
  const stateText =
    agent.status === 'working' ? agent.verb ?? 'Working'
    : agent.status === 'idle' && agent.idle ? IDLE_LABEL[agent.idle]
    : STATUS_LABEL[agent.status];
  const line =
    agent.status === 'idle' ? 'Available for work'
    : agent.task ?? '';
  return (
    <button onClick={() => onOpen(agent)} aria-label={`${agent.name}: ${stateText}${line ? `, ${line}` : ''}. Open details`} className="item group flex w-full flex-col gap-3 p-4 text-left transition-colors hover:border-[var(--color-line-active)]">
      <div className="flex items-center gap-3">
        <Avatar name={agent.name} color={agent.color} status={agent.status} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium">{agent.name}</p>
          <p className="flex items-center gap-1.5 truncate text-[13px]" style={{ color: STATUS_COLOR[agent.status] }}>
            {agent.status === 'idle' && <Coffee size={13} />}
            {agent.status === 'waiting' && <Hand size={13} />}
            {agent.status === 'blocked' && <AlertTriangle size={13} />}
            {stateText}
          </p>
        </div>
      </div>
      <div className="border-t border-[var(--color-line)] pt-3">
        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-line)]">
          <div className="h-full rounded-full" style={{ width: `${agent.status === 'idle' ? 0 : agent.progress ?? 0}%`, background: STATUS_COLOR[agent.status] }} />
        </div>
        <p className="truncate text-[13px] text-[var(--color-muted)]">{line}</p>
      </div>
    </button>
  );
}
