// The unread sweep (docs/17-OPERATOR.md "Unread sweep"): read an app's list of conversations in the client's browser
// and keep the unread ones. Pure mapping (tested) + one in-page extractor. Like every DOM reader here the selectors are
// a best guess at today's markup, overridable per kind with OPERATOR_DISCOVER_SELECTORS ({"slack": {...}, ...}) and
// visible with the probe (`src/probe.ts <profile> <home url> --kind slack --discover`).
//
// Gmail needs no list: its account is ONE channel, the unread inbox search (every unread thread is a message there).
import type { Page } from 'playwright-core';

export type SweepKind = 'google_chat' | 'slack' | 'teams';

export interface ListSelectors {
  /** One element per conversation in the sidebar / chat list. */
  item: string;
  /** Inside an item: what marks it unread (bold class, badge, aria). Empty = every item counts. */
  unread: string;
  name: string;
  /** Inside an item: the link to the conversation, else an attribute holding its id (idAttr). */
  link: string;
  idAttr: string;
  /** Unread count badge (number); missing = 1. */
  count: string;
  /** Inside an item: what marks a direct message (DM / 1:1). */
  direct: string;
}

export const LIST_SELECTORS: Record<SweepKind, ListSelectors> = {
  slack: {
    item: '[data-qa="virtual-list-item"], .p-channel_sidebar__static_list__item',
    unread: '.p-channel_sidebar__channel--unread, .c-mention_badge, [data-qa-channel-sidebar-is-unread="true"]',
    name: '.p-channel_sidebar__name, [data-qa="channel_sidebar_name_button"] span',
    link: 'a[href*="/client/"], a[href*="/archives/"]',
    idAttr: 'data-qa-channel-sidebar-channel-id',
    count: '.c-mention_badge',
    direct: '[data-qa-channel-sidebar-channel-type="im"], [data-qa-channel-sidebar-channel-type="mpim"], .p-channel_sidebar__channel--im',
  },
  google_chat: {
    item: '[data-group-id]',
    unread: '[aria-label*="unread" i], .H7du2c, [data-unread="true"]',
    name: '[data-name], span[role="presentation"], [jsname] span',
    link: 'a[href*="/room/"], a[href*="/dm/"], a[href*="/space/"]',
    idAttr: 'data-group-id',
    count: '[aria-label*="unread" i]',
    direct: '[data-group-id^="dm/"]',
  },
  teams: {
    item: '[data-tid="chat-list-item"], [data-tid^="chat-list-item"]',
    unread: '[data-tid="unread-indicator"], [aria-label*="unread" i], .fui-Badge',
    name: '[data-tid="chat-list-item-title"], [id^="title-chat-list-item"]',
    link: 'a[href*="/l/chat/"]',
    idAttr: 'data-item-id,data-chat-id,id',
    count: '.fui-Badge, [data-tid="unread-count"]',
    direct: '[data-tid="chat-list-item-oneonone"], [aria-label*="1:1" i]',
  },
};

export interface RawItem { name: string; href: string; id: string; count: string; unread: boolean; direct: boolean }
export interface Discovered { name: string; url: string; unread: number; direct: boolean }

/** Runs in the page; returns every list item with its raw fields. */
export const LIST_EXTRACT_SOURCE = `(sel) => {
  const q = (el, s) => { try { return s ? el.querySelector(s) : null; } catch { return null; } };
  const attr = (el, names) => { for (const a of names.split(',').map((s) => s.trim()).filter(Boolean)) { const v = el.getAttribute(a); if (v) return v; } return ''; };
  const out = [];
  for (const n of Array.from(document.querySelectorAll(sel.item))) {
    const self = (s) => { try { return s && n.matches(s); } catch { return false; } };
    const link = self(sel.link) ? n : q(n, sel.link);
    const nameEl = q(n, sel.name);
    let id = attr(n, sel.idAttr);
    for (const a of sel.idAttr.split(',').map((s) => s.trim()).filter(Boolean)) { if (id) break; const e = q(n, '[' + a + ']'); id = e ? (e.getAttribute(a) || '') : ''; }
    out.push({
      name: ((nameEl && (nameEl.getAttribute('data-name') || nameEl.textContent)) || n.getAttribute('aria-label') || '').trim().slice(0, 120),
      href: link ? (link.getAttribute('href') || '') : '',
      id,
      count: ((q(n, sel.count) || {}).textContent || '').trim(),
      unread: !sel.unread || self(sel.unread) || !!q(n, sel.unread),
      direct: !!sel.direct && (self(sel.direct) || !!q(n, sel.direct)),
    });
  }
  return out;
}`;

