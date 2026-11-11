// HQ Brain P2 people + access (vault onboarding-and-access-plan.md §1–3). Pure helpers for the People screens; the
// rules themselves are enforced server-side (apps/brain/src/access.ts + SQL), this only shows them.
export type PersonRole = 'admin' | 'member' | 'viewer';
export type AccessLevel = 'none' | 'read' | 'write';
export interface PersonGrant { slug: string; access: 'read' | 'write'; transcripts: boolean; expires_at: string | null }
export interface BrainPerson {
  id: string; email: string; name: string; title: string | null; role: PersonRole;
  invited_at: string; invite_expires_at: string | null; joined_at: string | null; disabled_at: string | null;
  grants: PersonGrant[]; last_active_at: string | null; connections: number;
}

export const OWNER_ONLY_AREAS = ['Your profile', 'Guides (docs/)', 'Scheduled tasks', 'env-index (where secrets live)', 'Vault rules (CLAUDE.md)', 'Secrets maps', 'Device notes', 'The all-projects session log'];

export const ROLE_HELP: Record<PersonRole, string> = {
  admin: 'Sees every project (not your owner-only areas) and can create projects.',
  member: 'Sees the projects you switch on. Read or edit per project.',
  viewer: 'Sees the projects you switch on, read-only.',
};

export function personStatus(p: BrainPerson, now = Date.now()): { level: 'ok' | 'warn' | 'bad' | 'setup'; label: string } {
  if (p.disabled_at) return { level: 'bad', label: 'Disabled' };
  if (!p.joined_at) {
    if (p.invite_expires_at && Date.parse(p.invite_expires_at) < now) return { level: 'warn', label: 'Invite expired' };
    return { level: 'setup', label: 'Invited' };
  }
  return p.connections > 0 ? { level: 'ok', label: 'Connected' } : { level: 'setup', label: 'Joined' };
}

/** Grants as the editor's draft map (slug → level + options). */
export interface Draft { role: PersonRole; grants: Record<string, { access: 'read' | 'write'; transcripts: boolean; expires_at: string | null }> }
export const draftOf = (p: Pick<BrainPerson, 'role' | 'grants'>): Draft => ({
  role: p.role, grants: Object.fromEntries(p.grants.map((g) => [g.slug, { access: g.access, transcripts: g.transcripts, expires_at: g.expires_at }])),
});
export const levelOf = (d: Draft, slug: string): AccessLevel => d.grants[slug]?.access ?? 'none';

export function setLevel(d: Draft, slug: string, level: AccessLevel): Draft {
  const grants = { ...d.grants };
  if (level === 'none') delete grants[slug];
  else grants[slug] = { transcripts: grants[slug]?.transcripts ?? false, expires_at: grants[slug]?.expires_at ?? null, access: d.role === 'viewer' ? 'read' : level };
  return { ...d, grants };
}

export function setRole(d: Draft, role: PersonRole): Draft {
  if (role !== 'viewer') return { ...d, role };
  return { role, grants: Object.fromEntries(Object.entries(d.grants).map(([k, g]) => [k, { ...g, access: 'read' as const }])) };
}

export const grantsPayload = (d: Draft) => Object.entries(d.grants).map(([slug, g]) => ({ slug, access: g.access, transcripts: g.transcripts, expires_at: g.expires_at }));
export const sameDraft = (a: Draft, b: Draft) => JSON.stringify({ ...a, grants: Object.fromEntries(Object.entries(a.grants).sort()) }) === JSON.stringify({ ...b, grants: Object.fromEntries(Object.entries(b.grants).sort()) });

export const joinUrl = (code: string, origin = 'https://hq.rizehub.ph') => `${origin}/join/${code}`;
export function inviteMessage(name: string, url: string): string {
  return `Hi ${name.split(' ')[0]}, I gave you access to some projects in our HQ Brain. Open ${url} within 7 days to set your password and 2FA, then connect HQ Brain in Claude (Settings › Connectors). — Julev`;
}
