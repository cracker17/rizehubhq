// Injected dependencies for research/QA tools. Production wiring here; tests pass fakes via deps.research.
import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';
import { createServiceClient } from '../db';
import { getVaultBrowserSession } from '../vault/browser';
import { launchResearchChromium, type LaunchResearchBrowser, type VaultLikeSession } from './browser';
import { evidenceStore, type EvidenceStore } from './evidence';
import { defaultNetEnv, type NetEnv } from './net';
import { execFileText, type ExecFn } from './pagespeed';
import type { ApiFetch } from './search';

export interface ResearchEnv {
  net: NetEnv;
  /** Fetch for fixed, trusted API hosts (search, PageSpeed, Semrush, Figma, media gateway). */
  apiFetch: ApiFetch;
  launchBrowser: LaunchResearchBrowser;
  evidence: EvidenceStore;
  env: Record<string, string | undefined>;
  exec: ExecFn;
  workspacesDir: string;
  /** Logged-in vault session of this task run (vault_login), if any. */
  vaultSession: (run: object) => VaultLikeSession | null;
  /** Upper bound for the automatic QA evidence step. */
  qaEvidenceTimeoutMs: number;
}

let sb: SupabaseClient | null | undefined;
function storageClient(): SupabaseClient | null {
  if (sb !== undefined) return sb;
  sb = config.supabaseUrl && config.supabaseServiceKey ? createServiceClient() : null;
  return sb;
}

export function defaultResearchEnv(): ResearchEnv {
  return {
    net: defaultNetEnv(),
    apiFetch: (...a) => fetch(...a),
    launchBrowser: launchResearchChromium,
    evidence: evidenceStore({ workspacesDir: config.workspacesDir, supabase: storageClient }),
    env: process.env,
    exec: execFileText,
    workspacesDir: config.workspacesDir,
    vaultSession: (run) => getVaultBrowserSession(run) as unknown as VaultLikeSession | null,
    qaEvidenceTimeoutMs: Number(process.env.QA_EVIDENCE_TIMEOUT_MS ?? 150_000),
  };
}

/** deps.research (tests) overrides the production env field by field. */
export function researchEnvFrom(deps: unknown): ResearchEnv {
  const injected = (deps as { research?: Partial<ResearchEnv> }).research;
  return injected ? { ...defaultResearchEnv(), ...injected } : defaultResearchEnv();
}
