// Live key checks with a fake fetch: which endpoint each provider gets, how answers map to ok / rejected, and that the
// key never appears in a message (Semrush and PageSpeed put keys in URLs; some APIs echo them in errors).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_KEY_NAMES } from '@rizehubhq/shared';
import { createKeyTester, KEY_PROBES, redact } from './keyTest';

const KEY = 'key_value_for_probe_tests_42';

function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (u: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(u), init: init ?? {} });
    return answer(String(u), init ?? {});
  }) as typeof fetch;
  return { f, calls };
}

test('every allowlisted key has a probe entry (null = stored untested)', () => {
  assert.deepEqual(Object.keys(KEY_PROBES).sort(), [...PROVIDER_KEY_NAMES].sort());
  assert.equal(KEY_PROBES.PAGESPEED_API_KEY, null);
});

test('a 200 means the key works; 401/403 mean rejected; 402/429 mean accepted', async () => {
  const { f, calls } = fakeFetch(() => new Response('{"data":[]}', { status: 200 }));
  const ok = await createKeyTester(f)('ANTHROPIC_API_KEY', KEY);
  assert.deepEqual(ok, { ok: true, message: 'Anthropic accepted the key.' });
  assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/models?limit=1');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['x-api-key'], KEY);
  assert.equal(calls[0]!.init.method, 'GET');

  for (const [status, expect] of [[401, false], [403, false], [402, true], [429, true]] as const) {
    const t = await createKeyTester(fakeFetch(() => new Response('nope', { status })).f)('GROQ_API_KEY', KEY);
    assert.equal(t.ok, expect, String(status));
  }
});

test('search APIs are probed with a 1-result search and say it used a credit', async () => {
  const { f, calls } = fakeFetch(() => new Response('{}', { status: 200 }));
  const t = await createKeyTester(f)('TAVILY_API_KEY', KEY);
  assert.equal(t.ok, true);
  assert.match((t as { message: string }).message, /1 search credit/);
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { query: 'RizeHub', max_results: 1, search_depth: 'basic' });
});

test('errors never contain the key (Semrush 200-with-ERROR text, echoed keys, network failures)', async () => {
  const semrush = await createKeyTester(fakeFetch(() => new Response(`ERROR 120 :: WRONG KEY - ID PAIR ${KEY}`, { status: 200 })).f)('SEMRUSH_API_KEY', KEY);
  assert.equal(semrush.ok, false);
  assert.ok(!JSON.stringify(semrush).includes(KEY));
  const echoed = await createKeyTester(fakeFetch(() => new Response(`bad request for key=${encodeURIComponent(KEY)}`, { status: 400 })).f)('GOOGLE_GENERATIVE_AI_API_KEY', KEY);
  assert.equal(echoed.ok, false);
  assert.ok(!JSON.stringify(echoed).includes(KEY));
  const down = await createKeyTester(fakeFetch(() => { throw new Error(`connect failed ${KEY}`); }).f)('FIGMA_TOKEN', KEY);
  assert.equal(down.ok, false);
  assert.match((down as { error: string }).error, /Could not reach Figma/);
  assert.ok(!JSON.stringify(down).includes(KEY));
  const psi = fakeFetch(() => new Response(''));
  assert.equal((await createKeyTester(psi.f)('PAGESPEED_API_KEY', KEY)).ok, null, 'PageSpeed: stored untested');
  assert.equal(psi.calls.length, 0, 'no Lighthouse run');
  assert.deepEqual(await createKeyTester(fakeFetch(() => new Response('')).f)('SUPABASE_SERVICE_ROLE_KEY', KEY), { ok: false, error: 'Unknown key name.' });
  assert.equal(redact('a abcd b', 'abcd'), 'a [key] b');
});
