// DEMO data for /leads and /jobs (no Supabase env). Same fictional Lead Finder companies as the worker's mock RizeHub
// (apps/worker/src/rizehub/mockData.ts); dates are relative to "now" so the stats always look current.
import type { JobRow, LeadCard, LeadStage } from './rizehubView';

const H = 3_600_000;
const D = 24 * H;

// [id, company, domain, platform, country, city, industry, signal, score, fit, stage, angle, list, ageDays]
type L = [string, string, string, string, string, string, string, string, number, number | null, LeadStage, string | null, string | null, number];
const LEADS: L[] = [
  ['ld_1001', 'Saltbush Skin Co.', 'saltbushskin.com.au', 'shopify', 'Australia', 'Sydney', 'skincare DTC', 'LCP 6.2 s', 88, 86, 'drafted', 'Hero video + 14 apps push mobile LCP to 6.2 s; offer a 3-point speed audit before BFCM', '2026-10 skincare AU shopify', 2],
  ['ld_1002', 'Bondi Brew Supply', 'bondibrewsupply.com.au', 'shopify', 'Australia', 'Sydney', 'coffee equipment', 'LCP 5.4 s', 81, 78, 'contacted', 'Vintage Debut theme: OS 2.0 migration unlocks sections for bundles', '2026-10 coffee AU shopify', 6],
  ['ld_1003', 'Kinfolk Candle Studio', 'kinfolkcandles.com.au', 'shopify', 'Australia', 'Melbourne', 'home fragrance', 'Hiring a Shopify dev', 86, 91, 'won', 'Posted a Shopify dev role 5 days ago: offer a retainer instead of a hire', '2026-09 home AU shopify', 21],
  ['ld_1004', 'Coral Coast Swimwear', 'coralcoastswim.com.au', 'shopify', 'Australia', 'Gold Coast', 'swimwear', 'LCP 7.1 s', 79, 74, 'replied', 'Summer launch in 6 weeks; LCP 7.1 s on collection pages', '2026-10 fashion AU shopify', 9],
  ['ld_1005', 'Wattle & Wool', 'wattleandwool.com.au', 'shopify', 'Australia', 'Hobart', 'knitwear apparel', '17 broken links', 72, 63, 'researched', 'Size guide link 404s from every product page', null, 3],
  ['ld_1006', 'Mallee Botanicals', 'malleebotanicals.com.au', 'shopify', 'Australia', 'Adelaide', 'skincare DTC', 'LCP 5.9 s', 77, 80, 'drafted', 'No GA4 + slow mobile: speed + tracking fix package', '2026-10 skincare AU shopify', 2],
  ['ld_1007', 'Harbourside Pet Co.', 'harboursidepet.com.au', 'shopify', 'Australia', 'Perth', 'pet supplies', 'Hiring front-end dev', 74, null, 'new', null, null, 1],
  ['ld_1008', 'Paperbark Stationery', 'paperbarkpaper.com.au', 'shopify', 'Australia', 'Geelong', 'stationery gifts', 'Vintage theme', 64, 48, 'lost', 'Owner happy with current theme', null, 30],
  ['ld_2001', 'Ridgeline Outfitters', 'ridgelineoutfitters.com', 'shopify', 'United States', 'Denver', 'outdoor gear', 'LCP 6.8 s', 90, 88, 'proposal', 'Shopify Plus careers post + LCP 6.8 s: speed retainer, 3 options', '2026-09 outdoor US shopify', 14],
  ['ld_2002', 'Lumen & Lye Soapworks', 'lumenandlye.com', 'shopify', 'United States', 'Portland', 'skincare DTC', 'LCP 5.1 s', 76, 71, 'contacted', 'Subscription page loads 5.1 s on mobile', '2026-09 skincare US shopify', 8],
  ['ld_2003', 'Gulf Breeze Hot Sauce', 'gulfbreezehot.com', 'shopify', 'United States', 'Tampa', 'specialty food', 'No SSL on contact', 69, null, 'new', null, null, 0.3],
  ['ld_2004', 'Brickhouse Barbell', 'brickhousebarbell.com', 'shopify', 'United States', 'Austin', 'fitness equipment', 'Mobile score 27', 83, 82, 'researched', 'Mobile PageSpeed 27; product pages ship 4 MB of images', '2026-10 fitness US shopify', 1],
  ['ld_2005', 'Northwind Stoneware', 'northwindstoneware.com', 'wordpress', 'United States', 'Burlington', 'ceramics', 'LCP 5.7 s', 71, 66, 'researched', 'WooCommerce + 38 plugins; mixed-content warnings', null, 4],
  ['ld_2006', 'Cedar & Pine Dental', 'cedarpinedental.com', 'wordpress', 'United States', 'Spokane', 'dental clinic', 'LCP 6.0 s', 73, null, 'new', null, null, 0.5],
  ['ld_2007', 'Halcyon Family Law', 'halcyonfamilylaw.com', 'wordpress', 'United States', 'Atlanta', 'law firm', 'Form over http://', 67, 70, 'contacted', 'Intake form posts over http://: trust + compliance angle', null, 11],
  ['ld_2009', 'Orbitly Analytics', 'orbitly.io', 'webflow', 'United States', 'San Francisco', 'B2B SaaS', 'Hiring Webflow dev', 85, 89, 'replied', 'Contract Webflow role on Wellfound: offer a sprint instead', '2026-10 saas US webflow', 5],
  ['ld_2010', 'Fieldnote Labs', 'fieldnotelabs.com', 'webflow', 'United States', 'Brooklyn', 'B2B SaaS', 'Shared meta on CMS', 70, null, 'new', null, null, 0.2],
  ['ld_3001', 'Thistle & Thread', 'thistleandthread.co.uk', 'shopify', 'United Kingdom', 'Edinburgh', 'haberdashery', 'LCP 5.5 s', 78, 72, 'drafted', 'Venture (vintage) theme + 5.5 s LCP before Christmas', '2026-10 craft UK shopify', 2],
  ['ld_3002', 'Brixton Bean Roasters', 'brixtonbean.co.uk', 'shopify', 'United Kingdom', 'London', 'coffee roaster', 'Hiring Shopify dev', 84, 85, 'won', 'Freelance Shopify dev post on LinkedIn', '2026-09 coffee UK shopify', 25],
  ['ld_3003', 'Wren Architecture', 'wrenarchitecture.co.uk', 'webflow', 'United Kingdom', 'Bristol', 'architecture studio', 'LCP 6.6 s', 75, 69, 'contacted', 'Hero video makes LCP 6.6 s; poster frame + lazy video', null, 10],
  ['ld_4002', 'Maple Row Bakery', 'maplerowbakery.ca', 'wordpress', 'Canada', 'Toronto', 'bakery', 'LCP 7.4 s', 63, 52, 'lost', 'Budget too small this quarter', null, 27],
  ['ld_4003', 'Arcadia Studio Supply', 'arcadiastudiosupply.com', 'webflow', 'Canada', 'Vancouver', 'art supplies', 'Hiring Webflow help', 72, null, 'new', null, null, 1.5],
];

