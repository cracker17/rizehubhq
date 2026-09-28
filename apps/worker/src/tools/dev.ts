// Dev tools (M9, docs/09 "Worker guardrails", docs/05 "Workspaces & safety"): workspace_fs, bash_sandboxed,
// github, shopify_theme, webflow_api, wp_rest. Guardrails live in src/dev/* (code, not prompts). Every call
// returns a short string for the model (never throws into the agent loop), is redacted of every token form,
// and is logged via deps.log; vault credential use is also written to credential_access_log.
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ToolFactory } from './types';
import type { ToolContext } from '../runner';
import { errMsg, log } from '../deps';
import { defaultVaultToolEnv, type VaultToolEnv } from './vault';
import { defaultDevEnv, envSlug, type DevEnv } from '../dev/env';
import { JailError, openJail, type Jail } from '../dev/jail';
import { Redactor, truncate } from '../dev/http';
import { workspaceFs } from '../dev/workspace';
import { chownTreeToAgent } from '../dev/agentUser';
import { BASE_ALLOWED_HOSTS, MAX_TIMEOUT_S, runSandboxed, ShellRefusal } from '../dev/shell';
import * as gh from '../dev/github';
import * as shop from '../dev/shopify';
import { webflowOp, WebflowRefusal } from '../dev/webflow';
import { wpBase, wpOp, WpRefusal } from '../dev/wordpress';
import { audit, clientOf, envToken, vaultToken, type Token } from '../dev/creds';
import { parseAllowEntry } from '../vault/guards';

const REFUSALS = [JailError, ShellRefusal, gh.GithubRefusal, shop.ShopifyRefusal, WebflowRefusal, WpRefusal];

/** Short summary of a call for logs (never content/bodies). */
function logArgs(input: Record<string, unknown>): string {
  const keep = ['op', 'path', 'command', 'repo', 'dir', 'number', 'theme_id', 'key', 'site_id', 'collection_id', 'item_id', 'type', 'id', 'credential_id'];
  return keep.filter((k) => input[k] !== undefined).map((k) => `${k}=${String(input[k]).slice(0, 120)}`).join(' ');
}

/** A vault credential's allowlist (when set) must name the API host this tool is about to call (paths are fixed by the tool). */
function hostOk(t: Token, url: string): boolean {
  if (t.source !== 'vault' || !t.allowlist.length) return true;
  const host = new URL(url).hostname.toLowerCase();
  return t.allowlist.some((raw) => {
    const e = parseAllowEntry(raw);
    return Boolean(e && (e.wildcard ? host === e.host || host.endsWith(`.${e.host}`) : host === e.host));
  });
}

