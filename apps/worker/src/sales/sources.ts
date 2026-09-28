// Where a lead (and its email address) may come from: public business sources only. LinkedIn is never scraped and
// bought / scraped contact-data brokers are never used. Mirrors sales_denied_host() in the migration (SQL enforces it too).

export const DENIED_HOSTS = [
  'linkedin.com', 'lnkd.in',
  'apollo.io', 'zoominfo.com', 'rocketreach.co', 'lusha.com', 'seamless.ai', 'contactout.com', 'signalhire.com',
  'hunter.io', 'snov.io', 'uplead.com', 'leadiq.com', 'kaspr.io', 'clearbit.com', 'salesintel.io', 'datanyze.com',
] as const;

export const LEAD_SOURCES = ['rizehub_lead_finder', 'business_website', 'public_directory', 'inbound', 'referral', 'ceo'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
/** Sources where the address was given to us (no published page needed). */
export const GIVEN_SOURCES: ReadonlySet<LeadSource> = new Set(['inbound', 'referral', 'ceo']);

export function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
}

/** null = allowed; otherwise why it is refused. */
export function deniedSource(url: string | null | undefined): string | null {
  if (!url) return null;
  const host = hostOf(url);
  if (!host) return 'not a valid http(s) URL';
  if (!/^https?:/i.test(url)) return 'only http(s) URLs';
  const hit = DENIED_HOSTS.find((d) => host === d || host.endsWith(`.${d}`));
  if (!hit) return null;
  return hit.startsWith('linkedin') || hit === 'lnkd.in'
    ? 'LinkedIn is never a lead source (no scraping; the CEO contacts people there himself)'
    : `${hit} is a contact-data broker: bought or scraped lists are never used`;
}

const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|icloud|me|aol|proton|protonmail|gmx|mail)\./i;
/** Personal-looking mailbox (free provider). Allowed only when the business publishes it (email_source_url). */
export const isFreeMailbox = (email: string) => FREE_MAIL.test(email);