export function demoLeads(now = new Date()): LeadCard[] {
  const t = now.getTime();
  return LEADS.map(([id, company, domain, platform, country, city, industry, signal, score, fit, stage, angle, list, age]) => {
    const created = new Date(t - age * D).toISOString();
    const at = (d: number) => new Date(t - Math.max(0.1, age - d) * D).toISOString();
    const reached = ['contacted', 'replied', 'proposal', 'won'].includes(stage) || (stage === 'lost' && age > 20);
    return {
      id, company, website: `https://${domain}`, platform, country, city, industry, signal, signals: [signal], score, fitScore: fit, angle, stage,
      appUrl: `https://app.rizehub.ph/lead-finder/leads/${id}`, list, createdAt: created, updatedAt: at(1),
      contactedAt: reached ? at(2) : null, repliedAt: ['replied', 'proposal', 'won'].includes(stage) ? at(4) : null,
      proposalAt: ['proposal', 'won'].includes(stage) ? at(6) : null,
    };
  });
}

type J = Omit<JobRow, 'id' | 'created_at' | 'posted_at' | 'applied_at' | 'follow_up_at'> & { age: number; appliedAge?: number; followIn?: number };
const JOBS: J[] = [
  {
    source: 'weworkremotely', url: 'https://weworkremotely.com/remote-jobs/kestrel-goods-senior-shopify-developer', title: 'Senior Shopify Developer (Liquid, OS 2.0)',
    company: 'Kestrel Goods', platform_tags: ['shopify', 'frontend'], rate: '$45–60/hr', fit_score: 92, status: 'drafted', age: 1,
    fit_reasons: ['Pure Shopify Liquid + OS 2.0 sections work', 'Contract, fully remote; US hours overlap with Manila evenings', 'Clear scope: rebuild 6 theme sections + Core Web Vitals'],
    red_flags: [], notes: 'Screening: "Share one section you built with metafields." Required keyword in first line: KESTREL.',
    draft: 'KESTREL: your collection template loads the whole product grid before the hero image, which is why mobile LCP sits above 4 s. I would move the grid to a section with lazy media and preload the hero, then rebuild the 6 sections as OS 2.0 blocks so your team can edit them without code.\n\nRecent Shopify work (same stack):\n• [portfolio link 1: Shopify section build]\n• [portfolio link 2: Shopify speed work]\n• [portfolio link 3: metafield-driven collection banner]\n\nScreening answer: a collection banner section that reads a video URL from a collection metafield and falls back to the image.\n\nI am in Davao (UTC+8) and cover US mornings. Resume: [resume link]. Happy to do a free 3-point audit of your theme first.',
  },
  {
    source: 'onlinejobs', url: 'https://www.onlinejobs.ph/jobseekers/job/1184321', title: 'Shopify Theme Developer (full-time, long-term)', company: 'Harbor Home Co.',
    platform_tags: ['shopify'], rate: '$1,200/mo', fit_score: 86, status: 'applied', age: 6, appliedAge: 4, followIn: 1,
    fit_reasons: ['Long-term Shopify theme work, 40 h/week', 'Employer has 3 previous hires on OnlineJobs.ph', 'Scope matches OS 2.0 section builds'],
    red_flags: ['Asks for a 1-hour paid test (OK)'], notes: 'Applied with 1 apply point.',
    draft: 'Hi Harbor Home team, your product pages already have strong photos, but the add-to-cart sits below two app blocks on mobile, so shoppers scroll past it...\n\n[portfolio links: 3 Shopify builds]\n[resume link]',
  },
  {
    source: 'remotive', url: 'https://remotive.com/remote-jobs/software-dev/webflow-developer-northgate', title: 'Webflow Developer & Designer', company: 'Northgate Labs',
    platform_tags: ['webflow', 'figma'], rate: '$50/hr', fit_score: 84, status: 'shortlisted', age: 2,
    fit_reasons: ['Webflow CMS + interactions, Figma handoff', 'Ongoing marketing-site ownership'], red_flags: ['US only (check if contractors abroad are OK)'], notes: null, draft: null,
  },
  {
    source: 'indeed', url: 'https://www.indeed.com/viewjob?jk=7c1e9b2a44d0f3e1', title: 'WordPress Developer (Elementor, WooCommerce)', company: 'Harbor & Pine Studio',
    platform_tags: ['wordpress'], rate: '$30–40/hr', fit_score: 78, status: 'drafted', age: 3,
    fit_reasons: ['Maintain 12 client sites built with Elementor', 'Part-time, async'], red_flags: [], notes: 'Indeed: keep it 150–200 words.',
    draft: 'Hi Harbor & Pine, twelve Elementor sites usually means twelve slightly different plugin stacks. I would start with a shared update checklist and a staging copy per site, so updates stop breaking layouts...\n\n[portfolio links: 3 WordPress sites]\n[resume link]',
  },
  {
    source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/4012345678', title: 'Front-End Developer (React + Figma)', company: 'Tidepool',
    platform_tags: ['frontend', 'figma'], rate: '$60k–90k/yr', fit_score: 71, status: 'shortlisted', age: 7,
    fit_reasons: ['Figma-to-code UI work', 'Remote worldwide'], red_flags: ['Posted 7 days ago with 100+ applicants'], notes: null, draft: null,
  },
  {
    source: 'upwork', url: 'https://www.upwork.com/jobs/~01a2b3c4d5e6f7a8b9', title: 'Clone competitor landing page pixel-perfect in Shopify', company: null,
    platform_tags: ['shopify'], rate: '$150 fixed', fit_score: 34, status: 'skipped', age: 2,
    fit_reasons: ['Shopify page build'], red_flags: ['Asks to copy another brand\'s page pixel for pixel (copyright)', 'Budget far below scope'], notes: 'Skipped per job-filters.md.', draft: null,
  },
  {
    source: 'onlinejobs', url: 'https://www.onlinejobs.ph/jobseekers/job/1190877', title: 'Shopify + Klaviyo Developer (part-time)', company: 'Lumen Supply',
    platform_tags: ['shopify'], rate: '$8/hr', fit_score: 58, status: 'found', age: 1,
    fit_reasons: ['Shopify theme tweaks'], red_flags: ['Rate below floor', 'Also wants daily social posting (VA work)'], notes: null, draft: null,
  },
  {
    source: 'pasted', url: 'https://jobs.example.org/p/1234-webflow-cms-specialist', title: 'Webflow CMS Specialist', company: 'Fieldnote Labs',
    platform_tags: ['webflow'], rate: null, fit_score: 88, status: 'drafted', age: 0.5,
    fit_reasons: ['CMS-heavy Webflow build (blog + resources)', 'Link pasted by you'], red_flags: ['Requires a Loom intro (manual step)'], notes: 'Manual: record a 60-second Loom.',
    draft: 'Hi Fieldnote team, your blog posts all share one meta description, so Google shows the same snippet for every article. I would add a CMS field for it and a fallback built from the summary...\n\n[portfolio links: 3 Webflow CMS builds]\n[resume link]',
  },
  {
    source: 'seek', url: 'https://www.seek.com.au/job/78123456', title: 'Shopify Developer (contract, AEST hours)', company: 'Coral Coast Swimwear',
    platform_tags: ['shopify'], rate: 'A$70/hr', fit_score: 81, status: 'replied', age: 12, appliedAge: 10,
    fit_reasons: ['Summer launch sprint, 8 weeks', 'AEST is 2 h ahead of Manila'], red_flags: [], notes: 'They replied: call Thursday 10:00 AEST.', draft: 'Sent version kept in HQ.',
  },
  {
    source: 'himalayas', url: 'https://himalayas.app/companies/orbitly/jobs/webflow-engineer', title: 'Webflow Engineer', company: 'Orbitly Analytics',
    platform_tags: ['webflow', 'frontend'], rate: '$55–70/hr', fit_score: 90, status: 'applied', age: 9, appliedAge: 8, followIn: -1,
    fit_reasons: ['Webflow + custom code embeds', 'Contract with ongoing work'], red_flags: [], notes: null, draft: 'Applied version kept in HQ.',
  },
  {
    source: 'jobicy', url: 'https://jobicy.com/jobs/88231-wordpress-woocommerce-developer', title: 'WooCommerce Developer', company: 'Northwind Stoneware',
    platform_tags: ['wordpress'], rate: '$35/hr', fit_score: 66, status: 'found', age: 0.2,
    fit_reasons: ['WooCommerce store speed + plugin cleanup'], red_flags: ['Vague scope'], notes: null, draft: null,
  },
];

export function demoJobs(now = new Date()): JobRow[] {
  const t = now.getTime();
  return JOBS.map(({ age, appliedAge, followIn, ...j }, i) => ({
    ...j, id: `demo-job-${i + 1}`, created_at: new Date(t - age * D + 2 * H).toISOString(), posted_at: new Date(t - age * D).toISOString(),
    applied_at: appliedAge !== undefined ? new Date(t - appliedAge * D).toISOString() : null,
    follow_up_at: j.status === 'applied' && followIn !== undefined ? new Date(t + followIn * D).toISOString() : null,
  }));
}