export function createDevTools(ctx: ToolContext, env: DevEnv): ToolSet {
  const { task, deps } = ctx;
  const agent = task.agent_id;
  let jail: Jail | null = null;
  // With the privilege drop the jail (and anything left from an earlier run of this task) belongs to the agent uid.
  const getJail = () => {
    if (!jail) { jail = openJail(env.workspacesDir, task.id); chownTreeToAgent(jail.root, env.agentUser); }
    return jail;
  };

  async function call(name: string, input: Record<string, unknown>, fn: (red: Redactor) => Promise<string> | string): Promise<string> {
    const red = new Redactor(env.env);
    const started = Date.now();
    let outcome = 'ok';
    let text: string;
    try {
      text = await fn(red);
      if (/^Refused/.test(text)) outcome = 'refused';
    } catch (e) {
      if (REFUSALS.some((R) => e instanceof R)) { outcome = 'refused'; text = `Refused: ${errMsg(e)}`; }
      else { outcome = 'error'; text = `Error: ${errMsg(e)}`; }
    }
    text = red.apply(text);
    log(deps, red.apply(`[${agent}] ${name} ${logArgs(input)} → ${outcome} (${Date.now() - started} ms)`));
    return text;
  }

  async function allowedHosts(): Promise<string[]> {
    const hosts = [...BASE_ALLOWED_HOSTS];
    const c = await clientOf(ctx);
    if (c?.website) {
      try {
        const h = new URL(/^https?:\/\//.test(c.website) ? c.website : `https://${c.website}`).hostname.replace(/^www\./, '');
        hosts.push(h, `*.${h}`);
      } catch { /* ignore bad website */ }
    }
    for (const h of (env.env.DEV_EXTRA_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) hosts.push(h);
    return hosts;
  }

  async function withCredAudit<T>(t: Token, toolName: string, op: string, host: string, fn: () => Promise<T>): Promise<T> {
    try {
      const r = await fn();
      if (t.credentialId) await audit(ctx, env, t.credentialId, 'api_call', true, { tool: toolName, op, host });
      return r;
    } catch (e) {
      if (t.credentialId) await audit(ctx, env, t.credentialId, 'api_call', false, { tool: toolName, op, host, error: errMsg(e).slice(0, 200) });
      throw e;
    }
  }

  // ---------------- workspace_fs ----------------
  const workspace_fs = tool({
    description: 'Files in your task workspace (workspaces/<task-id>, created on first use). Paths are relative to it; '
      + '"brain/..." paths are READ-ONLY knowledge files. Ops: list (recursive optional), read (100 KB cap; start_line/end_line), '
      + 'write (create/overwrite), patch (replace old_string with new_string; old_string must be unique unless replace_all), delete, mkdir. '
      + 'Absolute paths, "..", symlinks leaving the workspace, .git internals and secret files (.env, keys) are refused.',
    inputSchema: z.object({
      op: z.enum(['list', 'read', 'write', 'patch', 'delete', 'mkdir']),
      path: z.string().max(1000).describe('Relative path, e.g. "theme/sections/hero.liquid", "." for the root, or "brain/sops/shopify-section.md"'),
      content: z.string().optional().describe('write: full file content'),
      old_string: z.string().optional().describe('patch: exact existing text (include enough context to be unique)'),
      new_string: z.string().optional().describe('patch: replacement text'),
      replace_all: z.boolean().optional(),
      recursive: z.boolean().optional().describe('list: walk subfolders; delete: remove a folder'),
      start_line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
    }),
    execute: async (input) => call('workspace_fs', input, () => truncate(workspaceFs(getJail(), deps.brain, input, env.agentUser ?? null), 110_000)),
  });

  // ---------------- bash_sandboxed ----------------
  const bash_sandboxed = tool({
    description: 'Run ONE command inside your workspace (no shell). Allowed: git (no push/config: use the github tool), node, npm, pnpm, '
      + 'npx (@shopify/cli, playwright, lighthouse, typescript/tsc, eslint, prettier, vitest), shopify theme check/pull/push --theme <unpublished id>, '
      + 'theme-check, lighthouse, playwright, tsc, eslint, prettier, ls, cat, head, tail, grep, sed, find, mkdir, cp, mv, rm, zip, unzip, '
      + 'curl/wget (allowlisted hosts only, no redirects). No ; && | ` $() $VAR globs or input redirects; one trailing "> file" is allowed. '
      + 'Quote patterns. Paths are relative. No tokens exist in this environment. Default timeout 120 s (max 600).',
    inputSchema: z.object({
      command: z.string().max(8000).describe('e.g. "npm test", "git status", "find . -name \'*.liquid\'", "npx --yes @shopify/cli theme check --path theme"'),
      cwd: z.string().max(500).optional().describe('Relative folder to run in (default: workspace root)'),
      timeout_s: z.number().int().min(1).max(MAX_TIMEOUT_S).optional(),
    }),
    execute: async (input) => call('bash_sandboxed', input, async () => runSandboxed(env, getJail(), await allowedHosts(), input)),
  });

  // ---------------- github ----------------
  async function githubToken(red: Redactor, credentialId?: string): Promise<Token | string> {
    if (credentialId) return vaultToken(ctx, env, red, credentialId, ['github'], 'github');
    return envToken(env, red, 'GITHUB_TOKEN_DEFAULT')
      ?? 'No GitHub access: GITHUB_TOKEN_DEFAULT is not set and no credential_id was given. Check vault_list for a github credential, or ask_ceo.';
  }

  const github = tool({
    description: `GitHub for this task. Your branch is always "agent/${task.id}" (main/master and other names are refused). Ops: `
      + 'clone {repo, dir?, depth?} → create_branch {dir} → commit_push {dir, message} (git add -A, commit, push to your branch; never force) → '
      + 'open_pr {repo, title, body, base?, draft?} → pr_status {repo, number} (state + checks) → comment {repo, number, body} (your PR only). '
      + 'merge / delete_branch / force_push are never done by agents: they return the request_external_action to propose. '
      + 'Token: GITHUB_TOKEN_DEFAULT or a vault credential_id (github platform); you never see it.',
    inputSchema: z.object({
      op: z.enum(['clone', 'create_branch', 'commit_push', 'open_pr', 'pr_status', 'comment', 'merge', 'delete_branch', 'force_push']),
      repo: z.string().max(200).optional().describe('"owner/name"'),
      dir: z.string().max(300).optional().describe('Workspace folder of the clone (default: repo name)'),
      branch: z.string().max(200).optional().describe(`Only "agent/${task.id}" is accepted`),
      message: z.string().max(5000).optional(),
      title: z.string().max(250).optional(),
      body: z.string().max(60000).optional(),
      base: z.string().max(200).optional(),
      draft: z.boolean().optional(),
      number: z.number().int().min(1).optional(),
      depth: z.number().int().min(1).max(1000).optional(),
      credential_id: z.string().max(64).optional(),
    }),
    execute: async (input) => call('github', input, async (red) => {
      const i = input;
      if (i.op === 'merge' || i.op === 'delete_branch' || i.op === 'force_push') return gh.refusedGithubOp(i.op, i.repo, i.number);
      const jl = getJail();
      if (i.op === 'create_branch') return gh.createBranch({ env, jail: jl, red }, i.dir ?? (i.repo ? gh.checkRepo(i.repo).split('/')[1]! : '.'), i.branch);
      const t = await githubToken(red, i.credential_id);
      if (typeof t === 'string') return t;
      const need = (v: string | undefined, what: string) => { if (!v) throw new gh.GithubRefusal(`${i.op} needs ${what}`); return v; };
      const git = { env, jail: jl, red };
      const rest = { env, token: t, red, taskId: task.id };
      const host = i.op === 'clone' || i.op === 'commit_push' ? 'https://github.com/' : `${gh.API}/`;
      if (!hostOk(t, host)) return `Refused: this credential's allowlist does not include ${host}.`;
      return withCredAudit(t, 'github', i.op, new URL(host).host, async () => {
        switch (i.op) {
          case 'clone': return gh.clone(git, t, need(i.repo, 'repo'), i.dir, i.depth);
          case 'commit_push': return gh.commitPush(git, t, i.dir ?? (i.repo ? gh.checkRepo(i.repo).split('/')[1]! : need(undefined, 'dir')), need(i.message, 'message'));
          case 'open_pr': return gh.openPr(rest, need(i.repo, 'repo'), need(i.title, 'title'), i.body ?? '', i.base, i.draft);
          case 'pr_status': return gh.prStatus(rest, need(i.repo, 'repo'), i.number ?? 0);
          case 'comment': return gh.comment(rest, need(i.repo, 'repo'), i.number ?? 0, need(i.body, 'body'));
          default: return `Unknown op ${i.op}`;
        }
      });
    }),
  });

  // ---------------- shopify_theme ----------------
  async function shopCtx(red: Redactor, credentialId?: string, storeIn?: string): Promise<shop.ShopCtx | string> {
    const apiVersion = env.env.SHOPIFY_API_VERSION?.trim() || shop.DEFAULT_API_VERSION;
    if (credentialId) {
      const t = await vaultToken(ctx, env, red, credentialId, ['shopify'], 'shopify_theme');
      if (typeof t === 'string') return t;
      const candidates = [storeIn, ...t.allowlist, t.loginUrl ?? undefined].filter((x): x is string => Boolean(x))
        .map((x) => x.replace(/^https?:\/\//, '').replace(/[/*].*$/, '').toLowerCase());
      const store = candidates.find((h) => /\.myshopify\.com$/.test(h));
      if (!store) return 'This credential has no <shop>.myshopify.com domain (login URL or allowlist); pass `store` or ask the CEO to fix the credential.';
      const s = shop.checkStore(store);
      if (!hostOk(t, `https://${s}/admin/api/${apiVersion}/graphql.json`)) return `Refused: ${s} is not on this credential's allowlist (${t.allowlist.join(', ')}).`;
      return { env, token: t, store: s, red, apiVersion };
    }
    const c = await clientOf(ctx);
    if (!c) return 'This task has no client; pass credential_id (vault_list) for the store.';
    const slug = envSlug(c.slug);
    const t = envToken(env, red, `SHOPIFY_TOKEN_${slug}`);
    const store = env.env[`SHOPIFY_STORE_${slug}`]?.trim();
    if (!t || !store) return `No Shopify access for ${c.name}: set SHOPIFY_TOKEN_${slug} + SHOPIFY_STORE_${slug} on the worker, or use a vault credential_id (vault_list). Otherwise ask_ceo.`;
    const s = shop.checkStore(store);
    if (storeIn && shop.checkStore(storeIn) !== s) return `Refused: this task's store is ${s}, not ${storeIn}.`;
    return { env, token: t, store: s, red, apiVersion };
  }

  const shopify_theme = tool({
    description: 'Shopify themes via the Admin API (token added by the worker). Ops: list_themes; duplicate_live {name?} (creates an UNPUBLISHED copy of the live theme); '
      + 'list_files {theme_id, prefix?}; get_asset {theme_id, key}; put_asset {theme_id, key, value | from_file}; delete_asset {theme_id, key}; '
      + 'pull {theme_id, dir, files?} (download into the workspace); push {theme_id, dir, files?} (upload; settings_data.json only if listed); '
      + 'preview_url {theme_id}; check {dir} (shopify theme check). Writes to the LIVE (main) theme are refused; publish is never available (request_external_action).',
    inputSchema: z.object({
      op: z.enum(['list_themes', 'duplicate_live', 'list_files', 'get_asset', 'put_asset', 'delete_asset', 'pull', 'push', 'preview_url', 'check', 'publish']),
      theme_id: z.union([z.string(), z.number()]).optional(),
      key: z.string().max(300).optional().describe('Theme file key, e.g. sections/hero.liquid'),
      value: z.string().max(2_000_000).optional(),
      from_file: z.string().max(500).optional().describe('Workspace path to upload as the asset'),
      dir: z.string().max(300).optional().describe('Workspace folder holding the theme (layout/, sections/, …)'),
      files: z.array(z.string().max(300)).max(500).optional().describe('Only these keys (pull also accepts "sections/*")'),
      prefix: z.string().max(200).optional(),
      name: z.string().max(50).optional(),
      store: z.string().max(200).optional().describe('<shop>.myshopify.com (defaults from the credential / env)'),
      credential_id: z.string().max(64).optional(),
    }),
    execute: async (input) => call('shopify_theme', input, async (red) => {
      const i = input;
      if (i.op === 'check') {
        return runSandboxed(env, getJail(), await allowedHosts(), { command: `npx --yes @shopify/cli@latest theme check --path ${i.dir ?? '.'}`, timeout_s: 300 });
      }
      const c = await shopCtx(red, i.credential_id, i.store);
      if (typeof c === 'string') return c;
      const id = i.theme_id === undefined ? '' : String(i.theme_id);
      const need = () => { if (!id) throw new shop.ShopifyRefusal(`${i.op} needs theme_id (see list_themes)`); return id; };
      if (i.op === 'publish') return shop.publishRefused(c.store, id || undefined);
      if (i.op === 'preview_url') return JSON.stringify(shop.previewUrl(c.store, need()));
      return withCredAudit(c.token, 'shopify_theme', i.op, c.store, async () => {
        switch (i.op) {
          case 'list_themes': return shop.listThemes(c);
          case 'duplicate_live': return shop.duplicateLive(c, i.name);
          case 'list_files': return shop.listFiles(c, need(), i.prefix);
          case 'get_asset': return shop.getAsset(c, need(), i.key ?? '');
          case 'put_asset': return shop.putAsset(c, getJail(), need(), i.key ?? '', i.value, i.from_file);
          case 'delete_asset': return shop.deleteAsset(c, need(), i.key ?? '');
          case 'pull': return shop.pull(c, getJail(), need(), i.dir ?? 'theme', i.files);
          case 'push': return shop.push(c, getJail(), need(), i.dir ?? 'theme', i.files);
          default: return `Unknown op ${i.op}`;
        }
      });
    }),
  });

  // ---------------- webflow_api ----------------
  const webflow_api = tool({
    description: 'Webflow Data API v2 (token added by the worker). Ops: list_sites; list_collections {site_id}; get_collection {collection_id} (fields); '
      + 'list_items {collection_id, offset?, limit?}; get_item; create_item {collection_id, field_data} and update_item {collection_id, item_id, field_data} '
      + '(always saved as DRAFTS); list_pages {site_id}; get_page {page_id}; get_page_content {page_id}. '
      + 'publish and delete_item are never done by agents: they return the request_external_action to propose.',
    inputSchema: z.object({
      op: z.enum(['list_sites', 'list_collections', 'get_collection', 'list_items', 'get_item', 'create_item', 'update_item', 'list_pages', 'get_page', 'get_page_content', 'publish', 'delete_item']),
      site_id: z.string().max(40).optional(),
      collection_id: z.string().max(40).optional(),
      item_id: z.string().max(40).optional(),
      page_id: z.string().max(40).optional(),
      field_data: z.record(z.string(), z.unknown()).optional().describe('Field slugs → values (name, slug, rich text as HTML, references by item id)'),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      credential_id: z.string().max(64).optional(),
    }),
    execute: async (input) => call('webflow_api', input, async (red) => {
      if (input.op === 'publish' || input.op === 'delete_item') return webflowOp({ env, token: { token: '', source: 'env', allowlist: [] }, red }, input);
      let t: Token | string;
      if (input.credential_id) t = await vaultToken(ctx, env, red, input.credential_id, ['webflow'], 'webflow_api');
      else {
        const c = await clientOf(ctx);
        const name = c ? `WEBFLOW_TOKEN_${envSlug(c.slug)}` : '';
        t = (name && envToken(env, red, name)) || `No Webflow access${c ? `: set ${name} on the worker or` : ':'} pass a vault credential_id (vault_list). Otherwise ask_ceo.`;
      }
      if (typeof t === 'string') return t;
      const tok = t;
      if (!hostOk(tok, 'https://api.webflow.com/v2/')) return `Refused: this credential's allowlist does not include api.webflow.com.`;
      return withCredAudit(tok, 'webflow_api', input.op, 'api.webflow.com', () => webflowOp({ env, token: tok, red }, input));
    }),
  });

  // ---------------- wp_rest ----------------
  const wp_rest = tool({
    description: 'WordPress REST API on the credential\'s allowed (staging) domain with an Application Password (vault credential_id, required). '
      + 'Ops: list {type: posts|pages, search?, status?, page?}; get {type, id}; create {type, title, content, excerpt?, slug?, parent?, template?, status: draft|pending}; '
      + 'update {type, id, …} (only content that is not live yet); upload_media {file (workspace path), alt_text?, caption?}. '
      + 'status "publish", editing live content, publish and delete are never done by agents: they return the request_external_action to propose.',
    inputSchema: z.object({
      op: z.enum(['list', 'get', 'create', 'update', 'upload_media', 'publish', 'delete']),
      credential_id: z.string().max(64),
      site: z.string().max(300).optional().describe('Origin, e.g. https://staging.client.com (defaults to the credential\'s first allowed domain)'),
      type: z.enum(['posts', 'pages']).optional(),
      id: z.number().int().min(1).optional(),
      search: z.string().max(100).optional(),
      status: z.string().max(40).optional(),
      page: z.number().int().min(1).max(100).optional(),
      title: z.string().max(500).optional(),
      content: z.string().max(500_000).optional(),
      excerpt: z.string().max(5000).optional(),
      slug: z.string().max(200).optional(),
      parent: z.number().int().min(0).optional(),
      template: z.string().max(200).optional(),
      meta: z.record(z.string(), z.unknown()).optional(),
      file: z.string().max(500).optional(),
      alt_text: z.string().max(500).optional(),
      caption: z.string().max(2000).optional(),
    }),
    execute: async (input) => call('wp_rest', input, async (red) => {
      const t = await vaultToken(ctx, env, red, input.credential_id, ['wordpress', 'wp'], 'wp_rest');
      if (typeof t === 'string') return t;
      const base = wpBase(t, input.site);
      if (input.op === 'publish' || input.op === 'delete') return wpOp({ env, token: t, red, base }, getJail(), input);
      return withCredAudit(t, 'wp_rest', input.op, new URL(base).host, () => wpOp({ env, token: t, red, base }, getJail(), input));
    }),
  });

  return { workspace_fs, bash_sandboxed, github, shopify_theme, webflow_api, wp_rest };
}

/** Tests inject `deps.dev` (fake fetch/run, temp workspaces) and `deps.vault` (fake store); production uses the worker env. */
export const devTools: ToolFactory = (ctx) => {
  const injectedVault = (ctx.deps as { vault?: Partial<VaultToolEnv> }).vault;
  const v = { ...defaultVaultToolEnv(), ...injectedVault };
  const injected = (ctx.deps as { dev?: Partial<DevEnv> }).dev;
  return createDevTools(ctx, { ...defaultDevEnv({ store: v.store, keyring: v.keyring }), ...injected });
};
