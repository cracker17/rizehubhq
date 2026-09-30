'use client';
// Ctrl+K / ⌘K on /brain (docs/16-BRAIN.md "UI" §2): jump to a project instantly, run an action, or search the whole
// vault (semantic + keyword through the brain service). ↑/↓ to move, Enter to open, Esc to close.
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { FileText, FolderOpen, Loader2, Plus, Search, Smartphone } from 'lucide-react';
import { searchBrainAction } from '@/app/brain-actions';
import type { BrainHit, BrainProject } from '@/lib/brainView';

type Row =
  | { kind: 'project'; key: string; p: BrainProject }
  | { kind: 'action'; key: string; label: string; icon: typeof Plus; run: () => void }
  | { kind: 'hit'; key: string; h: BrainHit };

export const docHref = (path: string) => `/brain/doc?path=${encodeURIComponent(path)}`;

export function CommandPalette({ open, onClose, projects, onNewProject, onDevices, project }: {
  open: boolean; onClose: () => void; projects: BrainProject[]; onNewProject?: () => void; onDevices?: () => void; project?: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<BrainHit[]>([]);
  const [semantic, setSemantic] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQ(''); setHits([]); setError(null); setSel(0);
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  // Debounced vault search (from 3 characters).
  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 3) { setHits([]); setError(null); return; }
    const my = ++seq.current;
    const t = setTimeout(() => start(async () => {
      const r = await searchBrainAction(query, project);
      if (my !== seq.current) return;
      if (r.ok) { setHits(r.hits); setSemantic(r.semantic); setError(null); } else { setHits([]); setError(r.error); }
    }), 320);
    return () => clearTimeout(t);
  }, [q, open, project]);

  const rows = useMemo<Row[]>(() => {
    const s = q.trim().toLowerCase();
    const matches = projects.filter((p) => p.listed && (!s || [p.name, p.slug, ...p.aliases].some((k) => k.toLowerCase().includes(s)))).slice(0, s ? 6 : 8);
    const actions: Row[] = [];
    if (onNewProject && (!s || 'new project create'.includes(s))) actions.push({ kind: 'action', key: 'new', label: 'New project', icon: Plus, run: onNewProject });
    if (onDevices && (!s || 'devices accounts connector setup'.includes(s))) actions.push({ kind: 'action', key: 'devices', label: 'Devices & accounts', icon: Smartphone, run: onDevices });
    return [...matches.map((p): Row => ({ kind: 'project', key: `p:${p.slug}`, p })), ...actions, ...hits.map((h, i): Row => ({ kind: 'hit', key: `h:${h.path}:${i}`, h }))];
  }, [q, projects, hits, onNewProject, onDevices]);

  useEffect(() => { setSel((v) => Math.min(v, Math.max(0, rows.length - 1))); }, [rows.length]);

  const choose = (r: Row | undefined) => {
    if (!r) return;
    onClose();
    if (r.kind === 'project') router.push(`/brain/${r.p.slug}`);
    else if (r.kind === 'action') r.run();
    else router.push(docHref(r.h.path));
  };

  if (!open) return null;
  return (
    <div className="glass-scrim fixed inset-0 z-50 flex items-start justify-center p-3 pt-[10vh] sm:p-4 sm:pt-[12vh]" onClick={onClose}>
      <div role="dialog" aria-modal aria-label="Search the brain" onClick={(e) => e.stopPropagation()}
        className="glass w-full max-w-2xl overflow-hidden rounded-[20px] shadow-[0_0_80px_-20px_rgba(94,234,212,0.35)]">
        <div className="flex items-center gap-3 border-b border-[var(--color-line)] px-4">
          {pending ? <Loader2 size={18} className="animate-spin text-[#5eead4]" aria-hidden /> : <Search size={18} className="text-[#5eead4]" aria-hidden />}
          <input
            ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); onClose(); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((v) => Math.min(rows.length - 1, v + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((v) => Math.max(0, v - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); choose(rows[sel]); }
            }}
            placeholder={project ? `Search ${project}…` : 'Ask the Brain: a project, a decision, a URL…'}
            aria-label="Search the brain" role="combobox" aria-expanded aria-controls="brain-palette-list"
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--color-dim)]"
          />
          <kbd className="hidden rounded border border-[var(--color-line)] px-1.5 py-0.5 text-[11px] text-[var(--color-dim)] sm:block">Esc</kbd>
        </div>
        <ul id="brain-palette-list" role="listbox" className="scroll-thin max-h-[60vh] overflow-y-auto p-2">
          {rows.map((r, i) => {
            const active = i === sel;
            const first = i === 0 || rows[i - 1]!.kind !== r.kind;
            return (
              <li key={r.key} role="option" aria-selected={active}>
                {first && <p className="px-2.5 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wider text-[var(--color-dim)]">{r.kind === 'project' ? 'Projects' : r.kind === 'action' ? 'Actions' : `Found in the vault${semantic === 'on' ? ' · by meaning + words' : ''}`}</p>}
                <button onMouseEnter={() => setSel(i)} onClick={() => choose(r)}
                  className={clsx('flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-left', active ? 'bg-[color-mix(in_oklab,#5eead4_12%,transparent)]' : 'hover:bg-[var(--color-panel-2)]')}>
                  {r.kind === 'project' && <><FolderOpen size={16} className="mt-0.5 shrink-0 text-[#5eead4]" aria-hidden /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{r.p.name}</span><span className="block truncate text-xs text-[var(--color-muted)]">{r.p.slug}{r.p.open_next_steps ? ` · ${r.p.open_next_steps} open steps` : ""}</span></span></>}
                  {r.kind === 'action' && <><r.icon size={16} className="mt-0.5 shrink-0 text-[var(--color-muted)]" aria-hidden /><span className="text-sm">{r.label}</span></>}
                  {r.kind === 'hit' && <><FileText size={16} className="mt-0.5 shrink-0 text-[var(--color-muted)]" aria-hidden /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{r.h.title}{r.h.heading ? <span className="font-normal text-[var(--color-muted)]"> › {r.h.heading}</span> : null}</span><span className="line-clamp-2 text-xs text-[var(--color-muted)]">{r.h.text.replace(/\s+/g, ' ').slice(0, 220)}</span><span className="mt-0.5 block truncate font-mono text-[10.5px] text-[var(--color-dim)]">{r.h.path}</span></span></>}
                </button>
              </li>
            );
          })}
          {!rows.length && !pending && <li className="px-3 py-6 text-center text-sm text-[var(--color-muted)]">{q.trim().length < 3 ? 'Type to search every project.' : 'Nothing found.'}</li>}
          {error && <li role="alert" className="px-3 py-2 text-sm text-[#ff8a8d]">{error}</li>}
        </ul>
      </div>
    </div>
  );
}

/** Ctrl+K / ⌘K opens it (also while typing elsewhere: it is a global shortcut). */
export function usePaletteShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}
