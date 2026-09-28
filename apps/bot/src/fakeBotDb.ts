// In-memory BotDb for tests (mirrors decide_approval's pending re-check).
import { randomUUID } from 'node:crypto';
import type { BotDb, NewRequest } from './db';
import type { AgentLite, BotApproval, BotReport, Decision, QuickFacts, SpendRow } from './types';

export function approval(p: Partial<BotApproval> = {}): BotApproval {
  return {
    id: randomUUID(), kind: 'deliverable', request_id: null, task_id: null, agent_id: 'seo-1', title: 'Landing copy', summary: '540 words · QA 92',
    payload: { qa: { score: 92 }, output: { summary: '540 words, keyword in H1, 3 CTAs' } }, preview_url: null, status: 'pending', ceo_note: null,
    decided_at: null, decided_via: null, telegram_message_id: null, created_at: '2026-09-28T01:00:00Z',
    requests: { priority: 'normal', title: 'Bundle', due_date: null, clients: { name: 'Madam Muse' } }, ...p,
  };
}

export class FakeBotDb implements BotDb {
  approvals: BotApproval[] = [];
  reports: BotReport[] = [];
  settings: Record<string, unknown> = { timezone: 'Asia/Manila' };
  requests: NewRequest[] = [];
  decisions: { id: string; decision: Decision; note: string | null }[] = [];
  now = () => new Date('2026-09-28T06:02:00Z');

  async getSettings() { return { ...this.settings }; }
  async setPaused(paused: boolean) { this.settings.paused = paused; }
  async unsentApprovals(limit: number) { return this.approvals.filter((a) => a.status === 'pending' && a.telegram_message_id === null).slice(0, limit); }
  async pendingApprovals(limit: number) { const p = this.approvals.filter((a) => a.status === 'pending'); return { rows: p.slice(0, limit), total: p.length }; }
  async getApproval(id: string) { const a = this.approvals.find((x) => x.id === id); return a ? { ...a } : null; }
  async setApprovalMessageId(id: string, messageId: number) { const a = this.approvals.find((x) => x.id === id); if (a && a.telegram_message_id === null) a.telegram_message_id = messageId; }
  async decide(id: string, decision: Decision, note: string | null) {
    const a = this.approvals.find((x) => x.id === id);
    if (!a) throw new Error('approval not found');
    if (a.status !== 'pending') return `already_${a.status}`;
    // Mirrors decide_approval for Vault 2FA (20260928070000_review_fixes.sql): an answer is an approve with the code.
    if ((a.payload as { vault?: { kind?: string } } | null)?.vault?.kind === '2fa' && decision !== 'reject') {
      if (!note?.trim()) throw new Error('2FA: reply with the one-time code');
      decision = 'approve';
    }
    if (decision === 'changes' && !note?.trim()) throw new Error('say what should change');
    this.decisions.push({ id, decision, note });
    a.status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'changes_requested';
    a.ceo_note = note; a.decided_at = this.now().toISOString(); a.decided_via = 'telegram';
    return a.kind === 'deliverable' ? (decision === 'approve' ? 'task_done' : decision === 'changes' ? 'task_revision' : 'task_cancelled') : `action_${a.status}`;
  }
  async decidedSince(sinceIso: string) {
    return this.approvals.filter((a) => a.status !== 'pending' && a.decided_at && a.decided_at > sinceIso && (a.telegram_message_id ?? 0) > 0);
  }
  async unsentReports(sinceIso: string) { return this.reports.filter((r) => r.telegram_sent_at === null && r.created_at >= sinceIso && r.kind !== 'standup'); }
  async markReportSent(id: string) { const r = this.reports.find((x) => x.id === id); if (r && !r.telegram_sent_at) r.telegram_sent_at = this.now().toISOString(); }
  async latestReport(kind: BotReport['kind'], date: string) { return this.reports.find((r) => r.kind === kind && r.report_date === date) ?? null; }
  async reportFacts(): Promise<QuickFacts> { return { spend_usd: 0, qa: { reviews: 0, passed: 0 }, done: [], in_progress: [], blocked: [], approvals_waiting: [] }; }
  async spendRows(): Promise<SpendRow[]> { return []; }
  async agents(): Promise<AgentLite[]> { return [{ id: 'seo-1', name: 'SEO Writer 1', status: 'working' }]; }
  async createRequest(r: NewRequest) { this.requests.push(r); return { id: randomUUID(), clientFound: true }; }
}
