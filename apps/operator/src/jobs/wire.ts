// How index.ts builds worker mode's dependencies (docs/17-OPERATOR.md "Phase 2: worker mode"). Small and pure where it
// can be: the token lookup order and the terminal gate are tested in wire.test.ts.
import type { Keyring } from 'worker/src/vault/crypto';
import type { Token } from 'worker/src/dev/creds';
import type { SandboxStatus } from 'worker/src/dev/agentUser';
import { envTokenName, type Platform, type TokenSource } from './apis';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * A client's API token: the Client Vault credential linked with operator_set_credential first, else
 * OPERATOR_<PLATFORM>_TOKEN_<CLIENT> from .env.operator. A vault error falls through to the env (logged, never the token).
 */
export function tokenSource(o: {
  vaultToken: (client: string, platform: Platform, keyring: Keyring | null) => Promise<Token | null>;
  keyring: () => Keyring | null;
  env: () => Env;
  log?: (m: string) => void;
}): TokenSource {
  return async (client, platform) => {
    try {
      const t = await o.vaultToken(client, platform, o.keyring());
      if (t) return t;
    } catch (e) {
      o.log?.(`[operator] vault ${platform} token for ${client}: ${e instanceof Error ? e.message : e}`);
    }
    const name = envTokenName(platform, client);
    const v = o.env()[name]?.trim();
    return v ? { token: v, source: 'env', envName: name, allowlist: [] } : null;
  };
}

/** The job terminal exists only when agent commands cannot read the operator's secrets (privilege drop / OS sandbox). */
export function terminalAllowed(s: Pick<SandboxStatus, 'isolated' | 'refusal'>): boolean {
  return s.isolated && !s.refusal;
}

/** Job ids are uuids; the jail folder name must match openJail's SAFE_TASK_ID. */
export const jailName = (jobId: string) => `job-${jobId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 72)}`;

/** Daily housekeeping is due once per Manila calendar day (UTC+8, no DST). */
export function dailyDue(lastIso: string | null, nowMs: number): boolean {
  const day = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
  return !lastIso || day(Date.parse(lastIso)) !== day(nowMs);
}
