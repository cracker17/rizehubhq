// Seed data for the in-memory RizeHub mock: Lead Finder pool, workspace templates, existing client accounts.
// Companies are fictional; they only exist so the contract has realistic shapes to return.
import type { Platform, SignalKey, Template } from './contract';

type Sig = [SignalKey, string?, number?];
/** [id, company, domain, platform, industry, country, region, city, contact role, signals, score] */
type Row = [string, string, string, Platform, string, string, string, string, string, Sig[], number];

const ROWS: Row[] = [
  ['ld_1001', 'Saltbush Skin Co.', 'saltbushskin.com.au', 'shopify', 'skincare DTC', 'Australia', 'NSW', 'Sydney', 'Founder', [['slow_site', 'LCP 6.2 s', 6.2], ['low_mobile_score', 'Mobile score 31', 31]], 88],
  ['ld_1002', 'Bondi Brew Supply', 'bondibrewsupply.com.au', 'shopify', 'coffee equipment', 'Australia', 'NSW', 'Sydney', 'Owner', [['slow_site', 'LCP 5.4 s', 5.4], ['outdated_theme', 'Debut (vintage) theme']], 81],
  ['ld_1003', 'Kinfolk Candle Studio', 'kinfolkcandles.com.au', 'shopify', 'home fragrance', 'Australia', 'VIC', 'Melbourne', 'Co-founder', [['hiring_dev', 'Shopify developer role posted 5 days ago'], ['slow_site', 'LCP 4.8 s', 4.8]], 86],
  ['ld_1004', 'Coral Coast Swimwear', 'coralcoastswim.com.au', 'shopify', 'swimwear', 'Australia', 'QLD', 'Gold Coast', 'Marketing lead', [['slow_site', 'LCP 7.1 s', 7.1], ['missing_meta', '42% of pages without meta description']], 79],
  ['ld_1005', 'Wattle & Wool', 'wattleandwool.com.au', 'shopify', 'knitwear apparel', 'Australia', 'TAS', 'Hobart', 'Owner', [['broken_links', '17 broken links (incl. size guide)'], ['slow_site', 'LCP 4.1 s', 4.1]], 72],
  ['ld_1006', 'Mallee Botanicals', 'malleebotanicals.com.au', 'shopify', 'skincare DTC', 'Australia', 'SA', 'Adelaide', 'Founder', [['slow_site', 'LCP 5.9 s', 5.9], ['no_analytics', 'No GA4 tag found']], 77],
  ['ld_1007', 'Harbourside Pet Co.', 'harboursidepet.com.au', 'shopify', 'pet supplies', 'Australia', 'WA', 'Perth', 'E-commerce manager', [['hiring_dev', 'Front-end / Shopify contractor wanted'], ['low_mobile_score', 'Mobile score 38', 38]], 74],
  ['ld_1008', 'Paperbark Stationery', 'paperbarkpaper.com.au', 'shopify', 'stationery gifts', 'Australia', 'VIC', 'Geelong', 'Owner', [['outdated_theme', 'Brooklyn (vintage) theme'], ['missing_meta', '55% of pages without meta description']], 64],
  ['ld_2001', 'Ridgeline Outfitters', 'ridgelineoutfitters.com', 'shopify', 'outdoor gear', 'United States', 'CO', 'Denver', 'Head of e-commerce', [['slow_site', 'LCP 6.8 s', 6.8], ['hiring_dev', 'Shopify Plus developer listing on careers page']], 90],
  ['ld_2002', 'Lumen & Lye Soapworks', 'lumenandlye.com', 'shopify', 'skincare DTC', 'United States', 'OR', 'Portland', 'Founder', [['slow_site', 'LCP 5.1 s', 5.1], ['broken_links', '9 broken links']], 76],
  ['ld_2003', 'Gulf Breeze Hot Sauce', 'gulfbreezehot.com', 'shopify', 'specialty food', 'United States', 'FL', 'Tampa', 'Owner', [['no_ssl', 'Contact page served over http://'], ['slow_site', 'LCP 4.6 s', 4.6]], 69],
  ['ld_2004', 'Brickhouse Barbell', 'brickhousebarbell.com', 'shopify', 'fitness equipment', 'United States', 'TX', 'Austin', 'Operations', [['low_mobile_score', 'Mobile score 27', 27], ['outdated_theme', 'Supply (vintage) theme']], 83],
  ['ld_2005', 'Northwind Stoneware', 'northwindstoneware.com', 'wordpress', 'ceramics', 'United States', 'VT', 'Burlington', 'Studio manager', [['slow_site', 'LCP 5.7 s', 5.7], ['no_ssl', 'Mixed content warnings on shop pages']], 71],
  ['ld_2006', 'Cedar & Pine Dental', 'cedarpinedental.com', 'wordpress', 'dental clinic', 'United States', 'WA', 'Spokane', 'Practice manager', [['slow_site', 'LCP 6.0 s', 6.0], ['missing_meta', 'Duplicate titles on 12 service pages']], 73],
  ['ld_2007', 'Halcyon Family Law', 'halcyonfamilylaw.com', 'wordpress', 'law firm', 'United States', 'GA', 'Atlanta', 'Office manager', [['no_ssl', 'Intake form posts over http://'], ['broken_links', '11 broken links']], 67],
  ['ld_2008', 'Tidewater Landscaping', 'tidewaterlandscapes.com', 'wordpress', 'landscaping', 'United States', 'VA', 'Norfolk', 'Owner', [['low_mobile_score', 'Mobile score 33', 33], ['no_analytics', 'No analytics installed']], 62],
  ['ld_2009', 'Orbitly Analytics', 'orbitly.io', 'webflow', 'B2B SaaS', 'United States', 'CA', 'San Francisco', 'Head of marketing', [['hiring_dev', 'Webflow developer (contract) on Wellfound'], ['slow_site', 'LCP 3.9 s', 3.9]], 85],
  ['ld_2010', 'Fieldnote Labs', 'fieldnotelabs.com', 'webflow', 'B2B SaaS', 'United States', 'NY', 'Brooklyn', 'Founder', [['missing_meta', 'CMS blog posts share one meta description'], ['low_mobile_score', 'Mobile score 44', 44]], 70],
  ['ld_3001', 'Thistle & Thread', 'thistleandthread.co.uk', 'shopify', 'haberdashery', 'United Kingdom', 'Scotland', 'Edinburgh', 'Owner', [['slow_site', 'LCP 5.5 s', 5.5], ['outdated_theme', 'Venture (vintage) theme']], 78],
  ['ld_3002', 'Brixton Bean Roasters', 'brixtonbean.co.uk', 'shopify', 'coffee roaster', 'United Kingdom', 'England', 'London', 'Co-founder', [['hiring_dev', 'Freelance Shopify dev wanted (LinkedIn post)'], ['slow_site', 'LCP 4.4 s', 4.4]], 84],
  ['ld_3003', 'Wren Architecture', 'wrenarchitecture.co.uk', 'webflow', 'architecture studio', 'United Kingdom', 'England', 'Bristol', 'Studio director', [['slow_site', 'LCP 6.6 s (hero video)', 6.6], ['missing_meta', 'Project pages missing meta descriptions']], 75],
  ['ld_3004', 'Moorland Physio', 'moorlandphysio.co.uk', 'wordpress', 'physiotherapy clinic', 'United Kingdom', 'England', 'Leeds', 'Clinic lead', [['no_ssl', 'Booking page over http://'], ['low_mobile_score', 'Mobile score 36', 36]], 68],
  ['ld_4001', 'Kauri Coast Honey', 'kauricoasthoney.co.nz', 'shopify', 'specialty food', 'New Zealand', 'Northland', 'Whangarei', 'Owner', [['slow_site', 'LCP 5.0 s', 5.0], ['broken_links', '6 broken links']], 66],
  ['ld_4002', 'Maple Row Bakery', 'maplerowbakery.ca', 'wordpress', 'bakery', 'Canada', 'ON', 'Toronto', 'Owner', [['slow_site', 'LCP 7.4 s', 7.4], ['no_analytics', 'No analytics installed']], 63],
  ['ld_4003', 'Arcadia Studio Supply', 'arcadiastudiosupply.com', 'webflow', 'art supplies', 'Canada', 'BC', 'Vancouver', 'Founder', [['hiring_dev', 'Webflow + e-commerce help wanted'], ['low_mobile_score', 'Mobile score 41', 41]], 72],
];

