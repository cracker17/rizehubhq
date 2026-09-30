import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown, embedInput, MAX_CHARS, sha256 } from './chunk';

test('chunks follow headings and carry the heading path', () => {
  const c = chunkMarkdown('HQ Brain', '# HQ Brain\nintro line\n\n## Status\n- M0 done\n\n### Detail\nmore\n\n## Empty\n\n## Links\n- repo');
  assert.deepEqual(c.map((x) => [x.heading, x.text]), [
    ['HQ Brain', 'intro line'], ['HQ Brain › Status', '- M0 done'], ['HQ Brain › Status › Detail', 'more'], ['HQ Brain › Links', '- repo'],
  ]);
  assert.equal(c[1].text_sha, sha256(embedInput('HQ Brain', 'HQ Brain › Status', '- M0 done')));
});

test('long sections split under the limit, with overlap, never mid-bullet', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `- bullet number ${i} ${'word '.repeat(8).trim()} end`);
  const c = chunkMarkdown('T', `## Big\n${lines.join('\n')}`);
  assert.ok(c.length > 1);
  for (const x of c) assert.ok(x.text.length <= MAX_CHARS, `${x.text.length}`);
  for (const x of c.slice(1)) assert.match(x.text, /^…/, 'later chunks start with the overlap');
  for (const x of c) for (const l of x.text.split('\n').filter((l) => l.startsWith('- '))) assert.match(l, / end$/, 'whole bullets only');
  const huge = chunkMarkdown('T', 'x'.repeat(5000));
  assert.ok(huge.length >= 5 && huge.every((x) => x.text.length <= MAX_CHARS));
});

test('headings inside code fences are not headings; same text = same sha', () => {
  const c = chunkMarkdown('T', '## Real\n```\n# not a heading\n```');
  assert.equal(c.length, 1);
  assert.equal(c[0].heading, 'Real');
  assert.equal(chunkMarkdown('T', '## A\nsame')[0].text_sha, chunkMarkdown('T', '## A\nsame')[0].text_sha);
});
