import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envName, serverSetup, setupChecklist, slugify, viewerHostFor, viewerPort } from './operatorSetup';

test('setup: short names, env names, viewer hosts and ports', () => {
  assert.equal(slugify('Madam Muse'), 'madam-muse');
  assert.equal(slugify('  Café Ñoño & Co. '), 'cafe-nono-co');
  assert.equal(envName('madam-muse'), 'OPERATOR_CDP_MADAM_MUSE');
  assert.equal(viewerHostFor('lvlup'), 'ws.rizehub.ph');
  assert.equal(viewerHostFor('madam-muse'), 'ws-madam-muse.rizehub.ph');
  assert.equal(viewerPort('lvlup', ['lvlup', 'madam-muse']), 3101);
  assert.equal(viewerPort('madam-muse', ['lvlup', 'madam-muse']), 3102);
  assert.equal(viewerPort('new', ['lvlup']), 3102);
});

test('setup: the server lines for a new client mirror the lvlup pair', () => {
  const s = serverSetup('madam-muse', 3102);
  assert.match(s.compose, /^ {2}ws-madam-muse:\n {4}<<: \*browser/);
  assert.match(s.compose, /- \.\/profiles\/madam-muse:\/config/);
  assert.match(s.compose, /ports: \["\$\{VIEWER_BIND:-127\.0\.0\.1\}:3102:3001"\]/);
  assert.match(s.compose, /network_mode: "service:ws-madam-muse"/);
  assert.equal(s.env, 'OPERATOR_CDP_MADAM_MUSE=http://ws-madam-muse:9223');
  assert.match(s.nginx, /ws-madam-muse\.rizehub\.ph.*127\.0\.0\.1:3102/);
  assert.match(s.commands, /mkdir -p deploy\/workspace\/profiles\/madam-muse/);
});

test('setup: the Ready? list (optional items do not block)', () => {
  const base = { client: null, logins: [], accounts: 0, channels: 0, whatsapp: false, webflowLinked: false, airtableLinked: false, online: false };
  assert.equal(setupChecklist(base).filter((i) => !i.done && !i.optional).length, 6);
  const ready = setupChecklist({ ...base, client: { slug: 'mm', name: 'MM', viewer_url: 'https://ws-mm.rizehub.ph/', brain_project: null },
    logins: [{ site: 'google', state: 'ok', enabled: true }], accounts: 1, online: true });
  assert.deepEqual(ready.filter((i) => !i.done && !i.optional), []);
  assert.equal(setupChecklist({ ...base, logins: [{ site: 'slack', state: 'signed_out', enabled: true }] }).find((i) => i.label === 'All logins OK')!.done, false);
});
