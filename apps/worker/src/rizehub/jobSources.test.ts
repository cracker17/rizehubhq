import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_JOB_SOURCES, canonicalJobUrl, fetchJobFeeds, parseFeed, platformTags, type JobSource } from './jobSources';

const fx = (f: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', f), 'utf8');
const NOW = new Date('2026-09-28T02:00:00Z');

function fakeFetch(map: Record<string, string | number | 'timeout'>) {
  const calls: string[] = [];
  const f = async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.ok(init.signal, 'every fetch has a timeout signal');
    const v = map[url];
    if (v === undefined) throw new TypeError('fetch failed: getaddrinfo ENOTFOUND (offline)');
    if (v === 'timeout') { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
    if (typeof v === 'number') return new Response('error', { status: v });
    return new Response(v, { status: 200 });
  };
  return { f, calls };
}

test('RSS 2.0 (We Work Remotely): company split from title, HTML stripped, entities decoded, dates parsed', () => {
  const items = parseFeed(fx('wwr.rss.xml'), { splitCompanyFromTitle: true });
  assert.equal(items.length, 4);
  assert.equal(items[0]!.company, 'Kestrel Goods');
  assert.equal(items[0]!.title, 'Senior Shopify Developer (Liquid, OS 2.0)');
  assert.match(items[0]!.summary, /Shopify developer to rebuild our theme sections & improve Core Web Vitals/);
  assert.match(items[0]!.summary, /\$45–60\/hr/);
  assert.equal(items[0]!.posted_at, '2026-09-25T10:15:00.000Z');
  assert.equal(items[0]!.location, 'Anywhere in the World');
  assert.equal(items[1]!.title, 'Webflow Developer & Designer'); // CDATA
});

test('Atom: alternate link, company tag, category terms, html title', () => {
  const items = parseFeed(fx('board.atom.xml'));
  assert.equal(items.length, 2);
  assert.equal(items[0]!.url, 'https://jobs.example.org/p/1234-wordpress-elementor-developer#apply');
  assert.equal(items[0]!.title, 'WordPress & Elementor Developer (part-time)');
  assert.equal(items[0]!.company, 'Harbor & Pine Studio');
  assert.match(items[0]!.summary, /^wordpress Maintain 12 client sites/);
  assert.equal(items[0]!.posted_at, '2026-09-27T03:00:00.000Z');
});

test('canonical URLs drop tracking params, hash, www and trailing slash', () => {
  assert.equal(canonicalJobUrl('https://www.WeWorkRemotely.com/remote-jobs/x/?utm_source=rss&utm_medium=feed#top'), 'https://weworkremotely.com/remote-jobs/x');
  assert.equal(canonicalJobUrl('http://jobs.example.org/p?id=2&ref=abc&b=1'), 'https://jobs.example.org/p?b=1&id=2');
  assert.equal(canonicalJobUrl('javascript:alert(1)'), null);
  assert.equal(canonicalJobUrl('not a url'), null);
});

test('platform tags from text', () => {
  assert.deepEqual(platformTags('Shopify Liquid + React front-end'), ['shopify', 'frontend']);
  assert.deepEqual(platformTags('WooCommerce and Webflow'), ['webflow', 'wordpress']);
});

test('fetchJobFeeds: filters by terms + age, dedupes across sources, JSON mappers, failures are reported not thrown', async () => {
  const sources: JobSource[] = [
    { id: 'weworkremotely', name: 'WWR', kind: 'rss', url: 'https://wwr.test/feed.rss', splitCompanyFromTitle: true },
    { id: 'board', name: 'Board', kind: 'rss', url: 'https://board.test/atom' },
    { ...DEFAULT_JOB_SOURCES.find((s) => s.id === 'remotive')!, url: 'https://remotive.test/api' },
    { ...DEFAULT_JOB_SOURCES.find((s) => s.id === 'remoteok')!, url: 'https://remoteok.test/api' },
    { id: 'down', name: 'Offline board', kind: 'rss', url: 'https://down.test/feed' },
    { id: 'slow', name: 'Slow board', kind: 'json', url: 'https://slow.test/api', mapJson: () => [] },
    { id: 'broken', name: 'Broken board', kind: 'json', url: 'https://broken.test/api', mapJson: () => [] },
  ];
  const { f, calls } = fakeFetch({
    'https://wwr.test/feed.rss': fx('wwr.rss.xml'), 'https://board.test/atom': fx('board.atom.xml'),
    'https://remotive.test/api': fx('remotive.json'), 'https://remoteok.test/api': fx('remoteok.json'),
    'https://slow.test/api': 'timeout', 'https://broken.test/api': 500,
  });
  const res = await fetchJobFeeds({ sources, fetch: f, now: NOW, sinceDays: 14 });
  assert.equal(calls.length, 7);
  const titles = res.items.map((i) => i.title).sort();
  assert.deepEqual(titles, [
    'Front-End Developer (React + Figma)', 'Senior Shopify Developer (Liquid, OS 2.0)', 'Shopify Theme Developer',
    'Webflow Developer & Designer', 'WordPress & Elementor Developer (part-time)',
  ]); // Golang filtered by terms, June WordPress post by age, Kestrel duplicate (Atom) deduped, empty-url entry dropped
  const kestrel = res.items.find((i) => i.title.startsWith('Senior Shopify'))!;
  assert.equal(kestrel.url, 'https://weworkremotely.com/remote-jobs/kestrel-goods-senior-shopify-developer');
  assert.equal(kestrel.source, 'weworkremotely');
  assert.deepEqual(kestrel.platform_tags, ['shopify', 'frontend']); // category "Front-End Programming"
  const rok = res.items.find((i) => i.source === 'remoteok')!;
  assert.equal(rok.url, 'https://remoteok.com/remote-jobs/99-front-end-developer-tidepool');
  assert.equal(rok.rate, 'USD 60k–90k/year');
  assert.equal(res.items.find((i) => i.source === 'remotive')!.rate, '$50/hr');
  // newest first
  assert.equal(res.items[0]!.title, 'Shopify Theme Developer');
  const byId = Object.fromEntries(res.sources.map((s) => [s.id, s]));
  assert.equal(byId.down!.ok, false);
  assert.match(byId.down!.error!, /offline/);
  assert.equal(byId.slow!.error, 'timed out');
  assert.equal(byId.broken!.error, 'HTTP 500');
  assert.equal(byId.weworkremotely!.items, 4);
  assert.equal(byId.weworkremotely!.kept, 2);
});

test('fetchJobFeeds with every source offline returns nothing and does not throw', async () => {
  const res = await fetchJobFeeds({ sources: DEFAULT_JOB_SOURCES, fetch: fakeFetch({}).f, now: NOW });
  assert.equal(res.items.length, 0);
  assert.ok(res.sources.every((s) => !s.ok));
});
