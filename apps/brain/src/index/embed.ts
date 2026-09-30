// Embeddings (docs/16-BRAIN.md): OpenAI text-embedding-3-small by default (config/models.yaml `embeddings:`), 1536 dims
// to match brain_chunks.embedding. No key → no embedder → the index is keyword-only and /health says so.
import { createHash } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { embedMany } from 'ai';

export const DIMENSIONS = 1536;
export const BATCH = 96;

export interface Embedder {
  /** provider:model, stored in brain_sync_state.embed_model (a change re-embeds everything) */
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export function createEmbedder(spec: string, apiKey: string): Embedder | null {
  if (!apiKey) return null;
  const [provider, ...rest] = spec.split(':');
  const modelId = rest.join(':');
  if (provider !== 'openai' || !modelId) throw new Error(`Unsupported embeddings model "${spec}" (only openai:<model> is wired up)`);
  const openai = createOpenAI({ apiKey });
  return {
    model: spec,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const { embeddings } = await embedMany({
          model: openai.textEmbeddingModel(modelId), values: texts.slice(i, i + BATCH), maxRetries: 3,
          abortSignal: AbortSignal.timeout(60_000),
        });
        for (const e of embeddings) {
          if (e.length !== DIMENSIONS) throw new Error(`${spec} returned ${e.length} dimensions, the index expects ${DIMENSIONS}`);
          out.push(e);
        }
      }
      return out;
    },
  };
}

/** Deterministic stand-in for tests and local runs: bag of hashed words → unit vector (similar words ⇒ similar vectors). */
export function fakeEmbedder(model = 'fake:hash-1536'): Embedder {
  return {
    model,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array<number>(DIMENSIONS).fill(0);
        for (const w of t.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
          v[createHash('md5').update(w).digest().readUInt32BE(0) % DIMENSIONS] += 1;
        }
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
  };
}

/** pgvector text form */
export const toPgVector = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? Number(x.toFixed(7)) : 0)).join(',')}]`;
