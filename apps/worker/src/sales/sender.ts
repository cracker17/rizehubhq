// Sends approved outreach emails, one at a time, under today's cap (configured cap ∩ warm-up ramp; SQL stops at 50).
// Only rows whose external_action approval is APPROVED can be claimed (sales_claim_send). Before each send the address
// is re-checked: suppression list, a public source for the address, no denied source. CAN-SPAM problems (no physical
// address, no sender, main domain) stop the whole tick before anything is claimed.
import { outreachConfig, sendingProblems, type OutreachConfig } from './config';
import { composeMessage, ComposeError } from './compose';
import { isPermanentSmtpError, type Mailer } from './mailer';
import { capForDay } from './schedule';
import { deniedSource, GIVEN_SOURCES } from './sources';
import type { SalesDb } from './store';

type Logger = (msg: string, extra?: unknown) => void;
const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 400);

export interface SendTickResult {
  status: 'disabled' | 'cap_reached' | 'idle' | 'sent';
  sent: number; failed: number; skipped: number; cap: number; sentToday: number; problems: string[]; warmupDay?: number;
}

export async function todayCap(db: SalesDb, c: OutreachConfig, now: Date) {
  const first = c.warmupFrom ?? (await db.firstSentAt().then((s) => (s ? new Date(s) : null)).catch(() => null));
  return capForDay({ cap: c.cap, warmupStart: c.warmupStart, warmupStepPerWeek: c.warmupStepPerWeek, warmupFrom: first }, now);
}

export async function runSendTick(o: { db: SalesDb; mailer: Mailer | null; cfg?: OutreachConfig; now?: Date; log?: Logger; maxPerTick?: number }): Promise<SendTickResult> {
  const c = o.cfg ?? outreachConfig();
  const log = o.log ?? (() => undefined);
  const problems = sendingProblems(c);
  if (!o.mailer && !problems.length) problems.push('no SMTP transport');
  const { cap, warmupDay } = await todayCap(o.db, c, o.now ?? new Date());
  const r: SendTickResult = { status: 'idle', sent: 0, failed: 0, skipped: 0, cap, sentToday: 0, problems, warmupDay };
  if (problems.length) { r.status = 'disabled'; return r; }

  for (let i = 0; i < (o.maxPerTick ?? 10); i++) {
    const claim = await o.db.claimSend(cap);
    r.sentToday = claim.sent_today;
    if (claim.status !== 'claimed') { r.status = r.sent ? 'sent' : claim.status; break; }
    const { email, lead } = claim;
    // Last line of defence (SQL already checked approval + suppression): the address must be publicly published.
    const why = (await o.db.isSuppressed(email.to)) ? 'recipient opted out'
      : !lead.email_source_url && !GIVEN_SOURCES.has(lead.source) ? 'the address has no public business source'
        : deniedSource(lead.email_source_url);
    if (why) {
      await o.db.markSendFailed(email.id, `not sent: ${why}`, false);
      r.skipped++;
      log(`[sales] skipped ${email.kind} to ${lead.business_name}: ${why}`);
      continue;
    }
    try {
      const msg = composeMessage(c, email);
      const info = await o.mailer!.send(msg);
      if (info.rejected.map((x) => x.toLowerCase()).includes(email.to.toLowerCase())) throw Object.assign(new Error(`rejected by the server: ${info.response ?? ''}`), { responseCode: 550 });
      await o.db.markSent(email.id, info.messageId || msg.messageId, c.fromEmail);
      r.sent++; r.sentToday++;
      log(`[sales] sent ${email.kind}${email.follow_up_number ? ` #${email.follow_up_number}` : ''} to ${lead.business_name} (${r.sentToday}/${cap} today)`);
    } catch (e) {
      const permanent = e instanceof ComposeError || isPermanentSmtpError(e);
      const res = await o.db.markSendFailed(email.id, msgOf(e), !permanent).catch(() => ({ final: false, attempts: 0 }));
      r.failed++;
      log(`[sales] sending to ${lead.business_name} failed${res.final ? ' (final)' : ''}`, msgOf(e));
      if (e instanceof ComposeError) { r.status = 'disabled'; r.problems = e.problems; break; }
      if (!permanent) break; // server trouble: try again next tick
    }
    r.status = 'sent';
  }
  return r;
}
