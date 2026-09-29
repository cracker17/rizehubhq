import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Brain } from './brain';
import type { HqDb } from './hqdb';
import type { PickModel, PickedModel, TokenUsage } from './models/usage';
import type { Role } from './roles';

/** Everything planner/runner/qa/chat need; injected so tests can use fakes and mock models. */
export interface WorkerDeps {
  db: HqDb;
  brain: Brain;
  pickModel: PickModel;
  loadRole: (id: string) => Role;
  agentsDir: string;
  qaThreshold: number;
  /**
   * MONTHLY_BUDGET_USD. 0 = paid providers are off (free models only), so a plan's cost estimate is forced to $0:
   * the model's own guess would otherwise show a made-up dollar figure the CEO can never be charged.
   */
  monthlyBudgetUsd?: number;
  /** Called on a quota-type provider error so the picker can fall back (a 404/413 blocks only `modelId`). */
  onProviderQuota?: (provider: string, detail?: { modelId?: string; error?: unknown }) => void;
  log?: (msg: string, extra?: unknown) => void;
  now?: () => Date;
}

export interface RosterAgent { name?: string; department?: string; runtime?: string; model_role?: string }
export interface Roster {
  /** The active team (docs/04): id → display name, department, runtime, model role. Must match agents/*.md. */
  agents?: Record<string, RosterAgent>;
  routing: Record<string, string | string[]>;
  platform_to_dev?: Record<string, string>;
  qa?: Record<string, string>;
}

export function readRosterText(agentsDir: string): string {
  return fs.readFileSync(path.join(agentsDir, 'roster.yaml'), 'utf8');
}
export function readRoster(agentsDir: string): Roster {
  return YAML.parse(readRosterText(agentsDir)) as Roster;
}

export function log(deps: WorkerDeps, msg: string, extra?: unknown) {
  (deps.log ?? ((m: string, e?: unknown) => (e === undefined ? console.log(m) : console.log(m, e))))(msg, extra);
}

/**
 * Usage detail stored in activity_log for one model run (tokens_in/out are added by record_usage). With client_id,
 * task_id, request_id and actor on the row, this is what a cost dashboard aggregates (view ai_usage).
 */
export function usageDetail(picked: Pick<PickedModel, 'provider' | 'modelId'>, usage: TokenUsage, extra: Record<string, unknown> = {}) {
  return {
    provider: picked.provider, model: picked.modelId,
    cached_in: usage.cachedInputTokens ?? 0, cache_write_in: usage.cacheWriteTokens ?? 0, ...extra,
  };
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Today's date in Manila (YYYY-MM-DD). */
export function manilaToday(now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}
