// The tools a job run gets (docs/17-OPERATOR.md "Worker mode"), as plain specs: name, description, zod shape, handler.
// runner.ts turns them into an in-process MCP server for the Claude Agent SDK (tool ids mcp__op__<name>); tests call
// the handlers directly. Every handler returns text (or text + an image) and never throws into the agent loop.
import { z } from 'zod';
import { webFetch } from 'worker/src/research/fetch';
import { checkLinks, formatLinkReport } from 'worker/src/research/linkcheck';
import type { NetEnv } from 'worker/src/research/net';
import { airtableRead, AIRTABLE_READS, webflowRead, WEBFLOW_READS, type ApiEnv } from './apis';
import type { JobBrowser, WithContext } from './browser';
import { ACTION_KINDS, FinishSchema, FinishShape, type FinishArgs, type JobRow } from './prompt';
import { qaFeedback, qaVerdict, runQa } from './qa';

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolResult { content: ToolContent[]; isError?: boolean }
export interface ToolSpec { name: string; description: string; shape: z.ZodRawShape; run: (args: any) => Promise<ToolResult> } // eslint-disable-line @typescript-eslint/no-explicit-any

export type RunEnd = { kind: 'finished'; finish: FinishArgs } | { kind: 'waiting' };

export interface ToolboxDeps {
  job: JobRow;
  client: { slug: string; name: string };
  browser: JobBrowser;
  withCtx: WithContext;
  net: NetEnv;
  api: ApiEnv;
  step: (action: string, detail?: Record<string, unknown>) => Promise<void>;
  requestAction: (kind: string, summary: string, spec: Record<string, unknown>) => Promise<{ action_id: string; approval_id: string }>;
  saveEvidence: (label: string, url: string | null, jpeg: Buffer) => Promise<number | null>;
  memorySearch: (query: string) => Promise<string>;
  /** One sandboxed command (worker bash_sandboxed rules); absent when the operator has no isolated shell. */
  terminal?: (command: string, cwd?: string, timeoutS?: number) => Promise<string>;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t.slice(0, 30_000) }], ...(isError ? { isError } : {}) });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 800);

export class JobToolbox {
  ended: RunEnd | null = null;
  evidence: number[] = [];
  requested = 0;

  constructor(private d: ToolboxDeps) {}

