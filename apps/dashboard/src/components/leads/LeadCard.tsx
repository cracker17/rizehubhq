import { ExternalLink, Gauge, Globe2, MapPin } from 'lucide-react';
import { PLATFORM_COLOR, PLATFORM_LABEL, domainOf, fitTone, relTime, safeHref, type LeadCard as Lead } from '@/lib/data/rizehubView';

export function PlatformChip({ platform }: { platform: string | null }) {
  if (!platform) return null;
  const color = PLATFORM_COLOR[platform] ?? PLATFORM_COLOR.other;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ background: `color-mix(in oklab, ${color} 18%, transparent)`, color: `color-mix(in oklab, ${color} 55%, white)` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} aria-hidden />
      {PLATFORM_LABEL[platform] ?? platform}
    </span>
  );
}

export function FitBadge({ fit, score }: { fit: number | null; score: number | null }) {
  if (fit === null) {
    return score === null ? null : (
      <span className="shrink-0 rounded-md border border-[var(--color-line)] px-1.5 py-0.5 text-[11px] tabular-nums text-[var(--color-muted)]" title="Lead Finder score (not researched yet)">LF {score}</span>
    );
  }
  const c = fitTone(fit);
  return (
    <span className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums" title={`Fit score ${fit}/100${score !== null ? ` · Lead Finder ${score}` : ''}`}
      style={{ background: `color-mix(in oklab, ${c} 20%, transparent)`, color: `color-mix(in oklab, ${c} 60%, white)` }}>
      Fit {fit}
    </span>
  );
}

export function LeadCardView({ lead, now }: { lead: Lead; now: Date }) {
  const site = safeHref(lead.website);
  const app = safeHref(lead.appUrl);
  const place = [lead.city, lead.country].filter(Boolean).join(', ');
  return (
    <article className="item flex flex-col gap-2 p-3" aria-label={lead.company}>
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-[14px] font-semibold leading-snug">{lead.company}</h3>
        <FitBadge fit={lead.fitScore} score={lead.score} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <PlatformChip platform={lead.platform} />
        {site && (
          <a href={site} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-w-0 items-center gap-1 text-[12px] text-[var(--color-muted)] hover:text-white">
            <Globe2 size={12} aria-hidden /><span className="truncate">{domainOf(site)}</span>
          </a>
        )}
      </div>
      {lead.signal && (
        <p className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-lg bg-[color-mix(in_oklab,var(--color-warning)_14%,transparent)] px-2 py-1 text-[12px] font-medium text-[#ffc861]">
          <Gauge size={13} aria-hidden className="shrink-0" /><span className="truncate">{lead.signal}</span>
        </p>
      )}
      {lead.angle && <p className="line-clamp-2 text-[12.5px] leading-snug text-[var(--color-muted)]" title={lead.angle}>{lead.angle}</p>}
      {(lead.stage === 'won' || lead.stage === 'lost') && (
        <span className="w-fit rounded-full px-2 py-0.5 text-[11px] font-medium" style={{
          background: `color-mix(in oklab, ${lead.stage === 'won' ? 'var(--color-success)' : 'var(--color-danger)'} 18%, transparent)`,
          color: lead.stage === 'won' ? '#5fe0a8' : '#ff8a8d',
        }}>{lead.stage === 'won' ? 'Won' : 'Lost'}</span>
      )}
      <div className="mt-0.5 flex items-center gap-2 border-t border-[var(--color-line)] pt-2 text-[11.5px] text-[var(--color-dim)]">
        {place && <span className="inline-flex min-w-0 items-center gap-1"><MapPin size={11} aria-hidden className="shrink-0" /><span className="truncate">{place}</span></span>}
        <span className="ml-auto shrink-0" suppressHydrationWarning>{relTime(lead.updatedAt, now)}</span>
        {app && (
          <a href={app} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[var(--color-muted)] hover:text-white" aria-label={`Open ${lead.company} in RizeHub Lead Finder`} title="Open in RizeHub Lead Finder">
            <ExternalLink size={13} />
          </a>
        )}
      </div>
    </article>
  );
}
