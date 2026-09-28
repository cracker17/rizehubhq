// In-memory VaultStore for tests: mirrors the grant / status rules of 20260928040000_client_vault.sql
// (the real rules are tested against Postgres in scripts/db-tests/040-vault.mjs).
import { randomUUID } from 'node:crypto';
import type { Sealed } from './crypto';
import {
  VaultDenied, type AccessLinkState, type AccessLogEntry, type AgentCredentialList, type CredentialForUse, type CredentialMeta,
  type NewCredential, type TwofaAnswer, type VaultStore,
} from './store';

export interface FakeCred extends CredentialMeta { client_id: string; sealed: Sealed; failed_login_count: number; grants: Set<string>; created_by: string }
export interface FakeLink { tokenHash: string; clientId: string; platforms: string[]; expiresAt: number; usedAt: number | null; credentialId: string | null }
export interface FakeApproval { id: string; agentId: string; taskId: string | null; title: string; payload: Record<string, unknown>; status: string; ceo_note: string | null }

export class FakeVaultStore implements VaultStore {
  clients = new Map<string, { id: string; name: string; slug: string; status: string }>();
  creds = new Map<string, FakeCred>();
  links: FakeLink[] = [];
  log: AccessLogEntry[] = [];
  approvals: FakeApproval[] = [];

  addClient(id: string, name: string, slug: string) { this.clients.set(id, { id, name, slug, status: 'active' }); }