const LABEL: Record<SignalKey, string> = {
  slow_site: 'Slow mobile LCP', no_ssl: 'No SSL on key pages', hiring_dev: 'Hiring a developer', outdated_theme: 'Outdated theme',
  broken_links: 'Broken links', missing_meta: 'Weak meta tags', low_mobile_score: 'Low mobile PageSpeed', no_analytics: 'No analytics',
};

export interface SeedLead {
  id: string; company: string; website: string; platform: Platform; industry: string;
  location: { country: string; region: string; city: string };
  contact: { role: string; email: string; source: string };
  signals: { key: SignalKey; label: string; value?: string; metric?: { name: string; value: number; unit: string } }[];
  score: number;
}

export const SEED_LEADS: SeedLead[] = ROWS.map(([id, company, domain, platform, industry, country, region, city, role, sigs, score]) => ({
  id, company, website: `https://${domain}`, platform, industry, location: { country, region, city },
  contact: { role, email: `hello@${domain}`, source: 'Published on the contact page' },
  signals: sigs.map(([key, value, num]) => ({
    key, label: LABEL[key], value,
    metric: key === 'slow_site' && num ? { name: 'LCP', value: num, unit: 's' } : key === 'low_mobile_score' && num ? { name: 'PageSpeed mobile', value: num, unit: 'score' } : undefined,
  })),
  score,
}));

