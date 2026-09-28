// Privilege drop for agent commands (docs/09 "Worker guardrails" → "Agent uid").
//
// In production the worker process runs as root INSIDE its container (never on the host) only so it can start
// agent commands under a different, unprivileged uid (AGENT_UID/AGENT_GID, 1001 in the image). Why that
// protects the worker's secrets:
//   * /proc/<pid>/environ (and /proc/<pid>/mem, /proc/<pid>/fd/*) are guarded by the kernel's ptrace access check
//     in PTRACE_MODE_READ_FSCREDS mode (fs/proc/base.c environ_open → __mem_open → mm_access → ptrace_may_access).
//     Access is granted only if the caller's fsuid/fsgid match the target's real, effective AND saved uid/gid, or
//     the caller has CAP_SYS_PTRACE in the target's user namespace. uid 1001 vs the worker's uid 0 never matches,
//     and an unprivileged uid has no capabilities (Docker never grants CAP_SYS_PTRACE by default; exec as a
//     non-zero uid clears the permitted set). So agent code gets EACCES on /proc/<worker pid>/environ.
//   * libuv (child_process.spawn with uid/gid) calls setgroups(0, NULL), setgid(gid), setuid(uid) in the child
//     before exec: no supplementary groups (e.g. root's) are left behind.
//   * The env files are not mounted into the container (docker compose env_file only injects variables), and the
//     child env is built from scratch (shell.ts sandboxEnv), so the agent uid has nothing else to read.
// /proc/<pid>/environ always shows a process's ORIGINAL environment, so scrubbing process.env later
// (config.ts scrubProcessEnv) cannot hide it from a same-uid reader: the uid split is the real control.
import fs from 'node:fs';
import path from 'node:path';

export interface AgentIdentity { uid: number; gid: number }

const toId = (v: string | undefined): number | null => {
  if (v === undefined || !/^\d{1,9}$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n > 0 ? n : null; // never "drop" to root
};

export type GetUid = () => number | undefined;
const realGetUid: GetUid = () => (typeof process.getuid === 'function' ? process.getuid() : undefined);

/**
 * The uid/gid agent commands run as, or null when no drop happens: the worker must be root (only root can
 * setuid) and AGENT_UID must be a positive integer (AGENT_GID defaults to AGENT_UID).
 */
export function agentIdentity(env: Readonly<Record<string, string | undefined>>, getuid: GetUid = realGetUid): AgentIdentity | null {
  if (getuid() !== 0) return null;
  const uid = toId(env.AGENT_UID);
  if (uid === null) return null;
  return { uid, gid: toId(env.AGENT_GID) ?? uid };
}

export interface SandboxStatus {
  privilegeDrop: boolean;
  osSandbox: boolean;
  /** True when agent code cannot read the worker's secrets (privilege drop or an OS sandbox wrapper). */
  isolated: boolean;
  production: boolean;
  /** Set when bash_sandboxed must refuse to run anything (production without isolation). */
  refusal: string | null;
  /** Startup warning text, if any. */
  warning: string | null;
}

export function sandboxStatus(env: Readonly<Record<string, string | undefined>>, getuid: GetUid = realGetUid): SandboxStatus {
  const privilegeDrop = agentIdentity(env, getuid) !== null;
  const osSandbox = Boolean(env.DEV_SANDBOX_PREFIX?.trim());
  const production = env.NODE_ENV === 'production';
  const isolated = privilegeDrop || osSandbox;
  const uid = getuid();
  const why = uid === 0
    ? 'the worker runs as root but AGENT_UID is not set'
    : `the worker runs as uid ${uid ?? '?'} (not root), so it cannot start agent commands under AGENT_UID`;
  const refusal = production && !isolated
    ? `the shell is disabled on this worker: ${why} and DEV_SANDBOX_PREFIX is empty, so agent commands could read the worker's secrets. `
      + 'The CEO/admin must run the worker image as shipped (root in the container + AGENT_UID) or set DEV_SANDBOX_PREFIX. Use workspace_fs and the platform tools meanwhile.'
    : null;
  const warning = refusal
    ? `[worker] SECURITY: bash_sandboxed is DISABLED: ${why} and DEV_SANDBOX_PREFIX is empty (docs/09 "Agent uid").`
    : !isolated
      ? `[worker] SECURITY: agent shell commands run as the worker's own uid (${why}); only the command allowlist protects secrets. Fine for local dev, never in production.`
      : null;
  return { privilegeDrop, osSandbox, isolated, production, refusal, warning };
}

/** chown one path (never follows symlinks). No-op without an identity. */
export function chownToAgent(p: string, id: AgentIdentity | null | undefined): void {
  if (!id) return;
  try { fs.lchownSync(p, id.uid, id.gid); } catch { /* vanished */ }
}

/** chown a whole tree (lchown, symlinks are not followed; stays on the given root). */
export function chownTreeToAgent(root: string, id: AgentIdentity | null | undefined): void {
  if (!id) return;
  const walk = (p: string) => {
    let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.uid !== id.uid || st.gid !== id.gid) { try { fs.lchownSync(p, id.uid, id.gid); } catch { /* ignore */ } }
    if (!st.isDirectory()) return;
    let names: string[] = [];
    try { names = fs.readdirSync(p); } catch { return; }
    for (const n of names) walk(path.join(p, n));
  };
  walk(root);
}

/** Make a new path owned like `ownerOf` (e.g. files the root worker writes into the host bind-mounted brain/). */
export function inheritOwner(paths: string[], ownerOf: string, getuid: GetUid = realGetUid): void {
  if (getuid() !== 0) return;
  let st: fs.Stats;
  try { st = fs.statSync(ownerOf); } catch { return; }
  for (const p of paths) { try { fs.lchownSync(p, st.uid, st.gid); } catch { /* ignore */ } }
}
