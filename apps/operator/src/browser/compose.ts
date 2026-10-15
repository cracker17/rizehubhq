// Posting in Slack, Teams and Gmail (docs/17-OPERATOR.md "Posting in Slack, Teams and Gmail"). Used only where SQL
// allows it (operator_channel_posts: a passed send test + the CEO's switch). Same rules as Google Chat: type into the
// composer, compare it with the approved text, ask the database once more (pauses), then press the send key. Once the
// key is pressed a failure is never retried (MaybeSentError). @mentions are plain text here (no chips).
//
// Selectors are best guesses, overridable per kind with the "compose*" keys of OPERATOR_SLACK_SELECTORS /
// OPERATOR_TEAMS_SELECTORS / OPERATOR_GMAIL_SELECTORS; the send test proves them on the client's browser first.
import type { Page } from 'playwright-core';
import { comparable } from './chatDom';
import { MaybeSentError, type SendInput, type SendSteps } from './googleChat';
import type { WatchKind } from './watchers';

export interface ComposeSelectors { composeBox: string; composeOpen: string; composeSendKey: string }

export const COMPOSE_SELECTORS: Record<WatchKind, ComposeSelectors> = {
  slack: {
    composeBox: '[data-qa="message_input"] [contenteditable="true"], .ql-editor[contenteditable="true"]',
    composeOpen: '',
    composeSendKey: 'Enter',
  },
  teams: {
    composeBox: '[data-tid="ckeditor"][contenteditable="true"], [data-tid="ckeditor"] [contenteditable="true"], div[contenteditable="true"][role="textbox"]',
    composeOpen: '',
    composeSendKey: 'Enter',
  },
  gmail: {
    composeBox: 'div[contenteditable="true"][role="textbox"][aria-label*="Message Body" i], div.Am.Al.editable[contenteditable="true"]',
    composeOpen: 'span[role="link"][data-tooltip="Reply"], [role="button"][data-tooltip="Reply"], span.ams.bkH',
    composeSendKey: 'ControlOrMeta+Enter',
  },
};

export function composeSelectors(kind: WatchKind, overrides: Record<string, string> = {}): ComposeSelectors {
  const out = { ...COMPOSE_SELECTORS[kind] };
  for (const k of Object.keys(out) as (keyof ComposeSelectors)[]) if (typeof overrides[k] === 'string' && overrides[k]!.trim()) out[k] = overrides[k]!.trim();
  return out;
}

/** Where to type a reply: the conversation itself; for Gmail the message's thread in the mailbox the channel watches. */
export function composeUrl(kind: WatchKind, channelUrl: string, threadKey: string | null): string | null {
  if (kind !== 'gmail') return channelUrl;
  if (!threadKey || !/^[0-9a-zA-Z_-]{6,64}$/.test(threadKey)) return null;
  const base = channelUrl.split('#')[0]!;
  return `${base}#all/${threadKey}`;
}

/** Types and sends one message in the open conversation. `send: false` types, verifies and clears (rehearsal). */
export async function composeSend(page: Page, kind: WatchKind, sel: ComposeSelectors, input: Pick<SendInput, 'text'>, steps: SendSteps): Promise<{ sent: boolean; quoted: boolean; inThread: boolean; mentionsLinked: number }> {
  if (sel.composeOpen) {
    const open = page.locator(sel.composeOpen).last();
    if (await open.count().catch(() => 0)) { await open.click({ timeout: 15_000 }); await page.waitForTimeout(1200); }
  }
  const box = page.locator(sel.composeBox).last();
  await box.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => { throw new Error(`no ${kind} composer found (${sel.composeBox}); tune the compose selectors and run the send test`); });
  await box.click({ timeout: 10_000 });
  await page.keyboard.press('ControlOrMeta+A').catch(() => undefined);
  await page.keyboard.press('Backspace').catch(() => undefined);
  const lines = input.text.split('\n');
  for (const [i, line] of lines.entries()) {
    if (line) await page.keyboard.insertText(line);
    if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
  }
  await steps.step?.('browser.typed', { chars: input.text.length, mentions_linked: 0, kind });
  const typed = await box.innerText().catch(() => '');
  const clear = async () => { await box.click().catch(() => undefined); await page.keyboard.press('ControlOrMeta+A').catch(() => undefined); await page.keyboard.press('Backspace').catch(() => undefined); };
  if (comparable(typed) !== comparable(input.text)) {
    await clear();
    throw new Error(`the ${kind} composer did not hold the approved text; nothing was sent`);
  }
  const why = await steps.lastCheck();
  if (why || steps.send === false) { await clear(); return { sent: false, quoted: false, inThread: false, mentionsLinked: 0 }; }
  try {
    await page.keyboard.press(sel.composeSendKey);
    await page.waitForTimeout(1500);
  } catch (e) {
    throw new MaybeSentError(`pressed send in ${kind} but then: ${e instanceof Error ? e.message : e}`);
  }
  return { sent: true, quoted: false, inThread: kind === 'gmail', mentionsLinked: 0 };
}

/** The send test's message: unique, so reading it back proves it was posted (not an older test). */
export function sendTestText(now = Date.now()): string {
  return `HQ operator send test ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} #${(now % 100000).toString(36)}`;
}

/** Did the test message come back when the conversation was read again? */
export function testSeen(messages: { body: string }[], text: string): boolean {
  const want = comparable(text);
  return messages.slice(-15).some((m) => comparable(m.body).includes(want));
}
