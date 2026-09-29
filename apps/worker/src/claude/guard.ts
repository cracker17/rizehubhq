// Jail guard for Claude Code's own file tools (CLAUDE_FILE_TOOLS=native, docs/05 "Claude runtime"). The Claude runner
// installs this as a PreToolUse hook: a hook "deny" is final, whatever the permission rules say. Every path must
// resolve inside the task workspace (WORKSPACES_DIR/<task-id>), with the same rules as workspace_fs (dev/jail.ts): no
// `..`, no absolute paths outside, no symlink out, no secret-looking files (.env, keys), no writes to .git internals.
//
// Caveat (documented in docs/05): Claude Code opens the files itself, as the worker uid, after this check. The
// worker's own jail I/O (dev/safefs.ts) is race-safe; this check is not (a symlink swapped in between check and open
// is not caught). That is why the default is CLAUDE_FILE_TOOLS=hq (files through workspace_fs over MCP).
import fs from 'node:fs';
import path from 'node:path';
import { checkRel, inside, isGitInternal, isSecretName, JailError, relOf, resolveIn, type Jail } from '../dev/jail';
import { chownToAgent, type AgentIdentity } from '../dev/agentUser';

/** Claude Code built-in tools a `native` run may use (only for roles granted workspace_fs). */
export const NATIVE_FILE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'] as const;
const WRITES = new Set(['Edit', 'Write']);
const SKIP_DIRS = new Set(['node_modules', '.git']);
const SCAN_MAX = 5000;

/** A tool-supplied path (absolute or relative to the workspace) → its workspace-relative form. Throws JailError. */
export function jailRel(jail: Jail, p: unknown): string {
  if (p === undefined || p === null || p === '') return '.';
  if (typeof p !== 'string') throw new JailError('path must be a string');
  const s = p.trim();
  if (s.includes('\0')) throw new JailError('invalid path');
  const abs = path.isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s) ? path.resolve(s) : path.resolve(jail.root, s);
  if (!inside(jail.root, abs)) throw new JailError(`"${s}" is outside your workspace (${jail.root}); use paths inside it`);
  return relOf(jail, abs);
}

/** A glob / file pattern must stay relative and inside the searched folder. */
function checkPattern(p: unknown, what: string): void {
  if (p === undefined || p === null || p === '') return;
  if (typeof p !== 'string') throw new JailError(`${what} must be a string`);
  const s = p.trim().replace(/\\/g, '/');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.startsWith('~')) throw new JailError(`${what} "${p}" must be relative to your workspace`);
  if (s.replace(/^!/, '').split('/').includes('..')) throw new JailError(`".." is not allowed in ${what} "${p}"`);
}

/** Secret-looking file under dir (bounded scan, skipping node_modules/.git), or null. */
function secretUnder(dir: string): string | null {
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > SCAN_MAX) return null;
      if (isSecretName(e.name)) return path.join(d, e.name);
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) stack.push(path.join(d, e.name));
    }
  }
  return null;
}

/**
 * Checks one native file-tool call against the task jail. Returns null when it may run, else the reason it is refused
 * (shown to the model). Unknown tools are refused.
 */
export function checkNativeFileCall(tool: string, input: unknown, jail: Jail): string | null {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  try {
    switch (tool) {
      case 'Read':
      case 'Edit':
      case 'Write': {
        if (typeof i.file_path !== 'string' || !i.file_path.trim()) return `${tool} needs file_path`;
        const rel = checkRel(jailRel(jail, i.file_path));
        const writing = WRITES.has(tool);
        if (writing && rel === '.') return 'cannot write to the workspace root itself';
        if (writing && isGitInternal(rel)) return '.git internals are managed by the github tool; do not edit them.';
        resolveIn(jail, rel, { noFinalSymlink: writing });
        return null;
      }
      case 'Glob':
      case 'Grep': {
        const rel = jailRel(jail, i.path);
        const abs = rel === '.' ? jail.root : resolveIn(jail, rel);
        checkPattern(tool === 'Glob' ? i.pattern : i.glob, tool === 'Glob' ? 'pattern' : 'glob');
        if (tool === 'Grep') {
          let dir = false;
          try { dir = fs.statSync(abs).isDirectory(); } catch { /* missing: Grep reports it */ }
          const secret = dir ? secretUnder(abs) : null;
          if (secret) {
            return `this folder contains a secret-looking file (${relOf(jail, secret)}), so Grep cannot search it as a whole: `
              + 'search a subfolder or a single file instead.';
          }
        }
        return null;
      }
      default:
        return `${tool} is not available here`;
    }
  } catch (e) {
    if (e instanceof JailError) return e.message;
    return `refused: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * After Claude Code (running as the worker uid) wrote a file: hand it and any folders it created to the agent uid, so
 * bash_sandboxed (agent uid) can still change them. No-op without the privilege drop.
 */
export function handOverToAgent(jail: Jail, filePath: unknown, id: AgentIdentity | null | undefined): void {
  if (!id || typeof filePath !== 'string') return;
  let abs: string;
  try { abs = path.resolve(jail.root, jailRel(jail, filePath)); } catch { return; }
  for (let p = abs; inside(jail.root, p) && p !== jail.root; p = path.dirname(p)) {
    try { if (fs.lstatSync(p).isSymbolicLink()) return; } catch { continue; }
    chownToAgent(p, id);
  }
}
