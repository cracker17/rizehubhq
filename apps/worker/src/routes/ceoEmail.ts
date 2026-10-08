// Admin → Connectors → Email me updates → "Send test email" (docs/15 §5c). x-hq-secret like every dashboard → worker
// call; the CEO check happens in the dashboard. Sends ONE test email to the address saved in settings.ceo_email, from
// the saved Gmail account; the body of the request is ignored (the recipient can't be chosen here). One test per 20 s.
import type { Route } from './types';
import { workerEnv } from '../config';
import { createServiceClient } from '../db';
import { loadKeyring } from '../vault/crypto';
import { createSupabaseConnectorStore } from '../connectors/store';
import { sendCeoTestEmail, supabaseCeoEmailDeps, type CeoEmailDeps } from '../notify/ceoEmail';

export const TEST_COOLDOWN_MS = 20_000;

export function createCeoEmailRoutes(deps: () => Omit<CeoEmailDeps, 'pending' | 'agentNames'>, now: () => number = Date.now): Route[] {
  let lastTest = 0;
  return [{
    method: 'POST', path: '/notify/ceo-email/test', auth: 'secret',
    handle: async () => {
      const t = now();
      if (t - lastTest < TEST_COOLDOWN_MS) return [429, { error: 'A test email was just sent. Wait a few seconds and try again.' }];
      lastTest = t;
      const r = await sendCeoTestEmail(deps());
      return [200, r];
    },
  }];
}

let cached: Omit<CeoEmailDeps, 'pending' | 'agentNames'> | null = null;
export const ceoEmailRoutes: Route[] = createCeoEmailRoutes(() => {
  if (cached) return cached;
  const sb = createServiceClient();
  const { settings, record } = supabaseCeoEmailDeps(sb);
  cached = {
    settings, record, store: createSupabaseConnectorStore(sb),
    keyring: (() => { try { return loadKeyring(workerEnv()); } catch { return null; } })(),
    dashboardUrl: (workerEnv().DASHBOARD_URL ?? 'https://hq.rizehub.ph').replace(/\/+$/, ''),
    log: (m) => console.log(m),
  };
  return cached;
});
