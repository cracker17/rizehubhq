// External alerts (supabase/migrations/20261022000000_external_alerts.sql): other apps (Hushdesk first) tell the CEO
// about problems through HQ.
//   POST /hooks/notify (auth 'self', reached through the dashboard's public /api/notify): X-HQ-Signature = hex
//   HMAC-SHA256(HQ_NOTIFY_SECRET, rawBody), X-HQ-Timestamp = unix seconds (5-minute window). Body
//   { id, source, level, title, body?, url? }; stored once by id. The bot sends it to Telegram; this file emails it
//   through "Email me updates" (same Gmail account and address as the CEO copies, only when "failures" is on).
// The uptime watch (UPTIME_URLS) writes here too: a site that is down can't report itself.
import type http from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ceoEmailReady, isEmailAddress, parseCeoEmailSettings } from '@rizehubhq/shared';
import { errMsg } from '../deps';
import { verifyHmacSignature, type SignatureNames } from '../rizehub/webhook';
import { friendlyGmailError } from '../connectors/gmail';
import { openAccount, smtpSendCeo, type CeoEmailDeps, type CeoMail } from './ceoEmail';
import { esc, safeUrl, S } from './markdown';

export const NOTIFY_NAMES: SignatureNames = { signature: 'x-hq-signature', timestamp: 'x-hq-timestamp', secretName: 'HQ_NOTIFY_SECRET' };
export const ALERT_LEVELS = ['info', 'warning', 'error', 'critical'] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];
export const NOTIFY_MAX_BODY = 16 * 1024;

export interface ExternalAlert { id: string; source: string; level: AlertLevel; title: string; body: string; url: string | null }
export interface StoredAlert extends ExternalAlert { received_at: string }

export interface AlertStore {
  /** Inserts once; a repeat id is a duplicate (the sender retried). */
  insert(a: ExternalAlert): Promise<{ duplicate: boolean }>;
  unsentEmail(limit: number): Promise<StoredAlert[]>;
  markEmailed(id: string, error: string | null): Promise<void>;
}

// ---------- parsing (pure) ----------
const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

export function parseAlert(raw: unknown): { ok: true; alert: ExternalAlert } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'body must be an object' };
  const b = raw as Record<string, unknown>;
  if (typeof b.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(b.id)) return { ok: false, error: 'id is required ([A-Za-z0-9_.:-], ≤ 120)' };
  if (typeof b.source !== 'string' || !/^[a-z0-9-]{1,40}$/.test(b.source)) return { ok: false, error: 'source is required (a-z, 0-9, -)' };
  if (typeof b.level !== 'string' || !(ALERT_LEVELS as readonly string[]).includes(b.level)) return { ok: false, error: `level must be ${ALERT_LEVELS.join(' | ')}` };
  if (typeof b.title !== 'string' || !b.title.trim()) return { ok: false, error: 'title is required' };
  if (b.body !== undefined && typeof b.body !== 'string') return { ok: false, error: 'body must be text' };
  let url: string | null = null;
  if (b.url !== undefined && b.url !== null) {
    url = typeof b.url === 'string' ? safeUrl(b.url) : null;
    if (!url || !url.startsWith('https://') || url.length > 500) return { ok: false, error: 'url must be an https:// link' };
  }
  return {
    ok: true,
    alert: { id: b.id, source: b.source, level: b.level as AlertLevel, title: oneLine(b.title, 200), body: String(b.body ?? '').trim().slice(0, 4000), url },
  };
}

// ---------- POST /hooks/notify ----------
export interface NotifyEnv { store: Pick<AlertStore, 'insert'>; secret: string }

let bound: NotifyEnv | null = null;
/** Called by the worker on start (the route itself is registered statically in routes/index.ts). */
export function bindNotify(store: NotifyEnv['store'], secret: string): void { bound = { store, secret }; }

export function createNotifyHandler(get: () => NotifyEnv | null = () => bound, now: () => number = Date.now) {
  return async (req: http.IncomingMessage, raw: Buffer): Promise<[number, unknown]> => {
    const env = get();
    if (!env) return [503, { error: 'worker is starting; retry' }];
    if (!env.secret) return [503, { error: 'HQ_NOTIFY_SECRET is not configured' }];
    const v = verifyHmacSignature(raw, req.headers, env.secret, now(), NOTIFY_NAMES);
    if (!v.ok) {
      console.warn(`[notify] rejected alert: ${v.reason}`);
      return [401, { error: 'invalid signature', reason: v.reason }];
    }
    let body: unknown;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return [400, { error: 'invalid JSON' }]; }
    const p = parseAlert(body);
    if (!p.ok) return [400, { error: p.error }];
    try {
      const r = await env.store.insert(p.alert);
      return [202, { ok: true, id: p.alert.id, duplicate: r.duplicate }];
    } catch (e) {
      return [500, { error: `could not store the alert: ${errMsg(e)}` }];
    }
  };
}

