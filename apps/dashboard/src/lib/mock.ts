// DEMO data: used when Supabase env vars are not set. Shaped exactly like the database rows
// (src/lib/data/types.ts) so every screen runs the same code in DEMO and LIVE mode.
import type {
  ActivityRow, AgentRow, AgentScreenRow, ApprovalRow, ClientRow, HqSnapshot, QaReviewRow, RequestRow, TaskRow,
} from './data/types';
import type { AgentStatus, IdleActivity, TaskStatus } from '@rizehubhq/shared';

const CLIENTS: ClientRow[] = [
  { id: 'c-mm', name: 'Madam Muse', slug: 'madam-muse' },
  { id: 'c-vi', name: 'Vinyl Icons', slug: 'vinyl-icons' },
  { id: 'c-bc', name: 'Brisbane Coffee Co', slug: 'brisbane-coffee' },
  { id: 'c-io', name: 'IO', slug: 'io' },
  { id: 'c-lv', name: 'LvlUp Ventures', slug: 'lvlup' },
  { id: 'c-sb', name: 'Sagebeet', slug: 'sagebeet' },
  { id: 'c-mvs', name: 'MVS Psychology', slug: 'mvs-psychology' },
];

// [id, name, department, model_role, color, status, idle]: the six agents in agents/roster.yaml
const ROSTER: [string, string, string, string, string, AgentStatus, IdleActivity?][] = [
  ['coo', 'COO', 'leadership', 'lead', '#6D4AFF', 'working'],
  ['web-dev', 'Web Developer', 'dev', 'dev', '#5FBF4A', 'working'],
  ['designer', 'Graphic Designer', 'design', 'design', '#A259FF', 'working'],
  ['writer', 'Content Writer', 'content', 'writer', '#22C55E', 'working'],
  ['sales', 'Sales Agent', 'growth', 'sales', '#FFB020', 'idle', 'coffee'],
  ['qa-lead', 'QA', 'qa', 'qa', '#14B8A6', 'working'],
];

