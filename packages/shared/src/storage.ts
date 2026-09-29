// Storage connections (docs/15 §6): Google Drive and Dropbox through the CEO's own OAuth apps (plain APIs, no MCP).
// Shared by the worker (OAuth + uploads) and the dashboard (setup guide, callback routing).
// Vendor details checked 2026-09-29: developers.google.com/identity/protocols/oauth2/web-server,
// developers.google.com/workspace/drive/api/guides/api-specific-auth (drive.file = non-sensitive),
// docs.dropboxapi.com/dropbox-api/docs/oauth, github.com/dropbox/dropbox-api-spec (files.stone).

export type StorageProvider = 'drive' | 'dropbox';
export const STORAGE_PROVIDERS: readonly StorageProvider[] = ['drive', 'dropbox'];

/**
 * OAuth `state` of a storage sign-in starts with this, so the shared callback (/api/connectors/callback) can hand the
 * code to the storage finish route instead of the MCP one. MCP states never start with it (mcpClient.startSignIn).
 */
export const STORAGE_STATE_PREFIX = 'st_';
export const isStorageState = (state: string | null | undefined) => typeof state === 'string' && state.startsWith(STORAGE_STATE_PREFIX);

/** Top folder in Google Drive (Dropbox's app folder, /Apps/<app name>, already plays that role). */
export const STORAGE_ROOT_FOLDER = 'RizeHub HQ';
/** Folder for work that has no client. */
export const STORAGE_INTERNAL_FOLDER = 'Internal';

export interface StorageProviderInfo {
  key: StorageProvider;
  name: string;
  blurb: string;
  /** Where the CEO creates the OAuth app. */
  console: string;
  docs: string;
  /** One-time setup, shown in the connect dialog next to the redirect URL. */
  steps: string[];
  /** Where the CEO removes HQ's access later. */
  revoke: string;
}

export const STORAGE_INFO: Record<StorageProvider, StorageProviderInfo> = {
  drive: {
    key: 'drive', name: 'Google Drive',
    blurb: 'Saves into My Drive → RizeHub HQ. HQ can only see files it created (drive.file), nothing else in your Drive.',
    console: 'https://console.cloud.google.com/auth/clients',
    docs: 'https://developers.google.com/identity/protocols/oauth2/web-server',
    steps: [
      'Google Cloud Console: create (or pick) a project and enable the Google Drive API (APIs & Services → Library).',
      'Google Auth Platform → Branding: app name "RizeHub HQ" and your email. Audience: External. Data access: add only the scope …/auth/drive.file.',
      'Audience → Publish app ("In production"). drive.file is a non-sensitive scope, so no Google review is needed; in "Testing" Google expires the sign-in every 7 days.',
      'Clients → Create client → Web application. Authorized redirect URI: the URL below, exactly.',
      'Copy the client ID and client secret here, then sign in with the Google account that should own the files.',
    ],
    revoke: 'https://myaccount.google.com/connections',
  },
  dropbox: {
    key: 'dropbox', name: 'Dropbox',
    blurb: 'Saves into Dropbox → Apps → <your app name>. HQ can only see that app folder.',
    console: 'https://www.dropbox.com/developers/apps',
    docs: 'https://docs.dropboxapi.com/dropbox-api/docs/oauth',
    steps: [
      'Dropbox App Console → Create app → Scoped access → App folder. Name it e.g. "RizeHub HQ" (that becomes the folder name).',
      'Permissions tab: tick files.content.write (and files.content.read, files.metadata.read), then Submit.',
      'Settings tab → OAuth 2 → Redirect URIs: add the URL below, exactly.',
      'Copy the App key (client ID) and App secret here, then sign in.',
    ],
    revoke: 'https://www.dropbox.com/account/connected_apps',
  },
};

export const storageInfo = (p: string | null | undefined): StorageProviderInfo | null =>
  p === 'drive' || p === 'dropbox' ? STORAGE_INFO[p] : null;

/** What a QA-passed deliverable's automatic save records on the task output (`output.storage`). */
export interface SavedStorage {
  provider: StorageProvider;
  folder_url: string | null;
  files: { name: string; url: string }[];
  skipped?: string[];
  saved_at: string;
}
