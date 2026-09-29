// In-memory SalesDb for tests. Mirrors the SQL rules the worker relies on (suppression, approval-gated claiming, the
// 50/day hard stop, send → stage + follow-up schedule, batch approval defaults); the SQL itself is tested in
// scripts/db-tests/090-sales-pipeline.mjs.
import { randomUUID } from 'node:crypto';
import type { LeadStage } from '@rizehubhq/shared';
import { detectFlags } from './flags';
import { nextFollowUpAt } from './schedule';
import { deniedSource, GIVEN_SOURCES } from './sources';
import type { ClaimResult, DraftResult, EmailKind, EmailStatus, InboundRecord, LeadEmailRow, LeadInput, LeadRow, SalesDb } from './store';

export interface FakeApproval { id: string; type: 'sales.email_batch' | 'sales.email'; status: 'pending' | 'approved' | 'rejected'; emailIds: string[]; auto: boolean; batchDate?: string }

const DAY = 86_400_000;

export class FakeSalesDb implements SalesDb {
  leads = new Map<string, LeadRow>();
  emails = new Map<string, LeadEmailRow & { sending_at?: number | null; send_attempts: number }>();
  approvals = new Map<string, FakeApproval>();
  suppressed = new Map<string, { reason: string; source: string }>();
  settings = new Map<string, unknown>();
  events: { lead_id: string; kind: string; to?: string; note?: string | null }[] = [];
  requests: string[] = [];
  now: () => Date;

  constructor(now: () => Date = () => new Date()) { this.now = now; }
  private iso() { return this.now().toISOString(); }

  async upsertLead(p: LeadInput, taskId: string | null) {
    void taskId;
    for (const u of [p.website, p.source_url, p.email_source_url]) if (deniedSource(u)) throw new Error(`leads check: ${deniedSource(u)}`);
    const email = p.email?.trim().toLowerCase() || null;
    if (email && this.suppressed.has(email)) throw new Error(`recipient ${email} is on the suppression list (opted out)`);
    const existing = [...this.leads.values()].find((l) => (email && l.email === email) || (p.rizehub_lead_id && l.rizehub_lead_id === p.rizehub_lead_id));
    if (existing) { Object.assign(existing, { ...p, email: email ?? existing.email, research: { ...existing.research, ...(p.research ?? {}) } }); return { id: existing.id, created: false, stage: existing.stage }; }
    const t = this.iso();
    const l: LeadRow = {
      id: randomUUID(), business_name: p.business_name, website: p.website ?? null, contact_name: p.contact_name ?? null, contact_role: p.contact_role ?? null,
      email, email_source_url: p.email_source_url ?? null, source: p.source, source_url: p.source_url ?? null, rizehub_lead_id: p.rizehub_lead_id ?? null,
      platform: p.platform ?? null, location: p.location ?? null, country: p.country ?? null, research: p.research ?? {}, stage: 'found', score: p.score ?? null,
      next_follow_up_at: null, follow_up_count: 0, first_contacted_at: null, last_contacted_at: null, replied_at: null, lost_reason: null, client_id: null,
      created_at: t, updated_at: t,
    };
    this.leads.set(l.id, l);
    return { id: l.id, created: true, stage: l.stage };
  }

  async updateResearch(leadId: string, research: Record<string, unknown>, score: number | null) {
    const l = this.lead(leadId);
    l.research = { ...l.research, ...research };
    if (score !== null) l.score = score;
    if (l.stage === 'found') l.stage = 'researched';
    return { id: l.id, stage: l.stage, score: l.score };
  }

  private lead(id: string) { const l = this.leads.get(id); if (!l) throw new Error(`lead ${id} not found`); return l; }

