// bash_sandboxed: runs ONE allowlisted command inside the task jail. There is no shell: the command line is
// tokenised here (quotes only), anything that could chain or expand (; & | ` $( ${ $VAR < ( ) globs, newlines)
// is refused, and only a trailing `> file` / `>> file` into the jail is supported. Every argument is checked:
// no absolute paths, no `..`, no secret files, no symlink escapes, URLs only to allowlisted hosts.
// Children get a minimal env (PATH, HOME=jail, no tokens) and a timeout that kills the whole process group.
import fs from 'node:fs';
import path from 'node:path';
import { urlAllowed } from '../vault/guards';
import { which, type DevEnv, type RunResult } from './env';
import { inside, isGitInternal, pathHasSecret, type Jail } from './jail';

export class ShellRefusal extends Error {}
const refuse = (m: string): never => { throw new ShellRefusal(m); };

export const DEFAULT_TIMEOUT_S = 120;
export const MAX_TIMEOUT_S = 600;
export const OUTPUT_MAX_CHARS = 20_000;

/** Hosts curl/wget/any URL argument may reach. Client domains are added per task. */
export const BASE_ALLOWED_HOSTS = ['registry.npmjs.org', 'github.com', 'api.github.com', '*.myshopify.com', 'api.webflow.com'];

// ---------- tokenizer ----------
export interface ParsedCommand { argv: string[]; redirect: { path: string; append: boolean } | null }

/** Splits a command line like a POSIX shell would for quoting only; refuses every other shell feature. */
export function tokenize(line: string): ParsedCommand {
  if (typeof line !== 'string' || !line.trim()) refuse('command is empty');
  if (line.length > 8000) refuse('command is too long');
  if (/[\n\r\0]/.test(line)) refuse('newlines are not allowed: run one command per call');
  if (line.includes('`')) refuse('backticks (command substitution) are not allowed');
  if (/\$[({]/.test(line)) refuse('$( ) / ${ } substitution is not allowed');
  const tokens: { v: string; op?: '>' | '>>' }[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  const push = () => { if (has) tokens.push({ v: cur }); cur = ''; has = false; };
  while (i < line.length) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) refuse('unterminated single quote');
      cur += line.slice(i + 1, end); has = true; i = end + 1; continue;
    }
    if (c === '"') {
      i++; has = true;
      for (;;) {
        if (i >= line.length) refuse('unterminated double quote');
        const d = line[i]!;
        if (d === '"') { i++; break; }
        if (d === '$') refuse('variable expansion ($) is not supported; write the value literally (use single quotes for a literal $)');
        if (d === '\\' && i + 1 < line.length && '"\\$'.includes(line[i + 1]!)) { cur += line[i + 1]; i += 2; continue; }
        cur += d; i++;
      }
      continue;
    }
    if (c === '\\') { if (i + 1 >= line.length) refuse('trailing backslash'); cur += line[i + 1]; has = true; i += 2; continue; }
    if (c === ' ' || c === '\t') { push(); i++; continue; }
    if (c === '>') {
      push();
      const append = line[i + 1] === '>';
      tokens.push({ v: append ? '>>' : '>', op: append ? '>>' : '>' });
      i += append ? 2 : 1; continue;
    }
    if (';&|<()'.includes(c)) refuse(`"${c}" is not allowed: no chaining, pipes, background jobs or input redirects. Run one command per call.`);
    if (c === '$') refuse('variable expansion ($) is not supported; write values literally');
    if ('*?['.includes(c)) refuse(`unquoted "${c}": there is no glob expansion. Quote patterns (e.g. find . -name '*.liquid') or list files explicitly.`);
    if (c === '~' && !has) refuse('"~" is not allowed: use paths relative to the workspace');
    if (c === '{' || c === '}') refuse('brace expansion is not supported');
    cur += c; has = true; i++;
  }
  push();
  let redirect: ParsedCommand['redirect'] = null;
  const ops = tokens.filter((t) => t.op);
  if (ops.length > 1) refuse('only one output redirect is allowed');
  if (ops.length === 1) {
    const idx = tokens.findIndex((t) => t.op);
    if (idx !== tokens.length - 2) refuse('the only redirect allowed is a final "> file" (or ">> file")');
    redirect = { path: tokens[idx + 1]!.v, append: tokens[idx]!.op === '>>' };
    tokens.splice(idx, 2);
  }
  const argv = tokens.map((t) => t.v);
  if (!argv.length) refuse('command is empty');
  return { argv, redirect };
}

