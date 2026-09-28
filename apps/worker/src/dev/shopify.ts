// shopify_theme: Admin GraphQL API (themes, themeDuplicate, theme files). HARD guard: every write re-reads the
// theme's role right before writing and refuses anything that is not UNPUBLISHED/DEVELOPMENT (never MAIN).
// Publishing is not implemented at all: it is request_external_action.
import fs from 'node:fs';
import path from 'node:path';
import type { DevEnv } from './env';
import { apiError, httpRequest, truncate, type Redactor } from './http';
import { isSecretName, relOf, resolveIn, type Jail } from './jail';
import { externalAction, type Token } from './creds';

export const DEFAULT_API_VERSION = '2025-07';
const STORE_RE = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
const KEY_RE = /^(assets|blocks|config|layout|locales|sections|snippets|templates)\/[A-Za-z0-9._\-/@]+$/;
const WRITABLE_ROLES = new Set(['UNPUBLISHED', 'DEVELOPMENT']);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|pdf|zip)$/i;
const MAX_PUSH_BYTES = 20 * 1024 * 1024;

export class ShopifyRefusal extends Error {}
const refuse = (m: string): never => { throw new ShopifyRefusal(m); };

export function checkStore(store: string): string {
  const s = store.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!STORE_RE.test(s)) refuse(`store must be the <shop>.myshopify.com domain (got "${store}")`);
  return s;
}

export function checkKey(key: string): string {
  const k = key.trim().replace(/^\/+/, '');
  if (!KEY_RE.test(k) || k.split('/').includes('..') || k.split('/').includes('.')) {
    refuse(`"${key}" is not a theme file key (e.g. sections/hero.liquid, assets/app.css, templates/index.json)`);
  }
  return k;
}

export const themeGid = (id: string | number) => {
  const s = String(id).trim();
  const m = /^(?:gid:\/\/shopify\/OnlineStoreTheme\/)?(\d{1,20})$/.exec(s);
  if (!m) refuse(`theme_id must be a numeric theme id (got "${id}")`);
  return `gid://shopify/OnlineStoreTheme/${m![1]}`;
};
const numId = (gid: string) => gid.split('/').pop()!;

export interface ShopCtx { env: DevEnv; token: Token; store: string; red: Redactor; apiVersion: string }

export async function gql<T>(c: ShopCtx, query: string, variables: Record<string, unknown> = {}): Promise<{ data?: T; error?: string }> {
  const r = await httpRequest(c.env, {
    url: `https://${c.store}/admin/api/${c.apiVersion}/graphql.json`, method: 'POST',
    headers: { 'x-shopify-access-token': c.token.token, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }), retries: 3,
  });
  if (!r.ok) return { error: apiError('Shopify Admin API', r) };
  const j = r.json as { data?: T; errors?: { message: string }[] } | null;
  if (!j) return { error: `Shopify returned a non-JSON response: ${truncate(r.text, 500)}` };
  if (j.errors?.length) return { error: `Shopify GraphQL error: ${j.errors.map((e) => e.message).join('; ')}` };
  return { data: j.data };
}

interface ThemeNode { id: string; name: string; role: string; processing?: boolean; updatedAt?: string }

export async function listThemes(c: ShopCtx): Promise<string> {
  const r = await gql<{ themes: { nodes: ThemeNode[] } }>(c, 'query { themes(first: 50) { nodes { id name role processing updatedAt } } }');
  if (r.error) return r.error;
  const themes = r.data!.themes.nodes.map((t) => ({
    theme_id: numId(t.id), name: t.name, role: t.role, writable: WRITABLE_ROLES.has(t.role), processing: t.processing ?? false, updated_at: t.updatedAt,
  }));
  return JSON.stringify({ store: c.store, themes, note: 'Only UNPUBLISHED/DEVELOPMENT themes are writable. MAIN (live) is read-only for agents.' });
}

/** Fresh role lookup; used before every write. */
export async function themeRole(c: ShopCtx, id: string): Promise<{ theme?: ThemeNode; error?: string }> {
  const r = await gql<{ theme: ThemeNode | null }>(c, 'query($id: ID!) { theme(id: $id) { id name role processing } }', { id: themeGid(id) });
  if (r.error) return { error: r.error };
  if (!r.data!.theme) return { error: `Theme ${id} not found on ${c.store}.` };
  return { theme: r.data!.theme };
}

