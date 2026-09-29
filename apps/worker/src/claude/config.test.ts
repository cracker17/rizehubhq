// Claude runtime configuration: switches, model resolution through config/models.yaml, startup report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModelsConfig } from '../models/router';
import { claudeFileTools, claudeModel, claudeRuntimeEnabled, claudeStartupReport, claudeTimeoutMs, DEFAULT_CLAUDE_TIMEOUT_MS, hqMcpUrl } from './config';

const cfg = loadModelsConfig();
const dev = { id: 'web-dev', model_role: 'dev' as const };

test('claude config: off by default; file tools hq unless native; timeout; MCP url', () => {
  assert.equal(claudeRuntimeEnabled({}), false);
  for (const v of ['true', '1', 'on', 'YES']) assert.equal(claudeRuntimeEnabled({ CLAUDE_RUNTIME_ENABLED: v }), true, v);
  for (const v of ['false', '0', 'off', '']) assert.equal(claudeRuntimeEnabled({ CLAUDE_RUNTIME_ENABLED: v }), false, v);
  assert.equal(claudeFileTools({}), 'hq');
  assert.equal(claudeFileTools({ CLAUDE_FILE_TOOLS: 'native' }), 'native');
  assert.equal(claudeFileTools({ CLAUDE_FILE_TOOLS: 'bash' }), 'hq');
  assert.equal(claudeTimeoutMs({}), DEFAULT_CLAUDE_TIMEOUT_MS);
  assert.equal(claudeTimeoutMs({ CLAUDE_TIMEOUT_MS: '60000' }), 60_000);
  assert.equal(claudeTimeoutMs({ CLAUDE_TIMEOUT_MS: 'soon' }), DEFAULT_CLAUDE_TIMEOUT_MS);
  assert.match(hqMcpUrl({}), /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(hqMcpUrl({ CLAUDE_HQ_MCP_URL: 'http://hq-worker:4000/mcp/' }), 'http://hq-worker:4000/mcp');
});

test('claude config: model = CLAUDE_MODEL_<AGENT> → CLAUDE_MODEL → role order (override, MODEL_ID_<ROLE>, profile) → claude profile', () => {
  assert.equal(claudeModel(dev, { env: { CLAUDE_MODEL_WEB_DEV: 'claude-opus-5-5', CLAUDE_MODEL: 'claude-sonnet-5' }, cfg }), 'claude-opus-5-5');
  assert.equal(claudeModel(dev, { env: { CLAUDE_MODEL: 'anthropic:claude-haiku-4-5' }, cfg }), 'claude-haiku-4-5');
  assert.equal(claudeModel(dev, { env: { CLAUDE_MODEL: 'openai:gpt-5.5' }, cfg, profile: 'free' }), cfg.profiles.claude!.dev![0]!.split(':')[1], 'a non-Anthropic value is ignored');
  assert.equal(claudeModel(dev, { env: {}, cfg, profile: 'free', override: 'anthropic:claude-opus-5' }), 'claude-opus-5');
  assert.equal(claudeModel(dev, { env: { MODEL_ID_DEV: 'anthropic:claude-sonnet-5-5' }, cfg, profile: 'free' }), 'claude-sonnet-5-5');
  assert.equal(claudeModel(dev, { env: {}, cfg, profile: 'paid' }), cfg.profiles.paid!.dev![0]!.split(':')[1]);
  assert.equal(claudeModel(dev, { env: {}, cfg, profile: 'free' }), cfg.profiles.claude!.dev![0]!.split(':')[1], 'free profile has no Anthropic model → claude profile');
  const noClaude = { ...cfg, profiles: { free: cfg.profiles.free! } };
  assert.equal(claudeModel(dev, { env: {}, cfg: noClaude, profile: 'free' }), null);
});

test('claude config: startup report says where runtime:claude agents run', () => {
  const roles = [{ id: 'web-dev', runtime: 'claude' }, { id: 'coo', runtime: 'worker' }];
  const off = claudeStartupReport(roles, {}, 0);
  assert.match(off.line, /on the built-in runner \(CLAUDE_RUNTIME_ENABLED is off, ANTHROPIC_API_KEY not set, MONTHLY_BUDGET_USD is 0\): web-dev/);
  assert.equal(off.warnings.length, 1);
  const on = claudeStartupReport(roles, { CLAUDE_RUNTIME_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-ant-x' }, 30);
  assert.match(on.line, /on Claude: web-dev · file tools hq/);
  assert.equal(on.warnings.length, 0);
  assert.match(claudeStartupReport([{ id: 'coo', runtime: 'worker' }], {}, 0).line, /runtime:claude agents none/);
});
