'use client';
// /brain/[slug] (docs/16-BRAIN.md "UI" §3): status header + link chips, then Memory · Decisions · Next steps · Sessions
// · Files · Activity. Next steps and decisions save straight into the vault (one commit each, as "julev").
import { useCallback, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { ArrowDown, ArrowLeft, ArrowUp, ExternalLink, FileText, Plus, Search, Trash2 } from 'lucide-react';
import { btn, inputCls } from '@/components/clients/ui';
import { useHq } from '@/lib/data/store';
import { addDecisionAction, saveNextStepsAction } from '@/app/brain-actions';
import { PLATFORM_COLOR, PLATFORM_LABEL, platformOf, type BrainBundle, type BrainEvent } from '@/lib/brainView';
import { Markdown } from './Markdown';
import { ActivityList } from './BrainHome';
import { CommandPalette, docHref, usePaletteShortcut } from './CommandPalette';
import { useBrainLive } from './useBrainLive';

const TABS = ['Memory', 'Decisions', 'Next steps', 'Sessions', 'Files', 'Activity'] as const;
type Tab = (typeof TABS)[number];

function linkChips(links: BrainBundle['project']['links']): Array<{ label: string; url: string }> {
  return (links ?? []).flatMap((l) => {
    const text = typeof l === 'string' ? l : `${l.label ?? ''}: ${l.url ?? ''}`;
    const m = /^(?:([^:]{1,40}):\s*)?(https?:\/\/\S+)/.exec(text.replace(/^[-*]\s*/, '').trim());
    if (!m) return [];
    const url = m[2]!.replace(/[.,;)]+$/, '');
    let host = url;
    try { host = new URL(url).host; } catch { return []; }
    return [{ label: m[1]?.trim() || host, url }];
  }).slice(0, 8);
}

export function ProjectView({ bundle, events: initialEvents, demo, error }: { bundle: BrainBundle; events: BrainEvent[]; demo: boolean; error?: string }) {
  const [tab, setTab] = useState<Tab>('Memory');
  const [palette, setPalette] = useState(false);
  const { events } = useBrainLive(initialEvents, [bundle.project], demo);
  const openPalette = useCallback(() => setPalette(true), []);
  usePaletteShortcut(openPalette);
  const p = bundle.project;
  const platform = platformOf(p);
  const chips = linkChips(p.links);
  const projectEvents = events.filter((e) => e.project_slug === p.slug && e.action !== 'tool_call');

  return (
    <div className="flex flex-col gap-4 lg:gap-5">
      <div className="flex flex-col gap-3">
        <Link href="/brain" className="inline-flex w-fit items-center gap-1.5 text-sm text-[var(--color-muted)] hover:text-white"><ArrowLeft size={15} aria-hidden />Brain</Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2.5 text-2xl font-semibold">
              <span aria-hidden className="h-3 w-3 shrink-0 rounded-full" style={{ background: PLATFORM_COLOR[platform], boxShadow: `0 0 12px ${PLATFORM_COLOR[platform]}` }} />
              <span className="truncate">{p.name}</span>
            </h1>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {PLATFORM_LABEL[platform]} · <span className="font-mono">{p.slug}</span> · last activity {p.last_activity ?? 'n/a'} · {bundle.sessions.length} sessions · {p.doc_count} files
            </p>
          </div>
          <button className={btn.ghost} onClick={openPalette}><Search size={16} aria-hidden />Search this project</button>
        </div>
        {p.status && <p className="item px-4 py-3 text-sm"><span className="mr-2 font-mono text-[11px] uppercase tracking-wider text-[#5eead4]">Status</span>{p.status.replace(/^[-*]\s*/gm, '').split('\n').join(' · ')}</p>}
        {chips.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {chips.map((c) => (
              <li key={c.url}><a href={c.url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--color-line)] px-3 py-1 text-[13px] hover:border-[#5eead4]/60"><span className="truncate">{c.label}</span><ExternalLink size={12} aria-hidden className="shrink-0 text-[var(--color-dim)]" /></a></li>
            ))}
          </ul>
        )}
      </div>
      {error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">{error}</p>}

      <div role="tablist" aria-label="Project sections" className="scroll-thin -mx-1 flex gap-1 overflow-x-auto px-1">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={clsx('h-9 shrink-0 rounded-full px-3.5 text-sm', tab === t ? 'bg-[color-mix(in_oklab,#5eead4_16%,transparent)] text-[#e6fffa] ring-1 ring-[#5eead4]/40' : 'text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-white')}>
            {t}{t === 'Next steps' ? ` ${bundle.next_steps.filter((s) => !s.done).length}` : t === 'Decisions' ? ` ${bundle.decisions.length}` : ''}
          </button>
        ))}
      </div>

      <section role="tabpanel" aria-label={tab} className="card p-4 sm:p-6">
        {tab === 'Memory' && (bundle.memory
          ? <><p className="mb-3 font-mono text-[11px] text-[var(--color-dim)]">{bundle.memory.path} · updated {bundle.memory.doc_date ?? 'n/a'}</p><Markdown source={bundle.memory.body} /></>
          : <p className="text-sm text-[var(--color-muted)]">No memory.md yet.</p>)}
        {tab === 'Decisions' && <Decisions bundle={bundle} demo={demo} />}
        {tab === 'Next steps' && <NextSteps key={JSON.stringify(bundle.next_steps)} bundle={bundle} demo={demo} />}
        {tab === 'Sessions' && <Sessions bundle={bundle} />}
        {tab === 'Files' && (
          <ul className="flex flex-col gap-1">
            {bundle.documents.map((d) => (
              <li key={d.path}><Link href={docHref(d.path)} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-[var(--color-panel-2)]">
                <FileText size={15} className="shrink-0 text-[var(--color-muted)]" aria-hidden />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm">{d.title}</span><span className="block truncate font-mono text-[11px] text-[var(--color-dim)]">{d.path}</span></span>
                <span className="shrink-0 text-xs text-[var(--color-dim)]">{d.kind.replace('_', ' ')}{d.doc_date ? ` · ${d.doc_date}` : ''}</span>
              </Link></li>
            ))}
          </ul>
        )}
        {tab === 'Activity' && <ActivityList events={projectEvents} />}
      </section>
      <CommandPalette open={palette} onClose={() => setPalette(false)} projects={[bundle.project]} project={p.slug} />
    </div>
  );
}