  async addEmailDraft(leadId: string, kind: EmailKind, subject: string, body: string, taskId: string | null, flags: string[]): Promise<DraftResult> {
    void taskId;
    const l = this.lead(leadId);
    if (['unsubscribed', 'won', 'lost'].includes(l.stage)) throw new Error(`lead is ${l.stage} : no emails`);
    if (!l.email) throw new Error('lead has no business email address');
    if (!l.email_source_url && !GIVEN_SOURCES.has(l.source)) throw new Error('the address has no public source (email_source_url)');
    if (this.suppressed.has(l.email)) throw new Error(`recipient ${l.email} is on the suppression list (opted out)`);
    let fu: number | null = null;
    if (kind === 'follow_up') {
      if (!l.first_contacted_at) throw new Error('no first email was sent yet');
      if (l.replied_at || l.stage !== 'contacted') throw new Error(`lead replied or moved on (stage ${l.stage}): no follow-ups`);
      fu = l.follow_up_count + 1;
      if (fu > 3) throw new Error('all 3 follow-ups were sent: stop');
    }
    const all = [...new Set([...flags, ...detectFlags(subject, body, kind)])].sort();
    const prior = [...this.emails.values()].find((e) => e.lead_id === l.id && e.direction === 'out' && e.kind === kind && e.status === 'draft');
    const row = prior ?? {
      id: randomUUID(), lead_id: l.id, direction: 'out' as const, kind, follow_up_number: fu, to_email: l.email, from_email: null, subject, body,
      status: 'draft' as EmailStatus, flags: all, needs_explicit_approval: all.length > 0, approval_id: null, message_id: null, in_reply_to: null,
      classification: null, classified_by: null, auto_reply: false, ceo_note: null, last_error: null, created_at: this.iso(), sent_at: null, received_at: null,
      send_attempts: 0,
    };
    Object.assign(row, { subject, body, flags: all, needs_explicit_approval: all.length > 0, follow_up_number: fu });
    this.emails.set(row.id, row);
    return { id: row.id, status: row.status, flags: all, needs_explicit_approval: all.length > 0, replaced: !!prior };
  }

  async requestEmailApproval(emailId: string) {
    const e = this.emails.get(emailId);
    if (!e || e.status !== 'draft') throw new Error('only drafts can be queued');
    const ok = false; // outbound emails always wait for the CEO
    const ap: FakeApproval = { id: randomUUID(), type: 'sales.email', status: ok ? 'approved' : 'pending', emailIds: [e.id], auto: ok };
    this.approvals.set(ap.id, ap);
    e.approval_id = ap.id; e.status = ok ? 'approved' : 'pending_approval';
    return { approval_id: ap.id, auto_approved: ok, status: e.status };
  }

  /** Test helper: the CEO's decision (plain decide_approval semantics: batch approve = unflagged only). */
  decide(approvalId: string, decision: 'approve' | 'reject', perEmail: Record<string, 'approve' | 'reject'> = {}) {
    const ap = this.approvals.get(approvalId)!;
    for (const id of ap.emailIds) {
      const e = this.emails.get(id)!;
      if (e.status !== 'pending_approval') continue;
      const d = perEmail[id] ?? decision;
      if (d === 'reject') e.status = 'rejected';
      else if (perEmail[id] || ap.type === 'sales.email' || !e.needs_explicit_approval) e.status = 'approved';
      else { e.status = 'draft'; e.approval_id = null; e.ceo_note = 'Held: needs an explicit per-email approval.'; }
    }
    ap.status = decision === 'approve' || Object.values(perEmail).includes('approve') ? 'approved' : 'rejected';
  }

  async moveStage(leadId: string, stage: LeadStage, actor: string, note: string | null) {
    const l = this.lead(leadId);
    if (l.stage === stage) return { lead_id: l.id, stage, changed: false };
    if (l.stage === 'unsubscribed') throw new Error('lead opted out: the stage is final');
    if (stage === 'unsubscribed' && !['system', 'ceo'].includes(actor)) throw new Error('unsubscribed is set only by an opt-out (sales_suppress)');
    if ((stage === 'contacted' || stage === 'proposal_sent') && !['system', 'ceo'].includes(actor)) throw new Error(`stage ${stage} is set only after an approved email was actually sent`);
    if (stage === 'won' && actor !== 'ceo') throw new Error('only the CEO marks a lead won');
    const from = l.stage;
    l.stage = stage;
    if (['won', 'lost', 'unsubscribed', 'replied', 'call_booked', 'proposal_sent'].includes(stage)) l.next_follow_up_at = null;
    if (stage === 'lost') l.lost_reason = note ?? 'closed';
    if (['won', 'lost', 'unsubscribed'].includes(stage)) this.cancelOpen(l.id);
    this.events.push({ lead_id: l.id, kind: 'stage', to: stage, note });
    return { lead_id: l.id, stage, changed: true, from };
  }

  private cancelOpen(leadId: string, kinds?: EmailKind[]) {
    for (const e of this.emails.values()) {
      if (e.lead_id === leadId && e.direction === 'out' && ['draft', 'pending_approval', 'approved'].includes(e.status) && (!kinds || kinds.includes(e.kind))) e.status = 'cancelled';
    }
  }

  async listLeads(q: { stages?: LeadStage[]; search?: string; ids?: string[]; limit?: number }) {
    const s = q.search?.toLowerCase();
    return [...this.leads.values()].filter((l) => (!q.stages?.length || q.stages.includes(l.stage)) && (!q.ids?.length || q.ids.includes(l.id))
      && (!s || `${l.business_name} ${l.website ?? ''} ${l.email ?? ''}`.toLowerCase().includes(s))).slice(0, q.limit ?? 100);
  }

