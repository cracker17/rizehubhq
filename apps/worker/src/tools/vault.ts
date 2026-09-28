// Client Vault tools (M9a, docs/04 "Client Vault tools", docs/09). The model never sees a secret:
// the worker decrypts at call time, adds the token / fills the login itself and returns only results
// (redacted). Every use is written to credential_access_log (+ activity_log) through the store.
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ToolFactory } from './types';
import type { ToolContext } from '../runner';
import { createServiceClient } from '../db';
import { errMsg, log } from '../deps';
import { loadKeyring, open, type Keyring } from '../vault/crypto';
import { workerEnv } from '../config';
import {
  authHeaderFromScope, hasMethodOverride, loginEntry, maskUsername, METHOD_OVERRIDE_HEADERS, publishBlocked, redact, safeUrl,
  secretVariants, urlAllowed, writeAllowed,
} from '../vault/guards';
import { createSupabaseVaultStore, isUuid, VaultDenied, type CredentialForUse, type VaultStore } from '../vault/store';
import {
  BrowserUnavailable, closeCredentialSession, closeSession, getVaultBrowserSession, launchPlaywright, openSession, performLogin,
  registerSession, submitOtp, type LaunchBrowser,
} from '../vault/browser';

export interface VaultToolEnv {
  store: () => VaultStore;
  keyring: () => Keyring | null;
  fetch: typeof fetch;
  launchBrowser: LaunchBrowser;
  /** How long vault_request_2fa waits for the CEO's code. */
  twofaTimeoutMs: number;
  twofaPollMs: number;
  sleep: (ms: number) => Promise<void>;
}

const MAX_BODY_OUT = 6000;
const BLOCKED_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'host', 'content-length', 'connection', 'transfer-encoding',
  ...METHOD_OVERRIDE_HEADERS]);
const DENY_TEXT: Record<string, string> = {
  'not granted': 'You are not granted this credential. Ask the CEO (ask_ceo) if you need it.',
  'credential not found': 'Unknown credential id. Call vault_list to see what you may use.',
  revoked: 'This credential was revoked. Ask the CEO for new access.',
  'check needed': 'This credential is flagged "check needed" (failed logins or a reported problem). Do not retry; the CEO has been asked.',
  'client archived': 'This client is archived; its access is revoked.',
};

