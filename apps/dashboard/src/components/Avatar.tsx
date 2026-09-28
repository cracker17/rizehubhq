import type { AgentStatus } from '@rizehubhq/shared';
import { STATUS_COLOR, STATUS_LABEL } from '@/lib/status';

function initials(name: string) {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return (words[0][0] + (words[1]?.[0] ?? '')).toUpperCase();
}

/** Painted portraits (Magnific, same art style as the office) for the team and the CEO. */
const PORTRAITS = new Set(['coo', 'web-dev', 'designer', 'writer', 'sales', 'qa-lead', 'ceo']);
const ASSETS = process.env.NEXT_PUBLIC_OFFICE_ASSETS || '/office';
export function portraitUrl(id?: string | null) {
  return id && PORTRAITS.has(id) ? `${ASSETS}/portraits/${id}.webp` : null;
}

export function Avatar({ id, name, color, status, size = 44 }: { id?: string | null; name: string; color: string; status?: AgentStatus; size?: number }) {
  const src = portraitUrl(id);
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <span
        className="flex h-full w-full items-center justify-center overflow-hidden rounded-full text-[13px] font-semibold text-white"
        style={{ background: `radial-gradient(circle at 30% 25%, ${color}, color-mix(in oklab, ${color} 55%, #0b0a1f))`, boxShadow: `0 0 0 2px color-mix(in oklab, ${color} 40%, transparent)` }}
        aria-hidden
      >
        {src
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" className="h-full w-full object-cover" />
          : initials(name)}
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
