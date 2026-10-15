// Selector probe (docs/17-OPERATOR.md "Tuning the Google Chat selectors"). Read-only: attaches to a profile's browser,
// opens (or reuses) the chat tab, and prints what each selector finds plus the messages the watcher would store.
// Never types or sends.
//
//   docker compose exec operator ./node_modules/.bin/tsx src/probe.ts lvlup https://chat.google.com/room/AAAA...
//   OPERATOR_CDP_LVLUP=http://127.0.0.1:9223 pnpm --filter operator probe lvlup <chat url>     (through an SSH tunnel)
//   … probe.ts lvlup https://app.slack.com/client/T01/C02 --kind slack     (gmail | slack | teams: browser/watchers.ts)
import { cdpEndpointFor, loadOperatorConfig } from './config';
import { BrowserPool, chatPage } from './browser/cdp';
import { selectors, type Selectors } from './browser/chatDom';
import { readChat } from './browser/googleChat';
import { readWatched, watchSelectors, WATCH_KINDS, type WatchKind } from './browser/watchers';

const argv = process.argv.slice(2);
const ki = argv.indexOf('--kind');
const kind = (ki >= 0 ? argv.splice(ki, 2)[1] : 'google_chat') as WatchKind | 'google_chat';
const [profile, url, ...names] = argv;
if (!profile || !url || (kind !== 'google_chat' && !WATCH_KINDS.includes(kind))) {
  console.log('usage: probe <profile> <channel url> [my display name …] [--kind gmail|slack|teams]');
  process.exit(2);
}
const cfg = loadOperatorConfig(process.env);
const sel: Record<string, string> = kind === 'google_chat' ? selectors(cfg.selectorOverrides) : { ...watchSelectors(kind, cfg.watchOverrides[kind]) };
const pool = new BrowserPool((p) => cdpEndpointFor(p, process.env));

await pool.with(profile, async (ctx) => {
  const { page, opened } = await chatPage(ctx, url);
  console.log(`tab: ${opened ? 'opened' : 'reused'} ${page.url()}`);
  await page.waitForTimeout(opened ? 6000 : 1000);
  for (const f of page.frames()) {
    const counts = await f.evaluate(`(${JSON.stringify(sel)} && Object.fromEntries(Object.entries(${JSON.stringify(sel)})
      .filter(([k, v]) => !k.endsWith('Attr') && k !== 'newestFirst' && v).map(([k, s]) => { try { return [k, document.querySelectorAll(s).length]; } catch { return [k, 'bad selector']; } })))`)
      .catch(() => null) as Record<string, number | string> | null;
    if (counts && Object.values(counts).some((n) => typeof n === 'number' && n > 0)) console.log(`frame ${f.url().slice(0, 90)}\n`, counts);
  }
  try {
    const me = names.length ? names : ['Julev'];
    const r = kind === 'google_chat' ? await readChat(page, sel as Selectors, me) : await readWatched(page, kind, sel as unknown as ReturnType<typeof watchSelectors>, me);
    console.log(`space: ${r.title}\nmessages: ${r.messages.length} (last 8 below)`);
    for (const m of r.messages.slice(-8)) {
      console.log(`- [${m.sent_at ?? 'no time'}] ${m.from_me ? '(me) ' : ''}${m.sender_name || '(no sender)'}: ${m.body.slice(0, 100).replace(/\s+/g, ' ')}  id=${m.external_id.slice(0, 40)}${m.thread_key ? ` thread=${m.thread_key.slice(0, 20)}` : ''}`);
    }
  } catch (e) {
    console.log(`read failed: ${e instanceof Error ? e.message : e}`);
  }
});
pool.forgetAll();
process.exit(0);
