import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { LanguageModelUsage } from 'ai';
import type { Brain } from './brain';
import type { HqDb } from './hqdb';
import type { PickModel, PickedModel } from './models/usage';
import type { Role } from './roles';

/** Everything planner/runner/qa/chat need; injected so tests can use fakes and mock models. */
export interface WorkerDeps {
  db: HqDb;
  brain: Brain;
  pickModel: PickModel;
  loadRole: (id: string) => Role;
  agentsDir: string;
  qaThreshold: number;
  /** Called when a provider returns 429 so the picker can fall back. */
  onProviderQuota?: (provider: string) => void;
  log?: (msg: string, extra?: unknown) => void;
  now?: () => Date;
}

export interface Roster { routing: Record<string, string | string[]>; platform_to_dev?: Record<string, string>; qa?: Record<string, string> }

export function readRosterText(agentsDir: string): string {
  return fs.readFileSync(path.join(agentsDir, 'roster.yaml'), 'utf8');
}
export function readRoster(agentsDir: string): Roster {
  return YAML.parse(readRosterText(agentsDir)) as Roster;
}

export function log(deps: WorkerDeps, msg: string, extra?: unknown) {
  (deps.log ?? ((m: string, e?: unknown) => (e === undefined ? console.log(m) : console.log(m, e))))(msg, extra);
}

/** Usage detail stored in activity_log for one model run. */
export function usageDetail(picked: PickedModel, usage: Partial<LanguageModelUsage>, extra: Record<string, unknown> = {}) {
  return {
    provider: picked.provider, model: picked.modelId,
    cached_in: usage.cachedInputTokens ?? 0, ...extra,
  };
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Today's date in Manila (YYYY-MM-DD). */
export function manilaToday(now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}
