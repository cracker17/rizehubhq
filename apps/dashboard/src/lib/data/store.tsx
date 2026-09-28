'use client';
// Client store: one snapshot of HQ data kept live by Supabase Realtime (LIVE) or mutated in memory (DEMO).
// The office grid, KPIs, badges, approvals, requests and tasks all read from here (docs/06 "Realtime wiring").
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { getSupabaseBrowser } from '@/lib/supabase/browser';
import { askAgentAction, createRequestAction, decideApprovalAction, refreshSnapshotAction, type ActionResult } from '@/app/actions';
import { StepUpDialog, type StepUpRequest } from '@/components/StepUpDialog';
import { approvalRisk } from '@/lib/auth/stepUp';
import { buildIndexes, computeKpis, type Indexes, type Kpis } from './derive';
import { demoCreateRequest, demoDecide, demoStartPlanning } from './engine';
import type { Decision, HqSession, HqSnapshot, Priority } from './types';

// ---------- reducer ----------
type Table = 'agents' | 'agent_screens' | 'approvals' | 'tasks' | 'requests' | 'activity_log' | 'qa_reviews';
const KEY: Record<Table, { list: keyof Omit<HqSnapshot, 'loadedAt'>; id: string; prepend?: boolean }> = {
  agents: { list: 'agents', id: 'id' },
  agent_screens: { list: 'screens', id: 'agent_id' },
  approvals: { list: 'approvals', id: 'id', prepend: true },
  tasks: { list: 'tasks', id: 'id' },
  requests: { list: 'requests', id: 'id', prepend: true },
  activity_log: { list: 'activity', id: 'id', prepend: true },
  qa_reviews: { list: 'qaReviews', id: 'id' },
};

type Action =
  | { type: 'upsert'; table: Table; row: Record<string, unknown> }
  | { type: 'delete'; table: Table; key: unknown }
  | { type: 'replace'; snap: HqSnapshot }
  | { type: 'apply'; fn: (s: HqSnapshot) => HqSnapshot };

function reducer(s: HqSnapshot, a: Action): HqSnapshot {
  switch (a.type) {
    case 'replace': return a.snap;
    case 'apply': return a.fn(s);
    case 'upsert': {
      const k = KEY[a.table];
      const list = s[k.list] as unknown as Record<string, unknown>[];
      const id = a.row[k.id];
      const i = list.findIndex((x) => x[k.id] === id);
      const next = i >= 0 ? list.map((x, j) => (j === i ? { ...x, ...a.row } : x)) : k.prepend ? [a.row, ...list] : [...list, a.row];
      return { ...s, [k.list]: next };
    }
    case 'delete': {
      const k = KEY[a.table];
      return { ...s, [k.list]: (s[k.list] as unknown as Record<string, unknown>[]).filter((x) => x[k.id] !== a.key) };
    }
  }
}

// ---------- context ----------
export type ToastTone = 'success' | 'error' | 'info';
export interface Toast { id: number; text: string; tone: ToastTone }
export type RealtimeState = 'off' | 'connecting' | 'live' | 'error';

