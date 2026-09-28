// QA evidence files: always written to the task workspace (workspaces/<task-id>/qa/…), then uploaded to the
// private Supabase Storage bucket `evidence` (created on first use with the service role). When storage is
// unavailable the local path is the reference.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

export const EVIDENCE_BUCKET = 'evidence';
const SIGNED_URL_SECONDS = 60 * 60 * 24 * 30;

export interface SavedEvidence {
  /** Absolute path on the worker. */
  localPath: string;
  /** Object path inside the bucket (null if not uploaded). */
  storagePath: string | null;
  /** Best reference for QA notes/dashboard: signed URL, else storage:evidence/<path>, else the local path. */
  ref: string;
  warning?: string;
}

export interface EvidenceStore {
  save(taskId: string, name: string, data: Buffer, contentType: string): Promise<SavedEvidence>;
}

export function safeName(s: string): string {
  return s.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'file';
}

export function evidenceStore(o: { workspacesDir: string; supabase: () => SupabaseClient | null }): EvidenceStore {
  let bucketReady: Promise<boolean> | null = null;
  const ensureBucket = (sb: SupabaseClient) => (bucketReady ??= (async () => {
    const got = await sb.storage.getBucket(EVIDENCE_BUCKET);
    if (!got.error) return true;
    const made = await sb.storage.createBucket(EVIDENCE_BUCKET, { public: false, fileSizeLimit: '20MB' });
    if (made.error && !/already exists|duplicate/i.test(made.error.message)) throw new Error(made.error.message);
    return true;
  })().catch((e) => { bucketReady = null; throw e; }));

  return {
    async save(taskId, name, data, contentType) {
      const rel = path.join(safeName(taskId), 'qa', name);
      const localPath = path.join(o.workspacesDir, rel);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, data);
      let sb: SupabaseClient | null = null;
      try { sb = o.supabase(); } catch { sb = null; }
      if (!sb) return { localPath, storagePath: null, ref: localPath, warning: 'storage not configured; kept locally' };
      const storagePath = `${safeName(taskId)}/${name}`;
      try {
        await ensureBucket(sb);
        const up = await sb.storage.from(EVIDENCE_BUCKET).upload(storagePath, data, { contentType, upsert: true });
        if (up.error) throw new Error(up.error.message);
        const signed = await sb.storage.from(EVIDENCE_BUCKET).createSignedUrl(storagePath, SIGNED_URL_SECONDS);
        const ref = signed.data?.signedUrl ?? `storage:${EVIDENCE_BUCKET}/${storagePath}`;
        return { localPath, storagePath, ref };
      } catch (e) {
        return { localPath, storagePath: null, ref: localPath, warning: `upload failed (${e instanceof Error ? e.message : String(e)}); kept locally` };
      }
    },
  };
}

/** Test/offline store: keeps files in memory, refs look like storage paths. */
export function memoryEvidenceStore(): EvidenceStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    async save(taskId, name, data) {
      const p = `${safeName(taskId)}/${name}`;
      files.set(p, data);
      return { localPath: `/mem/${p}`, storagePath: p, ref: `storage:${EVIDENCE_BUCKET}/${p}` };
    },
  };
}
