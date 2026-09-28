// RizeHub connection settings (worker env only; agents never see keys). RIZEHUB_API_URL unset or "mock" →
// the in-memory mock (same contract) so local dev and tests never touch a real RizeHub (CLAUDE.md rule 9).
import { workerEnv } from '../config';
import { API_PREFIX, KEY_GROUPS, type KeyGroup } from './contract';
import { RizehubClient, type ClientOptions } from './client';
import { MOCK_KEYS, MockRizehub, mockFetch } from './mock';

export interface RizehubConfig {
  mock: boolean;
  baseUrl: string;
  keys: Partial<Record<KeyGroup, string>>;
  webhookSecret: string;
  /** How long a tool waits for a Lead Finder / report job before parking the task until job.completed. */
  jobWaitMs: number;
}

export function rizehubConfig(env: Readonly<Record<string, string | undefined>> = workerEnv()): RizehubConfig {
  const raw = (env.RIZEHUB_API_URL ?? '').trim();
  const mock = raw === '' || raw.toLowerCase() === 'mock';
  const keys: Partial<Record<KeyGroup, string>> = {};
  for (const g of KEY_GROUPS) {
    const v = env[`RIZEHUB_KEY_${g}`]?.trim();
    if (v) keys[g] = v;
    else if (mock) keys[g] = MOCK_KEYS[g];
  }
  return {
    mock,
    baseUrl: mock ? `http://rizehub.mock${API_PREFIX}` : raw.replace(/\/+$/, ''),
    keys,
    webhookSecret: (env.RIZEHUB_WEBHOOK_SECRET ?? '').trim(),
    jobWaitMs: Number(env.RIZEHUB_JOB_WAIT_MS ?? '') || 45_000,
  };
}

let shared: { client: RizehubClient; mock: MockRizehub | null; cfg: RizehubConfig } | null = null;

/** Process-wide client (one mock instance in mock mode, so state persists across tasks). */
export function getRizehub(): { client: RizehubClient; mock: MockRizehub | null; cfg: RizehubConfig } {
  if (shared) return shared;
  const cfg = rizehubConfig();
  const mock = cfg.mock ? new MockRizehub({ keys: cfg.keys, jobDelayMs: 1500 }) : null;
  const opts: ClientOptions = { baseUrl: cfg.baseUrl, keys: cfg.keys, fetch: mock ? mockFetch(mock) : undefined };
  shared = { client: new RizehubClient(opts), mock, cfg };
  return shared;
}

/** Tests: replace (or reset with null) the shared client. */
export function setRizehubForTests(v: { client: RizehubClient; mock: MockRizehub | null; cfg: RizehubConfig } | null): void {
  shared = v;
}
