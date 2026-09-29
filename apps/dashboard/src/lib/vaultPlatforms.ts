// Platforms, grant presets and form examples for the vault credential form (pure data, no React; tested in
// vaultPlatforms.test.ts). Two presets share one form: a client's logins (docs/06 §7a) and the agency's own tool
// logins (Admin → Tool logins, docs/06 §11). Platform slugs must pass vault_platform_ok() in SQL.

/** Same rule as vault_platform_ok() (supabase/migrations/20260928040000_client_vault.sql) and vault-actions.ts. */
export const PLATFORM_SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Client platforms (client profile chips, client credentials, the client's access link). */
export const PLATFORM_LABEL: Record<string, string> = {
  shopify: 'Shopify', webflow: 'Webflow', wordpress: 'WordPress', github: 'GitHub', figma: 'Figma', ga4: 'GA4 / GSC', gmail: 'Gmail',
  hosting: 'Hosting', ftp: 'FTP / SFTP', halaxy: 'Halaxy', other: 'Other',
};

/** The agency's own tools (Admin → Tool logins). */
export const TOOL_PLATFORM_LABEL: Record<string, string> = {
  semrush: 'Semrush', ahrefs: 'Ahrefs', canva: 'Canva', figma: 'Figma', 'shopify-partner': 'Shopify Partner', github: 'GitHub',
  hosting: 'Hosting', google: 'Google (Ads / Analytics)', meta: 'Meta Business', ai: 'AI tool', other: 'Other',
};

/** Display name for any stored platform slug (client or tool), falling back to the slug itself. */
export function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform] ?? TOOL_PLATFORM_LABEL[platform] ?? platform;
}

/** Suggested agents per platform for new client credentials (least privilege; the CEO can change it). */
export const SUGGESTED_GRANTS: Record<string, string[]> = {
  shopify: ['web-dev', 'qa-lead'], webflow: ['web-dev', 'qa-lead'], wordpress: ['web-dev', 'qa-lead'],
  github: ['web-dev'], figma: ['designer'], ga4: ['coo', 'writer'], gmail: ['coo'], hosting: ['web-dev'],
  ftp: ['web-dev'], halaxy: ['web-dev'], other: [],
};

/** What the shared credential form offers: platforms, grant presets and example text. */
export interface CredentialPreset {
  platforms: Record<string, string>;
  suggestedGrants: Record<string, string[]>;
  placeholder: { label: string; loginUrl: string; username: string; scope: string; allow: string; writes: string };
  /** Hint under the password field. */
  passwordHint: string;
}

export const CLIENT_PRESET: CredentialPreset = {
  platforms: PLATFORM_LABEL,
  suggestedGrants: SUGGESTED_GRANTS,
  placeholder: {
    label: 'e.g. Madam Muse · Shopify collaborator', loginUrl: 'https://store.myshopify.com/admin', username: 'team@rizehub.ph',
    scope: 'Theme edits on unpublished themes only. Never touch orders or payments. For API tokens: header: X-Shopify-Access-Token',
    allow: 'https://store.myshopify.com/admin/themes\nhttps://store.myshopify.com/admin/api',
    writes: 'PUT /admin/api/2025-07/themes/123/assets.json\nPOST /wp-json/wp/v2/posts',
  },
  passwordHint: 'Prefer a collaborator / staff account made for RizeHub, never the client\'s own login.',
};

export const TOOL_PRESET: CredentialPreset = {
  platforms: TOOL_PLATFORM_LABEL,
  suggestedGrants: {
    semrush: ['writer'], ahrefs: ['writer'], canva: ['designer'], figma: ['designer'], 'shopify-partner': ['web-dev'], github: ['web-dev'],
    hosting: ['web-dev'], google: ['coo', 'writer'], meta: [], ai: [], other: [],
  },
  placeholder: {
    label: 'e.g. Semrush · agency seat', loginUrl: 'https://www.semrush.com/login/', username: 'seo@rizehub.ph',
    scope: 'Keyword and competitor research only. Never change billing, users or the plan. For API keys: header: X-Api-Key',
    allow: 'https://www.semrush.com/analytics\nhttps://api.semrush.com/',
    writes: 'POST /v1/projects',
  },
  passwordHint: 'Use a team seat or a login made for RizeHub\'s agents, not your personal account.',
};
