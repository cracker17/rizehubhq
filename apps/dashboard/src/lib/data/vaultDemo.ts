import 'server-only';
// DEMO Client Vault: realistic clients, credentials, grants, access logs and links, kept in server memory
// so every Clients / Access / Connections action works without a database. No secrets are stored at all:
// DEMO "reveal" returns an obviously fake placeholder.
import { createHash, randomBytes } from 'node:crypto';
import { demoSnapshot } from '@/lib/mock';
import type {
  AccessLinkState, AccessLinkView, AccessLogView, AgentTaskView, ClientDetail, ClientSummary, ConnectionsData, CredentialView,
  RosterAgent, VaultClient,
} from './vault';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
export const DEMO_TOKEN = 'demo-token';
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

interface DemoState {
  clients: VaultClient[];
  creds: CredentialView[];
  log: AccessLogView[];
  links: (AccessLinkView & { token_hash: string })[];
  logSeq: number;
}

function seed(now = Date.now()): DemoState {
  const iso = (ms: number) => new Date(now + ms).toISOString();
  const snap = demoSnapshot(new Date(now));
  const extra: Record<string, Partial<VaultClient>> = {
    'c-mm': { platforms: ['shopify', 'github'], website: 'https://madammuse.co', service_package: 'shopify-growth', notes: 'Contacts: founder + ops lead (emails in brain/clients/madam-muse). Lingerie & shapewear DTC.' },
    'c-vi': { platforms: ['wordpress', 'ga4'], website: 'https://www.vinylicons.com', service_package: 'seo-retainer', notes: 'Monthly SEO report on the 1st.' },
    'c-bc': { platforms: ['shopify'], website: 'https://brisbanecoffee.example', service_package: 'shopify-growth', notes: 'Onboarding this week.' },
    'c-io': { platforms: ['shopify', 'figma'], website: 'https://itsolivia.example', service_package: 'content-studio', notes: 'Reels + content calendar.' },
    'c-lv': { platforms: ['webflow'], website: 'https://lvlup.vc', service_package: 'webflow-care', notes: 'Ecosystem Initiatives CMS.' },
    'c-sb': { platforms: ['shopify'], website: 'https://sagebeet.example', service_package: 'social-ads', status: 'paused', notes: 'Paused until spring campaign.' },
    'c-mvs': { platforms: ['halaxy', 'other'], website: 'https://mvspsychology.com.au', service_package: 'automation', notes: 'Booking chatbot + Halaxy API.' },
  };
  const clients: VaultClient[] = snap.clients.map((c, i) => ({
    id: c.id, name: c.name, slug: c.slug, platforms: [], website: null, service_package: null, status: 'active', notes: null,
    rizehub_workspace_id: i % 2 ? `ws_${c.slug.replace(/-/g, '_')}` : null, created_at: iso(-(40 + i * 9) * DAY), ...extra[c.id],
  }));

  const cred = (id: string, client_id: string, o: Partial<CredentialView>): CredentialView => ({
    id, client_id, platform: 'shopify', label: '', login_url: null, username: null, secret_type: 'password', twofa_method: 'none',
    scope_notes: null, url_allowlist: [], status: 'active', expires_at: null, last_used_at: null, last_used_by: null,
    failed_login_count: 0, created_by: 'ceo', created_at: iso(-20 * DAY), grants: [], ...o,
  });
  const creds: CredentialView[] = [
    cred('cr-mm-login', 'c-mm', {
      label: 'Madam Muse · Shopify collaborator', login_url: 'https://madammuse.myshopify.com/admin', username: 'team@rizehub.ph',
      twofa_method: 'collaborator', scope_notes: 'Theme edits on UNPUBLISHED themes only. Never touch orders, customers or payments.',
      url_allowlist: ['https://madammuse.myshopify.com/admin/themes', 'https://madammuse.myshopify.com/admin/online_store'],
      last_used_at: iso(-2 * HOUR), last_used_by: 'shopify-dev', grants: ['qa-lead', 'shopify-dev'],
    }),
    cred('cr-mm-api', 'c-mm', {
      label: 'Madam Muse · Admin API (custom app)', secret_type: 'api_token', username: null,
      scope_notes: 'read_products, read_themes, write_themes. header: X-Shopify-Access-Token',
      url_allowlist: ['https://madammuse.myshopify.com/admin/api'], last_used_at: iso(-35 * 60_000), last_used_by: 'shopify-dev',
      grants: ['shopify-dev'],
    }),
    cred('cr-mm-gh', 'c-mm', {
      platform: 'github', label: 'Madam Muse · theme repo (fine-grained PAT)', secret_type: 'api_token',
      scope_notes: 'Contents + Pull requests on madammuse-theme only. Agents push to agent/<task-id> branches.',
      url_allowlist: ['https://api.github.com/repos/rizehub/madammuse-theme'], expires_at: iso(5 * DAY),
      last_used_at: iso(-26 * HOUR), last_used_by: 'shopify-dev', grants: ['fullstack-dev', 'shopify-dev'],
    }),
    cred('cr-vi-wp', 'c-vi', {
      platform: 'wordpress', label: 'Vinyl Icons · WordPress (app password)', secret_type: 'app_password',
      login_url: 'https://www.vinylicons.com/wp-login.php', username: 'rizehub-agent', status: 'check_needed', failed_login_count: 2,
      scope_notes: 'Editor role on staging first. Drafts only.', url_allowlist: ['https://www.vinylicons.com/wp-json/wp/v2'],
      last_used_at: iso(-3 * DAY), last_used_by: 'wordpress-dev', grants: ['seo-1', 'wordpress-dev'],
    }),
    cred('cr-vi-ga4', 'c-vi', {
      platform: 'ga4', label: 'Vinyl Icons · GA4 + Search Console (read)', secret_type: 'api_token',
      scope_notes: 'Read-only reporting.', url_allowlist: ['https://analyticsdata.googleapis.com/v1beta', 'https://searchconsole.googleapis.com'],
      last_used_at: iso(-20 * HOUR), last_used_by: 'ea', grants: ['ea', 'seo-1', 'seo-2'],
    }),
    cred('cr-lv-wf', 'c-lv', {
      platform: 'webflow', label: 'LvlUp · Webflow site token', secret_type: 'api_token',
      scope_notes: 'CMS read/write as drafts; pages read. Publishing needs approval.', url_allowlist: ['https://api.webflow.com/v2/sites', 'https://api.webflow.com/v2/collections'],
      expires_at: iso(80 * DAY), last_used_at: iso(-5 * HOUR), last_used_by: 'webflow-dev', grants: ['webflow-dev'],
    }),
    cred('cr-sb-shop', 'c-sb', {
      label: 'Sagebeet · Shopify staff login', login_url: 'https://sagebeet.myshopify.com/admin', username: 'ops@sagebeet.example',
      status: 'revoked', revoked_at: iso(-12 * DAY), scope_notes: 'Replaced by collaborator access.', last_used_at: iso(-30 * DAY), last_used_by: 'shopify-dev',
    }),
    cred('cr-mvs-halaxy', 'c-mvs', {
      platform: 'halaxy', label: 'MVS Psychology · Halaxy API', secret_type: 'api_token', created_by: 'client_link',
      scope_notes: 'Appointments read + create only. No clinical notes.', url_allowlist: ['https://api.halaxy.example/v1/appointments'],
      last_used_at: iso(-9 * HOUR), last_used_by: 'fullstack-dev', grants: ['fullstack-dev'], created_at: iso(-4 * DAY),
    }),
  ];

  let logSeq = 0;
  const log: AccessLogView[] = [];
  const L = (credential_id: string, agent_id: string | null, action: string, success: boolean, agoMs: number, detail: Record<string, unknown> = {}) =>
    log.push({ id: ++logSeq, credential_id, agent_id, action, success, detail, created_at: iso(-agoMs) });
  L('cr-mm-login', 'ceo', 'store', true, 20 * DAY);
  L('cr-mm-login', 'shopify-dev', 'login', true, 26 * HOUR, { host: 'madammuse.myshopify.com' });
  L('cr-mm-login', 'qa-lead', 'login', true, 22 * HOUR, { host: 'madammuse.myshopify.com' });
  L('cr-mm-login', 'shopify-dev', 'login', true, 2 * HOUR, { host: 'madammuse.myshopify.com' });
  L('cr-mm-api', 'shopify-dev', 'api_call', true, 3 * HOUR, { method: 'GET', host: 'madammuse.myshopify.com', path: '/admin/api/2025-07/themes.json', status: 200 });
  L('cr-mm-api', 'shopify-dev', 'api_call', true, 35 * 60_000, { method: 'PUT', host: 'madammuse.myshopify.com', path: '/admin/api/2025-07/themes/1402/assets.json', status: 200 });
  L('cr-mm-api', 'seo-1', 'denied', false, 5 * HOUR, { tool: 'vault_api', reason: 'not granted' });
  L('cr-mm-gh', 'shopify-dev', 'api_call', true, 26 * HOUR, { method: 'POST', host: 'api.github.com', path: '/repos/rizehub/madammuse-theme/pulls', status: 201 });
  L('cr-vi-wp', 'wordpress-dev', 'failed_login', false, 3 * DAY + HOUR, { host: 'www.vinylicons.com' });
  L('cr-vi-wp', 'wordpress-dev', 'failed_login', false, 3 * DAY, { host: 'www.vinylicons.com' });
  L('cr-vi-ga4', 'ea', 'api_call', true, 20 * HOUR, { method: 'POST', host: 'analyticsdata.googleapis.com', path: '/v1beta/properties/000:runReport', status: 200 });
  L('cr-lv-wf', 'webflow-dev', 'api_call', true, 5 * HOUR, { method: 'PATCH', host: 'api.webflow.com', path: '/v2/collections/…/items', status: 200 });
  L('cr-sb-shop', 'ceo', 'revoke', true, 12 * DAY, { reason: 'Replaced by collaborator access' });
  L('cr-mm-login', 'ceo', 'reveal', true, 6 * DAY, { via: 'dashboard' });
  L('cr-mvs-halaxy', 'client', 'store', true, 4 * DAY);
  L('cr-mvs-halaxy', 'fullstack-dev', 'api_call', true, 9 * HOUR, { method: 'GET', host: 'api.halaxy.example', path: '/v1/appointments', status: 200 });

  const links: DemoState['links'] = [
    { id: 'ar-bc', client_id: 'c-bc', platforms: ['shopify', 'github'], expires_at: iso(48 * HOUR), used_at: null, created_at: iso(-24 * HOUR),
      note: 'Please add team@rizehub.ph as a collaborator and paste the Admin API token of the custom app.', credential_id: null, cancelled_at: null, token_hash: hashToken(DEMO_TOKEN) },
    { id: 'ar-mvs', client_id: 'c-mvs', platforms: ['halaxy'], expires_at: iso(-2 * DAY), used_at: iso(-4 * DAY), created_at: iso(-5 * DAY),
      note: null, credential_id: 'cr-mvs-halaxy', cancelled_at: null, token_hash: hashToken('demo-used-token') },
    { id: 'ar-vi', client_id: 'c-vi', platforms: ['wordpress'], expires_at: iso(-6 * DAY), used_at: null, created_at: iso(-9 * DAY),
      note: null, credential_id: null, cancelled_at: null, token_hash: hashToken('demo-expired-token') },
  ];
  return { clients, creds, log, links, logSeq };
}