// ---------- argument policy ----------
export interface ShellPolicyCtx { jail: Jail; cwd: string; allowedHosts: string[] }

const URLISH = /^[a-z][a-z0-9+.-]*:\/\//i;

function hostAllowed(raw: string, hosts: string[]): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  return urlAllowed(new URL(`https://${u.host}${u.pathname}`), hosts);
}

/** Generic checks on one argument (or the value part of --opt=value). */
function checkArg(value: string, ctx: ShellPolicyCtx, cmd: string): void {
  if (!value) return;
  if (URLISH.test(value)) {
    if (!hostAllowed(value, ctx.allowedHosts)) {
      refuse(`URL not allowed: ${value.slice(0, 200)}. Allowed hosts: ${ctx.allowedHosts.join(', ')} (http/https only).`);
    }
    return;
  }
  if (value.startsWith('/') || value.startsWith('~')) refuse(`absolute paths are not allowed ("${value}"): use paths relative to the workspace`);
  if (value.split(/[\\/]/).includes('..')) refuse(`".." is not allowed ("${value}")`);
  if (/(^|[=,])(\/|~\/)/.test(value) && cmd !== 'sed' && cmd !== 'grep') refuse(`absolute paths are not allowed inside arguments ("${value}")`);
  if (pathHasSecret(value)) refuse(`"${value}" looks like a secret file (.env, key, token file); it is off limits`);
  // Existing paths must resolve (through symlinks) inside the jail.
  const abs = path.resolve(ctx.cwd, value);
  if (!inside(ctx.jail.root, abs)) refuse(`"${value}" is outside the workspace`);
  try {
    fs.lstatSync(abs);
    const real = fs.realpathSync(abs);
    if (!inside(ctx.jail.root, real)) refuse(`"${value}" resolves outside the workspace (symlink)`);
  } catch (e) { if (e instanceof ShellRefusal) throw e; }
}

function checkAll(args: string[], ctx: ShellPolicyCtx, cmd: string, skip = new Set<number>()) {
  args.forEach((a, i) => {
    if (skip.has(i)) return;
    const eq = a.startsWith('-') ? a.indexOf('=') : -1;
    checkArg(eq > 0 ? a.slice(eq + 1) : a.startsWith('-') ? '' : a, ctx, cmd);
  });
}

const flagIn = (args: string[], flags: string[]) => args.find((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)));

// ---------- per-command rules ----------
const GIT_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'add', 'commit', 'checkout', 'switch', 'branch', 'restore', 'reset', 'stash', 'init',
  'clone', 'fetch', 'pull', 'merge', 'rebase', 'rm', 'mv', 'ls-files', 'rev-parse', 'blame', 'grep', 'describe',
  'shortlog', 'apply', 'cherry-pick', 'revert', 'tag', 'remote', 'ls-remote', 'clean',
]);
const GIT_BLOCKED_HINT: Record<string, string> = {
  push: 'push with the github tool (op "commit_push"): it pushes only to agent/<task-id>, never force-pushes.',
  config: 'git config is managed by the worker.',
  submodule: 'submodules are not supported in the sandbox.',
};

