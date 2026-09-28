// Injected environment for the dev tools (M9): everything that touches the OS or network goes through
// here so tests can use fakes (fake fetch, fake process runner, temp workspaces). No module state.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config';
import type { VaultToolEnv } from '../tools/vault';

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Absolute file (already jail-checked) that receives stdout instead of the captured output. */
  stdoutFile?: { path: string; append: boolean };
  /** Stop capturing after this many bytes per stream (the process keeps running). */
  maxCaptureBytes?: number;
}
export interface RunResult { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }
export type RunProcess = (file: string, args: string[], opts: RunOptions) => Promise<RunResult>;

export interface DevEnv {
  /** Parent of all task jails: WORKSPACES_DIR (default <repo>/workspaces). */
  workspacesDir: string;
  fetch: typeof fetch;
  run: RunProcess;
  sleep: (ms: number) => Promise<void>;
  /** Worker env (tokens are read from here by the tool layer only, never passed to children). */
  env: Record<string, string | undefined>;
  vault: Pick<VaultToolEnv, 'store' | 'keyring'>;
  /** Directory holding the GIT_ASKPASS helper (outside every jail). */
  helperDir: () => string;
  /** PATH given to sandboxed processes. */
  sandboxPath: string;
}

/** Real process runner: no shell, own process group (killed as a group on timeout), capped capture. */
export const runProcess: RunProcess = (file, args, opts) => new Promise((resolve) => {
  const max = opts.maxCaptureBytes ?? 256 * 1024;
  let out: fs.WriteStream | null = null;
  if (opts.stdoutFile) out = fs.createWriteStream(opts.stdoutFile.path, { flags: opts.stdoutFile.append ? 'a' : 'w' });
  const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const bufs = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const sizes = { stdout: 0, stderr: 0 };
  const take = (k: 'stdout' | 'stderr') => (b: Buffer) => {
    if (k === 'stdout' && out) { out.write(b); return; }
    if (sizes[k] < max) { bufs[k].push(b.subarray(0, max - sizes[k])); }
    sizes[k] += b.length;
  };
  child.stdout?.on('data', take('stdout'));
  child.stderr?.on('data', take('stderr'));
  let timedOut = false;
  const kill = () => {
    timedOut = true;
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  };
  const timer = setTimeout(kill, opts.timeoutMs);
  const finish = (code: number | null, signal: string | null, extraErr = '') => {
    clearTimeout(timer);
    const done = () => resolve({
      code, signal, timedOut,
      stdout: Buffer.concat(bufs.stdout).toString('utf8') + (sizes.stdout > max ? `\n…[stdout truncated: ${sizes.stdout} bytes]` : ''),
      stderr: Buffer.concat(bufs.stderr).toString('utf8') + extraErr + (sizes.stderr > max ? `\n…[stderr truncated: ${sizes.stderr} bytes]` : ''),
    });
    if (out) out.end(done); else done();
  };
  child.on('error', (e) => finish(127, null, `\n${e.message}`));
  child.on('close', (code, signal) => finish(code, signal));
});

let helperDirCache: string | null = null;
function defaultHelperDir(): string {
  if (helperDirCache && fs.existsSync(helperDirCache)) return helperDirCache;
  helperDirCache = fs.mkdtempSync(path.join(os.tmpdir(), 'rizehub-git-'));
  fs.chmodSync(helperDirCache, 0o700);
  return helperDirCache;
}

export function defaultSandboxPath(): string {
  return [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].filter((v, i, a) => a.indexOf(v) === i).join(':');
}

export function defaultDevEnv(vault: DevEnv['vault']): DevEnv {
  return {
    workspacesDir: config.workspacesDir,
    fetch: (...a) => fetch(...a),
    run: runProcess,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    env: process.env,
    vault,
    helperDir: defaultHelperDir,
    sandboxPath: defaultSandboxPath(),
  };
}

/** Finds an executable on a PATH string (no jail directories are ever on it). */
export function which(bin: string, pathStr: string): string | null {
  for (const dir of pathStr.split(':')) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

/** Env var suffix for a client slug: "madam-muse" → "MADAM_MUSE". */
export const envSlug = (slug: string) => slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
