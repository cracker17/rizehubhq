// brain_write (Client Success only by role): create/update client knowledge files at
// brain/clients/<slug>/<name>.md. Nothing else in brain/ is writable by agents.
import fs from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import type { ToolFactory } from './types';
import { inheritOwner } from '../dev/agentUser';

export const BRAIN_WRITE_MAX_BYTES = 32 * 1024;
const REL = /^(?:brain\/)?clients\/([a-z0-9][a-z0-9-]{0,62})\/([a-z0-9][a-z0-9-]{0,62})\.md$/;

/** Returns the absolute target or throws; exported for tests. */
export function brainWriteTarget(brainRoot: string, rel: string): string {
  const m = REL.exec(rel.trim());
  if (!m) throw new Error('brain_write only accepts brain/clients/<client-slug>/<name>.md (lowercase, a-z0-9-)');
  const clientsDir = path.resolve(brainRoot, 'clients');
  const target = path.resolve(clientsDir, m[1]!, `${m[2]}.md`);
  if (!target.startsWith(clientsDir + path.sep)) throw new Error('path escapes brain/clients');
  const dir = path.dirname(target);
  if (fs.existsSync(dir) && fs.realpathSync(dir) !== dir) throw new Error('client folder must not be a symlink');
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('target must not be a symlink');
  return target;
}

export const brainWriteTools: ToolFactory = ({ task, deps }) => ({
  brain_write: tool({
    description: 'Create or update a client knowledge file: brain/clients/<client-slug>/<name>.md (e.g. profile.md, brand.md, access-checklist.md). '
      + 'Never put passwords, tokens or other secrets here: logins belong in the Client Vault.',
    inputSchema: z.object({
      path: z.string().describe('brain/clients/<client-slug>/<name>.md'),
      content: z.string().describe('Full markdown content (replaces the file)'),
    }),
    execute: async ({ path: rel, content }) => {
      try {
        if (Buffer.byteLength(content) > BRAIN_WRITE_MAX_BYTES) return `Error: content is over ${BRAIN_WRITE_MAX_BYTES / 1024} KB; keep client files concise.`;
        if (/(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*\S{6,}/i.test(content)) {
          return 'Error: this looks like it contains a secret. Put logins in the Client Vault (vault tools / access link), not in brain files.';
        }
        const target = brainWriteTarget(deps.brain.root, rel);
        const made = fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
        // The worker runs as root in its container; brain/ is a host bind mount owned by the deploy user.
        // New files/folders take brain/'s owner so `git pull` on the host (deploy/update.sh) never trips over root-owned files.
        inheritOwner([...new Set([made, path.dirname(target)].filter((x): x is string => !!x)), target], deps.brain.root);
        deps.log?.(`[${task.agent_id}] brain_write ${path.relative(deps.brain.root, target)}`);
        return `Saved brain/${path.relative(deps.brain.root, target).split(path.sep).join('/')}.`;
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    },
  }),
});