  private safe(name: string, fn: (a: any) => Promise<ToolResult | string>): (a: any) => Promise<ToolResult> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return async (a) => {
      if (this.ended) return text('This run is over (finish or wait_for_approvals was called). Stop now: no more tool calls.', true);
      try { const r = await fn(a ?? {}); return typeof r === 'string' ? text(r) : r; }
      catch (e) { await this.d.step(`tool.failed`, { tool: name, error: errText(e) }).catch(() => undefined); return text(`${name} failed: ${errText(e)}`, true); }
    };
  }

  private async shot(width: number, fullPage: boolean, label: string): Promise<ToolResult> {
    const s = await this.d.browser.screenshot(width, fullPage);
    const id = await this.d.saveEvidence(`${label} ${s.width}px`, s.url, s.jpeg).catch(() => null);
    if (id) this.evidence.push(id);
    return { content: [{ type: 'image', data: s.jpeg.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: `Screenshot of ${s.url} at ${s.width}×${s.height}${id ? ` (saved as evidence #${id})` : ''}.` }] };
  }

  specs(): ToolSpec[] {
    const b = this.d.browser;
    const specs: ToolSpec[] = [
      { name: 'browser_open', description: 'Open a URL in your own tab of the client\'s logged-in browser (public http(s) only). new_tab keeps the current tab open.',
        shape: { url: z.string().max(2000), new_tab: z.boolean().optional() }, run: this.safe('browser_open', (a) => b.navigate(a.url, a.new_tab === true)) },
      { name: 'browser_snapshot', description: 'The current page as text + every visible control with a ref (all frames). Take one before clicking or typing; refs change when the page changes.',
        shape: {}, run: this.safe('browser_snapshot', () => b.snapshot()) },
      { name: 'browser_click', description: 'Click a control by ref. Publish / send / submit / delete / pay / invite buttons are refused: propose them with request_action kind browser_click.',
        shape: { ref: z.string().max(20) }, run: this.safe('browser_click', (a) => b.click(a.ref)) },
      { name: 'browser_type', description: 'Type into a text field / editable area by ref (replaces its content unless append). submit presses Enter (search boxes only). Never for passwords or codes.',
        shape: { ref: z.string().max(20), text: z.string().max(20_000), submit: z.boolean().optional(), append: z.boolean().optional() },
        run: this.safe('browser_type', (a) => b.type(a.ref, a.text, a.submit === true, a.append !== true)) },
      { name: 'browser_press', description: 'Press a key or chord (Escape, Tab, ArrowDown, Control+A …). Enter in chat / mail apps is refused.',
        shape: { key: z.string().max(40) }, run: this.safe('browser_press', (a) => b.press(a.key)) },
      { name: 'browser_select', description: 'Choose an option in a <select> by ref (value or label).',
        shape: { ref: z.string().max(20), value: z.string().max(300) }, run: this.safe('browser_select', (a) => b.select(a.ref, a.value)) },
      { name: 'browser_screenshot', description: 'Screenshot of your current tab at a width (375 phone, 768 tablet, 1366 laptop). Saved as evidence for Julev.',
        shape: { width: z.number().int().min(320).max(1920).optional(), full_page: z.boolean().optional() },
        run: this.safe('browser_screenshot', (a) => this.shot(a.width ?? 1366, a.full_page === true, 'screenshot')) },
      { name: 'browser_console', description: 'Console errors, page errors and failed / 4xx-5xx requests on your tabs since the last call.',
        shape: {}, run: this.safe('browser_console', async () => { const p = b.problemsSinceLast(); return p.length ? p.join('\n') : 'No console errors or failed requests since the last check.'; }) },
      { name: 'fetch_url', description: 'Fetch a public page without the browser (scraper): readable text, links as [text](url), optional SEO facts. GET only.',
        shape: { url: z.string().max(2000), seo: z.boolean().optional(), max_chars: z.number().int().min(500).max(40_000).optional() },
        run: this.safe('fetch_url', async (a) => (await webFetch(a.url, this.d.net, { seo: a.seo === true, maxChars: a.max_chars ?? 15_000 })).text) },
      { name: 'check_links', description: 'Check the links of a public page (HEAD/GET each); include_external also checks other sites.',
        shape: { url: z.string().max(2000), include_external: z.boolean().optional(), max_links: z.number().int().min(1).max(150).optional() },
        run: this.safe('check_links', async (a) => formatLinkReport(await checkLinks(a.url, this.d.net, { includeExternal: a.include_external === true, maxLinks: a.max_links ?? 60 }))) },
      { name: 'qa_check', description: 'Full QA of up to 3 URLs in the client\'s browser: 375 and 1366 px screenshots (saved as evidence), HTTP status, console errors, failed requests, 375 px overflow, broken links. Returns pass/fail with findings.',
        shape: { urls: z.array(z.string().max(2000)).min(1).max(3) },
        run: this.safe('qa_check', async (a) => {
          await this.d.step('qa.run', { urls: a.urls });
          const r = await runQa(a.urls, { withCtx: this.d.withCtx, net: this.d.net });
          const v = qaVerdict(r);
          const content: ToolContent[] = [];
          for (const p of r.pages) for (const s of p.shots) {
            const id = await this.d.saveEvidence(`QA ${s.width}px`, p.finalUrl, s.jpeg).catch(() => null);
            if (id) this.evidence.push(id);
            if (content.length < 4) content.push({ type: 'image', data: s.jpeg.toString('base64'), mimeType: 'image/jpeg' });
          }
          content.push({ type: 'text', text: v.pass ? `QA PASSED for ${a.urls.join(', ')}.${v.warnings.length ? `\nWarnings (third-party, not blocking):\n${v.warnings.join('\n')}` : ''}` : qaFeedback(v) });
          return { content };
        }) },
      { name: 'webflow', description: `Webflow Data API v2, read only: ${WEBFLOW_READS.join(', ')}. Ids are 24-character hex. Writes / publishing / deletes: request_action.`,
        shape: { op: z.string().max(40), site_id: z.string().max(40).optional(), collection_id: z.string().max(40).optional(), item_id: z.string().max(40).optional(),
          page_id: z.string().max(40).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() },
        run: this.safe('webflow', (a) => webflowRead(this.d.api, this.d.client.slug, a)) },
      { name: 'airtable', description: `Airtable, read only: ${AIRTABLE_READS.join(', ')}. base_id app…, record_id rec…, table = name or tbl… id. Writes / deletes: request_action.`,
        shape: { op: z.string().max(40), base_id: z.string().max(40).optional(), table: z.string().max(200).optional(), record_id: z.string().max(40).optional(),
          view: z.string().max(200).optional(), filter: z.string().max(2000).optional(), max_records: z.number().int().min(1).max(100).optional(), offset: z.string().max(200).optional() },
        run: this.safe('airtable', (a) => airtableRead(this.d.api, this.d.client.slug, a)) },
      { name: 'memory_search', description: 'Search this client\'s project memory (HQ Brain) for facts, decisions, earlier sessions.',
        shape: { query: z.string().min(2).max(200) }, run: this.safe('memory_search', (a) => this.d.memorySearch(a.query)) },
      { name: 'report_progress', description: 'One line for Julev\'s live view of what you are doing now (call at each real step).',
        shape: { step: z.string().min(2).max(200) }, run: this.safe('report_progress', async (a) => { await this.d.step('job.progress', { step: a.step }); return 'Noted.'; }) },
      { name: 'request_action', description: 'Propose an outside-world change for Julev\'s one-tap approval; the operator runs EXACTLY this spec after ✅. Kinds and specs: '
          + 'webflow_cms {collection_id, ops:[{op:"create"|"update", item_id?, field_data, draft?}]} (≤100); '
          + 'webflow_publish {site_id, custom_domain_ids?, webflow_subdomain?} or {collection_id, item_ids}; '
          + 'airtable_write {base_id, table, op:"create"|"update", records:[{id?, fields}], typecast?} (≤100); '
          + 'delete {platform:"webflow", collection_id, item_ids} | {platform:"airtable", base_id, table, record_ids}; '
          + 'browser_click {url, selector, text, type_text?, press?} (the refusal of a click gives you this spec); '
          + 'other {description} (Julev does it by hand). summary: one plain sentence of what changes, for Julev.',
        shape: { kind: z.enum(ACTION_KINDS), summary: z.string().min(3).max(1000), spec: z.record(z.unknown()) },
        run: this.safe('request_action', async (a) => {
          if (JSON.stringify(a.spec ?? {}).length > 90_000) return text('spec is too large: split it into several actions (≤100 items each).', true);
          const r = await this.d.requestAction(a.kind, a.summary, a.spec ?? {});
          this.requested++;
          return `Requested (approval ${r.approval_id.slice(0, 8)}). Julev decides on Telegram; it runs after ✅. Keep working on independent parts, or call wait_for_approvals.`;
        }) },
      { name: 'wait_for_approvals', description: 'End this run until Julev has decided the actions you requested; the next run starts with their results.',
        shape: { note: z.string().max(500).optional() },
        run: this.safe('wait_for_approvals', async (a) => {
          if (!this.requested) return text('You have not requested any action in this run. Call finish instead (or request_action first).', true);
          this.ended = { kind: 'waiting' };
          await this.d.step('job.waiting_note', { note: a.note ?? '' });
          return 'OK: this run ends now and resumes after the decisions. Stop: no more tool calls.';
        }) },
      { name: 'finish', description: 'End the job run with the result (call once, last). QA re-checks the links; the client update is posted through Julev\'s approval rules.',
        shape: FinishShape,
        run: this.safe('finish', async (a) => {
          const f = FinishSchema.safeParse(a);
          if (!f.success) return text(`finish arguments are invalid: ${f.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, true);
          this.ended = { kind: 'finished', finish: f.data };
          return 'Recorded. Stop now: no more tool calls.';
        }) },
    ];
    if (this.d.terminal) {
      const term = this.d.terminal;
      specs.push({ name: 'terminal', description: 'Run ONE command in this job\'s sandbox folder (no shell features; allowlisted programs: node, npx, git, curl to allowlisted hosts, lighthouse, playwright, ls, cat, grep …). No secrets exist there.',
        shape: { command: z.string().max(8000), cwd: z.string().max(300).optional(), timeout_s: z.number().int().min(1).max(600).optional() },
        run: this.safe('terminal', (a) => term(a.command, a.cwd, a.timeout_s)) });
    }
    return specs;
  }
}
