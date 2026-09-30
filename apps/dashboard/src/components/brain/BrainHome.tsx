'use client';
// /brain home (docs/16-BRAIN.md "UI" §1, §6, §9, §10): the Core with its HUD, the "Ask the Brain" bar (Ctrl+K), every
// project, the live activity feed, and Devices & accounts.
import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { ChevronRight, Plus, Search, ShieldAlert } from 'lucide-react';
import { btn } from '@/components/clients/ui';
import {
  PLATFORM_COLOR, SOURCE_LABEL, ago, dayAgo, describeEvent, isFeedEvent, platformOf, sourceOf, type BrainEvent,
} from '@/lib/brainView';
import type { BrainHome as HomeData } from '@/lib/data/brain';
import { BrainCore } from './BrainCore';
import { CommandPalette, docHref, usePaletteShortcut } from './CommandPalette';
import { NewProjectDialog } from './NewProjectDialog';
import { DevicesPanel } from './DevicesPanel';
import { useBrainLive, type LiveState } from './useBrainLive';

const SOURCE_COLOR = { claude: '#f0abfc', pc: '#60a5fa', agent: '#fbbf24', julev: '#5eead4', service: '#a09cc9' } as const;

function Light({ label, at, state }: { label: string; at: string | null; state: 'ok' | 'warn' | 'bad' }) {
  const color = state === 'ok' ? '#34d399' : state === 'warn' ? '#fbbf24' : '#f87171';
  return (
    <span className="flex items-center gap-1.5" title={`${label}: ${ago(at)}`}>
      <span className="relative flex h-2 w-2">
        {state === 'ok' && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-40" style={{ background: color }} />}
        <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
      </span>
      <span>{label}</span>
    </span>
  );
}

const fresh = (at: string | null, okMin: number, warnMin: number): 'ok' | 'warn' | 'bad' => {
  if (!at) return 'bad';
  const m = (Date.now() - new Date(at).getTime()) / 60_000;
  return m <= okMin ? 'ok' : m <= warnMin ? 'warn' : 'bad';
};

const LIVE_LABEL: Record<LiveState, string> = { demo: 'Demo', connecting: 'Connecting…', live: 'Live', polling: 'Refreshing every 15 s' };

export function BrainHome({ data, error }: { data: HomeData; error?: string }) {
  const router = useRouter();
  const [palette, setPalette] = useState(false);
  const [creating, setCreating] = useState(false);
  const devicesRef = useRef<HTMLElement>(null);
  const { events, live } = useBrainLive(data.events, data.projects, data.demo);
  const openPalette = useCallback(() => setPalette(true), []);
  usePaletteShortcut(openPalette);

  const h = data.health;
  const projects = useMemo(() => data.projects.filter((p) => p.listed)
    .sort((a, b) => (b.last_activity ?? '').localeCompare(a.last_activity ?? '') || a.name.localeCompare(b.name)), [data.projects]);
  const feed = events.filter(isFeedEvent).slice(0, 40);
  const weekAgo = Date.now() - 7 * 86400_000;
  const savesWeek = events.filter((e) => (e.action === 'saved' || e.action === 'doc_added' || e.action === 'doc_changed') && new Date(e.ts).getTime() > weekAgo).length;
  const blocked = [...new Set(events.filter((e) => e.action === 'blocked_secret').map((e) => e.path))].filter(Boolean);
  const embedded = h && h.chunks ? Math.round((100 * h.embedded) / h.chunks) : 0;
  const statusState = !h ? 'bad' : h.status === 'error' ? 'bad' : h.status === 'ok' ? 'ok' : 'warn';

  return (
    <div className="flex flex-col gap-4 lg:gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Brain</h1>
          <p className="text-sm text-[var(--color-muted)]">Your long-term memory, shared by every Claude app and the HQ agents.</p>
        </div>
        <div className="flex gap-2">
          <button className={btn.ghost} onClick={openPalette}><Search size={16} aria-hidden />Search<kbd className="ml-1 hidden rounded border border-[var(--color-line)] px-1 text-[10px] text-[var(--color-dim)] sm:inline">Ctrl K</kbd></button>
          <button className={btn.primary} onClick={() => setCreating(true)}><Plus size={16} aria-hidden />New project</button>
        </div>
      </div>
      {error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">{error}</p>}

      <section aria-label="Brain core" className="card relative overflow-hidden p-0" style={{ background: 'radial-gradient(120% 90% at 50% 45%, #0f1a3a 0%, #0b0a1f 55%, #07061a 100%)' }}>
        <BrainCore projects={projects} events={events} onOpen={(s) => router.push(`/brain/${s}`)} className="h-[400px] sm:h-[460px]" />
        <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
          <dl className="grid grid-cols-2 gap-x-5 gap-y-2 font-mono text-[11px] uppercase tracking-wider text-[var(--color-dim)] sm:grid-cols-4">
            {[['Projects', projects.length], ['Files', h?.documents ?? 0], ['Saves · 7d', savesWeek], ['Semantic', `${embedded}%`]].map(([k, v]) => (
              <div key={k}><dt>{k}</dt><dd className="text-lg font-semibold normal-case tracking-normal text-[#e6fffa] [text-shadow:0_0_12px_rgba(94,234,212,0.5)]">{v}</dd></div>
            ))}
          </dl>
          <div className="flex flex-col items-end gap-1.5 font-mono text-[11px] text-[var(--color-muted)]">
            <span className="flex gap-3">
              <Light label="PC" at={h?.last_webhook_at ?? null} state={fresh(h?.last_webhook_at ?? null, 24 * 60, 72 * 60)} />
              <Light label="GitHub" at={h?.last_pull_at ?? null} state={fresh(h?.last_pull_at ?? null, 15, 120)} />
              <Light label="VPS" at={h?.last_index_at ?? null} state={statusState === 'ok' ? fresh(h?.last_index_at ?? null, 24 * 60, 72 * 60) : statusState} />
            </span>
            <span className={clsx(live === 'live' ? 'text-[#5eead4]' : 'text-[var(--color-dim)]')}>{LIVE_LABEL[live]}</span>
          </div>
        </div>
        <div className="absolute inset-x-0 bottom-0 flex justify-center p-4">
          <button onClick={openPalette} className="glass flex h-11 w-full max-w-lg items-center gap-3 rounded-full px-4 text-left text-sm text-[var(--color-muted)] shadow-[0_0_40px_-12px_rgba(94,234,212,0.6)] hover:text-white">
            <Search size={16} className="text-[#5eead4]" aria-hidden />
            <span className="flex-1 truncate">Ask the Brain: a project, a decision, a URL…</span>
            <kbd className="hidden rounded border border-[var(--color-line)] px-1.5 text-[10px] text-[var(--color-dim)] sm:inline">Ctrl K</kbd>
          </button>
        </div>
      </section>

      {blocked.length > 0 && (
        <p className="item flex items-start gap-3 px-4 py-3 text-sm">
          <ShieldAlert size={17} className="mt-0.5 shrink-0 text-[#fbbf24]" aria-hidden />
          <span className="min-w-0">
            <strong>{blocked.length} file{blocked.length > 1 ? 's' : ''} kept out</strong> because they look like they contain a secret:{' '}
            <span className="break-all font-mono text-xs text-[var(--color-muted)]">{blocked.slice(0, 3).join(', ')}</span>. Remove the secret on the PC (keep only where it is stored) and the next sync picks them up.
          </span>
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-5">
        <section aria-labelledby="brain-projects" className="card p-4 sm:p-5">
          <h2 id="brain-projects" className="mb-3 font-semibold">Projects</h2>
          {!projects.length && <p className="text-sm text-[var(--color-muted)]">Nothing indexed yet.</p>}
          <ul className="grid gap-2 sm:grid-cols-2">
            {projects.map((p) => (
              <li key={p.slug}>
                <Link href={`/brain/${p.slug}`} className="item group flex h-full items-start gap-3 px-3.5 py-3 hover:border-[var(--color-line-active)]">
                  <span aria-hidden className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PLATFORM_COLOR[platformOf(p)], boxShadow: `0 0 10px ${PLATFORM_COLOR[platformOf(p)]}` }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{p.name}</span>
                    {p.status && <span className="line-clamp-2 text-xs text-[var(--color-muted)]">{p.status.split('\n')[0]!.replace(/^[-*]\s*/, '')}</span>}
                    <span className="mt-1 block text-[11px] text-[var(--color-dim)]">{p.last_activity ? `active ${dayAgo(p.last_activity)}` : 'no activity'} · {p.sessions} sessions · {p.open_next_steps} open</span>
                  </span>
                  <ChevronRight size={16} className="mt-1 shrink-0 text-[var(--color-dim)] group-hover:text-white" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="brain-activity" className="card p-4 sm:p-5">
          <h2 id="brain-activity" className="mb-3 font-semibold">Activity</h2>
          <ActivityList events={feed} />
        </section>
      </div>

      <section ref={devicesRef} id="devices" aria-labelledby="brain-devices" className="card scroll-mt-4 p-4 sm:p-5">
        <h2 id="brain-devices" className="mb-3 font-semibold">Devices &amp; accounts</h2>
        <DevicesPanel connections={data.connections} health={h} demo={data.demo} />
      </section>

      <CommandPalette open={palette} onClose={() => setPalette(false)} projects={data.projects}
        onNewProject={() => setCreating(true)} onDevices={() => devicesRef.current?.scrollIntoView({ behavior: 'smooth' })} />
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} projects={data.projects} />
    </div>
  );
}

export function ActivityList({ events }: { events: BrainEvent[] }) {
  if (!events.length) return <p className="text-sm text-[var(--color-muted)]">No activity yet.</p>;
  return (
    <ol className="scroll-thin flex max-h-[34rem] flex-col gap-0.5 overflow-y-auto pr-1">
      {events.map((e) => {
        const src = sourceOf(e.actor);
        const body = (
          <>
            <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: SOURCE_COLOR[src] }} />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] leading-snug">{describeEvent(e)}</span>
              <span className="block text-[11px] text-[var(--color-dim)]">{SOURCE_LABEL[src]}{e.project_slug ? ` · ${e.project_slug}` : ''} · {ago(e.ts)}</span>
            </span>
          </>
        );
        return (
          <li key={e.id} className="animate-[brain-in_.45s_ease-out]">
            {e.path && e.path.endsWith('.md') && e.action !== 'doc_removed' && e.action !== 'blocked_secret'
              ? <Link href={docHref(e.path)} className="flex gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[var(--color-panel-2)]">{body}</Link>
              : <div className="flex gap-2.5 px-2 py-1.5">{body}</div>}
          </li>
        );
      })}
    </ol>
  );
}
