// Device setup API (P1). The dashboard is the public door (keyless): /setup/<code> and /api/brain/device forward here.
// Setup codes and device tokens are only ever stored as sha256 hashes (brain_devices).
import { createHash, randomBytes } from 'node:crypto';
import type { Store } from '../store/types';
import { errorScript, renderInstaller } from './installer';

export const SETUP_CODE_RE = /^[0-9a-f]{20}$/;
export const DEVICE_TOKEN_RE = /^hqd_[A-Za-z0-9_-]{43}$/;
export const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const newDeviceToken = () => `hqd_${randomBytes(32).toString('base64url')}`;

const STEPS = new Set(['installer', 'claude', 'ps', 'git', 'python', 'folder', 'clone', 'github', 'cmds', 'task', 'mcp', 'roundtrip', 'sync', 'hqsync']);
const STATES = new Set(['wait', 'run', 'done', 'fail', 'skip']);
const INFO_KEYS = ['installer', 'os', 'computer', 'ps', 'git', 'vault_path', 'claude', 'sync_version'];
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?$/;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : undefined);

export interface SetupDeps { store: Store; publicUrl: string; repoUrl: string; log: (m: string) => void }

/** Redeem a setup link and render the installer (or a friendly error script; `iex` runs whatever comes back). */
export async function setupScript(d: SetupDeps, code: string): Promise<string> {
  if (!SETUP_CODE_RE.test(code)) return errorScript('this setup link is not valid.');
  const token = newDeviceToken();
  const dev = await d.store.rpc<{ id: string; name: string; track: 'owner' | 'member' } | null>('brain_device_redeem', {
    p_code_hash: sha256hex(code), p_token_hash: sha256hex(token),
  });
  if (!dev) return errorScript('this setup link has expired or was already used.');
  d.log(`setup: link redeemed for device ${dev.id} (${dev.track})`);
  return renderInstaller({ server: d.publicUrl, token, deviceId: dev.id, name: dev.name, track: dev.track, repoUrl: d.repoUrl });
}

/** Clean an installer / sync.ps1 report down to what brain_device_report accepts. Exported for tests. */
export function cleanReport(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const step = str(b.step, 40);
  if (step && STEPS.has(step)) {
    out.step = step;
    const s = str(b.s, 10);
    out.s = s && STATES.has(s) ? s : 'done';
    out.detail = str(b.detail, 300) ?? '';
  }
  if (b.info && typeof b.info === 'object' && !Array.isArray(b.info)) {
    const info: Record<string, string> = {};
    for (const k of INFO_KEYS) { const v = str((b.info as Record<string, unknown>)[k], 200); if (v) info[k] = v; }
    if (Object.keys(info).length) out.info = info;
  }
  if (b.roundtrip && typeof b.roundtrip === 'object' && !Array.isArray(b.roundtrip)) {
    const r = b.roundtrip as Record<string, unknown>;
    const rt: Record<string, string> = {};
    const nonce = str(r.nonce, 64);
    if (nonce && /^[0-9a-f]{32}$/.test(nonce)) rt.nonce = nonce;
    for (const k of ['written_at', 'pushed_at']) { const v = str(r[k], 40); if (v && ISO.test(v)) rt[k] = v; }
    if (Object.keys(rt).length) out.roundtrip = rt;
  }
  if (typeof b.pull_ok === 'boolean') out.pull_ok = b.pull_ok;
  if (typeof b.push_ok === 'boolean') out.push_ok = b.push_ok;
  if ('error' in b) out.error = str(b.error, 300) ?? '';
  return out;
}

export async function deviceReport(d: SetupDeps, bearer: string | undefined, body: Record<string, unknown>): Promise<[number, unknown]> {
  const token = (bearer?.replace(/^Bearer\s+/i, '') || (typeof body.token === 'string' ? body.token : '')).trim();
  if (!DEVICE_TOKEN_RE.test(token)) return [401, { error: 'unknown device' }];
  const clean = cleanReport(body);
  const r = await d.store.rpc<{ id: string } | null>('brain_device_report', { p_token_hash: sha256hex(token), p: clean });
  if (!r) return [401, { error: 'unknown or revoked device' }];
  // P3: a member PC is ready after its first good HQ Sync
  if (clean.step === 'hqsync' && clean.s === 'done') await d.store.rpc('brain_device_mark_ready', { p_token_hash: sha256hex(token) }).catch(() => undefined);
  return [200, { ok: true }];
}

/** After an index run: a changed devices/<id>.md with a round-trip nonce → mark it indexed, then read it back. */
export async function checkRoundTrips(store: Store, docs: Array<{ path: string; frontmatter: Record<string, unknown> }>, touched: Set<string>, log: (m: string) => void): Promise<void> {
  for (const doc of docs) {
    if (!touched.has(doc.path) || !/^devices\/[^/]+\.md$/.test(doc.path)) continue;
    const nonce = typeof doc.frontmatter.roundtrip === 'string' ? doc.frontmatter.roundtrip : '';
    if (!/^[0-9a-f]{32}$/.test(nonce)) continue;
    try {
      if (!(await store.rpc<boolean>('brain_device_roundtrip', { p_nonce: nonce, p_stage: 'indexed' }))) continue;
      const back = await store.rpc<{ body?: string } | null>('brain_get_document', { p_path: doc.path });
      if (back?.body !== undefined) {
        await store.rpc('brain_device_roundtrip', { p_nonce: nonce, p_stage: 'readable' });
        log(`device round trip complete: ${doc.path}`);
      }
    } catch (e) { log(`device round trip check failed for ${doc.path}: ${(e as Error).message}`); }
  }
}
