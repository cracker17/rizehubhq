// Applies the CEO-approved agent proposals (M14.4, migration 20260930040000_brain_agents.sql) to the vault: claim a
// batch (exactly once), turn each into a vault edit, write it through the normal write path (fresh pull → edit →
// secret scan → commit + push as agent:<id> → re-index), and record the result. Never throws.
import type { Store } from './store/types';
import type { BrainService } from './service';
import { saveSessionOp, updateMemoryOp, WriteError, type VaultOp } from './write/vault';

export interface Proposal {
  id: string; agent_id: string; project_slug: string; kind: 'decision' | 'next_step' | 'fact' | 'lesson' | 'session_note' | 'lead_note';
  section: string | null; text: string;
}

/** The vault edit for one proposal (exported for tests). */
export function proposalOp(p: Proposal): VaultOp {
  const project = p.project_slug;
  switch (p.kind) {
    case 'decision': return updateMemoryOp(project, { decisions: [p.text] });
    case 'next_step': return updateMemoryOp(project, { add_next_steps: [p.text] });
    case 'fact': return updateMemoryOp(project, { facts: [{ section: p.section || 'Notes', lines: [p.text] }] });
    case 'lesson': return updateMemoryOp(project, { facts: [{ section: 'Lessons', lines: [p.text] }] });
    case 'lead_note': return updateMemoryOp(project, { facts: [{ section: 'Leads', lines: [p.text] }] });
    case 'session_note': {
      const [first, ...rest] = p.text.split('\n').map((l) => l.trim()).filter(Boolean);
      const title = (first ?? 'Agent note').replace(/^#+\s*/, '').slice(0, 100);
      return saveSessionOp({ project, title: `${p.agent_id}: ${title}`, source: 'agent', what_we_did: rest.length ? rest.map((l) => l.replace(/^[-*]\s*/, '')) : [title] });
    }
  }
}

export async function applyApprovedProposals(d: { store: Store; service: BrainService; log: (m: string) => void }): Promise<number> {
  let claimed: Proposal[];
  try { claimed = (await d.store.rpc<Proposal[]>('brain_proposals_claim', { p_limit: 10 })) ?? []; } catch (e) {
    // Before migration 20260930040000 the function does not exist: stay quiet.
    if (!/brain_proposals_claim/.test((e as Error).message)) d.log(`proposals: claim failed: ${(e as Error).message}`);
    return 0;
  }
  let done = 0;
  for (const p of claimed) {
    try {
      const r = await d.service.write(proposalOp(p), `agent:${p.agent_id}`);
      await d.store.rpc('brain_proposal_done', { p_id: p.id, p_sha: r.sha, p_error: null });
      done++;
    } catch (e) {
      const msg = (e as Error).message;
      // Already in the memory (e.g. the same decision twice) counts as applied: nothing left to do.
      const already = e instanceof WriteError && /nothing to change/.test(msg);
      await d.store.rpc('brain_proposal_done', { p_id: p.id, p_sha: null, p_error: already ? null : msg }).catch(() => {});
      if (!already) d.log(`proposals: ${p.id} (${p.kind} for ${p.project_slug}) failed: ${msg}`);
    }
  }
  return done;
}
