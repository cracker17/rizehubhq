// HQ Sync (P3): a team member's PC keeps a filtered local copy of the vault without git. The device token (from the
// setup link) identifies the PC; the person's live grants decide every file (access.ts). Downloads come from the brain's
// own clone; uploads go through the same write path as the connector (pull → edit → secret check → commit as
// user:<email> → push → index). Conflicts keep both versions, like the owner's sync.ps1.
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../store/types';
import type { BrainService } from '../service';
import { canSeePath, canWriteProject, ownerOnly, projectOfPath, type Access } from '../access';
import { walk, MAX_FILE_BYTES } from '../index/indexer';
import { sha256 } from '../index/chunk';
import { findSecret } from '../secretScan';
import { DEVICE_TOKEN_RE, sha256hex } from '../setup/devices';
import { WriteError, type VaultOp } from '../write/vault';

export interface SyncDeps { store: Store; service: BrainService; vaultDir: string; log: (m: string) => void }
type Result = [number, unknown];

interface DeviceOwner { device_id: string; device_name: string; track: string; person_id: string | null; person: null | { person_id: string; role: 'admin' | 'member' | 'viewer'; email: string; name: string; grants: Array<{ slug: string; access: 'read' | 'write'; transcripts: boolean }> } }

/** Device token → the person's live access. Owner PCs use git (sync.ps1), not HQ Sync. */
export async function deviceAccess(store: Store, token: unknown): Promise<{ acc: Access; deviceId: string; deviceName: string } | { error: Result }> {
  if (typeof token !== 'string' || !DEVICE_TOKEN_RE.test(token)) return { error: [401, { error: 'unknown device' }] };
  const o = await store.rpc<DeviceOwner | null>('brain_device_owner', { p_token_hash: sha256hex(token) });
  if (!o) return { error: [401, { error: 'This computer was removed from HQ, or its person was disabled.' }] };
  if (!o.person) return { error: [409, { error: 'Owner computers sync with git (scripts/sync.ps1), not HQ Sync.' }] };
  const p = o.person;
  return {
    acc: { role: p.role, personId: p.person_id, email: p.email, name: p.name, grants: new Map((p.grants ?? []).map((g) => [g.slug, g])) },
    deviceId: o.device_id, deviceName: o.device_name,
  };
}

/** Every vault file this person may have on their PC, with its sha (same sha256 of the raw text as the index uses). */
export function manifestFor(vaultDir: string, acc: Access): Array<{ path: string; sha: string; bytes: number }> {
  const out: Array<{ path: string; sha: string; bytes: number }> = [];
  for (const rel of walk(vaultDir)) {
    if (!canSeePath(acc, rel)) continue;
    const abs = path.join(vaultDir, ...rel.split('/'));
    const size = fs.statSync(abs).size;
    if (size > MAX_FILE_BYTES) continue;
    const raw = fs.readFileSync(abs, 'utf8');
    if (findSecret(raw)) continue; // never hand out a file that looks like it holds a secret
    out.push({ path: rel, sha: sha256(raw), bytes: size });
  }
  return out;
}

const SAFE_PATH = /^projects\/[a-z0-9][a-z0-9-]{0,63}\/[A-Za-z0-9 ._()\/-]{1,200}\.md$/;

/** The conflict copy name, like sync.ps1: notes.md → notes.conflict-<device>-<yyyymmdd-hhmm>.md */
export function conflictName(rel: string, device: string, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const dev = device.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'pc';
  return rel.replace(/\.md$/, `.conflict-${dev}-${stamp}.md`);
}

/** A VaultOp that writes one file (the upload), relative to the vault. */
function putFileOp(rel: string, content: string, project: string, who: string): VaultOp {
  return (dir) => {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content.endsWith('\n') ? content : `${content}\n`);
    return { paths: [rel], project, summary: `HQ Sync: ${rel}`, message: `hq sync: ${rel} (${who})` };
  };
}

export async function handleSync(d: SyncDeps, action: string, body: Record<string, unknown>): Promise<Result> {
  const who = await deviceAccess(d.store, body.token);
  if ('error' in who) return who.error;
  const { acc, deviceName } = who;
  const projects = [...acc.grants.values()].map((g) => ({ slug: g.slug, access: acc.role === 'viewer' ? 'read' : g.access }));

  if (action === 'manifest') {
    return [200, { person: acc.name, role: acc.role, projects, files: manifestFor(d.vaultDir, acc) }];
  }

  const rel = typeof body.path === 'string' ? body.path.replace(/\\/g, '/').replace(/^\/+/, '') : '';
  if (!rel || rel.includes('..') || rel.length > 300) return [400, { error: 'path is required' }];

  if (action === 'file') {
    if (!canSeePath(acc, rel)) return [404, { error: 'not found' }];
    const abs = path.join(d.vaultDir, ...rel.split('/'));
    if (!fs.existsSync(abs)) return [404, { error: 'not found' }];
    const raw = fs.readFileSync(abs, 'utf8');
    if (findSecret(raw)) return [404, { error: 'not found' }];
    return [200, { path: rel, sha: sha256(raw), content: raw }];
  }

  if (action === 'upload') {
    const content = typeof body.content === 'string' ? body.content : null;
    if (content === null) return [400, { error: 'content is required' }];
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return [413, { error: 'file too big (512 KB max)' }];
    const project = projectOfPath(rel);
    if (!SAFE_PATH.test(rel) || ownerOnly(rel) || !project) return [403, { error: 'Only .md files inside a project folder can be synced.' }];
    if (!canSeePath(acc, rel) || !canWriteProject(acc, project)) return [403, { error: `You can read ${project} but not edit it. Ask Julev for edit access.` }];
    const secret = findSecret(content);
    if (secret) return [422, { error: `This file looks like it contains a secret (${secret}). Remove it and note where the secret is stored instead.` }];
    // Conflict: the server copy changed since the PC last downloaded it → keep both (the PC's version as a conflict copy).
    const abs = path.join(d.vaultDir, ...rel.split('/'));
    const current = fs.existsSync(abs) ? sha256(fs.readFileSync(abs, 'utf8')) : null;
    const base = typeof body.base_sha === 'string' ? body.base_sha : null;
    const target = current !== null && base !== current && current !== sha256(content) ? conflictName(rel, deviceName) : rel;
    if (current !== null && current === sha256(content)) return [200, { ok: true, path: rel, sha: current, unchanged: true }];
    try {
      const r = await d.service.write(putFileOp(target, content, project, acc.email ?? 'member'), `user:${acc.email}`);
      d.log(`hq-sync: ${acc.email} uploaded ${target} (${r.sha.slice(0, 7)})`);
      return [200, { ok: true, path: target, conflict: target !== rel, sha: sha256(content.endsWith('\n') ? content : `${content}\n`) }];
    } catch (e) {
      if (e instanceof WriteError) return [400, { error: e.message }];
      throw e;
    }
  }
  return [404, { error: 'unknown sync action' }];
}
