import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyDue, jailName, terminalAllowed, tokenSource } from './wire';

test('tokens: Client Vault first, then OPERATOR_<PLATFORM>_TOKEN_<CLIENT>, else null', async () => {
  const env = { OPERATOR_WEBFLOW_TOKEN_LVLUP: ' wf-env ', OPERATOR_AIRTABLE_TOKEN_MADAM_MUSE: 'pat-env' };
  const logs: string[] = [];
  const src = tokenSource({
    vaultToken: async (client, platform) => {
      if (client === 'broken') throw new Error('decrypt failed');
      return client === 'lvlup' && platform === 'airtable' ? { token: 'pat-vault', source: 'vault', credentialId: 'c1', allowlist: [] } : null;
    },
    keyring: () => null, env: () => env, log: (m) => logs.push(m),
  });
  assert.equal((await src('lvlup', 'airtable'))?.token, 'pat-vault');
  const wf = await src('lvlup', 'webflow');
  assert.deepEqual([wf?.token, wf?.source, wf?.envName], ['wf-env', 'env', 'OPERATOR_WEBFLOW_TOKEN_LVLUP']);
  assert.equal((await src('madam-muse', 'airtable'))?.token, 'pat-env');
  assert.equal(await src('broken', 'webflow'), null);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0]!, /pat-|wf-/);
});

test('terminal only when agent commands are isolated', () => {
  assert.equal(terminalAllowed({ isolated: true, refusal: null }), true);
  assert.equal(terminalAllowed({ isolated: false, refusal: null }), false);
  assert.equal(terminalAllowed({ isolated: false, refusal: 'disabled' }), false);
});

test('jail name and daily housekeeping (Manila day)', () => {
  assert.equal(jailName('0b1c-..//x'), 'job-0b1c-x');
  assert.equal(dailyDue(null, Date.parse('2026-10-16T01:00:00Z')), true);
  // 15:00Z and 15:59Z on the 15th are both 23:xx on the 15th in Manila
  assert.equal(dailyDue('2026-10-15T15:00:00Z', Date.parse('2026-10-15T15:59:00Z')), false);
  // 16:00Z is midnight on the 16th in Manila
  assert.equal(dailyDue('2026-10-15T15:59:00Z', Date.parse('2026-10-15T16:00:00Z')), true);
});