export function listSelectors(kind: SweepKind, overrides: Record<string, string> = {}): ListSelectors {
  const out = { ...LIST_SELECTORS[kind] };
  for (const k of Object.keys(out) as (keyof ListSelectors)[]) if (typeof overrides[k] === 'string' && overrides[k]!.trim()) out[k] = overrides[k]!.trim();
  return out;
}

/** A conversation's address from its link, or from its id when the app has no links (Google Chat, Teams). */
export function conversationUrl(kind: SweepKind, raw: Pick<RawItem, 'href' | 'id'>, pageUrl: string): string | null {
  if (raw.href) {
    try {
      const u = new URL(raw.href, pageUrl);
      return u.protocol === 'https:' ? u.toString() : null;
    } catch { return null; }
  }
  const id = raw.id.trim();
  if (!id) return null;
  if (kind === 'google_chat') {
    const m = /^(space|dm)\/([A-Za-z0-9_-]+)$/.exec(id);
    return m ? `https://chat.google.com/${m[1] === 'space' ? 'room' : 'dm'}/${m[2]}` : null;
  }
  if (kind === 'teams') {
    const t = id.replace(/^chat-list-item_?/, '');
    return /^19:[^\s/]+$/.test(t) ? `https://teams.microsoft.com/l/chat/${encodeURIComponent(t)}/0` : null;
  }
  if (kind === 'slack') {
    const team = /\/client\/(T[A-Z0-9]+)/.exec(pageUrl)?.[1];
    return team && /^[CDG][A-Z0-9]+$/.test(id) ? `https://app.slack.com/client/${team}/${id}` : null;
  }
  return null;
}

/** Unread items → conversations to read (deduplicated by address, capped so one sweep stays short). */
export function unreadConversations(kind: SweepKind, items: RawItem[], pageUrl: string, max = 15): Discovered[] {
  const seen = new Set<string>();
  const out: Discovered[] = [];
  for (const it of items) {
    if (!it.unread) continue;
    const url = conversationUrl(kind, it, pageUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const n = Number.parseInt(it.count.replace(/\D/g, ''), 10);
    out.push({ name: it.name || 'Conversation', url, unread: Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 1, direct: it.direct || (kind === 'google_chat' && /\/dm\//.test(url)) });
    if (out.length >= max) break;
  }
  return out;
}

export async function readUnreadList(page: Page, kind: SweepKind, sel: ListSelectors): Promise<Discovered[]> {
  let raw: RawItem[] = [];
  for (let i = 0; i < 6 && !raw.length; i++) {
    raw = (await page.evaluate(`(${LIST_EXTRACT_SOURCE})(${JSON.stringify(sel)})`).catch(() => [])) as RawItem[];
    if (!raw.length) await page.waitForTimeout(1500);
  }
  if (!raw.length) throw new Error(`no ${kind} conversations found with selector ${sel.item} (probe with --discover; tune OPERATOR_DISCOVER_SELECTORS)`);
  return unreadConversations(kind, raw, page.url());
}

/** Which messages of a first read are new: the last `unread` ones; the rest is history (baseline). */
export function baselineFlags(count: number, firstRead: boolean, unread: number | undefined): boolean[] {
  if (!firstRead) return Array.from({ length: count }, () => false);
  const fresh = Math.max(0, Math.min(count, unread ?? 0));
  return Array.from({ length: count }, (_, i) => i < count - fresh);
}
