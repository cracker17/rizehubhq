import type { AgentStatus } from '@rizehubhq/shared';
import { STATUS_COLOR, STATUS_LABEL } from '@/lib/status';

function initials(name: string) {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return (words[0][0] + (words[1]?.[0] ?? '')).toUpperCase();
}

export function Avatar({ name, color, status, size = 44 }: { name: string; color: string; status?: AgentStatus; size?: number }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <span
        className="flex h-full w-full items-center justify-center rounded-full text-[13px] font-semibold text-white"
        style={{ background: `radial-gradient(circle at 30% 25%, ${color}, color-mix(in oklab, ${color} 55%, #0b0a1f))`, boxShadow: `0 0 0 2px color-mix(in oklab, ${color} 40%, transparent)` }}
        aria-hidden
      >
        {initials(name)}
      </span>
      {status && (
        <span
          className="absolute -right-0.5 -bottom-0.5 h-3.5 w-3.5 rounded-full border-2 border-[var(--color-panel-2)]"
          style={{ background: STATUS_COLOR[status] }}
          title={STATUS_LABEL[status]}
        />
      )}
    </span>
  );
}
