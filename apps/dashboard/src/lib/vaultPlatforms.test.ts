import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_PRESET, PLATFORM_LABEL, PLATFORM_SLUG, TOOL_PLATFORM_LABEL, TOOL_PRESET, platformLabel } from './vaultPlatforms';

// agents/roster.yaml (six agents). A grant for an unknown agent is silently dropped by vault_insert_credential.
const ROSTER = new Set(['coo', 'web-dev', 'designer', 'writer', 'sales', 'qa-lead']);

test('every client and tool platform slug is one the database accepts (vault_platform_ok)', () => {
  for (const slug of [...Object.keys(PLATFORM_LABEL), ...Object.keys(TOOL_PLATFORM_LABEL)]) assert.match(slug, PLATFORM_SLUG, slug);
  assert.doesNotMatch('Shop ify!', PLATFORM_SLUG);
});

test('presets: every platform has a grant suggestion, only for real agents and listed platforms', () => {
  for (const [name, p] of Object.entries({ client: CLIENT_PRESET, tool: TOOL_PRESET })) {
    assert.deepEqual(Object.keys(p.suggestedGrants).sort(), Object.keys(p.platforms).sort(), `${name}: grants cover exactly the platforms`);
    for (const [platform, agents] of Object.entries(p.suggestedGrants)) {
      for (const a of agents) assert.ok(ROSTER.has(a), `${name}.${platform}: unknown agent ${a}`);
    }
    assert.ok(p.passwordHint.length > 10);
    assert.ok(Object.values(p.placeholder).every((v) => v.trim().length > 0));
  }
  assert.equal(TOOL_PRESET.platforms, TOOL_PLATFORM_LABEL);
  assert.equal(CLIENT_PRESET.platforms, PLATFORM_LABEL);
});

test('tool preset examples stay inside the worker\'s own rules (https allowlist, METHOD /path writes)', () => {
  for (const line of TOOL_PRESET.placeholder.allow.split('\n')) assert.match(line, /^https:\/\/[^\s]+$/);
  for (const line of TOOL_PRESET.placeholder.writes.split('\n')) assert.match(line, /^(POST|PUT|PATCH) (\/|https:\/\/)\S+$/);
  assert.match(TOOL_PRESET.placeholder.loginUrl, /^https:\/\//);
});

test('platformLabel: client names first, then tool names, then the raw slug', () => {
  assert.equal(platformLabel('shopify'), 'Shopify');
  assert.equal(platformLabel('semrush'), 'Semrush');
  assert.equal(platformLabel('shopify-partner'), 'Shopify Partner');
  assert.equal(platformLabel('github'), 'GitHub');
  assert.equal(platformLabel('some-new-tool'), 'some-new-tool');
});