const g = globalThis as unknown as { __rizehubVaultDemo?: DemoState };
function state(): DemoState {
  return (g.__rizehubVaultDemo ??= seed());
}

function hashNum(s: string) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

export function demoVault() {
  const s = state();
  const log = (credential_id: string | null, agent_id: string, action: string, success = true, detail: Record<string, unknown> = {}) => {
    s.log.unshift({ id: ++s.logSeq, credential_id, agent_id, action, success, detail, created_at: new Date().toISOString() });
  };
  const snap = () => demoSnapshot();

  return {
    summaries(): ClientSummary[] {
      const sn = snap();
      const now = Date.now();
      return s.clients.map((c) => {
        const reqs = sn.requests.filter((r) => r.client_id === c.id);
        const creds = s.creds.filter((x) => x.client_id === c.id);
        return {
          ...c,
          openRequests: reqs.filter((r) => ['staged', 'planning', 'plan_review', 'in_progress', 'awaiting_ceo'].includes(r.status)).length,
          spendMonth: Math.round((reqs.reduce((t, r) => t + Number(r.cost_usd || 0), 0) + (hashNum(c.id) % 900) / 100) * 100) / 100,
          credentials: creds.filter((x) => x.status !== 'revoked').length,
          attention: creds.filter((x) => x.status === 'check_needed' || (x.status === 'active' && x.expires_at && new Date(x.expires_at).getTime() - now < 14 * DAY)).length,
          openLinks: s.links.filter((l) => l.client_id === c.id && !l.used_at && !l.cancelled_at && new Date(l.expires_at).getTime() > now).length,
        };
      });
    },
    detail(id: string): ClientDetail | null {
      const client = s.clients.find((c) => c.id === id);
      if (!client) return null;
      const credentials = s.creds.filter((c) => c.client_id === id);
      const ids = new Set(credentials.map((c) => c.id));
      return {
        client, credentials,
        log: s.log.filter((l) => l.credential_id && ids.has(l.credential_id)).sort((a, b) => b.created_at.localeCompare(a.created_at)),
        links: s.links.filter((l) => l.client_id === id).map(({ token_hash: _t, ...l }) => l),
        requests: snap().requests.filter((r) => r.client_id === id).map((r) => ({
          id: r.id, title: r.title, raw_text: r.raw_text, status: r.status, priority: r.priority, cost_usd: Number(r.cost_usd || 0),
          created_at: r.created_at, due_date: r.due_date,
        })),
      };
    },
    connections(): ConnectionsData {
      return {
        clients: s.clients.map((c) => ({ id: c.id, name: c.name, platforms: c.platforms, status: c.status })),
        credentials: s.creds.map((c) => {
          const cl = s.clients.find((x) => x.id === c.client_id);
          return { ...c, client_name: cl?.name ?? 'Unknown client', client_status: cl?.status ?? 'active' };
        }),
        systemKeys: [
          { label: 'RizeHub Agent API · leads', secret_ref: 'RIZEHUB_KEY_LEADS', platform: 'other', status: 'active', last_used_at: new Date(Date.now() - 40 * 60_000).toISOString() },
          { label: 'RizeHub Agent API · reports', secret_ref: 'RIZEHUB_KEY_REPORTS', platform: 'other', status: 'active', last_used_at: new Date(Date.now() - 3 * HOUR).toISOString() },
          { label: 'Figma (read-only)', secret_ref: 'FIGMA_TOKEN', platform: 'figma', status: 'expiring', last_used_at: new Date(Date.now() - 2 * DAY).toISOString() },
          { label: 'GitHub default', secret_ref: 'GITHUB_TOKEN_DEFAULT', platform: 'github', status: 'active', last_used_at: null },
        ],
      };
    },
    roster(): RosterAgent[] {
      const sn = snap();
      return sn.agents.map((a) => {
        const h = hashNum(a.id);
        const tasks = sn.tasks.filter((t) => t.agent_id === a.id);
        const reviews = a.id === 'coo' || a.id === 'qa-lead' ? 0 : 3 + (h % 9);
        return {
          id: a.id, name: a.name, department: a.department, model_role: a.id === 'coo' ? 'lead' : a.id === 'qa-lead' ? 'qa' : a.id === 'ea' ? 'reports' : a.department === 'dev' ? 'dev' : 'specialist',
          model_override: a.id === 'shopify-dev' ? 'anthropic:claude-sonnet-5' : null, status: a.status, enabled: a.enabled,
          color: a.avatar?.color ?? '#6D4AFF', daily_budget_usd: a.department === 'dev' ? 5 : 3,
          stats: {
            tasksToday: tasks.length + (h % 3), qaReviews: reviews, qaPass: reviews ? 70 + (h % 31) : null,
            costToday: Math.round(((h % 180) / 100 + tasks.reduce((t, x) => t + Number(x.cost_usd || 0), 0)) * 100) / 100,
          },
        };
      });
    },
    agentTasks(agentId: string): AgentTaskView[] {
      const sn = snap();
      const clientName = new Map(sn.clients.map((c) => [c.id, c.name]));
      return sn.tasks.filter((t) => t.agent_id === agentId).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 15)
        .map((t) => ({ id: t.id, title: t.title, status: t.status, work_type: t.work_type, created_at: t.created_at, completed_at: t.completed_at,
          cost_usd: Number(t.cost_usd || 0), client_name: t.client_id ? clientName.get(t.client_id) ?? null : null }));
    },
    linkState(token: string): AccessLinkState {
      const l = s.links.find((x) => x.token_hash === hashToken(token));
      if (!l) return { state: 'invalid' };
      const cl = s.clients.find((c) => c.id === l.client_id);
      const st = l.used_at ? 'used' : l.cancelled_at || cl?.status === 'archived' ? 'invalid' : new Date(l.expires_at).getTime() <= Date.now() ? 'expired' : 'open';
      return { state: st, client_name: cl?.name, platforms: l.platforms, expires_at: l.expires_at, note: l.note };
    },

    // ---- mutations (DEMO only; the LIVE path goes through RPCs / the worker) ----
    addCredential(i: Omit<CredentialView, 'id' | 'status' | 'last_used_at' | 'last_used_by' | 'failed_login_count' | 'created_at'>): string {
      const id = `cr-${randomBytes(4).toString('hex')}`;
      s.creds.push({ ...i, id, status: 'active', last_used_at: null, last_used_by: null, failed_login_count: 0, created_at: new Date().toISOString() });
      log(id, i.created_by === 'client_link' ? 'client' : 'ceo', 'store', true, { grants: i.grants });
      return id;
    },
    updateCredential(id: string, patch: Partial<CredentialView>) {
      const c = s.creds.find((x) => x.id === id);
      if (!c) throw new Error('credential not found');
      if (patch.grants && c.status === 'revoked' && patch.grants.length) throw new Error('credential is revoked');
      Object.assign(c, patch);
      log(id, 'ceo', patch.grants && Object.keys(patch).length === 1 ? 'grants' : 'edit', true);
    },
    rotate(id: string) {
      const c = s.creds.find((x) => x.id === id);
      if (!c) throw new Error('credential not found');
      if (c.status === 'revoked') throw new Error('credential is revoked; add a new one instead');
      Object.assign(c, { status: 'active', failed_login_count: 0 });
      log(id, 'ceo', 'rotate');
    },
    revoke(id: string, reason: string | null) {
      const c = s.creds.find((x) => x.id === id);
      if (!c || c.status === 'revoked') return;
      Object.assign(c, { status: 'revoked', grants: [], revoked_at: new Date().toISOString() });
      log(id, 'ceo', 'revoke', true, { reason });
    },
    reveal(id: string): { label: string; secret: string } {
      const c = s.creds.find((x) => x.id === id);
      if (!c) throw new Error('credential not found');
      log(id, 'ceo', 'reveal', true, { via: 'dashboard' });
      return { label: c.label, secret: `DEMO-${randomBytes(2).toString('hex').toUpperCase()}-not-a-real-secret` };
    },
    createLink(clientId: string, platforms: string[], note: string | null): { token: string; expires_at: string } {
      const cl = s.clients.find((c) => c.id === clientId);
      if (!cl) throw new Error('client not found');
      if (cl.status === 'archived') throw new Error('client is archived');
      const token = randomBytes(32).toString('base64url');
      const expires_at = new Date(Date.now() + 72 * HOUR).toISOString();
      s.links.unshift({ id: `ar-${randomBytes(4).toString('hex')}`, client_id: clientId, platforms, expires_at, used_at: null, created_at: new Date().toISOString(),
        note, credential_id: null, cancelled_at: null, token_hash: hashToken(token) });
      return { token, expires_at };
    },
    cancelLink(id: string) {
      const l = s.links.find((x) => x.id === id);
      if (l && !l.used_at) l.cancelled_at = new Date().toISOString();
    },
    redeem(token: string, i: { platform: string; label: string | null; loginUrl: string | null; username: string | null; secretType: CredentialView['secret_type']; twofaMethod: CredentialView['twofa_method']; notes: string | null }): boolean {
      const l = s.links.find((x) => x.token_hash === hashToken(token));
      if (!l || l.used_at || l.cancelled_at || new Date(l.expires_at).getTime() <= Date.now()) return false;
      if (!l.platforms.includes(i.platform) && !l.platforms.includes('other')) throw new Error('platform not requested');
      // The shared demo link stays reusable so the demo keeps working; real links are single use.
      if (token !== DEMO_TOKEN) l.used_at = new Date().toISOString();
      const id = this.addCredential({
        client_id: l.client_id, platform: i.platform, label: i.label || `${i.platform[0]!.toUpperCase()}${i.platform.slice(1)} access (from client)`,
        login_url: i.loginUrl, username: i.username, secret_type: i.secretType, twofa_method: i.twofaMethod, scope_notes: i.notes,
        url_allowlist: [], expires_at: null, created_by: 'client_link', grants: [],
      });
      if (token !== DEMO_TOKEN) l.credential_id = id;
      return true;
    },
    updateClient(id: string, patch: Partial<VaultClient>) {
      const c = s.clients.find((x) => x.id === id);
      if (!c) throw new Error('client not found');
      const archiving = patch.status === 'archived' && c.status !== 'archived';
      Object.assign(c, patch);
      if (archiving) {
        for (const cr of s.creds.filter((x) => x.client_id === id && x.grants.length)) {
          cr.grants = [];
          log(cr.id, 'system', 'revoke', true, { reason: 'client_archived' });
        }
        for (const l of s.links.filter((x) => x.client_id === id && !x.used_at)) l.cancelled_at ??= new Date().toISOString();
      }
    },
    addClient(i: { name: string; slug: string; website: string | null; platforms: string[]; service_package: string | null }): string {
      if (s.clients.some((c) => c.slug === i.slug)) throw new Error('That slug is taken.');
      const id = `c-${randomBytes(3).toString('hex')}`;
      s.clients.push({ id, ...i, status: 'active', notes: null, rizehub_workspace_id: null, created_at: new Date().toISOString() });
      return id;
    },
  };
}
