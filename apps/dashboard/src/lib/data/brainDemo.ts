// DEMO-mode data for /brain (no Supabase): a small, plausible vault so the page renders and animates locally.
import type { BrainBundle, BrainConnection, BrainEvent, BrainHealth, BrainProject } from '@/lib/brainView';

const day = (n: number) => new Date(Date.now() - n * 86400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
const iso = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const P = (slug: string, name: string, aliases: string[], docs: number, last: number, status: string, steps = 2, sessions = 1): BrainProject => ({
  slug, name, aliases, status, listed: true, doc_count: docs, last_activity: day(last), sessions, open_next_steps: steps,
});

export const demoProjects: BrainProject[] = [
  P('hq-brain', 'HQ Brain', ['the brain', 'brain mcp'], 6, 0, '- M2 connector live; M3 UI in build', 3, 2),
  P('rizehub-hq', 'RizeHub HQ', ['hq', 'ai office'], 9, 1, '- Hermes live on OpenRouter', 4, 3),
  P('spicy-voyage', 'Spicy Voyage', ['spicy voyage shopify'], 4, 16, '- Horizon 4.1.5 theme built', 2),
  P('powerg-solar', 'PowerG Solar', ['powerg'], 3, 2, '- Live on Hostinger; mail off', 1),
  P('boardhub', 'BoardHub PH', ['boardhub'], 12, 5, '- Billing engine shipped', 5, 3),
  P('iponista', 'Iponista', ['budget app'], 5, 0, '- Household book next', 2, 2),
  P('azzurro', 'Azzurro Charters', ['azzurro'], 2, 60, '- Webflow blog hidden', 0),
  P('madam-muse', 'Madam Muse Horizon', ['madam muse'], 4, 20, '- Staging theme, never publish', 2),
];

export const demoHealth = (): BrainHealth => ({
  status: 'ok', error: null, head_sha: 'f8ac6d9', embed_model: 'openai:text-embedding-3-small',
  last_pull_at: iso(3), last_index_at: iso(3), last_webhook_at: iso(3), projects: demoProjects.length, documents: 81, chunks: 3071, embedded: 3071,
});

let nextId = 100;
export const demoEvents = (): BrainEvent[] => [
  { id: 9, ts: iso(2), actor: 'claude:Claude Code (hq-brain)', action: 'saved', project_slug: 'hq-brain', path: 'projects/hq-brain/sessions/LOG.md', summary: 'session saved: Built the connector' },
  { id: 8, ts: iso(3), actor: 'github:cracker17', action: 'pulled', project_slug: null, path: null, summary: '9fba090 → f8ac6d9' },
  { id: 7, ts: iso(40), actor: 'julev', action: 'connected', project_slug: null, path: null, summary: 'approved Claude Code (hq-brain) (brain:read, brain:write)' },
  { id: 6, ts: iso(90), actor: 'github:cracker17', action: 'doc_changed', project_slug: 'iponista', path: 'projects/iponista/memory.md', summary: '' },
  { id: 5, ts: iso(300), actor: 'brain-service', action: 'blocked_secret', project_slug: 'rizehub', path: 'projects/rizehub/sessions/2026-07-19-code-2c5624d0.md', summary: '' },
];

/** A fake live event for the demo animation (a save on a random project). */
export function demoPulse(projects: BrainProject[]): BrainEvent {
  const p = projects[Math.floor(Math.random() * projects.length)]!;
  const actors = ['claude:Claude', 'github:cracker17', 'julev', 'agent:coo'];
  return { id: nextId++, ts: new Date().toISOString(), actor: actors[Math.floor(Math.random() * actors.length)]!, action: 'saved', project_slug: p.slug, path: `projects/${p.slug}/memory.md`, summary: 'memory: 1 decision' };
}

export const demoConnections = (): BrainConnection[] => [
  { family_id: '00000000-0000-4000-8000-000000000001', client_id: 'hqbc_demo', client_name: 'Claude Code (hq-brain)', redirect_uris: ['http://localhost:33418/callback'], subject: 'ceo', scopes: ['brain:read', 'brain:write'], approved_at: iso(40), last_used_at: iso(2), expires_at: iso(-86400) },
];

export function demoBundle(slug: string): BrainBundle | null {
  const project = demoProjects.find((p) => p.slug === slug);
  if (!project) return null;
  const body = `---\nproject: ${slug}\nupdated: ${day(0)}\n---\n# ${project.name}\n\n## Overview\n- What it is: demo data (DEMO mode, no Supabase)\n\n## Status\n${project.status}\n\n## Decisions log\n- ${day(1)}: Markdown in git is the source of truth.\n\n## Open next steps\n- Build the Brain UI\n- [x] Ship the connector\n`;
  return {
    project,
    memory: { path: `projects/${slug}/memory.md`, title: project.name, doc_date: day(0), body },
    sessions: [{ path: `projects/${slug}/sessions/${day(1)}-demo.md`, title: 'Demo session', doc_date: day(1), body: `# Demo session\n## What we did\n- Looked around\n## Open next steps\n- Keep going` }],
    decisions: [{ decided_on: day(1), text: 'Markdown in git is the source of truth.' }],
    next_steps: [{ text: 'Build the Brain UI', done: false }, { text: 'Ship the connector', done: true }],
    documents: [{ path: `projects/${slug}/memory.md`, title: project.name, kind: 'memory', doc_date: day(0) }],
  };
}