  async insertCredential(c: NewCredential) {
    const cl = this.clients.get(c.clientId);
    if (!cl) throw new Error('client not found');
    if (cl.status === 'archived') throw new Error('client is archived');
    this.creds.set(c.id, {
      id: c.id, client_id: c.clientId, platform: c.platform, label: c.label, login_url: c.loginUrl, username: c.username,
      secret_type: c.secretType, twofa_method: c.twofaMethod, scope_notes: c.scopeNotes, url_allowlist: c.urlAllowlist,
      write_allowlist: c.writeAllowlist ?? [], status: 'active', expires_at: c.expiresAt, last_used_at: null, sealed: c.sealed, failed_login_count: 0,
      grants: new Set(c.grants), created_by: 'ceo',
    });
    await this.logAccess({ credentialId: c.id, agentId: 'ceo', taskId: null, action: 'store', success: true });
    return c.id;
  }
  async redeemAccessRequest(tokenHash: string, c: Omit<NewCredential, 'clientId' | 'urlAllowlist' | 'writeAllowlist' | 'expiresAt' | 'grants'>) {
    const l = this.links.find((x) => x.tokenHash === tokenHash && !x.usedAt && x.expiresAt > Date.now());
    if (!l) return null;
    if (!l.platforms.includes(c.platform) && !l.platforms.includes('other')) throw new Error('platform not requested');
    l.usedAt = Date.now();
    await this.insertCredential({ ...c, clientId: l.clientId, urlAllowlist: [], expiresAt: null, grants: [] });
    this.creds.get(c.id)!.created_by = 'client_link';
    l.credentialId = c.id;
    return c.id;
  }
  async accessRequestState(tokenHash: string): Promise<AccessLinkState> {
    const l = this.links.find((x) => x.tokenHash === tokenHash);
    if (!l) return { state: 'invalid' };
    return { state: l.usedAt ? 'used' : l.expiresAt <= Date.now() ? 'expired' : 'open', client_name: this.clients.get(l.clientId)?.name, platforms: l.platforms };
  }
  async rotateSecret(id: string, sealed: Sealed) {
    const c = this.creds.get(id);
    if (!c) throw new Error('credential not found');
    if (c.status === 'revoked') throw new Error('credential is revoked');
    Object.assign(c, { sealed, failed_login_count: 0, status: 'active' });
    await this.logAccess({ credentialId: id, agentId: 'ceo', taskId: null, action: 'rotate', success: true });
  }
  async getSealed(id: string) {
    const c = this.creds.get(id);
    return c ? { id: c.id, label: c.label, status: c.status, sealed: c.sealed } : null;
  }
  private granted(id: string, agentId: string): FakeCred {
    const c = this.creds.get(id);
    if (!c) throw new VaultDenied('credential not found');
    if (!c.grants.has(agentId)) throw new VaultDenied('not granted');
    return c;
  }
  async getForAgent(id: string, agentId: string): Promise<CredentialForUse> {
    const c = this.granted(id, agentId);
    if (this.clients.get(c.client_id)?.status === 'archived') throw new VaultDenied('client archived');
    if (c.status === 'revoked') throw new VaultDenied('revoked');
    if (c.status === 'check_needed' || c.failed_login_count >= 2) throw new VaultDenied('check needed');
    const { grants: _g, created_by: _c, ...rest } = c;
    return { ...rest, url_allowlist: [...c.url_allowlist], write_allowlist: [...c.write_allowlist] };
  }
  async listForAgent(agentId: string, clientId: string): Promise<AgentCredentialList> {
    const client = this.clients.get(clientId);
    if (!client) throw new Error('client not found');
    const all = [...this.creds.values()].filter((c) => c.client_id === clientId && c.status !== 'revoked');
    const granted = all.filter((c) => c.grants.has(agentId)).map(({ sealed: _s, grants: _g, failed_login_count: _f, client_id: _c, created_by: _b, ...m }) => m);
    return { client, granted, not_granted: all.length - granted.length };
  }
  async resolveClientId(ref: string) {
    for (const c of this.clients.values()) if (c.id === ref || c.slug === ref || c.name.toLowerCase() === ref.toLowerCase()) return c.id;
    return null;
  }
  async logAccess(e: AccessLogEntry) {
    this.log.push(e);
    const c = e.credentialId ? this.creds.get(e.credentialId) : undefined;
    if (!c) return;
    if (e.success && ['login', 'api_call', 'twofa'].includes(e.action)) {
      c.last_used_at = new Date().toISOString();
      if (e.action !== 'api_call') c.failed_login_count = 0;
    } else if (e.action === 'failed_login') {
      c.failed_login_count++;
      if (c.failed_login_count >= 2 && (c.status === 'active' || c.status === 'expiring')) {
        c.status = 'check_needed';
        this.approvals.push({ id: randomUUID(), agentId: e.agentId ?? '', taskId: e.taskId, title: `Access problem: ${c.label}`,
          payload: { type: 'vault_problem', credential_id: c.id, issue: 'failed_login' }, status: 'pending', ceo_note: null });
      }
    }
  }
  async reportProblem(id: string, agentId: string, taskId: string | null, issue: string) {
    const c = this.granted(id, agentId);
    if (c.status === 'active' || c.status === 'expiring') c.status = 'check_needed';
    const ap: FakeApproval = { id: randomUUID(), agentId, taskId, title: `Access problem: ${c.label}`, payload: { type: 'vault_problem', credential_id: id, issue }, status: 'pending', ceo_note: null };
    this.approvals.push(ap);
    await this.logAccess({ credentialId: id, agentId, taskId, action: 'problem', success: false, detail: { issue } });
    return ap.id;
  }
  async request2fa(id: string, agentId: string, taskId: string | null, question: string) {
    const c = this.granted(id, agentId);
    const ap: FakeApproval = { id: randomUUID(), agentId, taskId, title: `2FA code needed: ${c.label}`,
      payload: { type: 'question', question, vault: { kind: '2fa', credential_id: id } }, status: 'pending', ceo_note: null };
    this.approvals.push(ap);
    await this.logAccess({ credentialId: id, agentId, taskId, action: 'twofa_request', success: true });
    return ap.id;
  }
  /** Mirrors vault_take_2fa_code (20260928070000_review_fixes.sql): one handover, every other outcome scrubs. */
  async take2faCode(approvalId: string): Promise<TwofaAnswer> {
    const ap = this.approvals.find((a) => a.id === approvalId);
    if (!ap) throw new Error('not a 2FA request');
    if (ap.status === 'pending') return { status: 'pending' };
    const note = ap.ceo_note ?? '';
    if (ap.status === 'approved' && note && !note.startsWith('[2FA ')) {
      ap.ceo_note = '[2FA code used]';
      return { status: 'approved', code: note };
    }
    if (note && !note.startsWith('[2FA ')) ap.ceo_note = '[2FA code discarded]';
    if (note === '[2FA code used]') return { status: 'used' };
    if (note === '[2FA request expired]') return { status: 'expired' };
    return { status: ap.status === 'approved' ? 'no_code' : (ap.status as 'rejected') };
  }
  async expire2fa(approvalId: string) {
    const ap = this.approvals.find((a) => a.id === approvalId);
    if (!ap) return;
    if (ap.status === 'pending') { ap.status = 'rejected'; ap.ceo_note = '[2FA request expired]'; }
    else if (ap.ceo_note && !ap.ceo_note.startsWith('[2FA ')) ap.ceo_note = '[2FA code expired]';
  }
  /** Test helper: the CEO answers an approval (e.g. types the 2FA code in Telegram). */
  answer(approvalId: string, status: 'approved' | 'rejected', note: string | null) {
    const ap = this.approvals.find((a) => a.id === approvalId)!;
    ap.status = status; ap.ceo_note = note;
  }
}
