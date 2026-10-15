// The /operator setup wizard (docs/17-OPERATOR.md "Setup wizard"): pure helpers, shared by the page and tests.
// One client = one browser profile (its own container, logins and sessions), the sites it keeps logged in, the apps it
// watches, the API tokens it may use. The wizard writes the database part itself and prints the server part to paste.

/** "Madam Muse" → "madam-muse" (the client's short name = its browser profile). */
export function slugify(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

export const envName = (slug: string) => `OPERATOR_CDP_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

/** The viewer hostname: the first client keeps ws.rizehub.ph (phase 1), the others ws-<slug>.rizehub.ph. */
export const viewerHostFor = (slug: string) => (slug === 'lvlup' ? 'ws.rizehub.ph' : `ws-${slug}.rizehub.ph`);

/** Viewer ports: 3101 for the first client, then one per client in the order they were added. */
export function viewerPort(slug: string, allSlugs: readonly string[]): number {
  const i = allSlugs.indexOf(slug);
  return 3101 + (i >= 0 ? i : allSlugs.length);
}

/** What to paste on the server for this client's browser (deploy/workspace + the HQ .env + nginx). */
export function serverSetup(slug: string, port: number): { compose: string; env: string; nginx: string; commands: string } {
  const compose = [
    `  ws-${slug}:`,
    '    <<: *browser',
    `    container_name: ws-${slug}`,
    `    hostname: ws-${slug}`,
    '    volumes:',
    `      - ./profiles/${slug}:/config`,
    '      - ./init:/custom-cont-init.d:ro',
    `    ports: ["\${VIEWER_BIND:-127.0.0.1}:${port}:3001"]`,
    '    networks: [operator-ws]',
    '',
    `  cdp-${slug}:`,
    '    <<: *cdp',
    `    container_name: cdp-${slug}`,
    `    network_mode: "service:ws-${slug}"`,
    `    depends_on: [ws-${slug}]`,
  ].join('\n');
  const host = viewerHostFor(slug);
  return {
    compose,
    env: `${envName(slug)}=http://ws-${slug}:9223`,
    nginx: `server_name ${host} and proxy_pass https://127.0.0.1:${port} (its login snippet: /etc/nginx/snippets/ws-${slug}-auth.conf)`,
    commands: [
      `mkdir -p deploy/workspace/profiles/${slug}`,
      'docker compose -f deploy/workspace/docker-compose.yml --env-file deploy/workspace/.env up -d',
      'deploy/update.sh --force   # the operator picks up the new OPERATOR_CDP_ line',
      `sudo certbot --nginx -d ${host} --redirect -n`,
    ].join('\n'),
  };
}

/** Sites the operator checks stay logged in (operator_logins), with the page that needs a login. */
export const LOGIN_PRESETS: { site: string; label: string; url: string }[] = [
  { site: 'google', label: 'Google (Chat, Gmail)', url: 'https://chat.google.com/' },
  { site: 'slack', label: 'Slack', url: 'https://app.slack.com/client/' },
  { site: 'teams', label: 'Teams', url: 'https://teams.microsoft.com/v2/' },
  { site: 'webflow', label: 'Webflow', url: 'https://webflow.com/dashboard' },
  { site: 'airtable', label: 'Airtable', url: 'https://airtable.com/account' },
  { site: 'shopify', label: 'Shopify admin', url: 'https://admin.shopify.com/' },
  { site: 'github', label: 'GitHub', url: 'https://github.com/settings/profile' },
  { site: 'vercel', label: 'Vercel', url: 'https://vercel.com/dashboard' },
];

export interface SetupState {
  client: { slug: string; name: string; viewer_url: string | null; brain_project: string | null } | null;
  logins: { site: string; state: string; enabled: boolean }[];
  accounts: number;
  channels: number;
  whatsapp: boolean;
  webflowLinked: boolean;
  airtableLinked: boolean;
  githubLinked?: boolean;
  vercelLinked?: boolean;
  online: boolean;
}

export type StepKey = 'client' | 'browser' | 'logins' | 'apps' | 'apis' | 'check';
export const STEPS: { key: StepKey; label: string }[] = [
  { key: 'client', label: 'Client' }, { key: 'browser', label: 'Browser' }, { key: 'logins', label: 'Logins' },
  { key: 'apps', label: 'Apps to watch' }, { key: 'apis', label: 'APIs' }, { key: 'check', label: 'Ready?' },
];

/** The "Ready?" list: what is done, what is missing, and which step fixes it. Optional items never block. */
export function setupChecklist(s: SetupState): { label: string; done: boolean; step: StepKey; optional?: boolean }[] {
  const logins = s.logins.filter((l) => l.enabled);
  return [
    { label: 'Client saved', done: !!s.client, step: 'client' },
    { label: 'Linked to its project memory (HQ Brain)', done: !!s.client?.brain_project, step: 'client', optional: true },
    { label: 'Its browser is set up (you can see it on the Operator page)', done: !!s.client?.viewer_url, step: 'browser' },
    { label: 'The operator is running on the server', done: s.online, step: 'browser' },
    { label: 'Sites it should stay signed in to are chosen', done: logins.length > 0, step: 'logins' },
    { label: 'Signed in to all of them', done: logins.length > 0 && logins.every((l) => l.state === 'ok'), step: 'logins' },
    { label: 'Something to watch (an app for the unread sweep, a chat, or WhatsApp)', done: s.accounts + s.channels > 0 || s.whatsapp, step: 'apps' },
    { label: 'Webflow API token linked', done: s.webflowLinked, step: 'apis', optional: true },
    { label: 'Airtable API token linked', done: s.airtableLinked, step: 'apis', optional: true },
    { label: 'GitHub token linked', done: !!s.githubLinked, step: 'apis', optional: true },
    { label: 'Vercel token linked', done: !!s.vercelLinked, step: 'apis', optional: true },
  ];
}
