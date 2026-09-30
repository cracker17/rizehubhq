import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, docDate, docTitle, parseFrontmatter } from './documents';

test('classify follows the vault layout', () => {
  assert.deepEqual(classify('projects/hq-brain/memory.md'), { kind: 'memory', project: 'hq-brain' });
  assert.deepEqual(classify('projects/hq-brain/sessions/2026-09-30-plan-and-handoff.md'), { kind: 'session', project: 'hq-brain' });
  assert.deepEqual(classify('projects/hq-brain/sessions/2026-09-30-code-abc.md'), { kind: 'transcript', project: 'hq-brain' });
  assert.deepEqual(classify('projects/hq-brain/sessions/LOG.md'), { kind: 'session_log', project: 'hq-brain' });
  assert.deepEqual(classify('projects/rizehub-hq/brain-plan.md'), { kind: 'project_doc', project: 'rizehub-hq' });
  assert.deepEqual(classify('projects/job-search/notes/deep.md'), { kind: 'project_doc', project: 'job-search' });
  assert.deepEqual(classify('profile/profile.md'), { kind: 'profile', project: null });
  assert.deepEqual(classify('scheduled-tasks/azzurro-monthly.md'), { kind: 'scheduled_task', project: null });
  assert.deepEqual(classify('prompts/harvest-chat.md'), { kind: 'prompt', project: null });
  assert.deepEqual(classify('claude-commands/load.md'), { kind: 'command', project: null });
  assert.deepEqual(classify('README.md'), { kind: 'readme', project: null });
  assert.deepEqual(classify('CLAUDE.md'), { kind: 'readme', project: null });
  assert.deepEqual(classify('scripts/hooks/x.md'), { kind: 'other', project: null });
  assert.deepEqual(classify('projects/Bad Slug/memory.md'), { kind: 'other', project: null });
});

test('frontmatter: dates become strings, broken YAML falls back to plain text', () => {
  const { data, body } = parseFrontmatter('---\nproject: hq-brain\nupdated: 2026-09-30\ncron: "52 8 29 * *"\n---\n# HQ Brain\n\ntext');
  assert.deepEqual(data, { project: 'hq-brain', updated: '2026-09-30', cron: '52 8 29 * *' });
  assert.equal(body, '# HQ Brain\n\ntext');
  const broken = '---\nname: [unclosed\n---\nbody';
  assert.deepEqual(parseFrontmatter(broken), { data: {}, body: broken });
  assert.deepEqual(parseFrontmatter('# no frontmatter'), { data: {}, body: '# no frontmatter' });
});

test('date and title', () => {
  assert.equal(docDate('projects/x/memory.md', { updated: '2026-09-30' }), '2026-09-30');
  assert.equal(docDate('projects/x/sessions/2026-09-28-topic.md', {}), '2026-09-28');
  assert.equal(docDate('projects/x/sessions/2026-02-31-bad.md', {}), null);
  assert.equal(docDate('profile/profile.md', {}), null);
  assert.equal(docTitle('a/b.md', { name: 'Azzurro monthly' }, '# H'), 'Azzurro monthly');
  assert.equal(docTitle('a/b.md', {}, 'intro\n# Heading one\n'), 'Heading one');
  assert.equal(docTitle('a/plain-file.md', {}, 'no heading'), 'plain-file');
});