export interface HqStore {
  session: HqSession;
  snap: HqSnapshot;
  idx: Indexes;
  kpis: Kpis;
  realtime: RealtimeState;
  loadError?: string;
  busy: Set<string>;
  toasts: Toast[];
  toast: (text: string, tone?: ToastTone) => void;
  dismissToast: (id: number) => void;
  createRequest: (input: { text: string; priority: Priority; dueDate: string | null; clientSlug: string | null }) => Promise<boolean>;
  decide: (id: string, decision: Decision, note: string | null) => Promise<boolean>;
  ask: (agentId: string, question: string) => Promise<{ answer: string | null; live: boolean } | null>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<HqStore | null>(null);

export function useHq(): HqStore {
  const v = useContext(Ctx);
  if (!v) throw new Error('useHq must be used inside <HqProvider>');
  return v;
}

const DECISION_TEXT: Record<Decision, string> = { approve: 'Approved', changes: 'Changes requested', reject: 'Rejected' };

export function HqProvider({ session, initial, loadError, children }: {
  session: HqSession; initial: HqSnapshot; loadError?: string; children: React.ReactNode;
}) {
  const [snap, dispatch] = useReducer(reducer, initial);
  const [realtime, setRealtime] = useState<RealtimeState>(session.mode === 'live' && session.isCeo ? 'connecting' : 'off');
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const live = session.mode === 'live';

  const toast = useCallback((text: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const refresh = useCallback(async () => {
    if (!live) return;
    const next = await refreshSnapshotAction();
    if (next) dispatch({ type: 'replace', snap: next });
  }, [live]);

  // ---- realtime (LIVE only) ----
  useEffect(() => {
    if (!live || !session.isCeo || !session.supabase) return;
    const sb = getSupabaseBrowser(session.supabase);
    let hadError = false;
    let cancelled = false;
    const onChange = (table: Table) => (p: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
      if (p.eventType === 'DELETE') dispatch({ type: 'delete', table, key: (p.old as Record<string, unknown>)[KEY[table].id] });
      else dispatch({ type: 'upsert', table, row: p.new as Record<string, unknown> });
    };
    const channel = sb.channel('hq-office');
    (['agents', 'agent_screens', 'approvals', 'tasks', 'requests', 'qa_reviews'] as Table[]).forEach((t) => {
      channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, onChange(t));
    });
    channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_log' }, onChange('activity_log'));

    (async () => {
      const { data } = await sb.auth.getSession();
      if (data.session) await sb.realtime.setAuth(data.session.access_token);
      if (cancelled) return;
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setRealtime('live');
          if (hadError) { hadError = false; void refresh(); } // catch up on anything missed
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          hadError = true;
          setRealtime('error');
        }
      });
    })();

    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 60_000) void refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVis); void sb.removeChannel(channel); };
  }, [live, session.isCeo, session.supabase, refresh]);

  // Fallback polling when realtime is down (LIVE).
  useEffect(() => {
    if (!live || realtime !== 'error') return;
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [live, realtime, refresh]);

  const setBusyId = (id: string, on: boolean) => setBusy((b) => { const n = new Set(b); if (on) n.add(id); else n.delete(id); return n; });

  const createRequest = useCallback<HqStore['createRequest']>(async (input) => {
    if (!live) {
      try {
        const { snapshot, id } = demoCreateRequest(snapRef.current, input);
        dispatch({ type: 'replace', snap: snapshot });
        setTimeout(() => dispatch({ type: 'apply', fn: (s) => demoStartPlanning(s, id) }), 2500);
        toast('Staged. The COO is planning it…', 'success');
        return true;
      } catch (e) { toast(e instanceof Error ? e.message : 'Could not create the request', 'error'); return false; }
    }
    const tempId = `temp-${Date.now()}`;
    const now = new Date().toISOString();
    const client = input.clientSlug ? snapRef.current.clients.find((c) => c.slug === input.clientSlug) : undefined;
    dispatch({ type: 'upsert', table: 'requests', row: {
      id: tempId, source: 'dashboard', raw_text: input.text.trim(), client_id: client?.id ?? null, title: null, brief: null,
      priority: input.priority, due_date: input.dueDate, status: 'staged', cost_usd: 0, created_at: now, updated_at: now,
    } });
    const res = await createRequestAction(input);
    dispatch({ type: 'delete', table: 'requests', key: tempId });
    if (!res.ok) { toast(res.error, 'error'); return false; }
    if (!snapRef.current.requests.some((r) => r.id === res.id)) {
      dispatch({ type: 'upsert', table: 'requests', row: {
        id: res.id, source: 'dashboard', raw_text: input.text.trim(), client_id: client?.id ?? null, title: null, brief: null,
        priority: input.priority, due_date: input.dueDate, status: 'staged', cost_usd: 0, created_at: now, updated_at: now,
      } });
    }
    toast('Staged. The COO is planning it…', 'success');
    return true;
  }, [live, toast]);

  const decide = useCallback<HqStore['decide']>(async (id, decision, note) => {
    if (decision === 'changes' && !note?.trim()) { toast('Say what should change first.', 'error'); return false; }
    const before = snapRef.current.approvals.find((a) => a.id === id);
    if (!before || before.status !== 'pending') return false;
    if (!live) {
      try {
        const { snapshot } = demoDecide(snapRef.current, id, decision, note);
        dispatch({ type: 'replace', snap: snapshot });
        toast(`${DECISION_TEXT[decision]}: ${before.title}`, decision === 'reject' ? 'info' : 'success');
        return true;
      } catch (e) { toast(e instanceof Error ? e.message : 'Could not save the decision', 'error'); return false; }
    }
    setBusyId(id, true);
    // High-risk approvals may need a 2FA code first: no optimistic "approved" until the server says so.
    const risky = decision === 'approve' && approvalRisk(before) === 'high';
    const status = decision === 'approve' ? 'approved' : decision === 'changes' ? 'changes_requested' : 'rejected';
    if (!risky) dispatch({ type: 'upsert', table: 'approvals', row: { id, status, ceo_note: note, decided_at: new Date().toISOString(), decided_via: 'dashboard' } });
    let res: ActionResult<{ result: string }> = await decideApprovalAction({ id, decision, note });
    if (!res.ok && res.stepUp) {
      res = await new Promise<ActionResult<{ result: string }>>((resolve) => {
        setStepUp({
          title: 'Confirm with 2FA',
          detail: `Approving “${before.title}” changes the outside world, so it needs your authenticator code.`,
          submit: async (code) => {
            const r = await decideApprovalAction({ id, decision, note, totp: code });
            if (!r.ok && r.stepUp) return r.error;
            setStepUp(null);
            resolve(r);
            return null;
          },
          cancel: () => { setStepUp(null); resolve({ ok: false, error: 'Not approved: it needs your 2FA code.' }); },
        });
      });
    }
    setBusyId(id, false);
    if (!res.ok) {
      if (!risky) dispatch({ type: 'upsert', table: 'approvals', row: before as unknown as Record<string, unknown> }); // roll back
      toast(res.error, 'error');
      return false;
    }
    if (risky) dispatch({ type: 'upsert', table: 'approvals', row: { id, status, ceo_note: note, decided_at: new Date().toISOString(), decided_via: 'dashboard' } });
    toast(`${DECISION_TEXT[decision]}: ${before.title}`, decision === 'reject' ? 'info' : 'success');
    if (realtime !== 'live') void refresh();
    return true;
  }, [live, realtime, refresh, toast]);

  const ask = useCallback<HqStore['ask']>(async (agentId, question) => {
    const res = await askAgentAction({ agentId, question });
    if (!res.ok) { toast(res.error, 'error'); return null; }
    return { answer: res.answer, live: res.live };
  }, [toast]);

  const idx = useMemo(() => buildIndexes(snap), [snap]);
  const kpis = useMemo(() => computeKpis(snap), [snap]);
  const value = useMemo<HqStore>(() => ({
    session, snap, idx, kpis, realtime, loadError, busy, toasts, toast, dismissToast, createRequest, decide, ask, refresh,
  }), [session, snap, idx, kpis, realtime, loadError, busy, toasts, toast, dismissToast, createRequest, decide, ask, refresh]);

  return <Ctx.Provider value={value}>{children}<StepUpDialog request={stepUp} /></Ctx.Provider>;
}
