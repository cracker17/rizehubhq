'use client';
// Live /brain: new brain_events rows arrive over Supabase realtime (migration 20260930030000) and project changes
// trigger a refresh of the server data. Realtime down or not set up yet → refresh every 15 s instead. DEMO → a fake
// save every few seconds so the core still animates.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useHq } from '@/lib/data/store';
import { getSupabaseBrowser } from '@/lib/supabase/browser';
import type { BrainEvent, BrainProject } from '@/lib/brainView';
import { demoPulse } from '@/lib/data/brainDemo';

export type LiveState = 'demo' | 'connecting' | 'live' | 'polling';

export function useBrainLive(initial: BrainEvent[], projects: BrainProject[], demo: boolean): { events: BrainEvent[]; live: LiveState } {
  const { session } = useHq();
  const router = useRouter();
  const [events, setEvents] = useState<BrainEvent[]>(initial);
  const [live, setLive] = useState<LiveState>(demo ? 'demo' : 'connecting');
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  // Server data refreshed (router.refresh): merge, newest first, no duplicates.
  useEffect(() => {
    setEvents((cur) => {
      const byId = new Map<number, BrainEvent>();
      for (const e of [...initial, ...cur]) byId.set(e.id, e);
      return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, 200);
    });
  }, [initial]);

  useEffect(() => {
    if (!demo) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible' && projectsRef.current.length) setEvents((cur) => [demoPulse(projectsRef.current), ...cur].slice(0, 200));
    }, 6500);
    return () => clearInterval(t);
  }, [demo]);

  useEffect(() => {
    if (demo || !session.supabase) return;
    const sb = getSupabaseBrowser(session.supabase);
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const softRefresh = () => { if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; router.refresh(); }, 1200); };
    const channel = sb.channel('hq-brain')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'brain_events' }, (p) => {
        const e = p.new as BrainEvent;
        if (e.action === 'tool_call') return;
        setEvents((cur) => (cur.some((x) => x.id === e.id) ? cur : [e, ...cur].slice(0, 200)));
        if (['saved', 'indexed', 'pulled', 'revoked', 'connected'].includes(e.action)) softRefresh();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brain_projects' }, softRefresh);
    (async () => {
      const { data } = await sb.auth.getSession();
      if (data.session) await sb.realtime.setAuth(data.session.access_token);
      if (cancelled) return;
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') setLive('live');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setLive('polling');
      });
    })();
    return () => { cancelled = true; if (refreshTimer) clearTimeout(refreshTimer); void sb.removeChannel(channel); };
  }, [demo, session.supabase, router]);

  // Polling fallback. Also covers "subscribed but the table is not in the publication yet": refresh every 60 s anyway.
  useEffect(() => {
    if (demo) return;
    const every = live === 'live' ? 60_000 : 15_000;
    const t = setInterval(() => { if (document.visibilityState === 'visible') router.refresh(); }, every);
    return () => clearInterval(t);
  }, [demo, live, router]);

  return { events, live };
}
