'use client';
import { Bell, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { NewRequestDialog } from './NewRequestDialog';

export function Topbar() {
  const [open, setOpen] = useState(false);
  return (
    <header className="flex items-center gap-3">
      <div className="lg:hidden flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--color-primary)] text-sm font-bold">R</div>
      <label className="flex h-11 min-w-0 flex-1 items-center gap-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] px-4 text-[var(--color-muted)] md:max-w-[520px]">
        <Search size={18} strokeWidth={1.75} />
        <input className="min-w-0 flex-1 bg-transparent text-[15px] text-white outline-none placeholder:text-[var(--color-dim)]" placeholder="Search agents, tasks, or requests…" />
      </label>
      <div className="ml-auto flex items-center gap-3">
        <button onClick={() => setOpen(true)} className="hidden h-11 items-center gap-2 rounded-2xl bg-[var(--color-primary)] px-5 text-[15px] font-medium text-white hover:bg-[var(--color-primary-hover)] sm:flex">
          <Plus size={18} /> New Request
        </button>
        <button className="relative flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)]" aria-label="Notifications">
          <Bell size={18} strokeWidth={1.75} />
          <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-[var(--color-danger)]" />
        </button>
        <div className="hidden items-center gap-2.5 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] py-1.5 pl-1.5 pr-4 md:flex">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#7c5cff] to-[#14b8a6] text-xs font-semibold">JA</span>
          <span className="text-[15px]">Julev</span>
        </div>
      </div>
      <NewRequestDialog open={open} onClose={() => setOpen(false)} />
    </header>
  );
}