function gitRules(args: string[], ctx: ShellPolicyCtx) {
  const sub = args[0];
  if (!sub || sub.startsWith('-')) refuse('git global options (-c, -C, --git-dir, --exec-path, …) are not allowed; start with the subcommand, e.g. "git status"');
  if (!GIT_SUBCOMMANDS.has(sub)) refuse(`git ${sub} is not allowed. ${GIT_BLOCKED_HINT[sub] ?? `Allowed: ${[...GIT_SUBCOMMANDS].join(', ')}.`}`);
  const rest = args.slice(1);
  if (sub === 'remote' && rest.some((a) => !['-v', '--verbose', 'show', 'get-url', 'origin'].includes(a))) refuse('only "git remote -v" / "git remote get-url origin" are allowed');
  if (sub === 'tag' && rest.some((a) => ['-d', '--delete'].includes(a))) refuse('deleting tags is not allowed');
  const bad = flagIn(rest, ['--upload-pack', '--receive-pack', '--exec', '-u', '--config', '--template', '--separate-git-dir', '--git-dir', '--work-tree', '--recurse-submodules', '--recursive']);
  if (bad) refuse(`git option ${bad} is not allowed`);
  if (['clone', 'fetch', 'pull', 'ls-remote'].includes(sub) && rest.includes('-c')) refuse('git -c is not allowed');
  if (sub === 'rebase' && rest.includes('-x')) refuse('git rebase -x is not allowed');
  // Paths into .git are managed by the worker.
  if (rest.some((a) => isGitInternal(a.replace(/\\/g, '/')))) refuse('.git internals are off limits');
  checkAll(rest, ctx, 'git');
}

const NPX_ALLOWED = new Set(['@shopify/cli', '@shopify/theme-check', 'playwright', '@playwright/test', 'lighthouse', 'typescript', 'tsc', 'eslint', 'prettier', 'vitest', 'theme-check']);
const NPM_ALLOWED = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'un', 'run', 'run-script', 'test', 't', 'ls', 'list', 'outdated', 'audit', 'why', 'view', 'info', 'init', 'start', 'version', '--version', '-v']);
const PM_BLOCKED = new Set(['publish', 'unpublish', 'dlx', 'exec', 'x', 'login', 'logout', 'adduser', 'token', 'config', 'set', 'owner', 'deprecate', 'dist-tag', 'access', 'team', 'org', 'star', 'hook', 'profile', 'link', 'env', 'self-update', 'setup', 'server', 'store', 'deploy']);
const PM_BAD_FLAGS = ['--registry', '--userconfig', '--globalconfig', '--global', '-g', '--prefix', '--dir', '-C', '--workspace-root', '-w', '--location', '--script-shell', '--node-options'];

function pmRules(bin: 'npm' | 'pnpm', args: string[], ctx: ShellPolicyCtx) {
  const sub = args.find((a) => !a.startsWith('-')) ?? args[0];
  if (!sub) refuse(`${bin} needs a subcommand`);
  if (PM_BLOCKED.has(sub!)) refuse(`${bin} ${sub} is not allowed (${sub === 'publish' ? 'publishing is an external action' : 'blocked in the sandbox'}).`);
  if (bin === 'npm' && !NPM_ALLOWED.has(sub!)) refuse(`npm ${sub} is not allowed. Allowed: ${[...NPM_ALLOWED].join(', ')}.`);
  if (bin === 'pnpm' && !/^-{0,2}[a-z][a-z0-9:_-]*$/i.test(sub!)) refuse(`pnpm ${sub} is not allowed`);
  const bad = flagIn(args, PM_BAD_FLAGS);
  if (bad) refuse(`${bin} option ${bad} is not allowed (keep installs inside the workspace)`);
  checkAll(args, ctx, bin);
}

