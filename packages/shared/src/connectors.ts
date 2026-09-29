// MCP connector catalog and the default tool permissions (docs/15 §1, §3). Shared by the worker (applies the rules when
// it lists a server's tools) and the dashboard (wizard cards, badges, what can't be loosened). Endpoints and auth methods
// were checked against each vendor's docs / live OAuth discovery on 2026-09-29.

export type McpAuth = 'oauth' | 'token' | 'own_app';
export type ToolPolicy = 'allow' | 'ask' | 'off';
export type ToolBadge = 'credits' | 'money' | 'contact';
/** Why a tool can't be switched to "Allowed" (docs/15 §3 locked rules). */
export type LockReason = 'money' | 'contact';

export interface CatalogEntry {
  key: string;
  name: string;
  /** What agents can do with it, one line for the card. */
  blurb: string;
  url: string;
  /** How the CEO connects: one-click sign-in, paste a token, or their own OAuth app then sign in. */
  auth: McpAuth[];
  /** Header for a pasted token and its prefix, e.g. Authorization: Bearer <token>. */
  tokenHeader?: { name: string; prefix: string; hint: string; docs: string };
  /** Setup steps for services that need the CEO's own OAuth app first. */
  ownAppSteps?: string[];
  /** Generation tools spend paid credits / tools can spend money (ads, payments). */
  credits?: boolean;
  money?: boolean;
  /** A URL option the wizard asks for (e.g. Supabase project ref). */
  urlParam?: { name: string; label: string; hint: string; pattern: string };
  suggestedAgents: string[];
  docs: string;
}

export const MCP_CALLBACK_PATH = '/api/connectors/callback';
export const MCP_CLIENT_METADATA_PATH = '/oauth/client-metadata.json';

export const MCP_CATALOG: readonly CatalogEntry[] = [
  { key: 'notion', name: 'Notion', blurb: 'Search, read and write pages and databases.', url: 'https://mcp.notion.com/mcp', auth: ['oauth'],
    suggestedAgents: ['coo', 'writer'], docs: 'https://developers.notion.com/docs/get-started-with-mcp' },
  { key: 'linear', name: 'Linear', blurb: 'Read and manage issues and projects.', url: 'https://mcp.linear.app/mcp', auth: ['oauth', 'token'],
    tokenHeader: { name: 'Authorization', prefix: 'Bearer ', hint: 'Linear → Settings → API → Personal API keys', docs: 'https://linear.app/docs/mcp' },
    suggestedAgents: ['coo', 'web-dev'], docs: 'https://linear.app/docs/mcp' },
  { key: 'supabase', name: 'Supabase', blurb: 'Query and inspect a Supabase project (read-only by default).',
    url: 'https://mcp.supabase.com/mcp?read_only=true', auth: ['oauth', 'token'],
    tokenHeader: { name: 'Authorization', prefix: 'Bearer ', hint: 'supabase.com → Account → Access Tokens', docs: 'https://supabase.com/docs/guides/getting-started/mcp' },
    urlParam: { name: 'project_ref', label: 'Project ref', hint: 'The 20-letter id in your project URL (optional: leave empty for all projects).', pattern: '^[a-z]{20}$' },
    suggestedAgents: ['web-dev'], docs: 'https://supabase.com/docs/guides/getting-started/mcp' },
  { key: 'magnific', name: 'Magnific', blurb: 'Generate and upscale images, video and audio.', url: 'https://mcp.magnific.com', auth: ['oauth'], credits: true,
    suggestedAgents: ['designer'], docs: 'https://docs.magnific.com/modelcontextprotocol' },
  { key: 'higgsfield', name: 'Higgsfield', blurb: 'Generate images and video.', url: 'https://mcp.higgsfield.ai/mcp', auth: ['oauth'], credits: true,
    suggestedAgents: ['designer'], docs: 'https://higgsfield.ai/cli' },
  { key: 'elevenlabs', name: 'ElevenLabs', blurb: 'Voices, text-to-speech and voice agents.', url: 'https://api.elevenlabs.io/v1/mcp', auth: ['oauth'], credits: true,
    suggestedAgents: ['designer', 'writer'], docs: 'https://elevenlabs.io/docs/eleven-agents/operate/hosted-mcp' },
  { key: 'github', name: 'GitHub', blurb: 'Repos, issues and pull requests (read-only token first).', url: 'https://api.githubcopilot.com/mcp/', auth: ['token'],
    tokenHeader: { name: 'Authorization', prefix: 'Bearer ', hint: 'github.com → Settings → Developer settings → Fine-grained personal access tokens', docs: 'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server' },
    suggestedAgents: ['web-dev'], docs: 'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server' },
  { key: 'hubspot', name: 'HubSpot', blurb: 'CRM contacts, companies and deals.', url: 'https://mcp.hubspot.com', auth: ['own_app'],
    ownAppSteps: ['In HubSpot: Development → Build → create an "MCP auth app".', 'Add the redirect URL shown below.', 'Copy its client ID and client secret here.'],
    suggestedAgents: ['sales'], docs: 'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server' },
  { key: 'meta-ads', name: 'Meta Ads', blurb: 'Facebook and Instagram ad campaigns. Can spend ad budget.', url: 'https://mcp.facebook.com/ads', auth: ['own_app'], money: true,
    ownAppSteps: ['At developers.facebook.com create an app and add the "Create & manage ads with ads MCP server" use case.', 'Add the redirect URL shown below.', 'Copy the App ID and App Secret here.'],
    suggestedAgents: ['sales'], docs: 'https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-get-started' },
  { key: 'dropbox', name: 'Dropbox', blurb: 'Browse, search, read and save files.', url: 'https://mcp.dropbox.com/mcp', auth: ['own_app'],
    ownAppSteps: ['At dropbox.com/developers/apps create an app (Scoped access).', 'Add the redirect URL shown below.', 'Copy the App key and App secret here.'],
    suggestedAgents: ['designer', 'coo'], docs: 'https://help.dropbox.com/integrations/connect-dropbox-mcp-server' },
];

