'use client';
import Link from 'next/link';
import { Bell, LogOut, Plus, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useHq } from '@/lib/data/store';
import { signOutAction } from '@/app/actions';
import { NewRequestDialog } from './NewRequestDialog';

function initialsOf(email: string | null | undefined) {
  if (!email) return 'JA';
  const name = email.split('@')[0].replace(/[^a-z]/gi, ' ').trim().split(/\s+/);
  return ((name[0]?.[0] ?? 'C') + (name[1]?.[0] ?? '')).toUpperCase();
}

function UserMenu() {
  const { session, realtime } = useHq();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const live = session.mode === 'live';
  const label = live ? session.user?.email?.split('@')[0] ?? 'CEO' : 'Julev';
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu"
        className="flex h-11 items-center gap-2.5 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-1.5 md:pr-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#7c5cff] to-[#14b8a6] text-xs font-semibold">
          {live ? initialsOf(session.user?.email) : 'JA'}
        </span>
        <span className="hidden max-w-[140px] truncate text-[15px] capitalize md:inline">{label}</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+8px)] z-50 w-64 rounded-[14px] border border-[var(--color-line)] bg-[var(--color-panel-2)] p-2 shadow-[0_10px_30px_rgba(0,0,0,.45)]">
          <div className="px-3 py-2">
            <p className="truncate text-sm">{live ? session.user?.email : 'Demo mode'}</p>
            <p className="mt-0.5 text-xs text-[var(--color-muted)]">
              {live ? (realtime === 'live' ? 'Live updates on' : realtime === 'error' ? 'Live updates reconnecting…' : 'Connecting…') : 'Mock data · actions stay in this tab'}
            </p>
          </div>
          {live ? (
            <form action={signOutAction}>
              <button role="menuitem" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-white">
                <LogOut size={16} /> Sign out
              </button>
            </form>
          ) : (
            <p className="px-3 pb-2 text-xs text-[var(--color-dim)]">Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to go live.</p>
          )}
        </div>
      )}
    </div>
  );
}

export function Topbar() {
  const [open, setOpen] = useState(false);
  const { kpis, session, realtime } = useHq();
  return (
    <header className="flex items-center gap-2 sm:gap-3">
      <Link href="/" aria-label="RizeHub HQ home" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary)] text-sm font-bold lg:hidden">R</Link>
      <label className="flex h-11 min-w-0 flex-1 items-center gap-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] px-3 text-[var(--color-muted)] sm:px-4 md:max-w-[520px]">
        <Search size={18} strokeWidth={1.75} className="shrink-0" aria-hidden />
        <input aria-label="Search" className="min-w-0 flex-1 bg-transparent text-[15px] text-white outline-none placeholder:text-[var(--color-dim)]" placeholder="Search agents, tasks, or requests…" />
      </label>
      <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
        {session.mode === 'demo' && (
          <span title="No Supabase configured: showing mock data. Actions only change this tab."
            className="rounded-full border border-[var(--color-line)] px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
            Demo<span className="hidden sm:inline"> data</span>
          </span>
        )}
        {session.mode === 'live' && realtime === 'error' && (
          <span className="hidden rounded-full border border-[color-mix(in_oklab,var(--color-warning)_50%,transparent)] px-2.5 py-1 text-[11px] text-[var(--color-warning)] sm:inline">Reconnecting…</span>
        )}
        <button onClick={() => setOpen(true)} className="hidden h-11 items-center gap-2 rounded-2xl bg-[var(--color-primary)] px-5 text-[15px] font-medium text-white hover:bg-[var(--color-primary-hover)] sm:flex">
          <Plus size={18} /> New Request
        </button>
        <Link href="/approvals" className="relative flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)]"
          aria-label={kpis.pendingApprovals ? `${kpis.pendingApprovals} approvals waiting` : 'Notifications'}>
          <Bell size={18} strokeWidth={1.75} />
          {kpis.pendingApprovals > 0 && <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-[var(--color-danger)]" />}
        </Link>
        <UserMenu />
      </div>
      <NewRequestDialog open={open} onClose={() => setOpen(false)} />
    </header>
  );
}
