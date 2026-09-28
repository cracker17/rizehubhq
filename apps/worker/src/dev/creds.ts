// Token resolution for the dev tools. Tokens come from a Client Vault credential (grant + status checked by
// the vault store, decrypted only here, every use written to credential_access_log) or from a named worker
// env var (docs/09 "Where system secrets live"). The model only ever sees credential ids and results.
import { open } from '../vault/crypto';
import { isUuid, VaultDenied } from '../vault/store';
import { errMsg, log } from '../deps';
import type { ToolContext } from '../runner';
import type { DevEnv } from './env';
import type { Redactor } from './http';

export interface Token {
  token: string;
  source: 'vault' | 'env';
  envName?: string;
  credentialId?: string;
  username?: string | null;
  allowlist: string[];
  loginUrl?: string | null;
  scopeNotes?: string | null;
}

const DENY_TEXT: Record<string, string> = {
  'not granted': 'You are not granted this credential. Ask the CEO (ask_ceo) if you need it.',
  'credential not found': 'Unknown credential id. Call vault_list to see what you may use.',
  revoked: 'This credential was revoked. Ask the CEO for new access.',
  'check needed': 'This credential is flagged "check needed". Do not retry; the CEO has been asked.',
  'client archived': 'This client is archived; its access is revoked.',
};

export async function audit(ctx: ToolContext, env: DevEnv, credentialId: string | null, action: string, success: boolean, detail: Record<string, unknown>) {
  try {
    await env.vault.store().logAccess({ credentialId, agentId: ctx.task.agent_id, taskId: ctx.task.id, action, success, detail });
  } catch (e) {
    log(ctx.deps, `[${ctx.task.agent_id}] vault audit log failed`, errMsg(e));
  }
}

/** Returns the token (registered with the redactor) or a refusal text for the model. */
export async function vaultToken(
  ctx: ToolContext, env: DevEnv, red: Redactor, credentialId: string, platforms: string[], tool: string,
): Promise<Token | string> {
  if (!isUuid(credentialId)) return DENY_TEXT['credential not found']!;
  let c;
  try {
    c = await env.vault.store().getForAgent(credentialId, ctx.task.agent_id);
  } catch (e) {
    if (e instanceof VaultDenied) {
      await audit(ctx, env, e.message === 'credential not found' ? null : credentialId, 'denied', false, { tool, reason: e.message });
      return DENY_TEXT[e.message] ?? `Access denied: ${e.message}.`;
    }
    throw e;
  }
  if (!platforms.includes(c.platform.toLowerCase())) {
    await audit(ctx, env, c.id, 'denied', false, { tool, reason: 'wrong_platform', platform: c.platform });
    return `Refused: credential "${c.label}" is for ${c.platform}; ${tool} needs a ${platforms[0]} credential.`;
  }
  if (c.secret_type === 'ssh_key' || c.secret_type === 'password') {
    return `Credential "${c.label}" is a ${c.secret_type}; ${tool} needs an API token${platforms.includes('wordpress') ? ' or application password' : ''}.`;
  }
  const kr = env.vault.keyring();
  if (!kr) return 'The vault is not configured on the worker (VAULT_MASTER_KEY missing). Tell the CEO via ask_ceo.';
  const token = open(c.sealed, kr, c.id);
  red.add(token, c.username);
  return { token, source: 'vault', credentialId: c.id, username: c.username, allowlist: c.url_allowlist, loginUrl: c.login_url, scopeNotes: c.scope_notes };
}

export function envToken(env: DevEnv, red: Redactor, name: string): Token | null {
  const v = env.env[name]?.trim();
  if (!v) return null;
  red.add(v);
  return { token: v, source: 'env', envName: name, allowlist: [] };
}

/** Client slug of the task (for SHOPIFY_TOKEN_<SLUG> etc.), or null. */
export async function clientOf(ctx: ToolContext) {
  if (!ctx.task.client_id) return null;
  try { return await ctx.deps.db.getClient(ctx.task.client_id); } catch { return null; }
}

/** Standard reply for anything that must go through the CEO. */
export function externalAction(type: string, spec: string): string {
  return `Refused: this changes the live/outside world and is never done by agents. Propose it instead with `
    + `request_external_action({ type: "${type}", spec: ${JSON.stringify(spec)} }); the CEO approves and the worker executes it. Continue your task.`;
}
