// In-memory BotDb for tests (mirrors decide_approval's pending re-check).
import { randomUUID } from 'node:crypto';
import type { BotDb, NewRequest, NewVoiceNote } from './db';
import type { AgentLite, BotApproval, BotReport, BudgetAlert, Decision, QuickFacts, SpendRow, VoiceNoteState } from './types';

export function approval(p: Partial<BotApproval> = {}): BotApproval {
  return {
    id: randomUUID(), kind: 'deliverable', request_id: null, task_id: null, agent_id: 'writer', title: 'Landing copy', summary: '540 words · QA 92',
    payload: { qa: { score: 92 }, output: { summary: '540 words, keyword in H1, 3 CTAs' } }, preview_url: null, status: 'pending', ceo_note: null,
    decided_at: null, decided_via: null, telegram_message_id: null, created_at: '2026-09-28T01:00:00Z',
    requests: { priority: 'normal', title: 'Bundle', due_date: null, clients: { name: 'Madam Muse' } }, ...p,
  };
}

export class FakeBotDb implements BotDb {
  approvals: BotApproval[] = [];
  reports: BotReport[] = [];
  budgetAlerts: BudgetAlert[] = [];
  settings: Record<string, unknown> = { timezone: 'Asia/Manila' };
  requests: NewRequest[] = [];
  /** voice_notes rows; tests play the worker by editing them (or via onVoicePoll). */
  voiceNotes = new Map<string, NewVoiceNote & VoiceNoteState & { audioCleared: boolean }>();
  /** Called on every getVoiceNote poll (poll number from 1): lets a test finish the clip after n polls. */
  onVoicePoll: ((id: string, poll: number) => void) | null = null;
  private voicePolls = 0;
  decisions: { id: string; decision: Decision; note: string | null }[] = [];
  now = () => new Date('2026-09-28T06:02:00Z');
  /** Mirrors ceo_step_up_guard(): the CEO has 2FA on, so the bot (service role) can't approve high-risk actions. */
  ceoHasTotp = false;

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
    if (this.ceoHasTotp && decision === 'approve' && a.kind === 'external_action' && (a.payload as { type?: string } | null)?.type === 'external_action') {
      throw new Error('step_up_required: confirm with a fresh 2FA code in the dashboard');
    }
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
  async unsentBudgetAlerts() { return this.budgetAlerts.filter((a) => a.telegram_sent_at === null).sort((a, b) => a.alert_day.localeCompare(b.alert_day) || a.level - b.level); }
  async markBudgetAlertSent(id: string) { const a = this.budgetAlerts.find((x) => x.id === id); if (a && !a.telegram_sent_at) a.telegram_sent_at = this.now().toISOString(); }
  async latestReport(kind: BotReport['kind'], date: string) { return this.reports.find((r) => r.kind === kind && r.report_date === date) ?? null; }
  async reportFacts(): Promise<QuickFacts> { return { spend_usd: 0, qa: { reviews: 0, passed: 0 }, done: [], in_progress: [], blocked: [], approvals_waiting: [] }; }
  async spendRows(): Promise<SpendRow[]> { return []; }
  async agents(): Promise<AgentLite[]> { return [{ id: 'writer', name: 'Content Writer', status: 'working' }]; }
  async createRequest(r: NewRequest) { this.requests.push(r); return { id: randomUUID(), clientFound: true }; }
  async createVoiceNote(v: NewVoiceNote) {
    const id = randomUUID();
    this.voiceNotes.set(id, { ...v, status: 'pending', text: null, error: null, audioCleared: false });
    return id;
  }
  async getVoiceNote(id: string): Promise<VoiceNoteState | null> {
    this.onVoicePoll?.(id, ++this.voicePolls);
    const v = this.voiceNotes.get(id);
    return v ? { status: v.status, text: v.text, error: v.error } : null;
  }
  async abandonVoiceNote(id: string, error: string) {
    const v = this.voiceNotes.get(id);
    if (v && (v.status === 'pending' || v.status === 'working')) Object.assign(v, { status: 'failed', error, audioCleared: true });
  }
}
