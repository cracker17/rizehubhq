import 'server-only';
// /settings page data: 2FA status (Supabase Auth MFA) and the plan auto-approve rules with their recent activity.
import type { AutoApproveRule } from '@rizehubhq/shared';
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { demoSnapshot } from '@/lib/mock';
import { totpState } from '@/lib/auth/mfaServer';
import { demoRules } from './autoApproveDemo';

export interface SecurityStatus {
  /** 'off' = no verified TOTP factor yet. */
  totp: 'on' | 'off';
  since: string | null;
  level: string | null;
}

export interface AutoApproveEvent { at: string; action: 'plan.auto_approved' | 'plan.auto_approve_skipped'; ruleName: string | null; reason: string | null; requestId: string | null }

export interface SettingsPage {
  mode: 'demo' | 'live';
  security: SecurityStatus | null;
  rules: AutoApproveRule[];
  clients: { slug: string; name: string }[];
  events: AutoApproveEvent[];
  error?: string;
}

/** Admin → Security: 2FA status of the signed-in CEO (null in DEMO mode or without a session). */
export async function loadSecurity(): Promise<{ mode: 'demo' | 'live'; security: SecurityStatus | null }> {
  if (!supabaseEnv()) return { mode: 'demo', security: null };
  const state = await totpState((await createSupabaseServer())!);
  return { mode: 'live', security: state ? { totp: state.factorId ? 'on' : 'off', since: state.factorCreatedAt, level: state.currentLevel } : null };
}

export async function loadSettings(): Promise<SettingsPage> {
  if (!supabaseEnv()) {
    return { mode: 'demo', security: null, rules: demoRules().list(), clients: demoSnapshot().clients.map((c) => ({ slug: c.slug, name: c.name })), events: [] };
  }
  const db = (await createSupabaseServer())!;
  const [state, rules, clients, events] = await Promise.all([
    totpState(db),
    db.from('plan_auto_approve_rules').select('*').order('created_at').order('id'),
    db.from('clients').select('slug,name').neq('status', 'archived').eq('is_internal', false).order('name'),
    db.from('activity_log').select('created_at,action,request_id,detail').in('action', ['plan.auto_approved', 'plan.auto_approve_skipped'])
      .order('created_at', { ascending: false }).limit(10),
  ]);
  return {
    mode: 'live',
    security: state ? { totp: state.factorId ? 'on' : 'off', since: state.factorCreatedAt, level: state.currentLevel } : null,
    rules: (rules.data ?? []) as AutoApproveRule[],
    clients: (clients.data ?? []) as { slug: string; name: string }[],
    events: ((events.data ?? []) as { created_at: string; action: AutoApproveEvent['action']; request_id: string | null; detail: Record<string, unknown> }[])
      .map((e) => ({
        at: e.created_at, action: e.action, requestId: e.request_id,
        ruleName: typeof e.detail?.rule_name === 'string' ? e.detail.rule_name : null,
        reason: typeof e.detail?.reason === 'string' ? e.detail.reason : null,
      })),
    error: rules.error?.message ?? clients.error?.message,
  };
}
