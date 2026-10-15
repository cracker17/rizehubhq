'use client';
// Live /operator: every operator_actions row arrives over Supabase realtime the moment the operator writes it (reads,
// drafts, each browser step, sends), so the feed shows the AI working step by step. Inbox / settings changes refresh the
// server data. Realtime down → refresh every 10 s. DEMO → replays a short typing sequence so the page still moves.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useHq } from '@/lib/data/store';
import { getSupabaseBrowser } from '@/lib/supabase/browser';
import type { OperatorActionRow } from '@/lib/operatorView';

export type LiveState = 'demo' | 'connecting' | 'live' | 'polling';

const DEMO_STEPS: [string, Record<string, unknown>][] = [
  ['message.new', { channel: 'Alex, Riley', sender: 'Alex' }],
  ['message.classified', { category: 'reply', confidence: 0.91 }],
  ['send.auto_approved', {}],
  ['browser.open', { channel: 'Alex, Riley' }],
  ['browser.compose', { quoted: true }],
  ['browser.typed', { chars: 64, mentions_linked: 1 }],
  ['send.done', { mode: 'auto' }],
];

/** ambient = the small looping demo feed (off while the scripted demo player drives the page). */
export function useOperatorLive(initial: OperatorActionRow[], demo: boolean, ambient = demo): { actions: OperatorActionRow[]; live: LiveState } {
  const { session } = useHq();
  const router = useRouter();
  const [actions, setActions] = useState<OperatorActionRow[]>(initial);
  const [live, setLive] = useState<LiveState>(demo ? 'demo' : 'connecting');

  useEffect(() => {
    setActions((cur) => {
      const byId = new Map<number, OperatorActionRow>();
      for (const a of [...initial, ...cur]) byId.set(a.id, a);
      return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, 200);
    });
  }, [initial]);

  useEffect(() => {
    if (!demo || !ambient) return;
    let i = 0;
    let next = 5000;
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const [action, detail] = DEMO_STEPS[i % DEMO_STEPS.length]!;
      i++;
      const row: OperatorActionRow = { id: next++, created_at: new Date().toISOString(), client_slug: 'lvlup', inbox_id: null, actor: 'operator', action, ok: true, detail };
      setActions((cur) => [row, ...cur].slice(0, 200));
    }, 2600);
    return () => clearInterval(t);
  }, [demo, ambient]);

  useEffect(() => {
    if (demo || !session.supabase) return;
    const sb = getSupabaseBrowser(session.supabase);
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const softRefresh = () => { if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; router.refresh(); }, 800); };
    const channel = sb.channel('hq-operator')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'operator_actions' }, (p) => {
        const a = p.new as OperatorActionRow;
        setActions((cur) => (cur.some((x) => x.id === a.id) ? cur : [a, ...cur].slice(0, 200)));
        if (!a.action.startsWith('browser.')) softRefresh();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'operator_inbox' }, softRefresh);
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

  useEffect(() => {
    if (demo) return;
    const every = live === 'live' ? 60_000 : 10_000;
    const t = setInterval(() => { if (document.visibilityState === 'visible') router.refresh(); }, every);
    return () => clearInterval(t);
  }, [demo, live, router]);

  return { actions, live };
}
