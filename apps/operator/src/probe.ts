// Selector probe (docs/17-OPERATOR.md "Tuning the Google Chat selectors"). Read-only: attaches to a profile's browser,
// opens (or reuses) the chat tab, and prints what each selector finds plus the messages the watcher would store.
// Never types or sends.
//
//   docker compose exec operator ./node_modules/.bin/tsx src/probe.ts lvlup https://chat.google.com/room/AAAA...
//   OPERATOR_CDP_LVLUP=http://127.0.0.1:9223 pnpm --filter operator probe lvlup <chat url>     (through an SSH tunnel)
import { cdpEndpointFor, loadOperatorConfig } from './config';
import { BrowserPool, chatPage } from './browser/cdp';
import { selectors, type Selectors } from './browser/chatDom';
import { readChat } from './browser/googleChat';

const [profile, url, ...names] = process.argv.slice(2);
if (!profile || !url) {
  console.log('usage: probe <profile> <chat url> [my display name …]');
  process.exit(2);
}
const cfg = loadOperatorConfig(process.env);
const sel = selectors(cfg.selectorOverrides);
const pool = new BrowserPool((p) => cdpEndpointFor(p, process.env));

await pool.with(profile, async (ctx) => {
  const { page, opened } = await chatPage(ctx, url);
  console.log(`tab: ${opened ? 'opened' : 'reused'} ${page.url()}`);
  await page.waitForTimeout(opened ? 6000 : 1000);
  for (const f of page.frames()) {
    const counts = await f.evaluate(`(${JSON.stringify(sel)} && Object.fromEntries(Object.entries(${JSON.stringify(sel)})
      .filter(([k]) => !k.endsWith('Attr')).map(([k, s]) => { try { return [k, document.querySelectorAll(s).length]; } catch { return [k, 'bad selector']; } })))`)
      .catch(() => null) as Record<keyof Selectors, number | string> | null;
    if (counts && Object.values(counts).some((n) => typeof n === 'number' && n > 0)) console.log(`frame ${f.url().slice(0, 90)}\n`, counts);
  }
  try {
    const r = await readChat(page, sel, names.length ? names : ['Julev']);
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
