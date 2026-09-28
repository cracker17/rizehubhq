// Shared fixtures for the sales tests: an outreach config from a fake env, a recording mailer, a seeded FakeSalesDb.
// No sockets, no real keys: every address and host below is a placeholder.
import { outreachConfig, type OutreachConfig } from './config';
import type { ComposedMessage } from './compose';
import { FakeSalesDb } from './fakeStore';
import type { Mailer, SendInfo } from './mailer';
import type { LeadInput } from './store';

/** A config that passes sendingProblems() (fake SMTP, outreach domain, postal address). Override any env key. */
export function testConfig(env: Record<string, string | undefined> = {}): OutreachConfig {
  return outreachConfig({
    OUTREACH_ENABLED: 'true',
    OUTREACH_SMTP_HOST: 'smtp.outreach.test', OUTREACH_SMTP_USER: 'julev@getrizehub.test', OUTREACH_SMTP_PASS: 'not-a-real-password',
    OUTREACH_FROM_EMAIL: 'julev@getrizehub.test', OUTREACH_FROM_NAME: 'Julev Ajeto, RizeHub',
    OUTREACH_PHYSICAL_ADDRESS: '123 Example Street, Davao City 8000, Philippines',
    OUTREACH_DAILY_SEND_CAP: '20', OUTREACH_WARMUP_START_PER_DAY: '10',
    ...env,
  });
}

export interface RecordingMailer extends Mailer { sent: ComposedMessage[] }

/** Records every message; `fail(n)` makes the next send throw `err`, `reject` makes the server refuse the recipient. */
export function recordingMailer(o: { fail?: unknown; reject?: boolean } = {}): RecordingMailer & { failNext: unknown } {
  const m = {
    sent: [] as ComposedMessage[],
    failNext: o.fail as unknown,
    async send(msg: ComposedMessage): Promise<SendInfo> {
      if (m.failNext) { const e = m.failNext; m.failNext = undefined; throw e; }
      m.sent.push(msg);
      return o.reject ? { messageId: msg.messageId, accepted: [], rejected: [msg.to], response: '550 no such user' }
        : { messageId: msg.messageId, accepted: [msg.to], rejected: [], response: '250 ok' };
    },
  };
  return m;
}

/** 28 Sep 2026, 10:00 Manila (02:00 UTC). */
export const T0 = new Date('2026-09-28T02:00:00Z');

export function fakeDb(now: () => Date = () => T0): FakeSalesDb {
  return new FakeSalesDb(now);
}

let seq = 0;
/** A researched lead with a published business address (email_source_url). */
export async function seedLead(db: FakeSalesDb, over: Partial<LeadInput> = {}): Promise<string> {
  const n = ++seq;
  const r = await db.upsertLead({
    business_name: `Biz ${n}`, website: `https://biz${n}.test`, email: `hello@biz${n}.test`, email_source_url: `https://biz${n}.test/contact`,
    source: 'business_website', ...over,
  }, null);
  await db.updateResearch(r.id, { notes: 'LCP 6.1 s on mobile' }, 70);
  return r.id;
}

/** Drafts a clean first touch and returns its email id. */
export async function draftFirstTouch(db: FakeSalesDb, leadId: string, body = 'Hi, your product page takes 6 s to load on mobile. Want a free 3-point fix list?'): Promise<string> {
  const r = await db.addEmailDraft(leadId, 'first_touch', 'Your mobile product page', body, null, []);
  return r.id;
}