let lazyStore: VaultStore | null = null;
/** Production wiring: service-role Supabase + VAULT_MASTER_KEY from the worker env, real fetch, Playwright. */
export function defaultVaultToolEnv(): VaultToolEnv {
  return {
    store: () => (lazyStore ??= createSupabaseVaultStore(createServiceClient())),
    keyring: () => loadKeyring(workerEnv()),
    fetch: (...a) => fetch(...a),
    launchBrowser: launchPlaywright,
    twofaTimeoutMs: 10 * 60_000,
    twofaPollMs: 4000,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export function createVaultTools(ctx: ToolContext, env: VaultToolEnv): ToolSet {
  const { task, deps, state } = ctx;
  const agent = task.agent_id;

  async function audit(credentialId: string | null, action: string, success: boolean, detail: Record<string, unknown> = {}) {
    try {
      await env.store().logAccess({ credentialId, agentId: agent, taskId: task.id, action, success, detail });
    } catch (e) {
      log(deps, `[${agent}] vault audit log failed`, errMsg(e));
    }
  }

  /** Grant + status check. Returns the credential or the text to hand back to the agent. */
  async function use(credentialId: string, action: string): Promise<CredentialForUse | string> {
    if (!isUuid(credentialId)) return DENY_TEXT['credential not found']!;
    try {
      return await env.store().getForAgent(credentialId, agent);
    } catch (e) {
      if (e instanceof VaultDenied) {
        await audit(e.message === 'credential not found' ? null : credentialId, 'denied', false, { tool: action, reason: e.message });
        return DENY_TEXT[e.message] ?? `Access denied: ${e.message}.`;
      }
      throw e;
    }
  }

  function decrypt(c: CredentialForUse): string {
    const kr = env.keyring();
    if (!kr) throw new Error('The vault is not configured on the worker (VAULT_MASTER_KEY missing). Tell the CEO via ask_ceo.');
    return open(c.sealed, kr, c.id);
  }

  /** Close the 2FA question so a late answer is refused and no code lingers (best effort). */
  async function expire(approvalId: string) {
    try { await env.store().expire2fa(approvalId); } catch (e) { log(deps, `[${agent}] vault 2FA expire failed`, errMsg(e)); }
  }

  const isOver = async () => state.ended !== null || (await deps.db.getTask(task.id))?.status !== 'working';

  return {
    vault_list: tool({
      description: 'List the client logins/API tokens you are granted (metadata only, never secrets). '
        + 'Defaults to this task\'s client. Use the returned credential_id with vault_api or vault_login.',
      inputSchema: z.object({ client: z.string().max(120).optional().describe('Client slug or name; omit for the task\'s client') }),
      execute: async ({ client }) => {
        const ref = client?.trim() || task.client_id;
        if (!ref) return 'This task has no client. Pass `client` (slug or name).';
        const clientId = await env.store().resolveClientId(ref);
        if (!clientId) return `No client "${ref}".`;
        const list = await env.store().listForAgent(agent, clientId);
        await audit(null, 'list', true, { client_id: clientId, granted: list.granted.length });
        if (list.client.status === 'archived') return `${list.client.name} is archived; no access.`;
        const lines = list.granted.map((c) => [
          `- credential_id ${c.id} · ${c.platform} · "${c.label}"`,
          `  type ${c.secret_type} · user ${maskUsername(c.username)} · 2FA ${c.twofa_method} · status ${c.status}`
            + (c.login_url ? ` · login ${c.login_url}` : ''),
          `  allowed URLs: ${c.url_allowlist.length ? c.url_allowlist.join(', ') : '(none: vault_api disabled; vault_login only on the login site)'}`,
          `  API writes: ${c.write_allowlist?.length ? c.write_allowlist.join(', ') : 'none (read-only: GET/HEAD)'}`,
          c.scope_notes ? `  scope (follow strictly): ${c.scope_notes}` : '',
        ].filter(Boolean).join('\n'));
        const head = `${list.client.name}: ${list.granted.length} credential(s) granted to you.`;
        const tail = list.not_granted ? `\n${list.not_granted} other credential(s) exist for this client that you are not granted; ask_ceo if you need one.` : '';
        return `${head}\n${lines.join('\n')}${tail}`;
      },
    }),

    vault_api: tool({
      description: 'Call a client API with a stored token. The worker adds the credential itself (Authorization: Bearer, '
        + 'or the header named in the scope notes); you only get the response. The URL must be on the credential\'s allowlist. '
        + 'Read-only (GET/HEAD) unless the CEO listed that exact write ("PUT /path") for the credential (see vault_list). '
        + 'Publishing (theme role, site publish, status=publish) and DELETE are never allowed here: use request_external_action.',
      inputSchema: z.object({
        credential_id: z.string(),
        request: z.object({
          method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
          url: z.string().max(4000),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.string().max(200_000).optional().describe('Request body (JSON as a string)'),
        }),
      }),
      execute: async ({ credential_id, request }) => {
        const c = await use(credential_id, 'vault_api');
        if (typeof c === 'string') return c;
        const u = safeUrl(request.url);
        if (!u) return 'Refused: the URL must be https (no embedded credentials).';
        if (!c.url_allowlist.length || !urlAllowed(u, c.url_allowlist)) {
          await audit(c.id, 'denied', false, { tool: 'vault_api', reason: 'url_not_allowlisted', host: u.host, path: u.pathname });
          return `Refused: ${u.origin}${u.pathname} is not on this credential's allowlist (${c.url_allowlist.join(', ') || 'empty'}).`;
        }
        if (request.method === 'DELETE') {
          await audit(c.id, 'denied', false, { tool: 'vault_api', reason: 'delete_needs_approval', host: u.host, path: u.pathname });
          return 'Refused: deletes change the outside world. Propose it with request_external_action; the CEO decides.';
        }
        if (hasMethodOverride(u)) {
          await audit(c.id, 'denied', false, { tool: 'vault_api', reason: 'method_override', host: u.host, path: u.pathname });
          return 'Refused: method overrides (_method=…) are not allowed. Use the real method.';
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          const publish = publishBlocked(request.method, u, request.body);
          if (publish) {
            await audit(c.id, 'denied', false, { tool: 'vault_api', reason: 'publish_needs_approval', method: request.method, host: u.host, path: u.pathname });
            return `Refused: ${publish} makes changes live for the public. Propose it with request_external_action `
              + '(describe exactly what to publish); the CEO approves and the worker runs it.';
          }
          if (!writeAllowed(request.method, u, c.write_allowlist ?? [])) {
            await audit(c.id, 'denied', false, { tool: 'vault_api', reason: 'write_not_allowlisted', method: request.method, host: u.host, path: u.pathname });
            return `Refused: this credential is read-only for ${request.method} ${u.pathname}. `
              + `Allowed writes: ${c.write_allowlist?.length ? c.write_allowlist.join(', ') : 'none'}. `
              + 'Ask the CEO to allow it (ask_ceo) or propose the change with request_external_action.';
          }
        }
        if (c.secret_type === 'ssh_key') return 'This credential is an SSH key; it cannot be used for HTTP APIs.';

        let secret = '';
        let variants: string[] = [];
        try {
          secret = decrypt(c);
          variants = secretVariants(secret, c.username);
          const scopeHeader = authHeaderFromScope(c.scope_notes)?.toLowerCase() ?? null;
          const headers = new Headers();
          for (const [k, v] of Object.entries(request.headers ?? {})) {
            const name = k.toLowerCase();
            if (BLOCKED_HEADERS.has(name) || name === scopeHeader || !/^[a-z0-9-]{1,64}$/.test(name)) continue;
            headers.set(name, v);
          }
          const basic = c.secret_type === 'app_password' || /\bauth\s*[:=]\s*basic\b/i.test(c.scope_notes ?? '');
          if (basic) headers.set('authorization', `Basic ${Buffer.from(`${c.username ?? ''}:${secret}`).toString('base64')}`);
          else if (scopeHeader) headers.set(scopeHeader, secret);
          else headers.set('authorization', `Bearer ${secret}`);
          if (request.body && !headers.has('content-type') && /^\s*[[{]/.test(request.body)) headers.set('content-type', 'application/json');

          const res = await env.fetch(u.toString(), {
            method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
            redirect: 'manual', signal: AbortSignal.timeout(30_000),
          });
          const text = request.method === 'HEAD' ? '' : await res.text();
          const location = res.headers.get('location');
          const ok = res.status < 400;
          await audit(c.id, 'api_call', ok, { method: request.method, host: u.host, path: u.pathname, status: res.status });
          const body = redact(text.length > MAX_BODY_OUT ? `${text.slice(0, MAX_BODY_OUT)}\n…[truncated ${text.length - MAX_BODY_OUT} chars]` : text, variants);
          const hint = res.status === 401 || res.status === 403
            ? '\nAuth was refused. If the token is wrong or expired, call vault_report_problem; do not keep retrying.' : '';
          const head = [`HTTP ${res.status} ${res.statusText}`.trim(), `content-type: ${res.headers.get('content-type') ?? 'unknown'}`];
          if (location) head.push(`location: ${location} (redirects are not followed; call the new URL if it is allowlisted)`);
          return redact(`${head.join('\n')}\n\n${body}${hint}`, variants);
        } catch (e) {
          await audit(c.id, 'api_call', false, { method: request.method, host: u.host, path: u.pathname, error: redact(errMsg(e), variants).slice(0, 200) });
          return `Request failed: ${redact(errMsg(e), variants)}`;
        } finally {
          secret = '';
        }
      },
    }),

    vault_login: tool({
      description: 'Log in to a client site with a stored login. The worker opens an isolated browser, fills the username and '
        + 'password itself and keeps the logged-in session for this task (browser tools reuse it). Navigation is limited to the '
        + 'credential\'s allowlist. Never retries a failed login more than once.',
      inputSchema: z.object({
        credential_id: z.string(),
        url: z.string().max(2000).optional().describe('Login page; defaults to the credential\'s login URL'),
      }),
      execute: async ({ credential_id, url }) => {
        const c = await use(credential_id, 'vault_login');
        if (typeof c === 'string') return c;
        if (c.secret_type === 'api_token' || c.secret_type === 'ssh_key') return `This credential is ${c.secret_type}; use vault_api instead.`;
        const allow = [...c.url_allowlist, ...loginEntry(c.login_url)];
        const target = safeUrl(url ?? c.login_url ?? '');
        if (!target) return 'No valid https login URL. Pass `url` or ask the CEO to set one.';
        if (!urlAllowed(target, allow)) {
          await audit(c.id, 'denied', false, { tool: 'vault_login', reason: 'url_not_allowlisted', host: target.host });
          return `Refused: ${target.origin}${target.pathname} is not on this credential's allowlist (${allow.join(', ')}).`;
        }
        const existing = getVaultBrowserSession(state, c.id);
        if (existing?.state === 'logged_in') return `Already logged in to ${c.label} in this task; keep using that session.`;
        if (existing) await closeCredentialSession(state, c.id);

        let secret = '';
        let variants: string[] = [];
        let session: Awaited<ReturnType<typeof openSession>> | null = null;
        try {
          secret = decrypt(c);
          variants = secretVariants(secret, c.username);
          session = await openSession(env.launchBrowser, {
            credentialId: c.id, label: c.label, host: target.host, allow, isAllowed: (u) => urlAllowed(u, allow),
          });
          const outcome = await performLogin(session.page, target.toString(), c.username, secret);
          secret = '';
          const who = `${maskUsername(c.username)} at ${target.host}`;
          if (outcome === 'ok') {
            registerSession(state, session, isOver);
            await audit(c.id, 'login', true, { host: target.host });
            return `Logged in as ${who}. The session stays open for this task (closed automatically when it ends). `
              + `Stay within: ${allow.join(', ')}.${c.scope_notes ? ` Scope: ${c.scope_notes}` : ''} `
              + 'Anything risky (publish, delete, settings, payments) needs request_external_action.';
          }
          if (outcome === 'needs_2fa') {
            session.state = 'needs_2fa';
            registerSession(state, session, isOver);
            await audit(c.id, 'login', true, { host: target.host, stage: 'needs_2fa' });
            return `The site asks for a one-time code (${c.twofa_method}). Call vault_request_2fa("${c.id}"); the CEO will send it.`;
          }
          const s = session;
          session = null;
          await closeSession(s);
          if (outcome === 'failed') {
            await audit(c.id, 'failed_login', false, { host: target.host });
            const again = c.failed_login_count + 1 < 2;
            return again
              ? 'Login failed (the site kept the password form). You may try once more; if it fails again the credential is flagged and the CEO is asked.'
              : 'Login failed twice. The credential is now flagged "check needed" and the CEO was asked. Do not retry; continue without it or ask_ceo.';
          }
          await audit(c.id, 'login', false, { host: target.host, reason: 'no_login_form' });
          return `No login form found at ${target.origin}${target.pathname}. Check the URL (vault_list shows the login URL).`;
        } catch (e) {
          if (session) await closeSession(session);
          if (e instanceof BrowserUnavailable) {
            await audit(c.id, 'login', false, { host: target.host, reason: 'browser_unavailable' });
            return `Browser automation is not available on the worker: ${e.message} Use vault_api if there is an API token, or ask_ceo.`;
          }
          const msg = redact(errMsg(e), variants);
          await audit(c.id, 'login', false, { host: target.host, error: msg.slice(0, 200) });
          return `Login error: ${msg}`;
        } finally {
          secret = '';
        }
      },
    }),

    vault_request_2fa: tool({
      description: 'The login is waiting for a one-time code: ask the CEO (Telegram) and wait for it. The worker types the code '
        + 'itself; you never see it. Call only after vault_login said a code is needed.',
      inputSchema: z.object({ credential_id: z.string() }),
      execute: async ({ credential_id }) => {
        const c = await use(credential_id, 'vault_request_2fa');
        if (typeof c === 'string') return c;
        const s = getVaultBrowserSession(state, c.id);
        if (!s || s.state !== 'needs_2fa') return 'No login is waiting for a code. Call vault_login first.';
        const via: Record<string, string> = { sms: 'by SMS', email: 'by email', app: 'in the authenticator app', collaborator: 'to the collaborator account', none: '' };
        const question = `${ctx.role.name} is logging in to ${c.label} (${s.host}) as ${maskUsername(c.username)} and the site wants a one-time code`
          + `${via[c.twofa_method] ? ` sent ${via[c.twofa_method]}` : ''}. Reply with the code only.`;
        const approvalId = await env.store().request2fa(c.id, agent, task.id, question);
        s.busy = true;
        try {
          const until = Date.now() + env.twofaTimeoutMs;
          for (;;) {
            const ans = await env.store().take2faCode(approvalId);
            if (ans.status === 'approved' && typeof ans.code === 'string' && ans.code) {
              let code = ans.code.replace(/\s+/g, '');
              if (!/^[A-Za-z0-9-]{4,12}$/.test(code)) {
                code = '';
                return 'The CEO\'s reply did not look like a one-time code. Call vault_request_2fa again.';
              }
              const outcome = await submitOtp(s.page, code);
              code = '';
              s.lastUsedAt = Date.now();
              if (outcome === 'ok') {
                s.state = 'logged_in';
                await audit(c.id, 'twofa', true, { host: s.host });
                return `Code accepted. Logged in as ${maskUsername(c.username)} at ${s.host}; the session stays open for this task.`;
              }
              await audit(c.id, 'failed_login', false, { host: s.host, stage: '2fa' });
              await closeCredentialSession(state, c.id);
              return 'The code was not accepted (expired or mistyped). Call vault_login again once; if it keeps failing, vault_report_problem.';
            }
            if (ans.status !== 'pending') {
              await expire(approvalId);
              await closeCredentialSession(state, c.id);
              return 'The CEO did not provide a code. Continue without this login or ask_ceo.';
            }
            if (Date.now() >= until) {
              await expire(approvalId);
              await closeCredentialSession(state, c.id);
              return `No code within ${Math.round(env.twofaTimeoutMs / 60_000)} minutes; the login was closed. Continue without it or try later.`;
            }
            await env.sleep(env.twofaPollMs);
          }
        } finally {
          s.busy = false;
        }
      },
    }),

    vault_report_problem: tool({
      description: 'Report that a credential does not work (wrong password, expired token, locked account, missing permission). '
        + 'Flags it "check needed" and asks the CEO. Then stop using it.',
      inputSchema: z.object({ credential_id: z.string(), issue: z.string().min(3).max(1000) }),
      execute: async ({ credential_id, issue }) => {
        if (!isUuid(credential_id)) return DENY_TEXT['credential not found']!;
        try {
          const id = await env.store().reportProblem(credential_id, agent, task.id, issue);
          await closeCredentialSession(state, credential_id);
          return `Reported. The credential is flagged "check needed" and the CEO was asked (approval ${id}). Don't use it again in this task.`;
        } catch (e) {
          if (e instanceof VaultDenied) return DENY_TEXT[e.message] ?? `Access denied: ${e.message}.`;
          throw e;
        }
      },
    }),
  };
}

/** Tests inject `deps.vault` (fake store, fetch, browser); production uses the worker env. */
export const vaultTools: ToolFactory = (ctx) => {
  const injected = (ctx.deps as { vault?: Partial<VaultToolEnv> }).vault;
  return createVaultTools(ctx, { ...defaultVaultToolEnv(), ...injected });
};