function npxRules(args: string[], ctx: ShellPolicyCtx): string[] {
  let k = 0;
  while (k < args.length && args[k]!.startsWith('-')) {
    if (!['-y', '--yes', '--no-install', '--no'].includes(args[k]!)) refuse(`npx option ${args[k]} is not allowed`);
    k++;
  }
  const pkg = args[k];
  if (!pkg) refuse('npx needs a package');
  const name = pkg!.replace(/^(@?[^@]+)@.*$/, '$1');
  if (!NPX_ALLOWED.has(name)) refuse(`npx ${name} is not allowed. Allowed: ${[...NPX_ALLOWED].join(', ')}.`);
  if (name === '@shopify/cli') shopifyRules(args.slice(k + 1));
  checkAll(args.slice(k + 1), ctx, 'npx');
  return args;
}

const SHOPIFY_THEME_OK = new Set(['check', 'pull', 'push', 'list', 'info', 'package', 'init', 'dev', 'language-server']);
function shopifyRules(args: string[]) {
  if (args[0] === 'version' || args[0] === '--version' || args[0] === 'help') return;
  if (args[0] !== 'theme') refuse('only "shopify theme …" commands are allowed');
  const sub = args[1];
  if (!sub || !SHOPIFY_THEME_OK.has(sub) || sub === 'language-server') {
    if (sub === 'publish') refuse('shopify theme publish is never allowed: propose it with request_external_action({ type: "publish_theme", … }).');
    refuse(`shopify theme ${sub ?? ''} is not allowed. Use the shopify_theme tool for duplicate/delete; publish is an external action.`);
  }
  const rest = args.slice(2);
  if (sub === 'push' || sub === 'dev') {
    const bad = flagIn(rest, ['--publish', '-p', '--allow-live', '-a', '--live', '-l']);
    if (bad) refuse(`${bad} is not allowed: push only to an unpublished theme with --theme <id>. Publishing is an external action.`);
    if (sub === 'push' && !flagIn(rest, ['--theme', '-t'])) refuse('shopify theme push needs --theme <unpublished theme id>');
  }
  if (flagIn(rest, ['--password', '--store-password'])) refuse('do not pass passwords on the command line');
}

const FIND_BLOCKED = ['-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls', '-L', '-H', '-follow'];
const CURL_VALUE_OPTS = new Set(['-H', '--header', '-X', '--request', '-d', '--data', '--data-raw', '--data-urlencode', '--json', '-o', '--output', '-A', '--user-agent', '-w', '--write-out', '-m', '--max-time', '--retry', '--connect-timeout', '-r', '--range']);
const CURL_FLAG_OPTS = new Set(['-s', '--silent', '-S', '--show-error', '-f', '--fail', '-I', '--head', '-i', '--include', '-v', '--verbose', '--compressed']);
const WGET_VALUE_OPTS = new Set(['-O', '--output-document', '--header', '-T', '--timeout', '-t', '--tries', '-U', '--user-agent']);
const WGET_FLAG_OPTS = new Set(['-q', '--quiet', '-S', '--server-response', '--spider', '-nv', '--no-verbose']);

function fetchRules(bin: 'curl' | 'wget', args: string[], ctx: ShellPolicyCtx): string[] {
  const valueOpts = bin === 'curl' ? CURL_VALUE_OPTS : WGET_VALUE_OPTS;
  const flagOpts = bin === 'curl' ? CURL_FLAG_OPTS : WGET_FLAG_OPTS;
  let urls = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('-')) {
      const [name, inline] = a.includes('=') && a.startsWith('--') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
      if (valueOpts.has(name)) {
        const v = inline ?? args[++i];
        if (v === undefined) refuse(`${name} needs a value`);
        if (/^(-d|--data|--data-raw|--data-urlencode|--json)$/.test(name) && v!.startsWith('@')) refuse('reading request bodies from files (@file) is not allowed');
        if (['-o', '--output', '-O', '--output-document'].includes(name)) checkArg(v!, ctx, bin);
        if (/^(-H|--header)$/.test(name) && /^\s*(authorization|cookie|proxy-authorization)\s*:/i.test(v!)) refuse('auth/cookie headers are not allowed in the sandbox');
        continue;
      }
      if (flagOpts.has(name)) continue;
      // Combined short flags (-sS, -fsSI): every letter must be an allowed flag-only option.
      if (/^-[A-Za-z]{2,}$/.test(name) && [...name.slice(1)].every((ch) => flagOpts.has(`-${ch}`))) continue;
      refuse(`${bin} option ${name} is not allowed (redirect-following, config files, proxies, uploads and TLS overrides are blocked). Allowed: ${[...valueOpts, ...flagOpts].join(' ')}`);
    }
    if (!URLISH.test(a)) refuse(`${bin}: "${a}" is not an http(s) URL`);
    checkArg(a, ctx, bin);
    urls++;
  }
  if (!urls) refuse(`${bin} needs a URL`);
  return bin === 'curl' ? ['--proto', '=https,http', '--max-redirs', '0', '--max-filesize', '52428800', ...args] : ['--max-redirect=0', ...args];
}

