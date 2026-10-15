// GitHub and Vercel for jobs (docs/17-OPERATOR.md "GitHub and Vercel"). Same rules as Webflow / Airtable (apis.ts): the
// agent only READS through its tools; changes are proposed with request_action and run here after the CEO's ✅, from
// the spec he saw. Tokens come from the client's Client Vault credential (or OPERATOR_GITHUB_TOKEN_<CLIENT> /
// OPERATOR_VERCEL_TOKEN_<CLIENT>), are never shown to the model and are redacted from every text handed back.
//
//   github reads   list_repos, get_repo, list_issues, get_issue, list_prs, get_pr, list_commits, list_workflow_runs, get_file
//   vercel reads   list_projects, get_project, list_deployments, get_deployment, build_logs, list_domains
//   actions        github_issue, github_comment, github_merge · vercel_redeploy, vercel_promote
import { apiError, httpRequest, Redactor, truncate, type HttpRes } from 'worker/src/dev/http';
import type { Token } from 'worker/src/dev/creds';
import { envSlug } from 'worker/src/dev/env';
import { ApiRefusal, refuse, token, type ActionOutcome, type ApiEnv } from './apis';

export const GITHUB_READS = ['list_repos', 'get_repo', 'list_issues', 'get_issue', 'list_prs', 'get_pr', 'list_commits', 'list_workflow_runs', 'get_file'] as const;
export const VERCEL_READS = ['list_projects', 'get_project', 'list_deployments', 'get_deployment', 'build_logs', 'list_domains'] as const;
const GH = 'https://api.github.com';
const VC = 'https://api.vercel.com';

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const checkRepo = (r: unknown) => (typeof r === 'string' && REPO_RE.test(r.trim()) && !r.includes('..') ? r.trim() : refuse(`repo must be "owner/name", got "${String(r ?? '')}"`));
const checkNum = (n: unknown, what: string) => (Number.isInteger(n) && (n as number) > 0 && (n as number) < 1e9 ? (n as number) : refuse(`${what} must be a positive number`));
const checkVid = (v: unknown, what: string) => (typeof v === 'string' && /^[A-Za-z0-9_.-]{2,100}$/.test(v.trim()) ? v.trim() : refuse(`${what} is required (id or name)`));
const checkPath = (p: unknown) => (typeof p === 'string' && p.trim() && p.length <= 400 && !p.split('/').includes('..') ? p.trim().replace(/^\/+/, '') : refuse('path is a file path in the repo'));
const pick = <T extends Record<string, unknown>>(o: T, keys: string[]) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
const okOr = (r: HttpRes, what: string, map: (j: any) => unknown) => (r.ok ? truncate(JSON.stringify(map(r.json)), 12_000) : apiError(what, r)); // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------- GitHub ----------

