'use client';
// /office: the isometric office alone, full screen, with a compact header (for a big monitor).
import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { toTileAgent } from '@/lib/data/derive';
import { AgentPanel } from '../AgentPanel';
import { useOfficeSnapshot } from './useOfficeSnapshot';
import { MapSkeleton } from './MapSkeleton';

const OfficeMap = dynamic(() => import('./OfficeMap'), { ssr: false, loading: () => <MapSkeleton /> });

export function FullscreenOffice() {
  const { snap, idx, demo } = useOfficeSnapshot();
  const [openId, setOpenId] = useState<string | null>(null);
  const agents = useMemo(() => snap.agents.map((a) => toTileAgent(a, snap, idx)), [snap, idx]);
  const open = openId ? agents.find((a) => a.id === openId) ?? null : null;
  const working = agents.filter((a) => a.status === 'working').length;
  const idle = agents.filter((a) => a.status === 'idle').length;
  const needs = agents.filter((a) => a.status === 'waiting' || a.status === 'blocked').length;

  return (
    <div className="fixed inset-0 z-[45] bg-[#15131f]">
      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-12 items-center gap-3 bg-gradient-to-b from-[#0b0a1f]/85 to-transparent px-3 pt-[env(safe-area-inset-top,0px)] sm:px-4 [&>*]:pointer-events-auto">
        <Link href="/" className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-white">
          <ArrowLeft size={16} /> <span className="hidden sm:inline">Dashboard</span>
        </Link>
        <h1 className="whitespace-nowrap text-[15px] font-semibold"><span className="hidden sm:inline">RizeHub HQ · </span>Office</h1>
        {demo && <span className="rounded-full bg-[var(--color-panel-2)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]">Demo</span>}
        <p className="ml-auto flex min-w-0 items-center gap-2 whitespace-nowrap text-[13px] text-[var(--color-muted)]">
          <span className="flex items-center text-[var(--color-success)]"><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current sm:hidden" />{working}<span className="ml-1 hidden sm:inline">working</span></span>
          <span className="flex items-center text-[var(--color-warning)]"><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current sm:hidden" />{idle}<span className="ml-1 hidden sm:inline">on break</span></span>
          <span className="flex items-center text-[var(--color-danger)]"><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current sm:hidden" />{needs}<span className="ml-1 hidden sm:inline">need you</span></span>
          <span className="sr-only">working, on break, need you</span>
        </p>
      </header>
      <main className="absolute inset-0">
        <OfficeMap snap={snap} variant="full" onOpen={setOpenId} />
      </main>
      <AgentPanel key={open?.id} agent={open} onClose={() => setOpenId(null)} />
    </div>
  );
}