// ---------- plan ----------
export interface Plan { file: string; args: string[]; display: string }

const SIMPLE = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'mkdir', 'cp', 'mv', 'rm', 'unzip', 'tsc', 'eslint', 'prettier', 'theme-check', 'lighthouse', 'node']);
const LOCAL_BIN_FALLBACK = new Set(['tsc', 'eslint', 'prettier', 'playwright', 'lighthouse']);
export const ALLOWED_COMMANDS = ['git', 'node', 'npm', 'npx', 'pnpm', 'shopify', 'theme-check', 'lighthouse', 'playwright', 'tsc', 'eslint', 'prettier',
  'ls', 'cat', 'head', 'tail', 'grep', 'sed', 'find', 'mkdir', 'cp', 'mv', 'rm', 'zip', 'unzip', 'curl', 'wget'];

/** Validates argv and returns what to spawn (binary resolved on the sandbox PATH, never from the jail). */
export function planCommand(argv: string[], ctx: ShellPolicyCtx, sandboxPath: string): Plan {
  const [cmd0, ...rawArgs] = argv;
  const cmd = cmd0!;
  if (cmd.includes('/')) refuse('run commands by name (no paths to binaries)');
  if (!ALLOWED_COMMANDS.includes(cmd)) {
    refuse(`"${cmd}" is not allowed. Allowed commands: ${ALLOWED_COMMANDS.join(', ')}. Use workspace_fs for file edits.`);
  }
  let args = [...rawArgs];
  let bin = cmd;
  switch (cmd) {
    case 'git': gitRules(args, ctx); break;
    case 'npm': case 'pnpm': pmRules(cmd, args, ctx); break;
    case 'npx': args = npxRules(args, ctx); break;
    case 'shopify':
      shopifyRules(args); checkAll(args, ctx, cmd);
      bin = 'npx'; args = ['--yes', '@shopify/cli@latest', ...args]; break;
    case 'playwright': {
      const sub = args[0];
      if (!sub || !['test', 'screenshot', 'pdf', 'install', '--version'].includes(sub)) refuse('playwright: allowed subcommands are test, screenshot, pdf, install');
      if (sub === 'install' && args.includes('--with-deps')) refuse('--with-deps needs root; not allowed');
      checkAll(args, ctx, cmd); break;
    }
    case 'sed': {
      if (flagIn(args, ['--follow-symlinks'])) refuse('--follow-symlinks is not allowed');
      checkAll(args, ctx, cmd);
      args = ['--sandbox', ...args]; // GNU sed: rejects the e/w/r commands (no command execution, no writes elsewhere)
      break;
    }
    case 'find': {
      const bad = args.find((a) => FIND_BLOCKED.includes(a));
      if (bad) refuse(`find ${bad} is not allowed (no exec, no following symlinks, no writing files)`);
      checkAll(args, ctx, cmd); break;
    }
    case 'zip': {
      if (flagIn(args, ['-T', '-TT', '--unzip-command', '--test'])) refuse('zip -T/-TT is not allowed');
      checkAll(args, ctx, cmd); break;
    }
    case 'curl': case 'wget': args = fetchRules(cmd, args, ctx); break;
    case 'rm': case 'mv': case 'cp': {
      if (cmd === 'cp' && flagIn(args, ['-s', '--symbolic-link', '-l', '--link'])) refuse('cp cannot create links');
      checkAll(args, ctx, cmd);
      for (const a of args.filter((x) => !x.startsWith('-'))) {
        const abs = path.resolve(ctx.cwd, a);
        if (abs === ctx.jail.root) refuse(`${cmd} on the workspace root is not allowed`);
        if (isGitInternal(path.relative(ctx.jail.root, abs).split(path.sep).join('/'))) refuse('.git internals are off limits');
      }
      break;
    }
    case 'grep': {
      checkAll(args, ctx, cmd);
      args = ['--exclude=.env*', '--exclude=*.pem', '--exclude=*.key', '--exclude=id_*', '--exclude=.npmrc', '--exclude-dir=.git', ...args];
      break;
    }
    default:
      if (!SIMPLE.has(cmd)) refuse(`"${cmd}" is not allowed`);
      checkAll(args, ctx, cmd);
  }
  let file = which(bin, sandboxPath);
  if (!file && LOCAL_BIN_FALLBACK.has(bin)) {
    const npx = which('npx', sandboxPath);
    if (npx) { file = npx; args = ['--no-install', bin, ...args]; }
  }
  if (!file) refuse(`"${bin}" is not installed on the worker`);
  return { file: file!, args, display: [cmd, ...rawArgs].join(' ') };
}

