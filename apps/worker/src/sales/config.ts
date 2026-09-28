// Outreach mailbox settings (worker env only; passwords never reach agents, prompts or logs). docs/15-OUTREACH.md.
// Sending is refused (not "best effort") while anything CAN-SPAM needs is missing: sender address, physical address,
// an opt-out mechanism. The From address must be on a dedicated outreach domain, never the main domain.
import { workerEnv } from '../config';
import { CAP_ABSOLUTE_MAX, CAP_DEFAULT_MAX } from './schedule';

export interface MailServer { host: string; port: number; user: string; pass: string; secure: boolean }

export interface OutreachConfig {
  smtp: MailServer | null;
  imap: MailServer | null;
  fromName: string;
  fromEmail: string | null;
  physicalAddress: string | null;
  /** Effective configured cap (after the 30 / 50 ceilings). The warm-up ramp can lower it further per day. */
  cap: number;
  allowHigherCap: boolean;
  warmupStart: number;
  warmupStepPerWeek: number;
  warmupFrom: Date | null;
  unsubscribeUrl: string | null;
  unsubscribeSecret: string | null;
  autoApproveFollowUps: boolean;
  /** Manila hour (0–23) when the day's drafts become ONE batch approval. */
  batchHour: number;
  mainDomain: string;
  sendEveryMs: number;
  inboxEveryMs: number;
  /** Non-fatal notes for the startup log (cap lowered, unsubscribe link off…). */
  warnings: string[];
}

type Env = Readonly<Record<string, string | undefined>>;
const str = (v: string | undefined) => (v ?? '').trim();
const int = (v: string | undefined, d: number) => { const n = Number(str(v)); return str(v) !== '' && Number.isFinite(n) ? Math.trunc(n) : d; };
const bool = (v: string | undefined) => /^(1|true|yes|on)$/i.test(str(v));

function server(env: Env, kind: 'SMTP' | 'IMAP'): MailServer | null {
  const host = str(env[`OUTREACH_${kind}_HOST`]);
  const user = str(env[`OUTREACH_${kind}_USER`]);
  const pass = env[`OUTREACH_${kind}_PASS`] ?? '';
  if (!host || !user || !pass) return null;
  const port = int(env[`OUTREACH_${kind}_PORT`], kind === 'SMTP' ? 587 : 993);
  return { host, port, user, pass, secure: kind === 'SMTP' ? port === 465 : port !== 143 };
}

export function outreachConfig(env: Env = workerEnv()): OutreachConfig {
  const warnings: string[] = [];
  const allowHigherCap = bool(env.OUTREACH_ALLOW_HIGHER_CAP);
  const ceiling = allowHigherCap ? CAP_ABSOLUTE_MAX : CAP_DEFAULT_MAX;
  let cap = int(env.OUTREACH_DAILY_SEND_CAP, 20);
  if (cap > ceiling) {
    warnings.push(`OUTREACH_DAILY_SEND_CAP=${cap} lowered to ${ceiling}${allowHigherCap ? ' (absolute maximum)' : ' (set OUTREACH_ALLOW_HIGHER_CAP=true for up to 50)'}`);
    cap = ceiling;
  }
  cap = Math.max(0, cap);
  const from = str(env.OUTREACH_WARMUP_START);
  const warmupFrom = /^\d{4}-\d{2}-\d{2}$/.test(from) ? new Date(`${from}T00:00:00+08:00`) : null;
  const unsubscribeUrl = str(env.OUTREACH_UNSUBSCRIBE_URL) || null;
  const unsubscribeSecret = str(env.OUTREACH_UNSUBSCRIBE_SECRET) || null;
  if (unsubscribeUrl && !unsubscribeSecret) warnings.push('OUTREACH_UNSUBSCRIBE_URL is set but OUTREACH_UNSUBSCRIBE_SECRET is not: using the mailto: opt-out only');
  return {
    smtp: server(env, 'SMTP'),
    imap: server(env, 'IMAP'),
    fromName: str(env.OUTREACH_FROM_NAME) || 'Julev Ajeto, RizeHub',
    fromEmail: str(env.OUTREACH_FROM_EMAIL).toLowerCase() || null,
    physicalAddress: str(env.OUTREACH_PHYSICAL_ADDRESS) || null,
    cap, allowHigherCap,
    warmupStart: Math.max(1, int(env.OUTREACH_WARMUP_START_PER_DAY, 10)),
    warmupStepPerWeek: Math.max(0, int(env.OUTREACH_WARMUP_STEP_PER_WEEK, 5)),
    warmupFrom,
    unsubscribeUrl: unsubscribeUrl && unsubscribeSecret ? unsubscribeUrl : null,
    unsubscribeSecret,
    autoApproveFollowUps: bool(env.OUTREACH_AUTO_APPROVE_FOLLOW_UPS),
    batchHour: Math.min(23, Math.max(0, int(env.OUTREACH_BATCH_HOUR, 17))),
    mainDomain: (str(env.OUTREACH_MAIN_DOMAIN) || 'rizehub.ph').toLowerCase(),
    sendEveryMs: int(env.OUTREACH_SEND_EVERY_MS, 60_000),
    inboxEveryMs: int(env.OUTREACH_IMAP_EVERY_MS, 120_000),
    warnings,
  };
}

const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/** Why the worker must not send right now ([] = ok). Checked before every send batch. */
export function sendingProblems(c: OutreachConfig): string[] {
  const p: string[] = [];
  if (!c.smtp) p.push('OUTREACH_SMTP_HOST / _USER / _PASS are not set');
  if (!c.fromEmail || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(c.fromEmail)) p.push('OUTREACH_FROM_EMAIL is missing or invalid');
  else {
    const d = domainOf(c.fromEmail);
    if (d === c.mainDomain || d.endsWith(`.${c.mainDomain}`)) {
      p.push(`OUTREACH_FROM_EMAIL is on the main domain ${c.mainDomain} (or a subdomain): cold email must come from a separate, warmed-up outreach domain`);
    }
  }
  if (!c.physicalAddress || c.physicalAddress.length < 10) p.push('OUTREACH_PHYSICAL_ADDRESS is missing (CAN-SPAM requires a valid postal address in every email)');
  if (!/rizehub/i.test(c.fromName)) p.push('OUTREACH_FROM_NAME must name RizeHub (e.g. "Julev Ajeto, RizeHub")');
  if (c.cap <= 0) p.push('OUTREACH_DAILY_SEND_CAP is 0');
  return p;
}