async function writableTheme(c: ShopCtx, id: string): Promise<ThemeNode> {
  const r = await themeRole(c, id);
  if (r.error) refuse(r.error);
  const t = r.theme!;
  if (t.role === 'MAIN') refuse(`Refused: theme ${numId(t.id)} "${t.name}" is the LIVE (main) theme. Agents never write to it. Work on an unpublished copy (op "duplicate_live").`);
  if (!WRITABLE_ROLES.has(t.role)) refuse(`Refused: theme ${numId(t.id)} has role ${t.role}; only UNPUBLISHED/DEVELOPMENT themes are writable.`);
  return t;
}

export async function duplicateLive(c: ShopCtx, name?: string): Promise<string> {
  const list = await gql<{ themes: { nodes: ThemeNode[] } }>(c, 'query { themes(first: 20, roles: [MAIN]) { nodes { id name role } } }');
  if (list.error) return list.error;
  const live = list.data!.themes.nodes[0];
  if (!live) return 'No live theme found.';
  const newName = (name?.trim() || `${live.name} (RizeHub ${new Date().toISOString().slice(0, 10)})`).slice(0, 50);
  const r = await gql<{ themeDuplicate: { newTheme: ThemeNode | null; userErrors: { message: string }[] } }>(c,
    'mutation($id: ID!, $name: String) { themeDuplicate(id: $id, name: $name) { newTheme { id name role processing } userErrors { field message } } }',
    { id: live.id, name: newName });
  if (r.error) return r.error;
  const p = r.data!.themeDuplicate;
  if (p.userErrors.length || !p.newTheme) return `Duplicate failed: ${p.userErrors.map((e) => e.message).join('; ') || 'no theme returned'}`;
  if (p.newTheme.role === 'MAIN') return 'Unexpected: the duplicate reports role MAIN. Stop and ask_ceo.';
  return JSON.stringify({ ok: true, theme_id: numId(p.newTheme.id), name: p.newTheme.name, role: p.newTheme.role, processing: p.newTheme.processing ?? false,
    source_theme_id: numId(live.id), preview_url: previewUrl(c.store, numId(p.newTheme.id)).preview_url,
    note: 'The copy is unpublished. If processing is true, wait a little before pulling files.' });
}

interface FileNode { filename: string; size?: number; checksumMd5?: string; body?: { content?: string; contentBase64?: string; url?: string } }
const FILE_FIELDS = 'filename size checksumMd5 body { ... on OnlineStoreThemeFileBodyText { content } ... on OnlineStoreThemeFileBodyBase64 { contentBase64 } ... on OnlineStoreThemeFileBodyUrl { url } }';