function gh(a: ApiEnv, t: Token, method: string, p: string, body?: unknown): Promise<HttpRes> {
  return httpRequest(a.http, {
    url: `${GH}${p}`, method, retries: method === 'GET' ? 3 : 1,
    headers: { authorization: `Bearer ${t.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'rizehub-hq-operator',
      ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const issueLite = (i: any) => ({ number: i.number, title: i.title, state: i.state, user: i.user?.login, labels: (i.labels ?? []).map((l: any) => l.name ?? l), // eslint-disable-line @typescript-eslint/no-explicit-any
  comments: i.comments, updated_at: i.updated_at, url: i.html_url, pr: !!i.pull_request });

export async function githubRead(a: ApiEnv, client: string, i: { op: string; repo?: string; number?: number; state?: string; path?: string; ref?: string; limit?: number }): Promise<string> {
  const red = new Redactor(a.env);
  try {
    if (!(GITHUB_READS as readonly string[]).includes(i.op)) {
      refuse(`"${i.op}" is not a read. New issues, comments and merges are proposed with request_action (kind github_issue / github_comment / github_merge); pushing code is for HQ's dev agents.`);
    }
    const t = await token(a, client, 'github', red);
    const n = Math.min(Math.max(1, i.limit ?? 20), 50);
    const state = ['open', 'closed', 'all'].includes(i.state ?? '') ? i.state! : 'open';
    let out: string;
    switch (i.op) {
      case 'list_repos':
        out = okOr(await gh(a, t, 'GET', `/user/repos?per_page=${n}&sort=updated`), 'Listing repos', (j) => (j ?? []).map((r: any) => ({ repo: r.full_name, private: r.private, default_branch: r.default_branch, updated_at: r.updated_at, url: r.html_url }))); // eslint-disable-line @typescript-eslint/no-explicit-any
        break;
      case 'get_repo':
        out = okOr(await gh(a, t, 'GET', `/repos/${checkRepo(i.repo)}`), 'Reading the repo', (j) => pick(j, ['full_name', 'description', 'default_branch', 'homepage', 'open_issues_count', 'pushed_at', 'html_url']));
        break;
      case 'list_issues':
        out = okOr(await gh(a, t, 'GET', `/repos/${checkRepo(i.repo)}/issues?state=${state}&per_page=${n}`), 'Listing issues', (j) => (j ?? []).filter((x: any) => !x.pull_request).map(issueLite)); // eslint-disable-line @typescript-eslint/no-explicit-any
        break;
      case 'get_issue':
        out = okOr(await gh(a, t, 'GET', `/repos/${checkRepo(i.repo)}/issues/${checkNum(i.number, 'number')}`), 'Reading the issue', (j) => ({ ...issueLite(j), body: String(j?.body ?? '').slice(0, 6000) }));
        break;
      case 'list_prs':
        out = okOr(await gh(a, t, 'GET', `/repos/${checkRepo(i.repo)}/pulls?state=${state}&per_page=${n}`), 'Listing pull requests', (j) => (j ?? []).map((p: any) => ({ number: p.number, title: p.title, state: p.state, draft: p.draft, user: p.user?.login, head: p.head?.ref, base: p.base?.ref, updated_at: p.updated_at, url: p.html_url }))); // eslint-disable-line @typescript-eslint/no-explicit-any
        break;
      case 'get_pr':
        out = okOr(await gh(a, t, 'GET', `/repos/${checkRepo(i.repo)}/pulls/${checkNum(i.number, 'number')}`), 'Reading the pull request', (p) => ({
          ...pick(p, ['number', 'title', 'state', 'draft', 'merged', 'mergeable', 'mergeable_state', 'additions', 'deletions', 'changed_files', 'html_url']),
          head: p?.head?.ref, base: p?.base?.ref, body: String(p?.body ?? '').slice(0, 6000) }));
        break;
      case 'list_commits':
        out = okOr(await gh(a, t, 'GET', `/repos/${checkRepo(i.repo)}/commits?per_page=${n}${i.ref ? `&sha=${encodeURIComponent(i.ref)}` : ''}`), 'Listing commits', (j) => (j ?? []).map((c: any) => ({ sha: String(c.sha).slice(0, 10), message: String(c.commit?.message ?? '').split('\n')[0], author: c.commit?.author?.name, date: c.commit?.author?.date }))); // eslint-disable-line @typescript-eslint/no-explicit-any
        break;
      case 'list_workflow_runs':
        out = okOr(await gh(a, t, 'GET', `/repos/${checkRepo(i.repo)}/actions/runs?per_page=${n}`), 'Listing workflow runs', (j) => (j?.workflow_runs ?? []).map((w: any) => ({ id: w.id, name: w.name, branch: w.head_branch, status: w.status, conclusion: w.conclusion, created_at: w.created_at, url: w.html_url }))); // eslint-disable-line @typescript-eslint/no-explicit-any
        break;
      default: {
        const r = await gh(a, t, 'GET', `/repos/${checkRepo(i.repo)}/contents/${checkPath(i.path).split('/').map(encodeURIComponent).join('/')}${i.ref ? `?ref=${encodeURIComponent(i.ref)}` : ''}`);
        out = r.ok ? truncate(Buffer.from(String((r.json as { content?: string })?.content ?? ''), 'base64').toString('utf8'), 12_000) : apiError('Reading the file', r);
      }
    }
    return red.apply(out);
  } catch (e) {
    return red.apply(e instanceof ApiRefusal ? `Refused: ${e.message}` : `GitHub error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** github_issue {repo, title, body, labels?} · github_comment {repo, number, body} · github_merge {repo, number, method?, expected_head?}. */
export async function executeGithub(a: ApiEnv, t: Token, kind: string, s: Record<string, unknown>): Promise<ActionOutcome> {
  const repo = checkRepo(s.repo);
  if (kind === 'github_issue') {
    const title = typeof s.title === 'string' && s.title.trim() ? s.title.trim().slice(0, 250) : refuse('title is required');
    const labels = Array.isArray(s.labels) ? (s.labels as unknown[]).filter((l): l is string => typeof l === 'string').slice(0, 10) : undefined;
    const r = await gh(a, t, 'POST', `/repos/${repo}/issues`, { title, body: String(s.body ?? '').slice(0, 60_000), ...(labels?.length ? { labels } : {}) });
    return r.ok ? { ok: true, result: { issue: (r.json as { number?: number })?.number, url: (r.json as { html_url?: string })?.html_url }, error: null } : { ok: false, result: {}, error: apiError('Creating the issue', r).slice(0, 600) };
  }
  const n = checkNum(s.number, 'number');
  if (kind === 'github_comment') {
    const body = typeof s.body === 'string' && s.body.trim() ? s.body.slice(0, 60_000) : refuse('body is required');
    const r = await gh(a, t, 'POST', `/repos/${repo}/issues/${n}/comments`, { body });
    return r.ok ? { ok: true, result: { url: (r.json as { html_url?: string })?.html_url }, error: null } : { ok: false, result: {}, error: apiError('Commenting', r).slice(0, 600) };
  }
  if (kind === 'github_merge') {
    const method = ['merge', 'squash', 'rebase'].includes(String(s.method ?? '')) ? String(s.method) : 'squash';
    const r = await gh(a, t, 'PUT', `/repos/${repo}/pulls/${n}/merge`, { merge_method: method, ...(typeof s.expected_head === 'string' ? { sha: s.expected_head } : {}) });
    return r.ok ? { ok: true, result: { merged: true, sha: (r.json as { sha?: string })?.sha, method }, error: null } : { ok: false, result: {}, error: apiError('Merging the pull request', r).slice(0, 600) };
  }
  return refuse(`no GitHub executor for ${kind}`);
}

// ---------- Vercel ----------

/** The client's Vercel team (wizard / operator_clients.vercel_team, else OPERATOR_VERCEL_TEAM_<CLIENT>); null = personal account. */
async function teamOf(a: ApiEnv, client: string): Promise<string | null> {
  const t = (await a.vercelTeam?.(client).catch(() => null)) ?? a.env[`OPERATOR_VERCEL_TEAM_${envSlug(client)}`] ?? null;
  return t && /^[A-Za-z0-9_-]{2,64}$/.test(t.trim()) ? t.trim() : null;
}

function vc(a: ApiEnv, t: Token, team: string | null, method: string, p: string, body?: unknown): Promise<HttpRes> {
  const q = team ? `${p.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(team)}` : '';
  return httpRequest(a.http, {
    url: `${VC}${p}${q}`, method, retries: method === 'GET' ? 3 : 1,
    headers: { authorization: `Bearer ${t.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const depLite = (d: any) => ({ id: d.uid ?? d.id, url: d.url ? `https://${d.url}` : null, state: d.state ?? d.readyState, target: d.target ?? null, // eslint-disable-line @typescript-eslint/no-explicit-any
  created: d.created ?? d.createdAt, commit: d.meta?.githubCommitMessage?.split('\n')[0] ?? null, branch: d.meta?.githubCommitRef ?? null });

export async function vercelRead(a: ApiEnv, client: string, i: { op: string; project?: string; deployment_id?: string; limit?: number; target?: string }): Promise<string> {
  const red = new Redactor(a.env);
  try {
    if (!(VERCEL_READS as readonly string[]).includes(i.op)) {
      refuse(`"${i.op}" is not a read. Redeploying and promoting to production are proposed with request_action (kind vercel_redeploy / vercel_promote); env vars and domains: Julev changes them by hand.`);
    }
    const t = await token(a, client, 'vercel', red);
    const team = await teamOf(a, client);
    const n = Math.min(Math.max(1, i.limit ?? 10), 50);
    let out: string;
    switch (i.op) {
      case 'list_projects':
        out = okOr(await vc(a, t, team, 'GET', `/v9/projects?limit=${n}`), 'Listing projects', (j) => (j?.projects ?? []).map((p: any) => ({ id: p.id, name: p.name, framework: p.framework, updated: p.updatedAt }))); // eslint-disable-line @typescript-eslint/no-explicit-any
        break;
      case 'get_project':
        out = okOr(await vc(a, t, team, 'GET', `/v9/projects/${encodeURIComponent(checkVid(i.project, 'project'))}`), 'Reading the project', (p) => ({
          ...pick(p ?? {}, ['id', 'name', 'framework', 'nodeVersion']), production: p?.targets?.production ? depLite(p.targets.production) : null,
          git: p?.link ? { repo: `${p.link.org ?? p.link.owner ?? ''}/${p.link.repo ?? ''}`, branch: p.link.productionBranch } : null }));
        break;
      case 'list_deployments': {
        const pid = encodeURIComponent(checkVid(i.project, 'project'));
        const target = i.target === 'production' || i.target === 'preview' ? `&target=${i.target}` : '';
        out = okOr(await vc(a, t, team, 'GET', `/v6/deployments?projectId=${pid}&limit=${n}${target}`), 'Listing deployments', (j) => (j?.deployments ?? []).map(depLite));
        break;
      }
      case 'get_deployment':
        out = okOr(await vc(a, t, team, 'GET', `/v13/deployments/${encodeURIComponent(checkVid(i.deployment_id, 'deployment_id'))}`), 'Reading the deployment', (d) => ({ ...depLite(d ?? {}), error: d?.errorMessage ?? null, alias: d?.alias ?? [] }));
        break;
      case 'build_logs':
        out = okOr(await vc(a, t, team, 'GET', `/v3/deployments/${encodeURIComponent(checkVid(i.deployment_id, 'deployment_id'))}/events?limit=200`), 'Reading the build logs',
          (j) => (Array.isArray(j) ? j : []).map((e: any) => String(e?.payload?.text ?? e?.text ?? '')).filter(Boolean).slice(-120).join('\n')); // eslint-disable-line @typescript-eslint/no-explicit-any
        break;
      default:
        out = okOr(await vc(a, t, team, 'GET', `/v9/projects/${encodeURIComponent(checkVid(i.project, 'project'))}/domains`), 'Listing domains', (j) => (j?.domains ?? []).map((d: any) => ({ name: d.name, verified: d.verified, redirect: d.redirect ?? null }))); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    return red.apply(out);
  } catch (e) {
    return red.apply(e instanceof ApiRefusal ? `Refused: ${e.message}` : `Vercel error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** vercel_redeploy {deployment_id, name?, target?: "production"} · vercel_promote {project, deployment_id}. */
export async function executeVercel(a: ApiEnv, t: Token, client: string, kind: string, s: Record<string, unknown>): Promise<ActionOutcome> {
  const team = await teamOf(a, client);
  const dep = checkVid(s.deployment_id, 'deployment_id');
  if (kind === 'vercel_redeploy') {
    const src = await vc(a, t, team, 'GET', `/v13/deployments/${encodeURIComponent(dep)}`);
    if (!src.ok) return { ok: false, result: {}, error: apiError('Reading the deployment to redeploy', src).slice(0, 600) };
    const name = String((src.json as { name?: string })?.name ?? s.name ?? '');
    if (!name) return { ok: false, result: {}, error: 'the deployment has no project name' };
    const body: Record<string, unknown> = { name, deploymentId: dep, ...(s.target === 'production' ? { target: 'production' } : {}) };
    const r = await vc(a, t, team, 'POST', '/v13/deployments?forceNew=1', body);
    return r.ok ? { ok: true, result: { deployment: depLite(r.json ?? {}) }, error: null } : { ok: false, result: {}, error: apiError('Redeploying', r).slice(0, 600) };
  }
  if (kind === 'vercel_promote') {
    const project = checkVid(s.project, 'project');
    const r = await vc(a, t, team, 'POST', `/v10/projects/${encodeURIComponent(project)}/promote/${encodeURIComponent(dep)}`);
    return r.ok || r.status === 201 || r.status === 202 ? { ok: true, result: { promoted: dep, project }, error: null } : { ok: false, result: {}, error: apiError('Promoting to production', r).slice(0, 600) };
  }
  return refuse(`no Vercel executor for ${kind}`);
}
