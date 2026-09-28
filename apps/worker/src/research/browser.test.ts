import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPreviewHost, resolveChromiumPath } from './browser';
import { memoryEvidenceStore } from './evidence';
import { captureScreenshots, checkMobileOverflow, collectConsoleErrors, runSteps, type CheckEnv } from './pageChecks';
import { FakeResearchBrowser, FakeResearchPage, fakeNet } from './fakes';

const URL1 = 'https://preview.example/';

function env(site: ConstructorParameters<typeof FakeResearchBrowser>[0], extra: Partial<CheckEnv> = {}) {
  const browser = new FakeResearchBrowser(site);
  const evidence = memoryEvidenceStore();
  const net = fakeNet({ dns: { 'internal.example': '10.1.1.1' } });
  const e: CheckEnv = { net, launch: browser.launch, evidence, taskId: 'task-1', now: () => new Date('2026-09-28T02:00:00Z'), ...extra };
  return { browser, evidence, e };
}

test('screenshot at 375/768/1440: files saved as evidence, console errors + overflow collected, browser closed', async () => {
  const { browser, evidence, e } = env({
    [URL1]: {
      title: 'Bundle page', console: ['Uncaught TypeError: x is undefined'], pageErrors: ['boom'],
      subrequests: [{ url: 'https://cdn.example/app.js' }, { url: 'http://169.254.169.254/latest/meta-data/' }, { url: 'https://internal.example/x' },
        { url: 'https://analytics.example/collect', method: 'POST' }],
      overflow: { scrollWidth: 420, offenders: [{ el: 'div.hero', right: 420, width: 420 }] },
    },
  });
  const r = await captureScreenshots(URL1, [375, 768, 1440], true, e);
  assert.deepEqual(r.shots.map((s) => s.width), [375, 768, 1440]);
  assert.deepEqual([...evidence.files.keys()], [375, 768, 1440].map((w) => `task-1/screenshots/20260928T020000Z-preview.example-${w}.jpg`));
  assert.equal(r.shots[0]!.ref, 'storage:evidence/task-1/screenshots/20260928T020000Z-preview.example-375.jpg');
  assert.ok(r.consoleErrors.includes('console.error: Uncaught TypeError: x is undefined'));
  assert.ok(r.consoleErrors.includes('uncaught: boom'));
  assert.equal(r.overflow?.overflowing, true);
  const page = browser.pages[0]!;
  assert.deepEqual(page.viewports, [375, 768, 1440]);
  assert.ok(page.aborted.includes('GET http://169.254.169.254/latest/meta-data/'), 'metadata sub-request blocked');
  assert.ok(page.aborted.includes('GET https://internal.example/x'), 'DNS→private sub-request blocked');
  assert.ok(page.aborted.includes('POST https://analytics.example/collect'), 'non-GET blocked');
  assert.ok(page.continued.includes('GET https://cdn.example/app.js'));
  assert.ok(!r.consoleErrors.some((c) => c.includes('BLOCKED')), 'own blocks are not reported as page errors');
  assert.equal(browser.closed, 1);
});

test('navigation to a private address is refused by the in-browser guard too', async () => {
  const { e } = env({ 'https://internal.example/': { title: 'x' } });
  await assert.rejects(collectConsoleErrors('https://internal.example/', e), /ERR_BLOCKED_BY_CLIENT/);
  await assert.rejects(collectConsoleErrors('http://127.0.0.1:5432/', e), /Blocked address/);
});

test('console_errors, check_mobile_overflow', async () => {
  const { e } = env({ [URL1]: { console: ['bad'], status: 200, overflow: { scrollWidth: 375 } } });
  const c = await collectConsoleErrors(URL1, e);
  assert.deepEqual(c.consoleErrors, ['console.error: bad']);
  const o = await checkMobileOverflow(URL1, 375, e);
  assert.equal(o.overflowing, false);
});

test('steps: fill + click; the form POST is blocked unless allow_post on a preview host', async () => {
  const site = {
    [URL1]: { selectors: ['#email', 'button[type=submit]', '.thanks'], text: 'Thanks for subscribing',
      onClick: { 'button[type=submit]': [{ url: 'https://preview.example/subscribe', method: 'POST' }] } },
  };
  const steps = [
    { action: 'fill' as const, selector: '#email', value: 'qa@rizehub.ph' },
    { action: 'click' as const, selector: 'button[type=submit]' },
    { action: 'expect_text' as const, value: 'thanks' },
    { action: 'wait_for' as const, selector: '.missing' },
    { action: 'click' as const, selector: '.never' },
  ];
  const a = env(site);
  const r = await runSteps(URL1, steps, a.e);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true, false]); // stops at the first failure
  assert.ok(r.blocked.some((b) => b.startsWith('POST https://preview.example/subscribe')));

  const b = env(site, { allowPost: true });
  const r2 = await runSteps(URL1, steps.slice(0, 2), b.e);
  assert.equal(r2.blocked.length, 0);
  assert.ok(b.browser.pages[0]!.continued.includes('POST https://preview.example/subscribe'));

  const prod = 'https://www.client.example/';
  const c = env({ [prod]: { ...site[URL1], onClick: { 'button[type=submit]': [{ url: `${prod}subscribe`, method: 'POST' }] } } }, { allowPost: true });
  const r3 = await runSteps(prod, steps.slice(0, 2), c.e);
  assert.equal(r3.blocked.length, 1, 'allow_post is ignored on a non-preview host');
  assert.equal(isPreviewHost('shop-abc.myshopify.com'), true);
  assert.equal(isPreviewHost('madammuse.co'), false);
});

test('a vault session context is reused instead of launching a new browser', async () => {
  const site = { [URL1]: { title: 'Logged in' } };
  const { browser, e } = env(site);
  const vaultPage = new FakeResearchPage(site);
  let opened = 0;
  const vault = { closed: false, allow: [URL1], context: { newPage: async () => { opened++; return vaultPage; } } };
  const r = await captureScreenshots(URL1, [1440], false, { ...e, vault });
  assert.equal(r.viaVault, true);
  assert.equal(opened, 1);
  assert.equal(browser.launches, 0);
  assert.equal(vaultPage.closedPage, true, 'only the page is closed; the vault session stays open');
});

test('resolveChromiumPath: env first, then the newest chromium-* under the known browser dirs', () => {
  assert.equal(resolveChromiumPath({ PLAYWRIGHT_CHROMIUM_PATH: '/x/chrome' }), '/x/chrome');
  const p = resolveChromiumPath({}, (f) => f === '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    (d) => (d === '/opt/pw-browsers' ? ['chromium-1100', 'chromium-1194', 'ffmpeg-1011'] : []));
  assert.equal(p, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
  assert.equal(resolveChromiumPath({}, () => false, () => []), undefined);
});
