// Google Chat through the logged-in browser (docs/17-OPERATOR.md "Watcher" and "Sending"). Read: every frame of the
// chat's tab is scanned with the extractor and the frame with the most messages wins. Send: focus the composer (in the
// message's thread when it has one), optionally quote the message, type the reply with real @mention chips, compare
// the composer with the approved text, ask the database one last time (kill switch), then press Enter.
import type { Frame, Page } from 'playwright-core';
import { comparable, composeSegments, EXTRACT_SOURCE, normalizeMessages, type ChatMessage, type RawPage, type Selectors } from './chatDom';

/** Enter was pressed: the reply may be posted, so it must not be retried automatically. */
export class MaybeSentError extends Error {}

export class SignedOutError extends Error {
  constructor() { super('signed out of Google: log in again through the workspace viewer'); }
}

function assertSignedIn(page: Page) {
  const u = page.url();
  if (/accounts\.google\.com|\/ServiceLogin|signin/i.test(u)) throw new SignedOutError();
}

async function extractFrame(f: Frame, sel: Selectors): Promise<RawPage | null> {
  try { return (await f.evaluate(`(${EXTRACT_SOURCE})(${JSON.stringify(sel)})`)) as RawPage; } catch { return null; }
}

/** The frame that holds the conversation (most messages), with what it found. */
async function bestFrame(page: Page, sel: Selectors): Promise<{ frame: Frame; data: RawPage } | null> {
  let best: { frame: Frame; data: RawPage } | null = null;
  for (const f of page.frames()) {
    const data = await extractFrame(f, sel);
    if (data && (!best || data.messages.length > best.data.messages.length)) best = { frame: f, data };
  }
  return best && best.data.messages.length ? best : null;
}

export interface ReadResult { title: string; messages: ChatMessage[] }

export async function readChat(page: Page, sel: Selectors, myNames: readonly string[]): Promise<ReadResult> {
  assertSignedIn(page);
  // Chat renders messages after load; give it a moment on a fresh tab.
  let found = await bestFrame(page, sel);
  for (let i = 0; !found && i < 10; i++) {
    await page.waitForTimeout(1500);
    assertSignedIn(page);
    found = await bestFrame(page, sel);
  }
  if (!found) throw new Error(`no messages found with selector ${sel.message} (run the probe to tune OPERATOR_GCHAT_SELECTORS)`);
  return { title: found.data.title, messages: normalizeMessages(found.data.messages, myNames) };
}

export interface SendInput {
  externalId: string;
  threadKey: string | null;
  text: string;
  mentions: readonly string[];
  /** Quote the message being answered (flat group chats / DMs). */
  quote: boolean;
}

export interface SendSteps {
  /** Called right before Enter; a non-null reason aborts (the composer is cleared). */
  lastCheck: () => Promise<string | null>;
  step?: (what: string, detail?: Record<string, unknown>) => Promise<void> | void;
  /** false = type and verify, then clear instead of sending (OPERATOR_SENDS=off rehearsals, tests). */
  send?: boolean;
}

const cssAttr = (v: string) => v.replace(/["\\]/g, '\\$&');

async function clearComposer(page: Page, frame: Frame, sel: Selectors) {
  const box = frame.locator(sel.composer).last();
  await box.click().catch(() => undefined);
  await page.keyboard.press('ControlOrMeta+A').catch(() => undefined);
  await page.keyboard.press('Backspace').catch(() => undefined);
}

export async function sendReply(page: Page, sel: Selectors, input: SendInput, steps: SendSteps): Promise<{ sent: boolean; quoted: boolean; inThread: boolean; mentionsLinked: number }> {
  assertSignedIn(page);
  await page.bringToFront();
  const found = await bestFrame(page, sel);
  const frame = found?.frame ?? page.mainFrame();
  const idAttr = sel.messageIdAttr.split(',')[0]!.trim();
  // Hash ids (h:…) have no DOM attribute to find the message by: no quote then.
  const target = input.externalId.startsWith('h:') ? null : frame.locator(`[${idAttr}="${cssAttr(input.externalId)}"]`).first();

  // 1. In a threaded space, answer inside the message's thread.
  let inThread = false;
  let scope = frame.locator(':root');
  if (input.threadKey) {
    const topic = frame.locator(`[${sel.threadIdAttr}="${cssAttr(input.threadKey)}"]`).first();
    if (await topic.count()) {
      const reply = topic.locator(sel.threadReplyButton).first();
      if (await reply.count()) { await reply.click(); inThread = true; scope = topic; }
    }
  }

  // 2. Quote the message (hover reveals its action bar), when asked and available.
  let quoted = false;
  if (input.quote && !inThread && target && await target.count()) {
    await target.hover();
    const q = target.locator(sel.quoteButton).first();
    if (await q.count()) { await q.click(); quoted = true; }
  }
  await steps.step?.('browser.compose', { in_thread: inThread, quoted });

  // 3. Type: text, @mention chips (pick the option from Chat's list), line breaks.
  const box = scope.locator(sel.composer).last();
  if (!(await box.count())) throw new Error(`composer not found (${sel.composer})`);
  await box.click();
  let mentionsLinked = 0;
  for (const seg of composeSegments(input.text, input.mentions)) {
    if (seg.kind === 'newline') { await page.keyboard.press('Shift+Enter'); await page.waitForTimeout(150); continue; }
    if (seg.kind === 'text') { await page.keyboard.insertText(seg.text); await page.waitForTimeout(80); continue; }
    await page.keyboard.insertText(`@${seg.name.split(/\s+/)[0]}`);
    const option = frame.locator(sel.mentionOption).filter({ hasText: seg.name }).first();
    try {
      await option.waitFor({ state: 'visible', timeout: 3000 });
      await option.click();
      mentionsLinked++;
    } catch {
      // No match in the list: keep the rest of the name as plain text.
      await page.keyboard.insertText(seg.name.split(/\s+/).slice(1).join(' ') ? ` ${seg.name.split(/\s+/).slice(1).join(' ')}` : '');
    }
    await page.waitForTimeout(120);
  }

  // 4. The composer must hold exactly the approved text before anything is sent.
  const typed = await box.innerText().catch(() => '');
  if (comparable(typed) !== comparable(input.text)) {
    await clearComposer(page, frame, sel);
    throw new Error(`composer text does not match the approved reply (got "${typed.slice(0, 120)}")`);
  }
  await steps.step?.('browser.typed', { chars: input.text.length, mentions_linked: mentionsLinked });

  // 5. Last check against the database (a /pause that landed meanwhile stops it here), then send.
  const why = await steps.lastCheck();
  if (why || steps.send === false) {
    await clearComposer(page, frame, sel);
    if (why) throw new Error(`not sent: ${why}`);
    return { sent: false, quoted, inThread, mentionsLinked };
  }
  await page.keyboard.press('Enter');
  // Sent when the composer empties. From here on a failure is never retried automatically: it may have posted.
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    if (!comparable(await box.innerText().catch(() => ''))) return { sent: true, quoted, inThread, mentionsLinked };
  }
  throw new MaybeSentError('pressed Enter but the composer did not clear: check the chat in the viewer before re-sending');
}