// ---------- email ----------
const LEVEL_ICON: Record<AlertLevel, string> = { info: 'ℹ️', warning: '⚠️', error: '❗', critical: '🚨' };
const LEVEL_COLOR: Record<AlertLevel, string> = { info: '#475467', warning: '#B54708', error: '#B42318', critical: '#B42318' };
const titleCase = (s: string) => s.replace(/(^|-)([a-z])/g, (_, d: string, c: string) => `${d ? ' ' : ''}${c.toUpperCase()}`);

export function buildAlertEmail(a: StoredAlert): Omit<CeoMail, 'to'> {
  const app = titleCase(a.source);
  const subject = `${LEVEL_ICON[a.level]} ${app} ${a.level}: ${oneLine(a.title, 140)}`;
  const href = a.url ? safeUrl(a.url) : null;
  const text = `${app} · ${a.level}\n\n${a.title}\n\n${a.body}${href ? `\n\nOpen: ${href}` : ''}\n`;
  const paras = a.body.split(/\n{2,}/).filter(Boolean)
    .map((p) => `<p style="${S.p}">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:16px 8px;background:#f2f4f7;">'
    + '<table role="presentation" width="100%" style="border-collapse:collapse;max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e4e7ec;border-radius:12px;"><tr><td style="padding:20px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2328;">'
    + `<div style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${LEVEL_COLOR[a.level]};margin:0 0 6px;">${esc(app)} · ${esc(a.level)}</div>`
    + `<div style="font-weight:700;font-size:17px;margin:0 0 12px;">${esc(a.title)}</div>${paras}`
    + (href ? `<p style="margin:16px 0 0;"><a href="${esc(href)}" style="${S.a}">Open in ${esc(app)}</a></p>` : '')
    + '</td></tr>'
    + '<tr><td style="padding:12px 20px;border-top:1px solid #e4e7ec;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#667085;">Sent by RizeHub HQ</td></tr>'
    + '</table></body></html>';
  return { subject, text, html };
}

export interface AlertEmailDeps extends Pick<CeoEmailDeps, 'settings' | 'store' | 'keyring' | 'send' | 'log'> { alerts: AlertStore }
export interface AlertEmailTickResult { sent: number; failed: number; skipped?: 'off' | 'account' | 'no_keyring' | 'decrypt' }

/**
 * One pass. Emails need "Email me updates" on with "failures" ticked; while it is off, waiting alerts are marked
 * (never a flood of old alerts the day it is turned on). A broken Gmail account leaves them waiting.
 */
export async function alertEmailTick(d: AlertEmailDeps): Promise<AlertEmailTickResult> {
  const r: AlertEmailTickResult = { sent: 0, failed: 0 };
  const due = await d.alerts.unsentEmail(10);
  if (!due.length) return r;
  const s = parseCeoEmailSettings((await d.settings()).value);
  if (!ceoEmailReady(s) || !s.events.failures || !isEmailAddress(s.to)) {
    for (const a of due) await d.alerts.markEmailed(a.id, 'Email me updates (failures) is off');
    return { ...r, skipped: 'off' };
  }
  const acc = await openAccount(d, s.connector_id!);
  if ('skip' in acc) { d.log?.(`[notify] alert emails waiting: ${acc.error}`); return { ...r, skipped: acc.skip }; }
  const send = d.send ?? smtpSendCeo;
  for (const a of due) {
    try {
      await send(acc.email, acc.pass, { to: s.to!, ...buildAlertEmail(a) });
      await d.alerts.markEmailed(a.id, null);
      r.sent++;
    } catch (e) {
      const f = friendlyGmailError(e);
      r.failed++;
      d.log?.(`[notify] alert ${a.id} not emailed: ${f.message}`);
      if (f.reauth) { await d.store.mark(acc.id, 'needs_reauth', f.message).catch(() => undefined); break; }
      await d.alerts.markEmailed(a.id, f.message.slice(0, 300)); // one try per alert; Telegram still has it
    }
  }
  return r;
}

// ---------- uptime watch ----------
export const UPTIME_EVERY_MS = 5 * 60_000;
export const UPTIME_FAILS_TO_ALERT = 2;

export interface UptimeState { fails: Map<string, number>; downSince: Map<string, string> }
export const newUptimeState = (): UptimeState => ({ fails: new Map(), downSince: new Map() });

export function parseUptimeUrls(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter((u) => /^https:\/\/[^\s]+$/.test(u));
}

export type Probe = (url: string) => Promise<{ ok: boolean; detail: string }>;

export const httpProbe: Probe = async (url) => {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'RizeHub-HQ-uptime/1' } });
    return { ok: res.status < 500, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: errMsg(e).slice(0, 200) };
  }
};