async function files(c: ShopCtx, id: string, filenames: string[] | null, withBody: boolean, max = 2000): Promise<{ files?: FileNode[]; error?: string }> {
  const out: FileNode[] = [];
  let after: string | null = null;
  const fields = withBody ? FILE_FIELDS : 'filename size checksumMd5';
  for (;;) {
    const r: { data?: { theme: { files: { nodes: FileNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null }; error?: string } = await gql(c,
      `query($id: ID!, $f: [String!], $after: String) { theme(id: $id) { files(first: ${withBody ? 50 : 250}, filenames: $f, after: $after) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } } }`,
      { id: themeGid(id), f: filenames, after });
    if (r.error) return { error: r.error };
    if (!r.data!.theme) return { error: `Theme ${id} not found.` };
    out.push(...r.data!.theme.files.nodes);
    const pi = r.data!.theme.files.pageInfo;
    if (!pi.hasNextPage || out.length >= max) break;
    after = pi.endCursor;
  }
  return { files: out.slice(0, max) };
}

export async function listFiles(c: ShopCtx, id: string, prefix?: string): Promise<string> {
  const pattern = prefix?.trim() ? [`${prefix.trim().replace(/\*+$/, '')}*`] : null;
  const r = await files(c, id, pattern, false);
  if (r.error) return r.error;
  return truncate(JSON.stringify({ theme_id: id, count: r.files!.length, files: r.files!.map((f) => `${f.filename} (${f.size ?? '?'} B)`) }), 12_000);
}

export async function getAsset(c: ShopCtx, id: string, keyIn: string): Promise<string> {
  const key = checkKey(keyIn);
  const r = await files(c, id, [key], true, 1);
  if (r.error) return r.error;
  const f = r.files![0];
  if (!f) return `${key} does not exist in theme ${id}.`;
  if (f.body?.content !== undefined) return truncate(`// ${key} (${f.size ?? f.body.content.length} B, md5 ${f.checksumMd5 ?? '?'})\n${f.body.content}`, 100_000);
  return `${key} is binary (${f.size ?? '?'} B)${f.body?.url ? `: ${f.body.url}` : ''}.`;
}

async function upsert(c: ShopCtx, id: string, list: { filename: string; body: { type: 'TEXT' | 'BASE64'; value: string } }[]) {
  const errors: string[] = [];
  const done: string[] = [];
  for (let i = 0; i < list.length; i += 50) {
    // Re-check the role before EVERY batch: a theme can be published between calls.
    await writableTheme(c, id);
    const batch = list.slice(i, i + 50);
    const r = await gql<{ themeFilesUpsert: { upsertedThemeFiles: { filename: string }[] | null; userErrors: { filename?: string; message: string }[] } }>(c,
      'mutation($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) { themeFilesUpsert(themeId: $themeId, files: $files) { upsertedThemeFiles { filename } userErrors { filename message } } }',
      { themeId: themeGid(id), files: batch });
    if (r.error) { errors.push(r.error); break; }
    done.push(...(r.data!.themeFilesUpsert.upsertedThemeFiles ?? []).map((f) => f.filename));
    errors.push(...r.data!.themeFilesUpsert.userErrors.map((e) => `${e.filename ?? ''}: ${e.message}`));
  }
  return { done, errors };
}

export async function putAsset(c: ShopCtx, jail: Jail, id: string, keyIn: string, value?: string, fromFile?: string): Promise<string> {
  const key = checkKey(keyIn);
  if ((value === undefined) === (fromFile === undefined)) refuse('put_asset needs exactly one of `value` or `from_file` (a workspace path)');
  let body: { type: 'TEXT' | 'BASE64'; value: string };
  if (fromFile !== undefined) {
    const abs = resolveIn(jail, fromFile);
    const buf = fs.readFileSync(abs);
    if (buf.length > MAX_PUSH_BYTES) refuse('file too large');
    body = BINARY_EXT.test(key) ? { type: 'BASE64', value: buf.toString('base64') } : { type: 'TEXT', value: buf.toString('utf8') };
  } else body = { type: 'TEXT', value: value! };
  const t = await writableTheme(c, id);
  const r = await upsert(c, id, [{ filename: key, body }]);
  if (r.errors.length) return `Upload of ${key} failed: ${r.errors.join('; ')}`;
  return `Saved ${key} to unpublished theme ${id} "${t.name}". Preview: ${previewUrl(c.store, id).preview_url}`;
}

export async function deleteAsset(c: ShopCtx, id: string, keyIn: string): Promise<string> {
  const key = checkKey(keyIn);
  if (/^(layout\/theme\.liquid|config\/settings_schema\.json|config\/settings_data\.json)$/.test(key)) refuse(`${key} is required by every theme; not deleting it.`);
  const t = await writableTheme(c, id);
  const r = await gql<{ themeFilesDelete: { deletedThemeFiles: { filename: string }[] | null; userErrors: { message: string }[] } }>(c,
    'mutation($themeId: ID!, $files: [String!]!) { themeFilesDelete(themeId: $themeId, files: $files) { deletedThemeFiles { filename } userErrors { field message } } }',
    { themeId: themeGid(id), files: [key] });
  if (r.error) return r.error;
  const p = r.data!.themeFilesDelete;
  if (p.userErrors.length) return `Delete failed: ${p.userErrors.map((e) => e.message).join('; ')}`;
  return `Deleted ${key} from unpublished theme ${id} "${t.name}".`;
}

/** Downloads theme files into a workspace folder (read-only on the store side; any theme incl. live). */
export async function pull(c: ShopCtx, jail: Jail, id: string, dir: string, only?: string[]): Promise<string> {
  const root = resolveIn(jail, dir, { noFinalSymlink: true });
  if (root === jail.root) refuse('pull into a subfolder (e.g. "theme"), not the workspace root');
  const pattern = only?.length ? only.map((k) => (k.endsWith('*') ? k : checkKey(k))) : null;
  const r = await files(c, id, pattern, true);
  if (r.error) return r.error;
  let n = 0; const skipped: string[] = [];
  for (const f of r.files!) {
    let key: string;
    try { key = checkKey(f.filename); } catch { skipped.push(f.filename); continue; }
    const abs = resolveIn(jail, `${relOf(jail, root)}/${key}`, { noFinalSymlink: true });
    let data: Buffer | null = null;
    if (f.body?.content !== undefined) data = Buffer.from(f.body.content, 'utf8');
    else if (f.body?.contentBase64 !== undefined) data = Buffer.from(f.body.contentBase64, 'base64');
    else if (f.body?.url && /^https:\/\/cdn\.shopify\.com\//.test(f.body.url)) {
      // Public CDN file (no token sent).
      const res = await c.env.fetch(f.body.url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) }).catch(() => null);
      if (res?.ok) data = Buffer.from(await res.arrayBuffer());
    }
    if (!data) { skipped.push(f.filename); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    n++;
  }
  return `Pulled ${n} file(s) from theme ${id} into ${relOf(jail, root)}/.${skipped.length ? ` Skipped ${skipped.length}: ${skipped.slice(0, 20).join(', ')}` : ''}`;
}

function walk(dir: string, base: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walk(abs, base, out);
    else if (e.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
}

/** Uploads files from a workspace folder to an UNPUBLISHED theme. settings_data.json only when listed explicitly. */
export async function push(c: ShopCtx, jail: Jail, id: string, dir: string, only?: string[]): Promise<string> {
  const root = resolveIn(jail, dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) refuse(`"${dir}" is not a folder in the workspace`);
  let keys: string[];
  if (only?.length) keys = only.map(checkKey);
  else {
    const all: string[] = [];
    walk(root, root, all);
    keys = all.filter((k) => KEY_RE.test(k) && k !== 'config/settings_data.json');
  }
  keys = keys.filter((k) => !k.split('/').some(isSecretName));
  if (!keys.length) return 'Nothing to push (no theme files found under that folder).';
  let total = 0;
  const list = keys.map((k) => {
    const abs = resolveIn(jail, `${relOf(jail, root)}/${k}`);
    const buf = fs.readFileSync(abs);
    total += buf.length;
    if (total > MAX_PUSH_BYTES) refuse(`push is larger than ${MAX_PUSH_BYTES / 1024 / 1024} MB; push fewer files (\`files\`)`);
    return { filename: k, body: BINARY_EXT.test(k) ? { type: 'BASE64' as const, value: buf.toString('base64') } : { type: 'TEXT' as const, value: buf.toString('utf8') } };
  });
  const t = await writableTheme(c, id);
  const r = await upsert(c, id, list);
  const note = only?.length ? '' : ' (config/settings_data.json is never pushed unless listed in `files`, to keep customizer edits)';
  return `Pushed ${r.done.length}/${list.length} file(s) to unpublished theme ${id} "${t.name}"${note}.`
    + `${r.errors.length ? `\nErrors: ${truncate(r.errors.join('\n'), 3000)}` : ''}\nPreview: ${previewUrl(c.store, id).preview_url}`;
}

export function previewUrl(store: string, id: string) {
  const handle = store.replace(/\.myshopify\.com$/, '');
  const n = numId(themeGid(id));
  return {
    preview_url: `https://${store}/?preview_theme_id=${n}`,
    customizer_url: `https://admin.shopify.com/store/${handle}/themes/${n}/editor`,
  };
}

export function publishRefused(store: string, id?: string): string {
  return externalAction('publish_theme', `Publish theme ${id ?? '<theme id>'} on ${store}`);
}
