import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeApiAction, type ApiEnv } from './apis';
import { githubRead, vercelRead } from './devapis';

const TOKEN = 'ghp_secret_token_1234567890abcdef';
function env(responses: (req: { url: string; method: string; body: unknown }) => { status?: number; json?: unknown }, team: string | null = null) {
  const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
  const a: ApiEnv = {
    env: {},
    tokens: async () => ({ token: TOKEN, source: 'vault', allowlist: [] }),
    vercelTeam: async () => team,
    http: {
      sleep: async () => undefined,
      fetch: (async (url: string, init: RequestInit) => {
        const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url, method: init.method ?? 'GET', body, headers: init.headers as Record<string, string> });
        const r = responses({ url, method: init.method ?? 'GET', body });
        return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    },
  };
  return { a, calls };
}

test('github: reads (PRs, files, CI) go through; writes refused with the request_action hint; bad repos refused', async () => {
  const { a, calls } = env(({ url }) => {
    if (url.includes('/pulls?')) return { json: [{ number: 42, title: 'Fix footer link', state: 'open', draft: false, user: { login: 'riley' }, head: { ref: 'fix/footer' }, base: { ref: 'main' }, html_url: 'https://github.com/lvlup/site/pull/42' }] };
    if (url.includes('/contents/')) return { json: { content: Buffer.from('# LvlUp site\n').toString('base64') } };
    return { json: { workflow_runs: [{ id: 7, name: 'CI', head_branch: 'main', status: 'completed', conclusion: 'failure' }] } };
  });
  assert.match(await githubRead(a, 'lvlup', { op: 'list_prs', repo: 'lvlup/site' }), /"number":42.*"head":"fix\/footer"/);
  assert.equal(calls[0]!.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0]!.headers['x-github-api-version'], '2022-11-28');
  assert.equal(await githubRead(a, 'lvlup', { op: 'get_file', repo: 'lvlup/site', path: 'README.md' }), '# LvlUp site\n');
  assert.match(await githubRead(a, 'lvlup', { op: 'list_workflow_runs', repo: 'lvlup/site' }), /"conclusion":"failure"/);
  assert.match(await githubRead(a, 'lvlup', { op: 'merge_pr', repo: 'lvlup/site' }), /^Refused: .*github_merge/);
  assert.match(await githubRead(a, 'lvlup', { op: 'get_repo', repo: '../etc' }), /^Refused: repo must be/);
  assert.match(await githubRead(a, 'lvlup', { op: 'get_file', repo: 'lvlup/site', path: '../../x' }), /^Refused: path/);
});

test('vercel: deployments and build logs with the team id; promote / env changes refused as reads', async () => {
  const { a, calls } = env(({ url }) => (url.includes('/events')
    ? { json: [{ payload: { text: 'Installing…' } }, { payload: { text: 'Error: Module not found: ./Footer' } }] }
    : { json: { deployments: [{ uid: 'dpl_1', url: 'lvlup-site-abc.vercel.app', state: 'ERROR', target: 'production', meta: { githubCommitMessage: 'footer\nmore', githubCommitRef: 'main' } }] } }), 'team_LvlUp01');
  assert.match(await vercelRead(a, 'lvlup', { op: 'list_deployments', project: 'lvlup-site' }), /"id":"dpl_1","url":"https:\/\/lvlup-site-abc.vercel.app","state":"ERROR".*"commit":"footer"/);
  assert.match(calls[0]!.url, /\/v6\/deployments\?projectId=lvlup-site&limit=10&teamId=team_LvlUp01$/);
  assert.match(await vercelRead(a, 'lvlup', { op: 'build_logs', deployment_id: 'dpl_1' }), /Module not found/);
  assert.match(await vercelRead(a, 'lvlup', { op: 'promote', project: 'x' }), /^Refused: .*vercel_promote/);
  assert.match(await vercelRead(a, 'lvlup', { op: 'get_deployment' }), /^Refused: deployment_id is required/);
});

test('approved actions: issue, merge (squash by default), redeploy from the source deployment, promote; token never leaks', async () => {
  const { a, calls } = env(({ url, method }) => {
    if (method === 'PUT') return { json: { merged: true, sha: 'abc123' } };
    if (url.endsWith('/issues') && method === 'POST') return { json: { number: 9, html_url: 'https://github.com/lvlup/site/issues/9' } };
    if (url.includes('/v13/deployments/dpl_1')) return { json: { name: 'lvlup-site' } };
    if (url.includes('/v13/deployments?')) return { json: { id: 'dpl_2', url: 'lvlup-site-new.vercel.app', readyState: 'QUEUED' } };
    if (url.includes('/promote/')) return { status: 201, json: {} };
    return { status: 422, json: { message: `nope ${TOKEN}` } };
  });
  const run = (kind: string, spec: Record<string, unknown>) => executeApiAction(a, { id: 'x', job_id: 'j', client_slug: 'lvlup', kind, summary: 's', spec });
  assert.deepEqual((await run('github_issue', { repo: 'lvlup/site', title: 'Broken footer link', body: 'Found by QA' })).result, { issue: 9, url: 'https://github.com/lvlup/site/issues/9' });
  const m = await run('github_merge', { repo: 'lvlup/site', number: 42 });
  assert.deepEqual([m.ok, m.result.method], [true, 'squash']);
  assert.deepEqual(calls.find((c) => c.method === 'PUT')!.body, { merge_method: 'squash' });
  const r = await run('vercel_redeploy', { deployment_id: 'dpl_1' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.find((c) => c.url.includes('/v13/deployments?'))!.body, { name: 'lvlup-site', deploymentId: 'dpl_1' });
  assert.equal((await run('vercel_promote', { project: 'lvlup-site', deployment_id: 'dpl_2' })).ok, true);
  const bad = await run('github_comment', { repo: 'lvlup/site', number: 1, body: 'hi' });
  assert.equal(bad.ok, false);
  assert.equal(String(bad.error).includes(TOKEN), false);
  assert.equal((await run('github_merge', { repo: 'lvlup/site', number: 0 })).ok, false);
});