  async listEmails(q: { leadIds?: string[]; statuses?: EmailStatus[]; limit?: number }) {
    return [...this.emails.values()].filter((e) => (!q.leadIds?.length || q.leadIds.includes(e.lead_id)) && (!q.statuses?.length || q.statuses.includes(e.status)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, q.limit ?? 200);
  }

  async createDailyBatch(day: string | null, force: boolean) {
    const d = day ?? this.now().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    if (!force && [...this.approvals.values()].some((a) => a.type === 'sales.email_batch' && a.batchDate === d)) return null;
    const drafts = [...this.emails.values()].filter((e) => e.direction === 'out' && e.status === 'draft' && ['first_touch', 'follow_up'].includes(e.kind) && !e.approval_id
      && !['unsubscribed', 'won', 'lost'].includes(this.lead(e.lead_id).stage) && !this.suppressed.has(e.to_email ?? ''));
    if (!drafts.length) return null;
    const ap: FakeApproval = { id: randomUUID(), type: 'sales.email_batch', status: 'pending', emailIds: drafts.map((e) => e.id), auto: false, batchDate: d };
    this.approvals.set(ap.id, ap);
    for (const e of drafts) { e.status = 'pending_approval'; e.approval_id = ap.id; }
    return ap.id;
  }

  private sentToday(): number {
    const start = new Date(`${this.now().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })}T00:00:00+08:00`).getTime();
    return [...this.emails.values()].filter((e) => e.status === 'sent' && e.sent_at && Date.parse(e.sent_at) >= start).length;
  }

  async claimSend(p_cap: number): Promise<ClaimResult> {
    const cap = Math.max(0, Math.min(p_cap, 50));
    const sent = this.sentToday();
    if (sent >= cap) return { status: 'cap_reached', sent_today: sent, cap };
    for (const e of this.emails.values()) if (e.status === 'approved' && this.suppressed.has(e.to_email ?? '')) e.status = 'cancelled';
    const t = this.now().getTime();
    const e = [...this.emails.values()].find((x) => x.direction === 'out' && x.status === 'approved' && x.send_attempts < 3
      && x.approval_id && this.approvals.get(x.approval_id)?.status === 'approved'
      && !['unsubscribed', 'lost', 'won'].includes(this.lead(x.lead_id).stage)
      && (!x.sending_at || x.sending_at < t - 600_000));
    if (!e) return { status: 'idle', sent_today: sent, cap };
    e.sending_at = t; e.send_attempts++;
    const l = this.lead(e.lead_id);
    return {
      status: 'claimed', sent_today: sent, cap,
      email: { id: e.id, lead_id: e.lead_id, kind: e.kind, follow_up_number: e.follow_up_number, to: e.to_email!, subject: e.subject, body: e.body,
        in_reply_to: e.in_reply_to, references: [], approval_id: e.approval_id, attempt: e.send_attempts },
      lead: { id: l.id, business_name: l.business_name, contact_name: l.contact_name, email: l.email, source: l.source, email_source_url: l.email_source_url, stage: l.stage },
    };
  }

  async markSent(emailId: string, messageId: string, from: string | null) {
    const e = this.emails.get(emailId)!;
    if (e.status !== 'approved') throw new Error(`email ${emailId} is ${e.status} (not approved)`);
    Object.assign(e, { status: 'sent', sent_at: this.iso(), sending_at: null, message_id: messageId, from_email: from });
    const l = this.lead(e.lead_id);
    const now = this.now();
    const first = l.first_contacted_at ? new Date(l.first_contacted_at) : e.kind === 'first_touch' ? now : null;
    const cnt = e.kind === 'follow_up' ? Math.max(l.follow_up_count, e.follow_up_number ?? l.follow_up_count + 1) : l.follow_up_count;
    if (e.kind === 'first_touch' && ['found', 'researched'].includes(l.stage)) l.stage = 'contacted';
    if (e.kind === 'proposal') l.stage = 'proposal_sent';
    Object.assign(l, { first_contacted_at: first?.toISOString() ?? null, last_contacted_at: now.toISOString(), follow_up_count: Math.min(cnt, 3) });
    if (l.stage === 'contacted' && !l.replied_at && first) l.next_follow_up_at = nextFollowUpAt(first, Math.min(cnt, 3)).at.toISOString();
    return { stage: l.stage, follow_up_count: l.follow_up_count };
  }

  async markSendFailed(emailId: string, error: string, retryable: boolean) {
    const e = this.emails.get(emailId)!;
    const final = !retryable || e.send_attempts >= 3;
    Object.assign(e, { sending_at: null, last_error: error, status: final ? 'failed' : e.status });
    return { final, attempts: e.send_attempts };
  }

  async recordInbound(p: InboundRecord) {
    if (p.message_id && [...this.emails.values()].some((e) => e.message_id === p.message_id)) return { duplicate: true };
    const parent = [...this.emails.values()].find((e) => e.direction === 'out' && e.message_id && (e.message_id === p.in_reply_to || p.references.includes(e.message_id)));
    const l = parent ? this.leads.get(parent.lead_id) : [...this.leads.values()].find((x) => x.email === p.from.toLowerCase());
    let suppressed = false;
    if (p.classification === 'unsubscribe') { await this.suppress(p.from, `Replied: ${p.subject}`, 'reply', l?.id ?? null); suppressed = true; }
    if (!l) return { matched: false, suppressed };
    const id = randomUUID();
    this.emails.set(id, {
      id, lead_id: l.id, direction: 'in', kind: 'reply', follow_up_number: null, to_email: null, from_email: p.from, subject: p.subject, body: p.body,
      status: 'received', flags: [], needs_explicit_approval: false, approval_id: null, message_id: p.message_id, in_reply_to: p.in_reply_to,
      classification: p.classification, classified_by: p.classified_by, auto_reply: p.auto_reply, ceo_note: null, last_error: null,
      created_at: this.iso(), sent_at: null, received_at: p.received_at ?? this.iso(), send_attempts: 0,
    });
    if (p.classification === 'unsubscribe') return { matched: true, lead_id: l.id, email_id: id, unsubscribed: true };
    if (p.auto_reply) return { matched: true, lead_id: l.id, email_id: id, auto_reply: true };
    this.cancelOpen(l.id, ['follow_up', 'first_touch']);
    l.replied_at ??= this.iso(); l.next_follow_up_at = null;
    if (p.classification === 'not_interested') { l.stage = 'lost'; l.lost_reason = 'not_interested'; }
    else if (['found', 'researched', 'contacted'].includes(l.stage)) l.stage = 'replied';
    this.events.push({ lead_id: l.id, kind: 'reply', note: p.classification });
    if (!p.classification || p.classification === 'interested' || p.classification === 'question') this.requests.push(`Sales reply: ${l.business_name} replied (${p.classification ?? 'unclassified'})`);
    return { matched: true, lead_id: l.id, email_id: id, stage: l.stage };
  }

  async queueFollowUps() {
    const t = this.now().getTime();
    let closed = 0, queued = 0;
    for (const l of this.leads.values()) {
      if (l.stage !== 'contacted' || l.replied_at || !l.next_follow_up_at || Date.parse(l.next_follow_up_at) > t) continue;
      if (l.follow_up_count >= 3) { await this.moveStage(l.id, 'lost', 'system', 'no_response'); closed++; continue; }
      if ([...this.emails.values()].some((e) => e.lead_id === l.id && e.direction === 'out' && ['draft', 'pending_approval', 'approved'].includes(e.status))) continue;
      queued++;
      this.requests.push(`Sales follow-ups: ${l.business_name} · follow-up #${l.follow_up_count + 1}`);
      l.next_follow_up_at = new Date(t + 365 * DAY).toISOString(); // "request open" marker
    }
    return { closed_no_response: closed, queued, request_id: queued ? randomUUID() : null };
  }

  async suppress(email: string, reason: string, source: 'reply' | 'link' | 'ceo' | 'bounce' | 'import', leadId: string | null) {
    const e = email.trim().toLowerCase();
    const isNew = !this.suppressed.has(e);
    if (isNew) this.suppressed.set(e, { reason, source });
    for (const x of this.emails.values()) if (x.direction === 'out' && x.to_email === e && ['draft', 'pending_approval', 'approved'].includes(x.status)) x.status = 'cancelled';
    let n = 0;
    for (const l of this.leads.values()) {
      if ((l.email === e || l.id === leadId) && l.stage !== 'unsubscribed') { l.stage = 'unsubscribed'; l.next_follow_up_at = null; n++; this.events.push({ lead_id: l.id, kind: 'unsubscribe' }); }
    }
    return { suppressed: true, new: isNew, leads_unsubscribed: n };
  }

  async isSuppressed(email: string) { return this.suppressed.has(email.trim().toLowerCase()); }
  async firstSentAt() {
    const s = [...this.emails.values()].filter((e) => e.sent_at).map((e) => e.sent_at!).sort()[0];
    return s ?? null;
  }
  async getSetting(key: string) { return this.settings.get(key) ?? null; }
  async setSetting(key: string, value: unknown) { this.settings.set(key, value); }
}
