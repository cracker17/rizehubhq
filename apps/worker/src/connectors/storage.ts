// Saving files to the CEO's own storage (docs/15 §6): the default storage connection (Google Drive or Dropbox), folder
// `RizeHub HQ/<client or Internal>/<request title>/`. Private files only: no public or shared link is ever created
// (a shared link would be an approval). Vendor APIs checked 2026-09-29:
// - Drive v3 (developers.google.com/workspace/drive/api/guides/manage-uploads, …/folder, …/search-files): multipart upload
//   ≤ 5 MB, resumable above (POST ?uploadType=resumable → Location session URI → PUT the bytes); folders are files with
//   mimeType application/vnd.google-apps.folder; search `name = '…' and mimeType = … and '<parent>' in parents and
//   trashed = false`, with ' and \ escaped by a backslash. drive.file only lists files HQ itself created, which is all we need.
// - Dropbox (github.com/dropbox/dropbox-api-spec files.stone, docs.dropboxapi.com): POST content.dropboxapi.com/2/files/upload,
//   args as JSON in the Dropbox-API-Arg header, ≤ 150 MB per request, scope files.content.write; parent folders are created
//   automatically. In an App-folder app, paths are relative to /Apps/<app folder>.
// Access tokens are cached in memory only; the sealed secret (client + refresh token) is re-sealed with store.rotate
// only when the vendor rotates the refresh token.
import { STORAGE_INTERNAL_FOLDER, STORAGE_ROOT_FOLDER, type SavedStorage, type StorageProvider } from '@rizehubhq/shared';
import { open, seal, type Keyring } from '../vault/crypto';
import { connectorContext, type ConnectorRow, type ConnectorStore } from './store';
import { refreshAccess, StorageNeedsReauth, type Fetch, type StorageSecret } from './storageOAuth';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';
export const DROPBOX_API = 'https://api.dropboxapi.com/2';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MULTIPART_MAX = 5 * 1024 * 1024;
/** fetch bodies must be ArrayBuffer-backed (TS BodyInit); a Buffer may sit on a shared pool, so copy it. */
const bodyOf = (b: Buffer) => new Uint8Array(b);
/** Largest single file HQ uploads (Dropbox's single-request limit is 150 MB; Drive resumable has no such limit). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface StorageEnv {
  store: ConnectorStore;
  keyring: Keyring | null;
  fetch: Fetch;
  /** Puts the saved links on the task output + pending deliverable card (task_record_storage). */
  recordTask?: (taskId: string, saved: SavedStorage) => Promise<void>;
  now?: () => number;
}

export interface SaveFileInput { clientName: string | null; requestTitle: string; fileName: string; bytes: Buffer; mimeType: string }
export interface SavedFile { provider: StorageProvider; connectorId: string; name: string; url: string; folderUrl: string | null; path: string }

/** Storage isn't usable (not connected / cannot decrypt): a plain sentence for the agent or the log. */
export class StorageUnavailable extends Error {}

// ---------- names ----------
/** One safe path segment: no slashes, control or reserved characters, no trailing dots/spaces, ≤ 100 chars. */
export function safeSegment(s: string | null | undefined, fallback = 'Untitled'): string {
  const cleaned = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .replace(/[. ]+$/, '');
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

/** The folder path under the storage root: [client or Internal, request title]. */
export function folderParts(clientName: string | null, requestTitle: string): [string, string] {
  return [safeSegment(clientName, STORAGE_INTERNAL_FOLDER), safeSegment(requestTitle, 'Untitled request')];
}

const MIME: Record<string, string> = {
  md: 'text/markdown', txt: 'text/plain', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
  json: 'application/json', csv: 'text/csv', xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', pdf: 'application/pdf', zip: 'application/zip',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', liquid: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export function mimeFor(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

// ---------- Google Drive ----------
const driveQuote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function jsonOrThrow(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => '');
  let body: Record<string, unknown> = {};
  try { body = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* not JSON */ }
  if (!res.ok) {
    const err = body.error as { message?: string } | string | undefined;
    const msg = typeof err === 'string' ? err : err?.message ?? (body.error_summary as string | undefined) ?? text.slice(0, 200);
    const e = new Error(`${what}: HTTP ${res.status}${msg ? ` ${String(msg).slice(0, 200)}` : ''}`);
    if (res.status === 401) throw new StorageNeedsReauth(e.message);
    throw e;
  }
  return body;
}

export async function driveFindOrCreateFolder(fetchFn: Fetch, token: string, name: string, parent: string): Promise<string> {
  const q = `name = ${driveQuote(name)} and mimeType = '${FOLDER_MIME}' and ${driveQuote(parent)} in parents and trashed = false`;
  const u = new URL(`${DRIVE_API}/files`);
  u.searchParams.set('q', q);
  u.searchParams.set('fields', 'files(id,name)');
  u.searchParams.set('pageSize', '1');
  u.searchParams.set('spaces', 'drive');
  const found = await jsonOrThrow(await fetchFn(u, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) }), 'Drive folder search');
  const hit = (found.files as { id?: string }[] | undefined)?.[0]?.id;
  if (hit) return hit;
  const created = await jsonOrThrow(await fetchFn(`${DRIVE_API}/files?fields=id`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }), signal: AbortSignal.timeout(30_000),
  }), 'Drive folder create');
  if (typeof created.id !== 'string') throw new Error('Drive folder create: no id returned');
  return created.id;
}

