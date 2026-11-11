// Who may see what (HQ Brain P2, vault onboarding-and-access-plan.md §2). Pure functions + one loader, shared by every
// MCP tool. Deny by default: a person sees only granted projects (admins: every project), never the owner-only areas,
// and raw "-code-" transcripts only where the grant switches them on. The owner (CEO token) sees everything.
import type { Store } from './store/types';
import type { Caller } from './oauth/server';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export interface Grant { slug: string; access: 'read' | 'write'; transcripts: boolean }
export interface Access { role: Role; personId: string | null; email: string | null; name: string | null; grants: Map<string, Grant> }

export const OWNER: Access = { role: 'owner', personId: null, email: null, name: null, grants: new Map() };

/** Mirrors brain_owner_only() in 20261111020000_brain_people.sql. */
export function ownerOnly(path: string): boolean {
  return /^(profile|docs|scheduled-tasks|skills|claude-commands|devices|scripts)\//.test(path)
    || ['env-index.md', 'CLAUDE.md', 'projects.json', 'LOG.md', 'README.md'].includes(path)
    || /(^|\/)secrets-map\.md$/.test(path);
}

export const projectOfPath = (path: string): string | null => /^projects\/([a-z0-9][a-z0-9-]{0,63})\//.exec(path)?.[1] ?? null;
export const isTranscript = (path: string, kind?: string | null) => kind === 'transcript' || /-code-[0-9a-f]{6,}\.md$/.test(path);

export function canSeeProject(a: Access, slug: string | null): boolean {
  if (a.role === 'owner' || a.role === 'admin') return true;
  return !!slug && a.grants.has(slug);
}

export function canWriteProject(a: Access, slug: string | null): boolean {
  if (a.role === 'owner' || a.role === 'admin') return true;
  return !!slug && a.grants.get(slug)?.access === 'write';
}

/** One vault file for this caller. */
export function canSeePath(a: Access, path: string, kind?: string | null): boolean {
  if (a.role === 'owner') return true;
  if (ownerOnly(path)) return false;
  const slug = projectOfPath(path);
  if (!slug) return a.role === 'admin';
  if (!canSeeProject(a, slug)) return false;
  if (isTranscript(path, kind) && a.role !== 'admin' && !a.grants.get(slug)?.transcripts) return false;
  return true;
}

export const canCreateProjects = (a: Access) => a.role === 'owner' || a.role === 'admin';

/** Actor written on events and commits: the connector name for the owner, user:<email> for people. */
export function actorFor(a: Access, c: Pick<Caller, 'clientName'>): string {
  if (a.role !== 'owner' && a.email) return `user:${a.email}`.slice(0, 80);
  return `claude:${(c.clientName ?? 'connector').replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 40)}`;
}

/** CEO tokens → OWNER; person tokens → their live grants (null = the person was disabled meanwhile: refuse). */
export async function loadAccess(store: Store, caller: Pick<Caller, 'subject' | 'userId'>): Promise<Access | null> {
  if (caller.subject === 'ceo') return OWNER;
  if (caller.subject !== 'person' || !caller.userId) return null;
  const r = await store.rpc<null | { person_id: string; role: 'admin' | 'member' | 'viewer'; email: string; name: string; grants: Grant[] }>(
    'brain_person_access', { p_user: caller.userId });
  if (!r) return null;
  return { role: r.role, personId: r.person_id, email: r.email, name: r.name, grants: new Map((r.grants ?? []).map((g) => [g.slug, g])) };
}