/** Checks each URL; 2 failures in a row → one critical alert, the first success after that → one info "back up". */
export async function uptimeTick(urls: string[], state: UptimeState, probe: Probe, store: Pick<AlertStore, 'insert'>, now: () => Date = () => new Date()): Promise<void> {
  for (const url of urls) {
    const r = await probe(url);
    const host = new URL(url).host;
    const fails = r.ok ? 0 : (state.fails.get(url) ?? 0) + 1;
    state.fails.set(url, fails);
    const since = state.downSince.get(url);
    if (!r.ok && fails === UPTIME_FAILS_TO_ALERT && !since) {
      const at = now().toISOString();
      state.downSince.set(url, at);
      await store.insert({ id: `uptime:${host}:${at}`.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 120), source: 'uptime', level: 'critical',
        title: `${host} is down`, body: `${url} failed ${fails} checks in a row (${r.detail}).`, url }).catch(() => undefined);
    } else if (r.ok && since) {
      state.downSince.delete(url);
      const mins = Math.max(1, Math.round((now().getTime() - Date.parse(since)) / 60_000));
      await store.insert({ id: `uptime:${host}:${since}:up`.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 120), source: 'uptime', level: 'info',
        title: `${host} is back up`, body: `${url} answers again (${r.detail}) after about ${mins} min.`, url }).catch(() => undefined);
    }
  }
}

export function startUptimeWatch(o: { urls: string[]; store: Pick<AlertStore, 'insert'>; probe?: Probe; everyMs?: number; log?: (m: string) => void }): NodeJS.Timeout | null {
  if (!o.urls.length) return null;
  const state = newUptimeState();
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    void uptimeTick(o.urls, state, o.probe ?? httpProbe, o.store)
      .catch((e) => o.log?.(`[uptime] check failed: ${errMsg(e).slice(0, 300)}`)).finally(() => { busy = false; });
  }, o.everyMs ?? UPTIME_EVERY_MS);
  t.unref?.();
  return t;
}

// ---------- production wiring ----------
export function supabaseAlertStore(sb: SupabaseClient): AlertStore {
  return {
    insert: async (a) => {
      const { data, error } = await sb.from('external_alerts').upsert(a, { onConflict: 'id', ignoreDuplicates: true }).select('id');
      if (error) throw new Error(`external_alerts: ${error.message}`);
      return { duplicate: !(data ?? []).length };
    },
    unsentEmail: async (limit) => {
      const { data, error } = await sb.from('external_alerts').select('id,source,level,title,body,url,received_at')
        .is('email_sent_at', null).neq('level', 'warning').gte('received_at', new Date(Date.now() - 24 * 3600_000).toISOString())
        .order('received_at').limit(limit);
      if (error) throw new Error(`external_alerts: ${error.message}`);
      return (data ?? []) as StoredAlert[];
    },
    markEmailed: async (id, err) => {
      const { error } = await sb.from('external_alerts').update({ email_sent_at: new Date().toISOString(), email_error: err }).eq('id', id).is('email_sent_at', null);
      if (error) throw new Error(`external_alerts: ${error.message}`);
    },
  };
}

/** Production timer (index.ts): every 30 s like the CEO copies, same pause rule. */
export function startAlertEmailSender(o: { deps: AlertEmailDeps; paused: () => Promise<boolean>; everyMs?: number }): NodeJS.Timeout {
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => { if (!(await o.paused())) await alertEmailTick(o.deps); })()
      .catch((e) => o.deps.log?.(`[notify] alert email loop failed: ${errMsg(e).slice(0, 300)}`))
      .finally(() => { busy = false; });
  }, o.everyMs ?? 30_000);
  t.unref?.();
  return t;
}