export async function driveUpload(fetchFn: Fetch, token: string, p: { name: string; parent: string; bytes: Buffer; mimeType: string }): Promise<{ id: string; url: string }> {
  const meta = JSON.stringify({ name: p.name, parents: [p.parent] });
  const fields = 'id,name,webViewLink';
  let res: Response;
  if (p.bytes.length <= MULTIPART_MAX) {
    const boundary = `hq${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${p.mimeType}\r\n\r\n`, 'utf8'),
      p.bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    res = await fetchFn(`${DRIVE_UPLOAD}?uploadType=multipart&fields=${encodeURIComponent(fields)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: bodyOf(body), signal: AbortSignal.timeout(120_000),
    });
  } else {
    const init = await fetchFn(`${DRIVE_UPLOAD}?uploadType=resumable&fields=${encodeURIComponent(fields)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': p.mimeType, 'X-Upload-Content-Length': String(p.bytes.length),
      },
      body: meta, signal: AbortSignal.timeout(30_000),
    });
    if (!init.ok) await jsonOrThrow(init, 'Drive upload start');
    const session = init.headers.get('location');
    if (!session || !/^https:\/\/www\.googleapis\.com\//.test(session)) throw new Error('Drive upload start: no upload session returned');
    res = await fetchFn(session, {
      method: 'PUT', headers: { 'Content-Type': p.mimeType, 'Content-Length': String(p.bytes.length) }, body: bodyOf(p.bytes),
      signal: AbortSignal.timeout(600_000),
    });
  }
  const f = await jsonOrThrow(res, 'Drive upload');
  if (typeof f.id !== 'string') throw new Error('Drive upload: no file id returned');
  return { id: f.id, url: typeof f.webViewLink === 'string' ? f.webViewLink : `https://drive.google.com/file/d/${f.id}/view` };
}