// ---------- env + run ----------
const PASS_ENV = ['LANG', 'LC_ALL', 'TZ', 'PLAYWRIGHT_BROWSERS_PATH', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];

/** Minimal child env: PATH, HOME=jail, no tokens (proxy vars only when they carry no credentials). */
export function sandboxEnv(jail: Jail, workerEnv: Record<string, string | undefined>, sandboxPath: string): Record<string, string> {
  const tmp = path.join(jail.root, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const env: Record<string, string> = {
    PATH: sandboxPath, HOME: jail.root, TMPDIR: tmp, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0',
    npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'https',
    GIT_AUTHOR_NAME: workerEnv.DEV_GIT_AUTHOR_NAME || 'RizeHub Agent', GIT_AUTHOR_EMAIL: workerEnv.DEV_GIT_AUTHOR_EMAIL || 'agents@rizehub.ph',
    GIT_COMMITTER_NAME: workerEnv.DEV_GIT_AUTHOR_NAME || 'RizeHub Agent', GIT_COMMITTER_EMAIL: workerEnv.DEV_GIT_AUTHOR_EMAIL || 'agents@rizehub.ph',
    SHOPIFY_CLI_NO_ANALYTICS: '1',
  };
  for (const k of PASS_ENV) {
    const v = workerEnv[k];
    if (v && !/:\/\/[^/\s]*@/.test(v)) env[k] = v;
  }
  return env;
}

export function formatResult(r: RunResult, display: string, timeoutS: number, redirected: string | null): string {
  const clip = (s: string) => (s.length > OUTPUT_MAX_CHARS
    ? `${s.slice(0, OUTPUT_MAX_CHARS / 4)}\n…[${s.length - OUTPUT_MAX_CHARS} chars omitted]…\n${s.slice(-(OUTPUT_MAX_CHARS * 3) / 4)}` : s);
  const status = r.timedOut ? `TIMED OUT after ${timeoutS}s (process group killed)` : r.signal ? `killed by ${r.signal}` : `exit ${r.code}`;
  const parts = [`$ ${display}`, status];
  if (redirected) parts.push(`stdout written to ${redirected}`);
  if (r.stdout.trim()) parts.push(`--- stdout ---\n${clip(r.stdout.trimEnd())}`);
  if (r.stderr.trim()) parts.push(`--- stderr ---\n${clip(r.stderr.trimEnd())}`);
  if (!r.stdout.trim() && !r.stderr.trim() && !redirected) parts.push('(no output)');
  return parts.join('\n');
}

/**
 * Optional OS-level sandbox around every agent command (recommended in production, because node/npm scripts can
 * do anything the worker user can): DEV_SANDBOX_PREFIX is a JSON argv, e.g.
 * ["bwrap","--ro-bind","/usr","/usr","--ro-bind","/bin","/bin","--ro-bind","/lib","/lib","--ro-bind","/lib64","/lib64",
 *  "--bind","{jail}","{jail}","--proc","/proc","--dev","/dev","--unshare-all","--share-net","--die-with-parent","--chdir","{jail}"]
 * "{jail}" is replaced by the task workspace path.
 */
export function wrapWithPrefix(prefixJson: string | undefined, file: string, args: string[], jailRoot: string): [string, string[]] {
  if (!prefixJson?.trim()) return [file, args];
  let prefix: unknown;
  try { prefix = JSON.parse(prefixJson); } catch { throw new ShellRefusal('DEV_SANDBOX_PREFIX is not valid JSON; the worker admin must fix it'); }
  if (!Array.isArray(prefix) || !prefix.length || !prefix.every((x) => typeof x === 'string')) throw new ShellRefusal('DEV_SANDBOX_PREFIX must be a JSON array of strings');
  const p = (prefix as string[]).map((x) => x.split('{jail}').join(jailRoot));
  return [p[0]!, [...p.slice(1), file, ...args]];
}

export interface ShellInput { command: string; cwd?: string; timeout_s?: number }

/** Plans and runs one command. Throws ShellRefusal for policy refusals. */
export async function runSandboxed(env: DevEnv, jail: Jail, allowedHosts: string[], i: ShellInput): Promise<string> {
  const parsed = tokenize(i.command);
  const cwdRel = (i.cwd ?? '.').trim() || '.';
  const policy: ShellPolicyCtx = { jail, cwd: jail.root, allowedHosts };
  checkArg(cwdRel === '.' ? '' : cwdRel, policy, 'cwd');
  const cwd = path.resolve(jail.root, cwdRel);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) refuse(`cwd "${cwdRel}" is not a directory in the workspace`);
  if (!inside(jail.root, fs.realpathSync(cwd))) refuse('cwd is outside the workspace');
  policy.cwd = cwd;
  const plan = planCommand(parsed.argv, policy, env.sandboxPath);
  let stdoutFile: { path: string; append: boolean } | undefined;
  let redirected: string | null = null;
  if (parsed.redirect) {
    const t = parsed.redirect.path;
    if (!t || URLISH.test(t)) refuse('redirect target must be a file in the workspace');
    checkArg(t, policy, 'redirect');
    const abs = path.resolve(cwd, t);
    if (isGitInternal(path.relative(jail.root, abs).split(path.sep).join('/'))) refuse('.git internals are off limits');
    try { if (fs.lstatSync(abs).isSymbolicLink()) refuse('redirect target is a symlink'); } catch (e) { if (e instanceof ShellRefusal) throw e; }
    if (!fs.existsSync(path.dirname(abs))) refuse('redirect target folder does not exist (create it with mkdir first)');
    stdoutFile = { path: abs, append: parsed.redirect.append };
    redirected = path.relative(jail.root, abs);
  }
  const timeoutS = Math.min(Math.max(1, Math.round(i.timeout_s ?? DEFAULT_TIMEOUT_S)), MAX_TIMEOUT_S);
  const [file, args] = wrapWithPrefix(env.env.DEV_SANDBOX_PREFIX, plan.file, plan.args, jail.root);
  const r = await env.run(file, args, {
    cwd, env: sandboxEnv(jail, env.env, env.sandboxPath), timeoutMs: timeoutS * 1000, stdoutFile, maxCaptureBytes: 512 * 1024,
  });
  return formatResult(r, plan.display, timeoutS, redirected);
}
