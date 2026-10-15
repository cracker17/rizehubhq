// Gmail, Slack and Teams watchers (docs/17-OPERATOR.md "More channels"): read-only, in the client's logged-in
// workspace browser, with the same in-page extractor as Google Chat (chatDom.ts) and per-kind selectors. Nothing here
// types or clicks: replies for these channels are drafted and, once approved, posted by Julev ('manual' in SQL).
//
// None of these apps publish their DOM, so every selector is a best guess at today's markup and can be overridden per
// kind with OPERATOR_SLACK_SELECTORS / OPERATOR_TEAMS_SELECTORS / OPERATOR_GMAIL_SELECTORS (JSON). Tune with the probe:
//   docker compose exec operator ./node_modules/.bin/tsx src/probe.ts lvlup <channel url> --kind slack
//
// Gmail watches a list (a label or a search, e.g. #label/LvlUp or #search/from:lvlup.vc): every thread row is one
// "message" (subject + snippet), keyed by the thread's last message id, so a new reply in a thread is a new message.
import type { Page } from 'playwright-core';
import { EXTRACT_SOURCE, normalizeMessages, type ChatMessage, type RawPage } from './chatDom';

export type WatchKind = 'gmail' | 'slack' | 'teams';
export const WATCH_KINDS: readonly WatchKind[] = ['gmail', 'slack', 'teams'];

export interface WatchSelectors {
  message: string; idSelector: string; messageIdAttr: string; sender: string; timestamp: string; timestampAttr: string;
  text: string; thread: string; threadIdAttr: string; spaceTitle: string; newestFirst: string;
}

export const WATCH_SELECTORS: Record<WatchKind, WatchSelectors> = {
  slack: {
    message: '[data-qa="virtual-list-item"], .c-virtual_list__item',
    idSelector: 'a.c-timestamp[data-ts], [data-ts]',
    messageIdAttr: 'data-ts,data-item-key,id',
    sender: '[data-qa="message_sender_name"], .c-message__sender_button',
    timestamp: 'a.c-timestamp[data-ts], [data-ts]',
    timestampAttr: 'data-ts',
    text: '[data-qa="message-text"], .c-message_kit__blocks, .p-rich_text_section',
    thread: '', threadIdAttr: '',
    spaceTitle: '[data-qa="channel_name"], .p-view_header__channel_title, [data-qa="channel_header_title"]',
    newestFirst: '',
  },
  teams: {
    message: '[data-tid="chat-pane-item"], [data-tid="chat-pane-message"]',
    idSelector: '[data-mid], [id^="content-"]',
    messageIdAttr: 'data-mid,id',
    sender: '[data-tid="message-author-name"]',
    timestamp: 'time[datetime]',
    timestampAttr: 'datetime',
    text: '[id^="content-"], [data-tid="chat-pane-message"] [dir="auto"]',
    thread: '', threadIdAttr: '',
    spaceTitle: '[data-tid="chat-title"], [data-tid="channel-name"], h2',
    newestFirst: '',
  },
  gmail: {
    message: 'tr.zA',
    idSelector: '[data-legacy-last-message-id], [data-thread-id]',
    messageIdAttr: 'data-legacy-last-message-id,data-thread-id',
    sender: '.yX [email], .yW [email], .yX span[name]',
    timestamp: 'td.xW span[title], .xW [title]',
    timestampAttr: 'title',
    text: '.y6, .xT',
    thread: '', threadIdAttr: '',
    spaceTitle: 'title',
    newestFirst: '1',
  },
};

/** A kind's selectors with the env overrides (only known keys, only non-empty strings). */
export function watchSelectors(kind: WatchKind, overrides: Record<string, string> = {}): WatchSelectors {
  const out = { ...WATCH_SELECTORS[kind] };
  for (const k of Object.keys(out) as (keyof WatchSelectors)[]) if (typeof overrides[k] === 'string' && overrides[k]!.trim()) out[k] = overrides[k]!.trim();
  return out;
}

const SIGNED_OUT: Record<WatchKind, RegExp> = {
  gmail: /accounts\.google\.com|\/ServiceLogin|workspace\.google\.com\/.*products/i,
  slack: /slack\.com\/(signin|sign_in|checkcookie)|\/ssb\/signin/i,
  teams: /login\.microsoftonline\.com|login\.live\.com|teams\.microsoft\.com\/.*(signin|login)/i,
};

export class WatchSignedOutError extends Error {
  constructor(kind: WatchKind) { super(`signed out of ${kind === 'gmail' ? 'Gmail' : kind === 'slack' ? 'Slack' : 'Teams'}: log in again through the workspace viewer`); }
}

export function isSignedOut(kind: WatchKind, url: string): boolean {
  return SIGNED_OUT[kind].test(url);
}

/** Every frame is scanned; the one with the most messages wins (Teams renders the chat in an iframe on some tenants). */
export async function readWatched(page: Page, kind: WatchKind, sel: WatchSelectors, myNames: readonly string[], tries = 10): Promise<{ title: string; messages: ChatMessage[] }> {
  const check = () => { if (isSignedOut(kind, page.url())) throw new WatchSignedOutError(kind); };
  check();
  let best: RawPage | null = null;
  for (let i = 0; i < tries; i++) {
    for (const f of page.frames()) {
      const data = await f.evaluate(`(${EXTRACT_SOURCE})(${JSON.stringify(sel)})`).catch(() => null) as RawPage | null;
      if (data && (!best || data.messages.length > best.messages.length)) best = data;
    }
    if (best?.messages.length) break;
    await page.waitForTimeout(1500);
    check();
  }
  if (!best?.messages.length) throw new Error(`no ${kind} messages found with selector ${sel.message} (run the probe with --kind ${kind}; tune OPERATOR_${kind.toUpperCase()}_SELECTORS)`);
  const title = kind === 'gmail' ? best.title.replace(/\s*[-–]\s*[^-–]*@[^-–]*-\s*Gmail\s*$/i, '').replace(/\s*-\s*Gmail\s*$/i, '').trim() : best.title;
  return { title, messages: normalizeMessages(best.messages, myNames) };
}