export const COUNTRY_ALIASES: Record<string, string> = {
  au: 'australia', aus: 'australia', us: 'united states', usa: 'united states', 'u.s.': 'united states', america: 'united states',
  uk: 'united kingdom', gb: 'united kingdom', britain: 'united kingdom', england: 'united kingdom', nz: 'new zealand', ca: 'canada',
};

export const TEMPLATES: Template[] = [
  { id: 'shopify-growth', name: 'Shopify Growth', services: ['shopify-dev', 'cro', 'seo', 'reports'], projects: ['Baseline speed + CRO audit', 'Month 1 plan', 'Theme backup + staging theme'], report_type: 'seo-monthly' },
  { id: 'seo-retainer', name: 'SEO Retainer', services: ['seo', 'content', 'reports'], projects: ['Baseline SEO audit', 'Keyword map', 'Month 1 content plan'], report_type: 'seo-monthly' },
  { id: 'webflow-build', name: 'Webflow Build', services: ['webflow-dev', 'design', 'seo'], projects: ['Discovery + sitemap', 'Wireframes', 'Build', 'Launch checklist'], report_type: 'site-audit' },
  { id: 'wordpress-care', name: 'WordPress Care', services: ['wordpress-dev', 'maintenance', 'reports'], projects: ['Backup + staging setup', 'Plugin audit', 'Speed pass'], report_type: 'site-audit' },
  { id: 'ads-management', name: 'Ads Management', services: ['ads', 'design', 'reports'], projects: ['Account audit', 'Creative plan', 'Tracking check'], report_type: 'ads-performance' },
];

export const SERVICES = ['shopify-dev', 'webflow-dev', 'wordpress-dev', 'cro', 'seo', 'content', 'reports', 'design', 'ads', 'maintenance', 'social'];

export const SEED_ACCOUNTS = [
  { id: 'acc_madammuse', company: 'Madam Muse', domain: 'madammuse.co', plan: 'shopify-growth', country: 'US', time_zone: 'America/New_York',
    contact: { name: 'Jesse', email: 'hello@madammuse.co', role: 'Founder' },
    workspace: { id: 'ws_madammuse', template: 'shopify-growth', site: 'https://madammuse.co', platform: 'shopify' as Platform } },
  { id: 'acc_vinylicons', company: 'Vinyl Icons', domain: 'vinylicons.com', plan: 'seo-retainer', country: 'US', time_zone: 'America/Los_Angeles',
    contact: { name: 'Store team', email: 'hello@vinylicons.com', role: 'Owner' },
    workspace: { id: 'ws_vinylicons', template: 'seo-retainer', site: 'https://www.vinylicons.com', platform: 'shopify' as Platform } },
];