export function demoSnapshot(now = new Date()): HqSnapshot {
  const at = (h: number, m = 0) => { const d = new Date(now); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const daysAgo = (d: number, h = 10) => { const x = new Date(now); x.setDate(x.getDate() - d); x.setHours(h, 0, 0, 0); return x.toISOString(); };
  const dateIn = (d: number) => { const x = new Date(now); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };

  const req = (id: string, title: string | null, raw: string, status: RequestRow['status'], client: string | null,
    o: Partial<RequestRow> = {}): RequestRow => ({
    id, title, raw_text: raw, status, client_id: client, source: 'telegram', brief: null, priority: 'normal',
    due_date: null, cost_usd: 0, created_at: ago(300), updated_at: ago(20), ...o,
  });
  const requests: RequestRow[] = [
    req('r-mm-bundle', 'Madam Muse bundle launch', 'Madam Muse needs a bundle landing page with SEO copy and 3 ad graphics, due Friday', 'plan_review', 'c-mm', { priority: 'high', due_date: dateIn(3), source: 'dashboard', created_at: at(8, 30) }),
    req('r-sb-plan', null, 'Sagebeet spring campaign: 6 social posts + 2 ads', 'planning', 'c-sb', { created_at: ago(12) }),
    req('r-vi-report', 'Vinyl Icons September report', 'Monthly SEO report for Vinyl Icons', 'in_progress', 'c-vi', { source: 'schedule', due_date: dateIn(1), created_at: daysAgo(1) }),
    req('r-bc-onboard', 'Onboard Brisbane Coffee Co', 'Onboard Brisbane Coffee Co on the shopify-growth package', 'in_progress', 'c-bc', { created_at: daysAgo(1, 15) }),
    req('r-leads', 'AU Shopify lead list', 'Find 30 Australian Shopify stores with slow LCP', 'in_progress', null, { created_at: at(9, 40) }),
    req('r-jobs', 'Shopify dev job shortlist', 'Shortlist remote Shopify dev jobs this week', 'in_progress', null, { priority: 'low', source: 'schedule', created_at: at(7) }),
    req('r-io-reel', 'Collagen Jelly reel script', '28s reel script + cover graphic for the Collagen Jelly launch', 'in_progress', 'c-io', { due_date: dateIn(1), created_at: daysAgo(2) }),
    req('r-mm-copy', 'Madam Muse landing copy', 'Landing copy + meta for the bundle page', 'in_progress', 'c-mm', { created_at: at(8, 45), cost_usd: 0.04 }),
    req('r-blog', 'Blog: Shopify speed checklist', 'Write a blog post about Shopify speed for Madam Muse', 'in_progress', 'c-mm', { created_at: at(10) }),
    req('r-lvlup', 'LvlUp Ecosystem CMS page', 'Build the Ecosystem Initiatives CMS page on Webflow', 'in_progress', 'c-lv', { priority: 'high', created_at: daysAgo(1, 11) }),
    req('r-halaxy', 'Halaxy booking API integration', 'Connect the booking chatbot to Halaxy', 'in_progress', 'c-mvs', { created_at: daysAgo(2, 9) }),
    req('r-sb-ads', 'Sagebeet ad refresh', 'New ad set for Sagebeet', 'in_progress', 'c-sb', { created_at: daysAgo(1, 14) }),
    req('r-oct-cal', 'October content calendar', 'Plan the October content calendar for IO', 'in_progress', 'c-io', { created_at: daysAgo(1, 9) }),
    req('r-proposal', 'Proposal: Shopify speed fix', 'Proposal for the Shopify speed lead from Threads', 'in_progress', null, { created_at: at(9) }),
    req('r-vi-data', 'Vinyl Icons data pull', 'Pull September GSC + GA4 data for Vinyl Icons', 'done', 'c-vi', { source: 'schedule', created_at: daysAgo(1, 8), cost_usd: 0.02 }),
    req('r-audit', 'Nanaimo homepage audit', 'Quick homepage speed audit', 'rejected', null, { created_at: daysAgo(2, 16) }),
  ];

  let tn = 0;
  const task = (request_id: string, agent_id: string, title: string, work_type: string, status: TaskStatus,
    o: Partial<TaskRow> = {}): TaskRow => {
    const r = requests.find((x) => x.id === request_id);
    return {
      id: o.id ?? `t${++tn}`, request_id, client_id: r?.client_id ?? null, agent_id, title, instructions: title,
      work_type, acceptance_criteria: ['Matches the brief', 'Brand voice', 'Mobile-friendly'], depends_on: [], status,
      revision_count: 0, max_revisions: 3, output: null, claimed_at: null, started_at: null,
      completed_at: status === 'done' ? ago(60 + tn * 17) : null, cost_usd: 0, created_at: ago(240), updated_at: ago(10), ...o,
    };
  };
  const tasks: TaskRow[] = [
    task('r-vi-report', 'coo', 'Vinyl Icons September report', 'client-report', 'queued', { id: 't-ea' }),
    task('r-vi-report', 'coo', 'Publish September report', 'client-report', 'awaiting_ceo', { id: 't-vi-publish' }),
    task('r-vi-report', 'qa-lead', 'Report data check', 'client-report', 'done', { completed_at: at(9, 15) }),
    task('r-bc-onboard', 'coo', 'Create RizeHub workspace', 'workspace-setup', 'awaiting_ceo', { id: 't-bc-ws' }),
    task('r-bc-onboard', 'coo', 'Access checklist email', 'access-checklist', 'pending'),
    // parked while the RizeHub Lead Finder job runs (the Sales Agent is free meanwhile)
    task('r-leads', 'sales', 'Lead Finder: 30 AU Shopify stores', 'lead-finder-search', 'pending', { id: 't-prospect' }),
    task('r-leads', 'sales', 'Lead report: 18 AU Shopify stores', 'lead-report', 'awaiting_ceo', { id: 't-lead-report' }),
    task('r-jobs', 'sales', '14 new Shopify dev jobs', 'job-search', 'queued', { id: 't-jobs-screen' }),
    task('r-jobs', 'sales', 'Job shortlist (5 drafts)', 'job-application', 'awaiting_ceo', { id: 't-jobs' }),
    task('r-io-reel', 'writer', 'Collagen Jelly reel script v1', 'short-video-script', 'awaiting_ceo', { id: 't-reel1' }),
    task('r-io-reel', 'designer', 'Reel cover + caption frames', 'social-graphic', 'queued', { id: 't-reel2', revision_count: 1 }),
    task('r-mm-copy', 'writer', 'Bundle landing copy', 'landing-copy', 'awaiting_ceo', { id: 't-copy', revision_count: 1, cost_usd: 0.03 }),
    task('r-mm-copy', 'writer', 'Meta titles + descriptions', 'meta-tags', 'working', { id: 't-meta' }),
    task('r-mm-copy', 'qa-lead', 'Landing copy v2 (Madam Muse)', 'landing-copy', 'qa_reviewing', { id: 't-qa' }),
    task('r-blog', 'writer', 'Blog: Shopify speed checklist', 'seo-article', 'queued', { id: 't-blog' }),
    task('r-blog', 'designer', 'Blog header image', 'social-graphic', 'queued'),
    task('r-lvlup', 'web-dev', 'LvlUp Ecosystem CMS page', 'webflow-cms', 'working', { id: 't-lvlup' }),
    task('r-lvlup', 'designer', 'Ecosystem card design', 'ui-mockup', 'done'),
    task('r-lvlup', 'qa-lead', 'Cross-browser check', 'webflow-cms', 'pending'),
    task('r-halaxy', 'web-dev', 'Halaxy booking API integration', 'api-integration', 'queued', { id: 't-halaxy' }),
    task('r-halaxy', 'web-dev', 'Booking flow tests', 'api-integration', 'qa_pending', { revision_count: 2 }),
    task('r-sb-ads', 'designer', 'Missing brand fonts for Sagebeet', 'ad-creative', 'failed', { id: 't-sb-fail' }),
    task('r-sb-ads', 'designer', '3 launch ads (1:1, 4:5, 9:16)', 'ad-creative', 'queued', { id: 't-ads' }),
    task('r-oct-cal', 'writer', 'October content calendar', 'content-calendar', 'queued', { id: 't-cal' }),
    task('r-oct-cal', 'writer', 'Caption pack (week 1)', 'social-captions', 'done'),
    task('r-oct-cal', 'writer', 'Hashtag research', 'social-captions', 'done'),
    task('r-proposal', 'sales', 'Proposal: Shopify speed fix', 'proposal', 'queued', { id: 't-proposal' }),
    task('r-mm-bundle', 'designer', 'Bundle page wireframe', 'wireframe', 'working', { id: 't-wire' }),
    task('r-vi-data', 'coo', 'Pull GSC + GA4 data', 'client-report', 'done', { completed_at: at(8, 40) }),
    task('r-vi-data', 'coo', 'Clean data sheet', 'client-report', 'done', { completed_at: at(9, 5) }),
    task('r-leads', 'sales', 'Lead Finder: AU pilot batch', 'lead-finder-search', 'done', { completed_at: at(10) }),
    task('r-jobs', 'sales', 'OnlineJobs.ph scan', 'job-search', 'done', { completed_at: at(7, 30) }),
    task('r-oct-cal', 'writer', 'Week 1 posts', 'content-calendar', 'done', { completed_at: at(12, 5) }),
  ];

  const workingProgress: Record<string, number> = {
    coo: 40, 'web-dev': 25, designer: 80, writer: 85, sales: 35, 'qa-lead': 50,
  };
  const currentTask: Record<string, string> = {
    'web-dev': 't-lvlup', designer: 't-wire', writer: 't-meta', 'qa-lead': 't-qa',
  };

  const agents: AgentRow[] = ROSTER.map(([id, name, department, model_role, color, status, idle]) => ({
    id, name, department, model_role, status, current_task_id: currentTask[id] ?? null,
    idle_activity: idle ?? null, idle_since: idle ? ago(15) : null, avatar: { color }, enabled: true, updated_at: ago(5),
  }));

  const screen = (agent_id: string, app: string, title: string, step_note: string, content: string | null = null): AgentScreenRow => ({
    agent_id, task_id: currentTask[agent_id] ?? null, app, title, step_note, content, image_url: null,
    progress: workingProgress[agent_id] ?? null, updated_at: ago(1),
  });
  const screens: AgentScreenRow[] = [
    screen('coo', 'doc', 'plan-sagebeet-spring.md', 'Splitting the campaign into tasks', '# Sagebeet spring campaign\n\n1. Social captions ×6 → Content Writer\n2. Ads ×2 → Graphic Designer\n3. QA → QA'),
    screen('web-dev', 'browser', 'lvlup.vc/ecosystem — preview', 'Binding CMS fields to the card grid'),
    screen('designer', 'browser', 'Figma — Bundle page wireframe', 'Mobile layout for the bundle builder'),
    screen('writer', 'doc', 'bundle-meta.md', 'Writing meta descriptions', 'Build Your Perfect Bundle | Madam Muse\nMix and match shapewear essentials and save up to 20%.'),
    screen('sales', 'leads', 'Lead Finder — AU · Shopify', 'Waiting for the Lead Finder job (11 of 30 scored)'),
    screen('qa-lead', 'review', 'Landing copy v2 (Madam Muse)', 'Checking keyword in H1 and CTA links'),
  ];

  const ap = (id: string, kind: ApprovalRow['kind'], title: string, agent_id: string, o: Partial<ApprovalRow>): ApprovalRow => ({
    id, kind, title, agent_id, request_id: null, task_id: null, summary: null, payload: {}, preview_url: null,
    status: 'pending', ceo_note: null, decided_at: null, decided_via: null, created_at: ago(30), ...o,
  });
  const approvals: ApprovalRow[] = [
    ap('ap1', 'plan', 'Plan: Madam Muse bundle launch', 'coo', {
      request_id: 'r-mm-bundle', created_at: at(8, 50),
      summary: '4 tasks · copy → wireframe → Shopify build, plus 3 ads · est. $0 (free profile)',
      payload: {
        title: 'Madam Muse bundle launch', client_slug: 'madam-muse', priority: 'high', due_date: dateIn(3), estimated_cost_usd: 0,
        summary: 'Launch a "Build your bundle" landing page on madammuse.co: SEO copy first, then a mobile-first wireframe, then a Shopify section on an unpublished theme, with 3 launch ads in parallel.',
        assumptions: ['Bundle discount is 20% for 3+ items', 'Use the existing brand fonts and product photos', 'Build on an unpublished duplicate theme only'],
        questions_for_ceo: ['Should the bundle page link from the main nav or only from ads?', 'Any products to exclude from bundles?'],
        tasks: [
          { key: 'copy', agent_id: 'writer', work_type: 'landing-copy', title: 'Bundle landing copy', depends_on: [],
            acceptance_criteria: ['Primary keyword in H1', '450–600 words', '3 CTAs linking to /bundle', 'Brand voice per brand.md'] },
          { key: 'wire', agent_id: 'designer', work_type: 'wireframe', title: 'Bundle page wireframe', depends_on: ['copy'],
            acceptance_criteria: ['Mobile-first at 375px', 'Bundle builder above the fold', 'Uses the approved copy'] },
          { key: 'build', agent_id: 'web-dev', work_type: 'shopify-section', title: 'Bundle hero + builder section', depends_on: ['copy', 'wire'],
            acceptance_criteria: ['OS 2.0 section with schema settings', 'No layout shift (CLS < 0.1)', 'Works at 375px and 1440px', 'Unpublished theme only'] },
          { key: 'ads', agent_id: 'designer', work_type: 'ad-creative', title: '3 launch ads (1:1, 4:5, 9:16)', depends_on: [],
            acceptance_criteria: ['Three sizes exported', 'Logo safe zones respected', 'Offer text readable on mobile'] },
        ],
      },
    }),
    ap('ap2', 'deliverable', 'Bundle landing copy', 'writer', {
      request_id: 'r-mm-copy', task_id: 't-copy', summary: '540 words, keyword in H1, 3 CTAs to /bundle · QA 92',
      preview_url: 'https://docs.example.com/madam-muse/bundle-copy', created_at: ago(45),
      payload: {
        output: {
          summary: '540-word landing copy for the bundle page: hero, 3 benefit blocks, FAQ and 3 CTAs to /bundle. Keyword "shapewear bundle" in H1 and first paragraph.',
          links: [{ label: 'Google Doc', url: 'https://docs.example.com/madam-muse/bundle-copy' }],
          files: ['bundle-landing-copy.md', 'meta-titles.csv'],
        },
        qa: {
          verdict: 'pass', score: 92, summary: 'Clear, on-brand copy. All criteria met on the second attempt.',
          checks: [
            { criterion: 'Primary keyword in H1', result: 'pass', note: '"Build your shapewear bundle"' },
            { criterion: '450–600 words', result: 'pass', note: '540 words' },
            { criterion: '3 CTAs linking to /bundle', result: 'pass', note: 'All 3 links resolve' },
            { criterion: 'Brand voice per brand.md', result: 'pass', note: 'Warm, confident, no slang' },
          ],
        },
      },
    }),
    ap('ap3', 'external_action', 'Create RizeHub workspace', 'coo', {
      request_id: 'r-bc-onboard', task_id: 't-bc-ws', summary: 'Account + "shopify-growth" workspace (dry run checked)', created_at: ago(60),
      payload: {
        type: 'action', action: 'Create RizeHub account "Brisbane Coffee Co" with a "shopify-growth" workspace',
        risk: 'Low · reversible', on_approve: 'The COO calls the RizeHub Agent API (onboarding key) and emails the access checklist.',
        options: ['Create now', 'Wait until the contract is signed'],
      },
    }),
    ap('ap4', 'deliverable', 'Lead report: 18 AU Shopify stores', 'sales', {
      request_id: 'r-leads', task_id: 't-lead-report', summary: '18 qualified leads, 18 outreach drafts · QA 88', created_at: ago(70),
      payload: {
        output: { summary: '18 AU Shopify stores with LCP > 4s, each with a fit score and a first-touch draft.', files: ['au-shopify-leads.csv', 'outreach-drafts.md'] },
        qa: { verdict: 'pass', score: 88, summary: 'Good list. Two stores are borderline on size.', checks: [
          { criterion: 'Every lead has a verified store URL', result: 'pass', note: '' },
          { criterion: 'Signal (LCP) measured, not guessed', result: 'pass', note: 'PSI mobile runs attached' },
          { criterion: 'Drafts are personalised', result: 'pass', note: '' },
        ] },
      },
    }),
    ap('ap5', 'deliverable', 'Job shortlist (5 drafts)', 'sales', {
      request_id: 'r-jobs', task_id: 't-jobs', summary: 'Top match: Shopify dev, US agency, $25/h, fit 91 · QA 90', created_at: ago(90),
      payload: {
        output: { summary: '5 roles scored ≥ 80 with tailored application drafts.', links: ['https://www.onlinejobs.ph/jobseekers/job/example'] },
        qa: { verdict: 'pass', score: 90, checks: [
          { criterion: 'No red-flag listings', result: 'pass', note: '' },
          { criterion: 'Drafts mention relevant portfolio sites', result: 'pass', note: '' },
          { criterion: 'Rate ≥ target', result: 'pass', note: '' },
        ] },
      },
    }),
    ap('ap6', 'deliverable', 'Collagen Jelly reel script v1', 'writer', {
      request_id: 'r-io-reel', task_id: 't-reel1', summary: '28 s, 6 beats, hook in 2 s, on-screen text per beat · QA 86', created_at: ago(120),
      payload: {
        output: { summary: '28-second 9:16 reel script: hook, 4 benefit beats and CTA, with on-screen text and shot notes.', files: ['collagen-jelly-script-v1.md'] },
        qa: { verdict: 'pass', score: 86, checks: [
          { criterion: 'Hook in first 2 seconds', result: 'pass', note: '' },
          { criterion: 'On-screen text ≤ 7 words per beat', result: 'pass', note: '' },
          { criterion: 'Claims match brand.md', result: 'pass', note: 'No medical claims' },
        ] },
      },
    }),
    ap('ap7', 'external_action', 'Publish September report', 'coo', {
      request_id: 'r-vi-report', task_id: 't-vi-publish', summary: 'Report + cover email to the client', created_at: ago(150),
      payload: {
        type: 'question', question: 'The September report is ready. Send it to Vinyl Icons today with the cover email, or hold until Monday?',
        options: ['Send today', 'Hold until Monday'],
      },
    }),
    // history
    ap('ap-h1', 'plan', 'Plan: October content calendar', 'coo', { status: 'approved', decided_at: at(12, 5), decided_via: 'telegram', request_id: 'r-oct-cal', created_at: at(11, 40), summary: '3 tasks · due Friday', payload: { title: 'October content calendar', tasks: [] } }),
    ap('ap-h2', 'deliverable', 'Vinyl Icons data sheet', 'coo', { status: 'approved', decided_at: at(9, 20), decided_via: 'dashboard', request_id: 'r-vi-data', created_at: at(9, 16), summary: 'GSC + GA4 · QA 96' }),
    ap('ap-h3', 'plan', 'Plan: Nanaimo homepage audit', 'coo', { status: 'rejected', decided_at: daysAgo(2, 17), decided_via: 'dashboard', ceo_note: 'Not a client yet', request_id: 'r-audit', created_at: daysAgo(2, 16), summary: '1 task' }),
  ];

  const act = (id: number, created_at: string, actor: string, action: string, detail: Record<string, unknown> = {}, o: Partial<ActivityRow> = {}): ActivityRow => ({
    id, created_at, actor, action, detail, request_id: null, task_id: null, client_id: null, cost_usd: 0, ...o,
  });
  const activity: ActivityRow[] = [
    act(6, at(12, 5), 'ceo', 'approval.approved', { kind: 'plan', text: 'You approved the October content calendar' }),
    act(5, at(11, 20), 'qa-lead', 'qa.revision', { text: 'QA sent landing copy back: 1 fix' }),
    act(4, at(10), 'sales', 'tool.rizehub.lead_finder', { text: 'Lead Finder found 30 AU Shopify stores' }),
    act(3, at(9, 15), 'qa-lead', 'qa.pass', { score: 96, text: 'QA passed: Vinyl Icons report data (96)' }),
    act(2, at(8, 30), 'ceo', 'request.created', { source: 'dashboard' }, { request_id: 'r-mm-bundle' }),
    act(1, at(8), 'coo', 'digest.morning', { text: 'Morning brief sent to Telegram' }),
  ];

  const qaReviews: QaReviewRow[] = [];
  const perDay = [5, 6, 4, 7, 6, 8, 6];
  const fails = [1, 0, 1, 0, 0, 1, 0];
  perDay.forEach((n, i) => {
    for (let k = 0; k < n; k++) {
      qaReviews.push({ id: `qa${i}-${k}`, task_id: 'x', verdict: k < fails[i] ? 'fail' : 'pass', score: k < fails[i] ? 70 : 92, created_at: daysAgo(6 - i, 9 + k) });
    }
  });

  return {
    clients: CLIENTS, agents, screens, approvals, requests, tasks, activity, qaReviews, loadedAt: now.toISOString(),
  };
}