function Decisions({ bundle, demo }: { bundle: BrainBundle; demo: boolean }) {
  const router = useRouter();
  const { toast } = useHq();
  const [text, setText] = useState('');
  const [pending, start] = useTransition();
  const add = () => start(async () => {
    const r = await addDecisionAction(bundle.project.slug, text);
    if (!r.ok) { toast(r.error, 'error'); return; }
    setText(''); toast('Decision saved to the vault', 'success'); router.refresh();
  });
  return (
    <div className="flex flex-col gap-5">
      <div className="flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && !pending && add()}
          placeholder={demo ? 'Demo mode: saving needs the live dashboard' : 'Log a decision (dated today)…'} className={inputCls} maxLength={500} disabled={demo} />
        <button className={btn.primary} onClick={add} disabled={demo || pending || !text.trim()}><Plus size={16} aria-hidden />{pending ? 'Saving…' : 'Add'}</button>
      </div>
      {bundle.decisions.length === 0 && <p className="text-sm text-[var(--color-muted)]">No decisions logged yet.</p>}
      <ol className="relative flex flex-col gap-4 border-l border-[#5eead4]/25 pl-5">
        {bundle.decisions.map((d, i) => (
          <li key={i} className="relative animate-[brain-in_.45s_ease-out]" style={{ animationDelay: `${Math.min(i, 12) * 40}ms`, animationFillMode: 'backwards' }}>
            <span aria-hidden className="absolute -left-[26px] top-1 h-3 w-3 rounded-full border-2 border-[#5eead4] bg-[var(--color-bg)] shadow-[0_0_10px_rgba(94,234,212,0.6)]" />
            <p className="font-mono text-[11px] text-[#5eead4]">{d.decided_on ?? 'undated'}</p>
            <p className="text-sm leading-relaxed">{d.text}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function NextSteps({ bundle, demo }: { bundle: BrainBundle; demo: boolean }) {
  const router = useRouter();
  const { toast } = useHq();
  const [steps, setSteps] = useState(bundle.next_steps.map((s) => ({ ...s })));
  const [draft, setDraft] = useState('');
  const [pending, start] = useTransition();
  const dirty = useMemo(() => JSON.stringify(steps) !== JSON.stringify(bundle.next_steps), [steps, bundle.next_steps]);
  const move = (i: number, d: -1 | 1) => setSteps((s) => { const n = [...s]; const j = i + d; if (j < 0 || j >= n.length) return s; [n[i], n[j]] = [n[j]!, n[i]!]; return n; });
  const save = () => start(async () => {
    const r = await saveNextStepsAction(bundle.project.slug, steps);
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast('Next steps saved to the vault', 'success'); router.refresh();
  });
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1.5">
        {steps.map((s, i) => (
          <li key={i} className="item flex items-center gap-2 px-2.5 py-1.5">
            <input type="checkbox" checked={s.done} aria-label={`Done: ${s.text}`} onChange={(e) => setSteps((x) => x.map((y, j) => (j === i ? { ...y, done: e.target.checked } : y)))} className="h-4 w-4 shrink-0 accent-[#14b8a6]" />
            <input value={s.text} onChange={(e) => setSteps((x) => x.map((y, j) => (j === i ? { ...y, text: e.target.value } : y)))} aria-label="Step"
              className={clsx('h-8 min-w-0 flex-1 bg-transparent text-sm outline-none', s.done && 'text-[var(--color-dim)] line-through')} maxLength={500} />
            <button aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-1 text-[var(--color-dim)] hover:text-white disabled:opacity-30"><ArrowUp size={14} /></button>
            <button aria-label="Move down" onClick={() => move(i, 1)} disabled={i === steps.length - 1} className="rounded p-1 text-[var(--color-dim)] hover:text-white disabled:opacity-30"><ArrowDown size={14} /></button>
            <button aria-label="Remove" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} className="rounded p-1 text-[var(--color-dim)] hover:text-[#ff8a8d]"><Trash2 size={14} /></button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a step…" className={inputCls} maxLength={500}
          onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { setSteps((x) => [...x, { text: draft.trim(), done: false }]); setDraft(''); } }} />
        <button className={btn.ghost} disabled={!draft.trim()} onClick={() => { setSteps((x) => [...x, { text: draft.trim(), done: false }]); setDraft(''); }}><Plus size={16} aria-hidden />Add</button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--color-dim)]">Saved into memory.md › Open next steps (one vault commit). Ticked steps stay as “[x]” until you remove them.</p>
        <div className="flex gap-2">
          {dirty && <button className={btn.ghost} onClick={() => setSteps(bundle.next_steps.map((s) => ({ ...s })))} disabled={pending}>Undo</button>}
          <button className={btn.primary} onClick={save} disabled={demo || !dirty || pending}>{pending ? 'Saving…' : demo ? 'Demo mode' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function Sessions({ bundle }: { bundle: BrainBundle }) {
  const [openPath, setOpen] = useState<string | null>(bundle.sessions[0]?.path ?? null);
  if (!bundle.sessions.length) return <p className="text-sm text-[var(--color-muted)]">No sessions saved yet.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {bundle.sessions.map((s) => {
        const open = openPath === s.path;
        return (
          <li key={s.path} className="item overflow-hidden">
            <button onClick={() => setOpen(open ? null : s.path)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--color-panel-2)]">
              <span className="font-mono text-[11px] text-[#5eead4]">{s.doc_date ?? ''}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.title}</span>
              <span aria-hidden className={clsx('text-[var(--color-dim)] transition-transform', open && 'rotate-90')}>›</span>
            </button>
            {open && <div className="border-t border-[var(--color-line)] px-4 py-4"><Markdown source={s.body} /><Link href={docHref(s.path)} className="mt-3 inline-block font-mono text-[11px] text-[var(--color-dim)] hover:text-white">{s.path}</Link></div>}
          </li>
        );
      })}
    </ul>
  );
}

