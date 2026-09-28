import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { AGENT_RUNTIME, MODEL_ROLES } from '@rizehubhq/shared';
import { config } from './config';

export const RoleFrontMatter = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  department: z.string().min(1),
  model_role: z.enum(MODEL_ROLES),
  /** worker = AI SDK runner; hermes = the agent's Hermes Agent instance (hermes/runner.ts; falls back to the AI SDK runner). */
  runtime: z.enum(AGENT_RUNTIME),
  max_turns: z.number().int().positive().max(200),
  budget_usd_per_task: z.number().nonnegative(),
  tools: z.array(z.string()).min(1),
  work_types: z.array(z.string()).default([]),
});

export type Role = z.infer<typeof RoleFrontMatter> & { body: string };

/** Loads agents/<id>.md: front-matter becomes settings, the body becomes the system prompt. */
export function loadRole(id: string, dir = config.agentsDir): Role {
  const raw = fs.readFileSync(path.join(dir, `${id}.md`), 'utf8');
  const { data, content } = matter(raw);
  const fm = RoleFrontMatter.parse(data);
  if (fm.id !== id) throw new Error(`Role file ${id}.md has id "${fm.id}"`);
  return { ...fm, body: content.trim() };
}

export function listRoleIds(dir = config.agentsDir): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_')).map((f) => f.slice(0, -3)).sort();
}
