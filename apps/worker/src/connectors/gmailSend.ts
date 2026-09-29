// Sends the emails the CEO approved (gmail.send approvals queued by tools/gmail.ts gmail_send, docs/15 §5). Exactly once:
// external_action_exec claim → done/failed (max 3 attempts). Right before sending it re-checks that the account is still
// connected, still allows sending, and is still granted to the agent that asked; otherwise it refuses for good.
import nodemailer from 'nodemailer';
import type { SupabaseClient } from '@supabase/supabase-js';
import { open, type Keyring } from '../vault/crypto';
import { connectorContext, type ConnectorStore } from './store';
import { GMAIL_SMTP, friendlyGmailError } from './gmail';

export interface GmailSendSpec {
  connector_id: string; account: string; agent_id: string; to: string; cc: string | null; subject: string; body: string; in_reply_to: string | null;
}
export interface SendApproval { id: string; payload: { attempts?: number; last_error?: { retryable?: boolean }; spec?: { gmail?: GmailSendSpec } } }
export type SmtpSend = (account: string, appPassword: string, m: GmailSendSpec) => Promise<{ messageId: string; accepted: string[]; rejected: string[] }>;

export interface GmailSendDeps {
  list: () => Promise<SendApproval[]>;
  exec: (approvalId: string, phase: 'claim' | 'done' | 'failed', result?: Record<string, unknown>) => Promise<boolean>;
  store: ConnectorStore;
  keyring: Keyring | null;
  send?: SmtpSend;
  log?: (msg: string) => void;
}

export const smtpSend: SmtpSend = async (account, pass, m) => {
  const t = nodemailer.createTransport({ ...GMAIL_SMTP, auth: { user: account, pass } });
  const info = await t.sendMail({
    from: account, to: m.to, cc: m.cc || undefined, subject: m.subject, text: m.body,
    ...(m.in_reply_to ? { inReplyTo: m.in_reply_to, references: m.in_reply_to } : {}),
  });
  return { messageId: String(info.messageId ?? ''), accepted: (info.accepted ?? []).map(String), rejected: (info.rejected ?? []).map(String) };
};

const MAX_ATTEMPTS = 3;
const refuse = (code: string, message: string) => ({ code, message, retryable: false });

export async function executeApprovedGmailSends(d: GmailSendDeps): Promise<number> {
  let sent = 0;
  for (const ap of await d.list()) {
    const spec = ap.payload.spec?.gmail;
    if (Number(ap.payload.attempts ?? 0) >= MAX_ATTEMPTS || ap.payload.last_error?.retryable === false) continue;
    if (!(await d.exec(ap.id, 'claim'))) continue;
    if (!spec?.connector_id || !spec.to || !spec.subject) { await d.exec(ap.id, 'failed', refuse('bad_spec', 'The approval has no email to send.')); continue; }
    const c = await d.store.get(spec.connector_id);
    const granted = c ? (await d.store.forAgent(spec.agent_id, 'gmail')).some((x) => x.id === c.id) : false;
    if (!c || c.kind !== 'gmail' || c.status !== 'active' || c.account_email !== spec.account) {
      await d.exec(ap.id, 'failed', refuse('account_unavailable', `${spec.account} is no longer connected and active. Nothing was sent.`)); continue;
    }
    if (c.settings.mode !== 'read_draft_send' || !granted) {
      await d.exec(ap.id, 'failed', refuse('access_changed', `Sending from ${spec.account} is no longer allowed for this agent. Nothing was sent.`)); continue;
    }
    if (!d.keyring || !c.sealed) { await d.exec(ap.id, 'failed', { code: 'no_keyring', message: 'VAULT_MASTER_KEY is not set on the worker.', retryable: true }); continue; }
    try {
      const pass = open(c.sealed, d.keyring, connectorContext(c.id));
      const info = await (d.send ?? smtpSend)(c.account_email, pass, spec);
      await d.store.mark(c.id, 'active', null, true).catch(() => undefined);
      await d.exec(ap.id, 'done', { message_id: info.messageId, accepted: info.accepted, rejected: info.rejected, sent_at: new Date().toISOString(), from: c.account_email });
      sent++;
      d.log?.(`[gmail] sent approval ${ap.id} from ${c.account_email}`);
    } catch (e) {
      const f = friendlyGmailError(e);
      if (f.reauth) await d.store.mark(c.id, 'needs_reauth', f.message).catch(() => undefined);
      await d.exec(ap.id, 'failed', { code: f.reauth ? 'auth' : 'smtp', message: f.message, retryable: !f.reauth }).catch(() => false);
      d.log?.(`[gmail] approval ${ap.id} not sent: ${f.message}`);
    }
  }
  return sent;
}

/** Approved gmail.send approvals of the last 14 days that haven't run yet (service role). */
export function listApprovedGmailSends(sb: SupabaseClient, limit = 10) {
  return async (): Promise<SendApproval[]> => {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const { data, error } = await sb.from('approvals').select('id,payload').eq('kind', 'external_action').eq('status', 'approved')
      .eq('payload->>action_type', 'gmail.send').gte('decided_at', since).order('decided_at').limit(limit * 4);
    if (error) throw new Error(`approvals: ${error.message}`);
    return ((data ?? []) as SendApproval[]).filter((a) => !('executed_at' in (a.payload ?? {}))).slice(0, limit);
  };
}

/** Production timer (index.ts): every 15 s, skipped while the CEO has paused HQ (settings.paused). */
export function startGmailSender(o: { deps: GmailSendDeps; paused: () => Promise<boolean>; everyMs?: number }): NodeJS.Timeout {
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => { if (!(await o.paused())) await executeApprovedGmailSends(o.deps); })()
      .catch((e) => o.deps.log?.(`[gmail] send loop failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { busy = false; });
  }, o.everyMs ?? 15_000);
  t.unref?.();
  return t;
}