// ---------- Dropbox ----------
/** JSON for the Dropbox-API-Arg header: every character above 0x7E escaped as \uXXXX (HTTP headers are ASCII). */
export function headerSafeJson(v: unknown): string {
  return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export async function dropboxUpload(fetchFn: Fetch, token: string, p: { path: string; bytes: Buffer }): Promise<{ path: string; name: string }> {
  const res = await fetchFn(`${DROPBOX_CONTENT}/files/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': headerSafeJson({ path: p.path, mode: 'add', autorename: true, mute: false }),
    },
    body: bodyOf(p.bytes), signal: AbortSignal.timeout(600_000),
  });
  const f = await jsonOrThrow(res, 'Dropbox upload');
  return { path: typeof f.path_display === 'string' ? f.path_display : p.path, name: typeof f.name === 'string' ? f.name : p.path.split('/').pop()! };
}

/** Web link to a folder inside the app folder (dropbox.com/home/Apps/<app folder>/…); only the CEO can open it. */
export function dropboxWebUrl(appFolder: string | null | undefined, dir: string): string {
  const segs = ['Apps', appFolder?.trim() || STORAGE_ROOT_FOLDER, ...dir.split('/').filter(Boolean)];
  return `https://www.dropbox.com/home/${segs.map(encodeURIComponent).join('/')}`;
}

// ---------- the default storage ----------
const accessCache = new Map<string, { token: string; expiresAt: number }>();
export function clearStorageTokenCache() { accessCache.clear(); }
/** Keeps the access token from the code exchange, so the first save after connecting needs no refresh. */
export function rememberAccessToken(connectorId: string, token: string, expiresAt: number) { accessCache.set(connectorId, { token, expiresAt }); }

/** The signed-in account's email (or name) — Drive about.get / Dropbox users/get_current_account. */
export async function accountOf(fetchFn: Fetch, provider: StorageProvider, token: string): Promise<string | null> {
  if (provider === 'drive') {
    const r = await jsonOrThrow(await fetchFn(`${DRIVE_API}/about?fields=${encodeURIComponent('user(emailAddress,displayName)')}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
    }), 'Drive account');
    const u = r.user as { emailAddress?: string; displayName?: string } | undefined;
    return u?.emailAddress ?? u?.displayName ?? null;
  }
  // RPC endpoint without arguments: POST with no body and no Content-Type.
  const r = await jsonOrThrow(await fetchFn(`${DROPBOX_API}/users/get_current_account`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
  }), 'Dropbox account');
  return (r.email as string | undefined) ?? ((r.name as { display_name?: string } | undefined)?.display_name ?? null);
}

export interface OpenStorage {
  provider: StorageProvider;
  connectorId: string;
  name: string;
  save(input: SaveFileInput): Promise<SavedFile>;
  /** Proves the sign-in still works: refreshes the access token (forced) and reads the account. Returns its email/name. */
  check(): Promise<string | null>;
}

/** Opens a storage connection (the default one when `id` is omitted). null = no storage connected. */
export async function openStorage(env: StorageEnv, id?: string): Promise<OpenStorage | null> {
  let row: (ConnectorRow & { kind?: string }) | null;
  if (id) {
    const c = await env.store.get(id);
    row = c && c.kind === 'storage' ? c : null;
    if (!row) return null;
  } else {
    if (!env.store.defaultStorage) return null;
    row = await env.store.defaultStorage();
    if (!row) return null;
  }
  const c = row;
  if (!env.keyring || !c.sealed) throw new StorageUnavailable('The worker cannot decrypt connector secrets (VAULT_MASTER_KEY is not set).');
  let secret: StorageSecret;
  try { secret = JSON.parse(open(c.sealed, env.keyring, connectorContext(c.id))) as StorageSecret; } catch {
    throw new StorageUnavailable(`The saved sign-in of ${c.name} could not be decrypted. Reconnect it in Admin → Connectors.`);
  }
  const kr = env.keyring;
  const now = () => (env.now ? env.now() : Date.now());
  const provider = secret.provider;
  const appFolder = (c.settings as { appFolder?: string }).appFolder ?? null;

  async function token(force = false): Promise<string> {
    const cached = accessCache.get(c.id);
    if (!force && cached && cached.expiresAt - 60_000 > now()) return cached.token;
    try {
      const t = await refreshAccess(env.fetch, secret, now());
      accessCache.set(c.id, { token: t.accessToken, expiresAt: t.expiresAt });
      if (t.refreshToken) {
        secret = { ...secret, refreshToken: t.refreshToken };
        await env.store.rotate(c.id, seal(JSON.stringify(secret), kr, connectorContext(c.id)));
      }
      return t.accessToken;
    } catch (e) {
      if (e instanceof StorageNeedsReauth) {
        await env.store.mark(c.id, 'needs_reauth', `${provider === 'drive' ? 'Google' : 'Dropbox'} refused the saved sign-in (${e.message}). Reconnect it.`).catch(() => undefined);
      }
      throw e;
    }
  }

  /** Runs fn with a token; a 401 once (token revoked mid-hour) retries with a fresh token. */
  async function withToken<T>(fn: (t: string) => Promise<T>): Promise<T> {
    try { return await fn(await token()); } catch (e) {
      if (!(e instanceof StorageNeedsReauth) || !accessCache.has(c.id)) throw e;
      accessCache.delete(c.id);
      return fn(await token(true));
    }
  }

  const driveFolders = new Map<string, string>(); // "parent/name" → id, for this open storage only

  async function driveFolder(t: string, parts: string[]): Promise<string> {
    let parent = 'root';
    for (const name of parts) {
      const key = `${parent}/${name}`;
      let idHere = driveFolders.get(key);
      if (!idHere) { idHere = await driveFindOrCreateFolder(env.fetch, t, name, parent); driveFolders.set(key, idHere); }
      parent = idHere;
    }
    return parent;
  }

  return {
    provider, connectorId: c.id, name: c.name,
    async save(input) {
      if (input.bytes.length > MAX_FILE_BYTES) throw new Error(`${input.fileName} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
      const [client, title] = folderParts(input.clientName, input.requestTitle);
      const fileName = safeSegment(input.fileName, 'file');
      const saved = await withToken(async (t): Promise<SavedFile> => {
        if (provider === 'drive') {
          const folder = await driveFolder(t, [STORAGE_ROOT_FOLDER, client, title]);
          const f = await driveUpload(env.fetch, t, { name: fileName, parent: folder, bytes: input.bytes, mimeType: input.mimeType });
          return { provider, connectorId: c.id, name: fileName, url: f.url, folderUrl: `https://drive.google.com/drive/folders/${folder}`,
            path: `${STORAGE_ROOT_FOLDER}/${client}/${title}/${fileName}` };
        }
        const dir = `/${client}/${title}`;
        const f = await dropboxUpload(env.fetch, t, { path: `${dir}/${fileName}`, bytes: input.bytes });
        const folderUrl = dropboxWebUrl(appFolder, dir);
        // No per-file web link exists without a shared link (which needs approval): open the folder with the file previewed.
        return { provider, connectorId: c.id, name: f.name, url: `${folderUrl}?preview=${encodeURIComponent(f.name)}`, folderUrl,
          path: `Apps/${appFolder ?? STORAGE_ROOT_FOLDER}${f.path}` };
      });
      await env.store.mark(c.id, 'active', null, true).catch(() => undefined);
      return saved;
    },
    async check() {
      return accountOf(env.fetch, provider, await token(true));
    },
  };
}

/** Saves one file to the default storage. null = no storage connected. */
export async function saveFile(env: StorageEnv, input: SaveFileInput): Promise<SavedFile | null> {
  const s = await openStorage(env);
  return s ? s.save(input) : null;
}
