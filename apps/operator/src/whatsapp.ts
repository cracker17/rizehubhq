// WhatsApp Business through Meta's Cloud API (docs/17-OPERATOR.md "WhatsApp Business"). Pure parts (tested): the
// webhook signature check, turning a webhook into messages, the 24 h window, the send request. The webhook reaches the
// operator through the dashboard (public /api/operator/whatsapp → http://hq-operator:4200/hooks/whatsapp); the app
// secret and the access tokens live only in .env.operator.
//
//   OPERATOR_WHATSAPP_APP_SECRET        Meta app secret: X-Hub-Signature-256 of every webhook POST
//   OPERATOR_WHATSAPP_VERIFY_TOKEN      the "verify token" typed in Meta's webhook settings (GET handshake)
//   OPERATOR_WHATSAPP_TOKEN[_<CLIENT>]  access token (system user) for sending; per client, else the shared one
//   OPERATOR_WHATSAPP_GRAPH_VERSION     Graph API version (default v23.0)
import { createHmac, timingSafeEqual } from 'node:crypto';
import { envSlug } from 'worker/src/dev/env';

type Env = Readonly<Record<string, string | undefined>>;

export const WINDOW_MS = 24 * 3600_000;

/** X-Hub-Signature-256 = "sha256=" + hex HMAC of the raw body with the app secret. */
export function verifyMetaSignature(raw: Buffer, header: string | null | undefined, secret: string): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header ?? '').trim());
  if (!m || !secret) return false;
  const want = createHmac('sha256', secret).update(raw).digest();
  const got = Buffer.from(m[1]!, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface WaInbound {
  phoneId: string;
  msg: { external_id: string; thread_key: string; sender_name: string; body: string; sent_at: string | null; from_me: false };
}

/** What we store of a message: its text, or a short description of media (with the caption). */
function bodyOf(m: Record<string, any>): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (m.type) {
    case 'text': return String(m.text?.body ?? '');
    case 'button': return String(m.button?.text ?? '');
    case 'interactive': return String(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '[interactive reply]');
    case 'reaction': return '';
    case 'location': return `[location] ${[m.location?.name, m.location?.address].filter(Boolean).join(', ')}`.trim();
    case 'image': case 'video': case 'document': case 'audio': case 'sticker': {
      const media = m[m.type] ?? {};
      return `[${m.type}${media.filename ? `: ${media.filename}` : ''}]${media.caption ? ` ${media.caption}` : ''}`;
    }
    default: return `[${String(m.type ?? 'message')}]`;
  }
}

/** Every customer message in a webhook payload (statuses, reactions and empty messages are skipped). */
export function parseWebhook(payload: unknown): WaInbound[] {
  const out: WaInbound[] = [];
  const p = payload as { object?: string; entry?: { changes?: { field?: string; value?: any }[] }[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (p?.object !== 'whatsapp_business_account') return out;
  for (const e of p.entry ?? []) {
    for (const c of e.changes ?? []) {
      if (c.field !== 'messages') continue;
      const v = c.value ?? {};
      const phoneId = String(v.metadata?.phone_number_id ?? '');
      if (!/^\d{6,30}$/.test(phoneId)) continue;
      const names = new Map<string, string>((v.contacts ?? []).map((x: any) => [String(x.wa_id), String(x.profile?.name ?? '')])); // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const m of v.messages ?? []) {
        const body = bodyOf(m).trim();
        const from = String(m.from ?? '');
        if (!body || !m.id || !/^\d{6,20}$/.test(from)) continue;
        const ts = Number(m.timestamp);
        out.push({ phoneId, msg: { external_id: String(m.id).slice(0, 300), thread_key: from, sender_name: names.get(from) || `+${from}`,
          body: body.slice(0, 20000), sent_at: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null, from_me: false } });
      }
    }
  }
  return out;
}

/** Free-form replies are allowed only within 24 h of the customer's last message. */
export function windowOpen(lastInbound: string | null, now = Date.now()): boolean {
  return !!lastInbound && now - new Date(lastInbound).getTime() < WINDOW_MS;
}

export function whatsappToken(env: Env, client: string): string | null {
  return (env[`OPERATOR_WHATSAPP_TOKEN_${envSlug(client)}`] ?? env.OPERATOR_WHATSAPP_TOKEN ?? '').trim() || null;
}

/** The Graph API call that sends one text reply, quoting the customer's message when we have its id. */
export function sendRequest(o: { env: Env; phoneId: string; to: string; text: string; replyTo: string | null; token: string }): { url: string; init: RequestInit } {
  const v = /^v\d{1,3}\.\d$/.test(o.env.OPERATOR_WHATSAPP_GRAPH_VERSION ?? '') ? o.env.OPERATOR_WHATSAPP_GRAPH_VERSION! : 'v23.0';
  const body: Record<string, unknown> = { messaging_product: 'whatsapp', recipient_type: 'individual', to: o.to, type: 'text', text: { body: o.text, preview_url: true } };
  if (o.replyTo && o.replyTo.startsWith('wamid.')) body.context = { message_id: o.replyTo };
  return {
    url: `https://graph.facebook.com/${v}/${encodeURIComponent(o.phoneId)}/messages`,
    init: { method: 'POST', headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) },
  };
}

/** Not sent and retrying will not help (no contact, no token, window closed): failed once, with the reason. */
export class WhatsAppRefusal extends Error { readonly final = true; }

/**
 * Sends one approved reply. Order: the 24 h window → the last database check (pauses) → one POST. A network failure
 * after the request left is "may have been sent" (never retried); an API error is a plain failure with Meta's message.
 */
export async function sendWhatsApp(o: {
  env: Env; client: string; phoneId: string; to: string | null; text: string; replyTo: string | null;
  lastInbound: () => Promise<string | null>; lastCheck: () => Promise<string | null>;
  fetch: typeof fetch; maySent: (m: string) => Error; now?: number;
}): Promise<{ sent: boolean; quoted: boolean; inThread: boolean; mentionsLinked: number; wamid?: string }> {
  if (!o.to || !/^\d{6,20}$/.test(o.to)) throw new WhatsAppRefusal('no WhatsApp contact to reply to (this update has no customer message)');
  const token = whatsappToken(o.env, o.client);
  if (!token) throw new WhatsAppRefusal(`no WhatsApp access token: set OPERATOR_WHATSAPP_TOKEN_${envSlug(o.client)} or OPERATOR_WHATSAPP_TOKEN`);
  if (!windowOpen(await o.lastInbound(), o.now)) {
    throw new WhatsAppRefusal('outside WhatsApp\'s 24 h window (the customer last wrote more than 24 h ago): only a template message can be sent; reply yourself in WhatsApp Manager');
  }
  const why = await o.lastCheck();
  if (why) return { sent: false, quoted: false, inThread: false, mentionsLinked: 0 };
  const { url, init } = sendRequest({ env: o.env, phoneId: o.phoneId, to: o.to, text: o.text, replyTo: o.replyTo, token });
  let res: Response;
  try { res = await o.fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }); }
  catch (e) { throw o.maySent(`WhatsApp did not answer (${e instanceof Error ? e.message : e}): it may have been sent, check WhatsApp before resending`); }
  const j = await res.json().catch(() => ({})) as { messages?: { id?: string }[]; error?: { message?: string; code?: number } };
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}${j.error?.code ? ` (${j.error.code})` : ''}: ${String(j.error?.message ?? 'error').replace(token, '…').slice(0, 300)}`);
  return { sent: true, quoted: !!o.replyTo, inThread: false, mentionsLinked: 0, wamid: j.messages?.[0]?.id };
}