export const catalogEntry = (key: string | null | undefined) => MCP_CATALOG.find((c) => c.key === key) ?? null;

export interface McpToolLike { name: string; description?: string | null; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | null }

const CONTACT = /(^|[_\W])(call|calls|phone|dial|sms|text_message|whatsapp|outbound)([_\W]|$)/i;
const GENERATE = /(generat|create_|upscal|train|synthes|speech|voice|video|image|audio|sound|clone|text_to|to_speech|render|edit_image)/i;

/**
 * Default permission for a tool the first time it is seen (docs/15 §3):
 * - contact tools (phone calls, SMS, WhatsApp) → Off and locked (never Allowed);
 * - money services (ads, payments): anything not marked read-only → Ask me, locked;
 * - credit services: generation tools → Ask me (they spend paid credits);
 * - readOnlyHint true (and not destructive) → Allowed; anything else → Ask me (a missing hint counts as "may write").
 */
export function defaultToolPolicy(tool: McpToolLike, entry: Pick<CatalogEntry, 'credits' | 'money'> | null):
  { policy: ToolPolicy; locked: LockReason | null; badges: ToolBadge[] } {
  const text = `${tool.name} ${tool.description ?? ''}`;
  const readOnly = tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
  if (CONTACT.test(tool.name) && !readOnly) return { policy: 'off', locked: 'contact', badges: ['contact'] };
  if (entry?.money && !readOnly) return { policy: 'ask', locked: 'money', badges: ['money'] };
  if (entry?.credits && GENERATE.test(text) && !readOnly) return { policy: 'ask', locked: null, badges: ['credits'] };
  return { policy: readOnly ? 'allow' : 'ask', locked: null, badges: [] };
}

/** Whether the CEO may set this policy on a tool with this lock. */
export function policyAllowed(policy: ToolPolicy, locked: LockReason | null | undefined): boolean {
  return !(locked && policy === 'allow');
}
