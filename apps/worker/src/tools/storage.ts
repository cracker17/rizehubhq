// save_file (docs/15 §6): an agent saves a file to the CEO's own storage (the default Google Drive or Dropbox connection)
// in RizeHub HQ/<client or Internal>/<request title>/, and gets the link back. Internal (the CEO's own storage): no
// approval. Private only: no public or shared link is ever made (that would be an external action needing approval).
// A workspace file is read race-safely from this task's jail only (dev/jail.ts + dev/safefs.ts).
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ToolFactory } from './types';
import type { ToolContext } from '../runner';
import { config, workerEnv } from '../config';
import { createServiceClient } from '../db';
import { errMsg, log } from '../deps';
import { loadKeyring } from '../vault/crypto';
import { createSupabaseConnectorStore } from '../connectors/store';
import { MAX_FILE_BYTES, mimeFor, openStorage, safeSegment, StorageUnavailable, type StorageEnv } from '../connectors/storage';
import { StorageNeedsReauth } from '../connectors/storageOAuth';
import { folderNamesFor } from '../connectors/storageDeliverable';
import { JailError, openJail, resolveIn } from '../dev/jail';
import { readInJailSized } from '../dev/safefs';

export const NO_STORAGE = 'No storage is connected. The CEO connects Google Drive or Dropbox in Admin → Connectors → Storage. '
  + 'Keep the file in your workspace, mention it in your output, and do not retry.';

export function createStorageTools(ctx: ToolContext, getEnv: () => StorageEnv, workspacesDir: string): ToolSet {
  const { task, deps } = ctx;
  return {
    save_file: tool({
      description: 'Save a file to the CEO\'s own storage (Google Drive or Dropbox, whichever is the default) in '
        + 'RizeHub HQ/<client or Internal>/<request title>/ and get its link. Give EITHER `content` (text you wrote, with a file_name '
        + 'like "blog-post.md") OR `path` (a file in your task workspace, e.g. "exports/hero.png"). The file stays private to the CEO: '
        + 'no public or shared link is made. Put the returned link in your output. QA-passed deliverables are also saved automatically.',
      inputSchema: z.object({
        file_name: z.string().max(200).optional().describe('Name to save as (required with content; default for path = its file name)'),
        content: z.string().max(2_000_000).optional().describe('Text content to save'),
        path: z.string().max(1000).optional().describe('Relative path of a file in your workspace'),
        mime_type: z.string().max(120).regex(/^[\w.+-]+\/[\w.+-]+$/).optional(),
      }),
      execute: async ({ file_name, content, path, mime_type }) => {
        if ((content === undefined) === (path === undefined)) return 'Give either `content` (with file_name) or `path`, not both.';
        if (content !== undefined && !file_name?.trim()) return 'Give a file_name (e.g. "brief.md") with the content.';
        let bytes: Buffer;
        let name: string;
        if (path !== undefined) {
          try {
            const jail = openJail(workspacesDir, task.id);
            const r = readInJailSized(jail, resolveIn(jail, path), MAX_FILE_BYTES + 1);
            if (r.size > MAX_FILE_BYTES) return `Refused: ${path} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`;
            bytes = r.data;
          } catch (e) {
            if (e instanceof JailError) return `Refused: ${e.message}`;
            return `Could not read ${path} in your workspace: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : errMsg(e)}.`;
          }
          name = file_name?.trim() || path.replace(/\\/g, '/').split('/').pop()!;
        } else {
          bytes = Buffer.from(content!, 'utf8');
          name = file_name!.trim();
        }
        name = safeSegment(name, 'file');
        try {
          const storage = await openStorage(getEnv());
          if (!storage) return NO_STORAGE;
          const names = await folderNamesFor(task, deps.db);
          const f = await storage.save({ ...names, fileName: name, bytes, mimeType: mime_type ?? mimeFor(name) });
          await deps.db.logActivity(task.agent_id, 'storage.saved', task.request_id, task.id, {
            provider: f.provider, connector: storage.name, files: [f.name], folder_url: f.folderUrl, bytes: bytes.length,
          }).catch(() => undefined);
          log(deps, `[${task.agent_id}] save_file ${f.provider} ${f.path} (${bytes.length} B)`);
          return `Saved to ${storage.name} (${f.provider === 'drive' ? 'Google Drive' : 'Dropbox'}): ${f.path}\nLink (private to the CEO): ${f.url}`;
        } catch (e) {
          log(deps, `[${task.agent_id}] save_file failed: ${errMsg(e)}`);
          await deps.db.logActivity(task.agent_id, 'storage.failed', task.request_id, task.id, { file: name, error: errMsg(e).slice(0, 300) }).catch(() => undefined);
          if (e instanceof StorageUnavailable) return `${e.message} Tell the CEO; keep the file in your workspace.`;
          if (e instanceof StorageNeedsReauth) return 'The storage sign-in expired or was revoked. The CEO must reconnect it in Admin → Connectors → Storage. Keep the file in your workspace and mention it in your output.';
          return `Saving failed: ${errMsg(e).slice(0, 300)}. Keep the file in your workspace and mention it in your output.`;
        }
      },
    }),
  };
}

let prodEnv: StorageEnv | null = null;
/** Production storage env: Supabase connector store, vault keyring, real fetch, task_record_storage. */
export function defaultStorageEnv(): StorageEnv {
  if (prodEnv) return prodEnv;
  const sb = createServiceClient();
  prodEnv = {
    store: createSupabaseConnectorStore(sb),
    keyring: loadKeyring(workerEnv()),
    fetch: (...a) => fetch(...a),
    recordTask: async (taskId, saved) => {
      const { error } = await sb.rpc('task_record_storage', { p_task: taskId, p_storage: saved });
      if (error) throw new Error(`task_record_storage: ${error.message}`);
    },
  };
  return prodEnv;
}

/** Tests inject `deps.storage` (fake store + fetch) and `deps.dev.workspacesDir`; production uses Supabase + the real APIs. */
export const storageTools: ToolFactory = (ctx) => {
  const d = ctx.deps as { storage?: StorageEnv | null; workspacesDir?: string; dev?: { workspacesDir?: string } };
  const dir = d.workspacesDir ?? d.dev?.workspacesDir ?? config.workspacesDir;
  return createStorageTools(ctx, () => d.storage ?? defaultStorageEnv(), dir);
};
