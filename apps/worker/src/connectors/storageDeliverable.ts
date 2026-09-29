// Automatic save of a QA-passed deliverable (docs/15 §6) to the default storage: its text (summary, content, links) as
// a Markdown file plus the workspace files listed in output.files, into RizeHub HQ/<client or Internal>/<request title>/.
// Never fatal: no storage connected → nothing happens; a failed upload is logged ('storage.failed') and QA carries on.
import fs from 'node:fs';
import path from 'node:path';
import type { SavedStorage } from '@rizehubhq/shared';
import type { HqDb, TaskRow } from '../hqdb';
import { openJail, resolveIn, JailError } from '../dev/jail';
import { readInJailSized } from '../dev/safefs';
import { MAX_FILE_BYTES, mimeFor, openStorage, safeSegment, type StorageEnv } from './storage';

const MAX_FILES = 20;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;

/** Client name (or null = Internal) and request title for a task's storage folder. */
export async function folderNamesFor(task: Pick<TaskRow, 'client_id' | 'request_id' | 'title'>, db: Pick<HqDb, 'getClient' | 'getRequest'>):
  Promise<{ clientName: string | null; requestTitle: string }> {
  const [client, request] = await Promise.all([
    task.client_id ? db.getClient(task.client_id).catch(() => null) : Promise.resolve(null),
    db.getRequest(task.request_id).catch(() => null),
  ]);
  return { clientName: client?.name ?? null, requestTitle: request?.title?.trim() || task.title };
}

/** The deliverable's text as Markdown (null when the output has no text worth saving). */
export function deliverableMarkdown(task: Pick<TaskRow, 'title' | 'output'>): string | null {
  const o = (task.output ?? {}) as { summary?: unknown; content?: unknown; links?: unknown; preview_url?: unknown };
  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  const content = typeof o.content === 'string' ? o.content.trim() : '';
  const links = (Array.isArray(o.links) ? o.links : []).filter((l): l is string => typeof l === 'string' && l.trim() !== '');
  if (typeof o.preview_url === 'string' && o.preview_url && !links.includes(o.preview_url)) links.unshift(o.preview_url);
  if (!summary && !content && !links.length) return null;
  return [
    `# ${task.title}`,
    summary ? `${summary}` : '',
    content ? `---\n\n${content}` : '',
    links.length ? `## Links\n${links.map((l) => `- ${l}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n') + '\n';
}

/** Relative workspace paths among output.files (URLs and absolute paths are not files HQ can upload). */
export function workspaceFileList(output: Record<string, unknown> | null): string[] {
  const files = Array.isArray(output?.files) ? output!.files : [];
  return [...new Set(files.filter((f): f is string => typeof f === 'string')
    .map((f) => f.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter((f) => f && !/^[a-z][a-z0-9+.-]*:/i.test(f) && !f.startsWith('/') && !/^brain(\/|$)/.test(f)))].slice(0, MAX_FILES);
}

export interface AutoSaveResult { saved: SavedStorage | null; error?: string }

/**
 * Saves a QA-passed deliverable. Returns what was saved (null when no storage is connected or there was nothing to save).
 * The maker's task workspace is WORKSPACES_DIR/<task id>; nothing outside it is ever read.
 */
export async function autoSaveDeliverable(task: TaskRow, o: { db: HqDb; env: StorageEnv; workspacesDir: string; log?: (m: string) => void }): Promise<AutoSaveResult> {
  const { db, env } = o;
  let provider: string | null = null;
  try {
    const storage = await openStorage(env);
    if (!storage) return { saved: null };
    provider = storage.provider;
    const names = await folderNamesFor(task, db);
    const out: SavedStorage = { provider: storage.provider, folder_url: null, files: [], saved_at: new Date(env.now ? env.now() : Date.now()).toISOString() };
    const skipped: string[] = [];

    const md = deliverableMarkdown(task);
    if (md) {
      const f = await storage.save({ ...names, fileName: `${safeSegment(task.title, 'Deliverable')}.md`, bytes: Buffer.from(md, 'utf8'), mimeType: 'text/markdown' });
      out.files.push({ name: f.name, url: f.url });
      out.folder_url = f.folderUrl;
    }

    const rels = workspaceFileList(task.output);
    // Never create a workspace just to look in it (a task without one listed URLs or names, not files).
    if (rels.length && !fs.existsSync(path.join(o.workspacesDir, task.id))) skipped.push(...rels.map((r) => `${r} (no workspace)`));
    else if (rels.length) {
      let total = 0;
      const jail = openJail(o.workspacesDir, task.id);
      for (const rel of rels) {
        let data: Buffer;
        try {
          const abs = resolveIn(jail, rel);
          const r = readInJailSized(jail, abs, MAX_FILE_BYTES + 1);
          if (r.size > MAX_FILE_BYTES) { skipped.push(`${rel} (over ${MAX_FILE_BYTES / 1024 / 1024} MB)`); continue; }
          data = r.data;
        } catch (e) {
          skipped.push(`${rel} (${e instanceof JailError ? e.message : 'not found'})`);
          continue;
        }
        if (total + data.length > MAX_TOTAL_BYTES) { skipped.push(`${rel} (total size limit)`); continue; }
        total += data.length;
        const base = rel.split('/').pop()!;
        const f = await storage.save({ ...names, fileName: base, bytes: data, mimeType: mimeFor(base) });
        out.files.push({ name: f.name, url: f.url });
        out.folder_url ??= f.folderUrl;
      }
    }
    if (skipped.length) out.skipped = skipped.slice(0, 20);
    if (!out.files.length) return { saved: null };

    await env.recordTask?.(task.id, out).catch((e) => o.log?.(`[storage] recording links on ${task.id} failed: ${e instanceof Error ? e.message : String(e)}`));
    await db.logActivity(task.agent_id, 'storage.saved', task.request_id, task.id, {
      provider: out.provider, connector: storage.name, folder_url: out.folder_url, files: out.files.map((f) => f.name), skipped: out.skipped ?? [], auto: true,
    }).catch(() => undefined);
    o.log?.(`[storage] ${task.title}: ${out.files.length} file(s) saved to ${storage.name}`);
    return { saved: out };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    o.log?.(`[storage] auto-save of ${task.title} failed: ${error}`);
    await db.logActivity(task.agent_id, 'storage.failed', task.request_id, task.id, { provider, error, auto: true }).catch(() => undefined);
    return { saved: null, error };
  }
}
