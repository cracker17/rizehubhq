import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLogins, loginVerdict } from './logins';

const p = (finalUrl: string, extra: Partial<{ passwordField: boolean; checkUrl: string }> = {}) => ({ checkUrl: extra.checkUrl ?? 'https://webflow.com/dashboard', finalUrl, title: 'x', passwordField: extra.passwordField ?? false, status: 200 });

test('signed out: redirect to a sign-in page, a known logged-out page, or a password field', () => {
  assert.equal(loginVerdict('google', p('https://accounts.google.com/v3/signin/identifier?continue=x', { checkUrl: 'https://chat.google.com/' })).state, 'signed_out');
  assert.equal(loginVerdict('google', p('https://workspace.google.com/products/chat/', { checkUrl: 'https://chat.google.com/' })).state, 'signed_out');
  assert.equal(loginVerdict('webflow', p('https://webflow.com/login?r=%2Fdashboard')).state, 'signed_out');
  assert.equal(loginVerdict('airtable', p('https://airtable.com/login?continue=%2Faccount', { checkUrl: 'https://airtable.com/account' })).state, 'signed_out');
  assert.equal(loginVerdict('custom', p('https://app.example.com/home', { passwordField: true })).state, 'signed_out');
  assert.equal(loginVerdict('custom', p('https://app.example.com/auth/start', { checkUrl: 'https://app.example.com/home' })).state, 'signed_out');
});

test('still logged in', () => {
  assert.equal(loginVerdict('google', p('https://chat.google.com/u/0/app/home', { checkUrl: 'https://chat.google.com/' })).state, 'ok');
  assert.equal(loginVerdict('webflow', p('https://webflow.com/dashboard/sites')).state, 'ok');
  assert.equal(loginVerdict('airtable', p('https://airtable.com/account', { checkUrl: 'https://airtable.com/account' })).state, 'ok');
});

test('a failing check is recorded as error (not as a lost login) and the pass goes on', async () => {
  const rec: string[] = [];
  const n = await checkLogins({
    logins: async () => [{ client_slug: 'lvlup', site: 'webflow', check_url: 'https://webflow.com/dashboard' }, { client_slug: 'lvlup', site: 'google', check_url: 'https://chat.google.com/' }],
    profileOf: async () => 'lvlup',
    withProfile: () => async (fn) => fn({ newPage: async () => { throw new Error('browser down'); } } as never),
    record: async (c, s, st) => { rec.push(`${c}/${s}:${st}`); },
  });
  assert.equal(n, 2);
  assert.deepEqual(rec, ['lvlup/webflow:error', 'lvlup/google:error']);
});
