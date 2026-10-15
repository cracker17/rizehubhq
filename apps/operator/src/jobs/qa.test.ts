import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qaFeedback, qaSummary, qaTargets, qaVerdict, type QaPage, type QaReport } from './qa';

const page = (p: Partial<QaPage> = {}): QaPage => ({
  url: 'https://lvlup.example/team', finalUrl: 'https://lvlup.example/team', status: 200, title: 'Team', consoleErrors: [], failedRequests: [],
  overflow: { viewport: 375, scrollWidth: 375, overflowing: false, offenders: [] }, shots: [{ width: 375, jpeg: Buffer.from('x') }], error: null, ...p,
});
const links = (broken: { url: string; status: number }[] = []) => ({ page: 'https://lvlup.example/team', found: 5, checked: 5, ok: 5 - broken.length, skipped: 0,
  broken: broken.map((b) => ({ ...b, error: null, anchors: ['Read more'] })), blocked: [], redirected: 0, truncated: false });

test('a clean page passes; third-party noise is only a warning', () => {
  const r: QaReport = { pages: [page({ consoleErrors: ['Failed to load https://www.googletagmanager.com/gtm.js'], failedRequests: ['https://cdn.other.example/x.js → HTTP 404'] })], links: [links()] };
  const v = qaVerdict(r);
  assert.equal(v.pass, true);
  assert.equal(v.warnings.length, 2);
});

test('first-party errors, HTTP errors, overflow and broken links fail with findings', () => {
  const r: QaReport = {
    pages: [page({ status: 500 }), page({ url: 'https://lvlup.example/a', finalUrl: 'https://lvlup.example/a', consoleErrors: ['TypeError: x is undefined'],
      failedRequests: ['https://lvlup.example/img/hero.webp → HTTP 404'], overflow: { viewport: 375, scrollWidth: 512, overflowing: true, offenders: [{ el: 'div.hero', right: 512, width: 512 }] } }),
      page({ url: 'https://lvlup.example/b', error: 'net::ERR_NAME_NOT_RESOLVED' })],
    links: [links([{ url: 'https://lvlup.example/old', status: 404 }]), { page: 'https://lvlup.example/c', error: 'timeout' }],
  };
  const v = qaVerdict(r);
  assert.equal(v.pass, false);
  const all = v.errors.join('\n');
  assert.match(all, /HTTP 500/);
  assert.match(all, /console error: TypeError/);
  assert.match(all, /hero\.webp → HTTP 404/);
  assert.match(all, /horizontal scroll at 375 px \(page 512px wide; div\.hero\)/);
  assert.match(all, /did not load/);
  assert.match(all, /broken link https:\/\/lvlup\.example\/old → 404/);
  assert.match(v.warnings.join('\n'), /link check of https:\/\/lvlup\.example\/c failed/);
  assert.match(qaFeedback(v), /^QA found 6 problem\(s\)/);
  const s = qaSummary(r, v, [7, 8]);
  assert.deepEqual(s.evidence, [7, 8]);
  assert.equal(JSON.stringify(s).includes('jpeg'), false, 'no image bytes in the summary');
});

test('QA targets: http(s) links only, deduplicated, capped', () => {
  assert.deepEqual(qaTargets(['https://a.example/x', 'https://a.example/x', 'mailto:x@y.z', 'not a url', 42, 'http://b.example/', 'https://c.example', 'https://d.example']),
    ['https://a.example/x', 'http://b.example/', 'https://c.example/']);
  assert.deepEqual(qaTargets(null), []);
});
