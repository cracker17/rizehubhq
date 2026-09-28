// Route → scope table for /agent-api/v1 (docs/12). One entry per endpoint in openapi.yaml.
// Keys carry scopes; a key with "*:read" may call every GET below.

export interface RouteScope { method: 'GET' | 'POST' | 'PUT' | 'PATCH'; pattern: string; scope: string; write: boolean }

export const ROUTES: RouteScope[] = [
  { method: 'POST', pattern: '/leads/search', scope: 'leads:search', write: true },
  { method: 'GET', pattern: '/jobs/{id}', scope: 'jobs:read', write: false },
  { method: 'GET', pattern: '/leads/{id}', scope: 'leads:read', write: false },
  { method: 'PATCH', pattern: '/leads/{id}', scope: 'leads:write_stage', write: true },
  { method: 'POST', pattern: '/leads/{id}/notes', scope: 'leads:write_notes', write: true },
  { method: 'POST', pattern: '/lists', scope: 'lists:write', write: true },
  { method: 'POST', pattern: '/lists/{id}/leads', scope: 'lists:write', write: true },
  { method: 'GET', pattern: '/accounts', scope: 'accounts:read', write: false },
  { method: 'POST', pattern: '/accounts', scope: 'accounts:create', write: true },
  { method: 'GET', pattern: '/accounts/{id}', scope: 'accounts:read', write: false },
  { method: 'POST', pattern: '/accounts/{id}/workspaces', scope: 'workspaces:create', write: true },
  { method: 'POST', pattern: '/accounts/{id}/invites', scope: 'invites:draft', write: true },
  { method: 'POST', pattern: '/invites/{id}/send', scope: 'invites:send', write: true },
  { method: 'GET', pattern: '/workspaces/{id}', scope: 'workspaces:read', write: false },
  { method: 'PUT', pattern: '/workspaces/{id}/config', scope: 'workspaces:configure', write: true },
  { method: 'POST', pattern: '/workspaces/{id}/projects', scope: 'workspaces:configure', write: true },
  { method: 'GET', pattern: '/workspaces/{id}/metrics', scope: 'metrics:read', write: false },
  { method: 'POST', pattern: '/workspaces/{id}/reports', scope: 'reports:generate', write: true },
  { method: 'GET', pattern: '/workspace-templates', scope: 'templates:read', write: false },
  { method: 'GET', pattern: '/reports/{id}', scope: 'reports:read', write: false },
  { method: 'POST', pattern: '/reports/{id}/notes', scope: 'reports:write_notes', write: true },
  { method: 'POST', pattern: '/reports/{id}/publish', scope: 'reports:publish', write: true },
];

/** Default scopes for the four HQ keys (create one key per group; never one master key). */
export const KEY_GROUP_SCOPES: Record<'LEADS' | 'ONBOARDING' | 'REPORTS' | 'READONLY', string[]> = {
  LEADS: ['leads:search', 'leads:read', 'leads:write_notes', 'leads:write_stage', 'lists:write', 'jobs:read'],
  ONBOARDING: ['accounts:create', 'accounts:read', 'workspaces:create', 'workspaces:configure', 'workspaces:read', 'invites:draft', 'invites:send', 'templates:read', 'jobs:read'],
  REPORTS: ['reports:generate', 'reports:read', 'reports:write_notes', 'reports:publish', 'metrics:read', 'workspaces:read', 'jobs:read'],
  READONLY: ['*:read'],
};

const compiled = ROUTES.map((r) => ({
  ...r,
  re: new RegExp(`^${r.pattern.replace(/\{[a-z_]+\}/g, '[A-Za-z0-9_\\-]+')}$`),
}));

/** Path relative to /agent-api/v1 (e.g. "/leads/ld_1"); returns null for unknown routes (answer 404). */
export function matchRoute(method: string, path: string): RouteScope | null {
  const p = path.replace(/\/+$/, '') || '/';
  const hit = compiled.find((r) => r.method === method.toUpperCase() && r.re.test(p));
  return hit ? { method: hit.method, pattern: hit.pattern, scope: hit.scope, write: hit.write } : null;
}

export function hasScope(scopes: string[], needed: string): boolean {
  if (scopes.includes(needed)) return true;
  return needed.endsWith(':read') && scopes.includes('*:read');
}
