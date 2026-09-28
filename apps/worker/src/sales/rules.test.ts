// Pure sales rules: flags (mirrors sales_detect_flags), sources, config / CAN-SPAM checks, enums vs the migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LEAD_EMAIL_STATUS, LEAD_STAGE } from '@rizehubhq/shared';
import { describeFlags, detectFlags, needsExplicitApproval } from './flags';
import { deniedSource, isFreeMailbox, LEAD_SOURCES } from './sources';
import { outreachConfig, parseQuietHours, sendingProblems } from './config';
import { REPLY_CLASSES } from './store';
import { testConfig } from './testKit';

const MIGRATION = fs.readFileSync(path.resolve(import.meta.dirname,'../../../../supabase/migrations/20260928090000_sales_pipeline.sql'), 'utf8');
const sqlList = (re: RegExp) => [...(re.exec(MIGRATION)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

test('flags: same samples as the SQL suite (scripts/db-tests/090-sales-pipeline.mjs); stored flags are sorted', () => {
  const f = (s: string) => detectFlags('', s);
  assert.deepEqual(f('Your product pages take ~6s on mobile (PageSpeed, 3 Oct). Happy to send a free 3-point fix list. Want it?'), []);
  assert.deepEqual(f('Our speed fix is $450 flat.'), ['pricing']);
  assert.deepEqual(f('We can quote it this week'), ['pricing']);
  assert.deepEqual(f('I can do 20% off for you'), ['discount']);
  assert.deepEqual(f('We would send the agreement and a deposit link'), ['contract']);
  assert.deepEqual(f('We can have it ready by Friday'), ['commitment']);
  assert.deepEqual(f('Delivered within 5 business days'), ['commitment']);
  assert.deepEqual(f('Live by Oct 14, guaranteed'), ['commitment', 'contract']);
  assert.deepEqual(f('Your conversion rate may suffer and it costs you sales'), []);
});

test('flags: subject counts, proposals always flagged, any flag needs an explicit approval', () => {
  assert.deepEqual(detectFlags('Pricing for the fix', 'Hi there'), ['pricing']);
  assert.deepEqual(detectFlags('Proposal', 'Scope below.', 'proposal'), ['proposal']);
  assert.equal(needsExplicitApproval([]), false);
  assert.equal(needsExplicitApproval(['pricing']), true);
  assert.equal(describeFlags(['pricing', 'commitment']), 'prices, a date or deliverable commitment');
});

test('sources: LinkedIn and contact-data brokers are refused (subdomains too); business sites pass', () => {
  assert.match(deniedSource('https://www.linkedin.com/company/acme')!, /LinkedIn is never a lead source/);
  assert.match(deniedSource('https://lnkd.in/abc')!, /LinkedIn/);
  assert.match(deniedSource('https://app.apollo.io/#/people')!, /contact-data broker/);
  assert.match(deniedSource('https://hunter.io/search/acme.com')!, /broker/);
  assert.equal(deniedSource('https://acme.com/contact'), null);
  assert.equal(deniedSource('https://notlinkedin.com.au/'), null, 'only the real host or its subdomains');
  assert.equal(deniedSource(null), null);
  assert.match(deniedSource('not a url')!, /valid/);
  assert.match(deniedSource('ftp://acme.com/x')!, /http/);
  assert.deepEqual([...LEAD_SOURCES], sqlList(/source\s+text not null check \(source in \(([^)]*)\)\)/));
});

test('sources: free mailboxes are flagged as personal-looking; business domains are not', () => {
  assert.equal(isFreeMailbox('owner@gmail.com'), true);
  assert.equal(isFreeMailbox('shop@outlook.com'), true);
  assert.equal(isFreeMailbox('hello@acme.com'), false);
  assert.equal(isFreeMailbox('hello@gmailshop.com'), false);
});

test('config: fail safe with no keys (disabled, no SMTP/IMAP, sending refused with every CAN-SPAM reason)', () => {
  const c = outreachConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.smtp, null);
  assert.equal(c.imap, null);
  assert.equal(c.quietHours, null);
  const p = sendingProblems(c).join(' | ');
  assert.match(p, /OUTREACH_SMTP_HOST/);
  assert.match(p, /OUTREACH_FROM_EMAIL is missing/);
  assert.match(p, /OUTREACH_PHYSICAL_ADDRESS/);
  assert.deepEqual(sendingProblems(testConfig()), []);
});

test('config: the main domain is refused as sender; caps are clamped to 30 (50 with ALLOW_HIGHER_CAP); name must say RizeHub', () => {
  assert.match(sendingProblems(testConfig({ OUTREACH_FROM_EMAIL: 'julev@rizehub.ph' })).join(), /main domain/);
  assert.match(sendingProblems(testConfig({ OUTREACH_FROM_EMAIL: 'julev@mail.rizehub.ph' })).join(), /main domain/);
  assert.match(sendingProblems(testConfig({ OUTREACH_FROM_NAME: 'Julev' })).join(), /must name RizeHub/);
  assert.match(sendingProblems(testConfig({ OUTREACH_DAILY_SEND_CAP: '0' })).join(), /CAP is 0/);
  const high = testConfig({ OUTREACH_DAILY_SEND_CAP: '80' });
  assert.equal(high.cap, 30);
  assert.match(high.warnings.join(), /lowered to 30/);
  assert.equal(testConfig({ OUTREACH_DAILY_SEND_CAP: '80', OUTREACH_ALLOW_HIGHER_CAP: 'true' }).cap, 50);
  assert.equal(testConfig({ OUTREACH_SMTP_PORT: '465' }).smtp?.secure, true);
  assert.equal(testConfig().smtp?.secure, false, '587 = STARTTLS');
  // unsubscribe URL without its secret is dropped (mailto opt-out only)
  const u = testConfig({ OUTREACH_UNSUBSCRIBE_URL: 'https://hq.example.test/hooks/unsubscribe' });
  assert.equal(u.unsubscribeUrl, null);
  assert.match(u.warnings.join(), /UNSUBSCRIBE_SECRET/);
});

test('config: quiet hours parse "22-7" / "09:00-17:00"; junk is ignored with a warning', () => {
  assert.deepEqual(parseQuietHours('22-7'), { start: 22, end: 7 });
  assert.deepEqual(parseQuietHours('09:00-17:00'), { start: 9, end: 17 });
  assert.deepEqual(parseQuietHours('20-24'), { start: 20, end: 0 });
  assert.equal(parseQuietHours('8-8'), null);
  assert.equal(parseQuietHours('25-3'), null);
  assert.equal(parseQuietHours('night'), null);
  assert.equal(parseQuietHours(undefined), null);
  const c = testConfig({ OUTREACH_QUIET_HOURS: 'late' });
  assert.equal(c.quietHours, null);
  assert.match(c.warnings.join(), /OUTREACH_QUIET_HOURS/);
});

test('enums: shared LEAD_STAGE / LEAD_EMAIL_STATUS and REPLY_CLASSES mirror the migration exactly', () => {
  assert.deepEqual([...LEAD_STAGE], sqlList(/create type lead_stage as enum \(([^)]*)\)/));
  assert.deepEqual([...LEAD_EMAIL_STATUS], sqlList(/status\s+text not null check \(status in \(([^)]*)\)\)/));
  assert.deepEqual([...REPLY_CLASSES], sqlList(/classification\s+text check \(classification in \(([^)]*)\)\)/));
});
