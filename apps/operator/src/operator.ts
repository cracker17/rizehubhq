// The operator's three loops (docs/17-OPERATOR.md "How it works"). Framework-free and dependency-injected, so the
// whole flow runs in tests with a fake database, a fake chat and a fake classifier.
//
//   watch     every OPERATOR_POLL_MS per channel: read the chat in the client's browser, store new messages
//             (a channel's first poll is a baseline: stored as history, never answered)
//   classify  every tick: when the budget allows, claim one new message, load the client's memory from the HQ Brain
//             plus the chat history, classify + draft with Claude, hand the verdict to SQL (tiers decide what happens)
//   send      every tick (unless OPERATOR_SENDS=off): claim one approved reply (SQL refuses while any pause is on),
//             type it in the browser, check the database once more, press Enter
import type { Gate } from './ai';
import type { ClassifyOutcome } from './classify';
import { ClassifyError } from './classify';
import type { BrainBundle, BrainHit, InboxRow, OperatorChannel, OperatorClient, OperatorDb } from './db';
import type { ChatMessage } from './browser/chatDom';
import { MaybeSentError } from './browser/googleChat';
import type { SendInput, SendSteps } from './browser/googleChat';
import { buildUserPrompt, formatMemory, searchQuery } from './prompt';

export interface ChatDriver {
  read(client: OperatorClient, channel: OperatorChannel): Promise<{ title: string; messages: ChatMessage[] }>;
  send(client: OperatorClient, channel: OperatorChannel, input: SendInput, steps: SendSteps): Promise<{ sent: boolean } & Record<string, unknown>>;
}

export interface OperatorDeps {
  db: OperatorDb;
  chat: ChatDriver;
  gate: () => Promise<Gate>;
  classify: (o: { prompt: string; model: string; apiKey: string; capUsd: number }) => Promise<ClassifyOutcome>;
  pollMs: number;
  sends: boolean;
  now?: () => number;
  log?: (m: string) => void;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

export class Operator {
  private lastPoll = new Map<string, number>();
  private lastBlockedLog = { reason: '', at: 0 };

  constructor(private d: OperatorDeps) {}

  private now() { return (this.d.now ?? Date.now)(); }
  private log(m: string) { (this.d.log ?? console.log)(m); }

  private async lookups(): Promise<{ clients: Map<string, OperatorClient>; channels: OperatorChannel[] }> {
    const [clients, channels] = await Promise.all([this.d.db.clients(), this.d.db.channels()]);
    return { clients: new Map(clients.map((c) => [c.slug, c])), channels };
  }

  // ---------- watch ----------

  /** Polls every channel that is due. Returns how many new messages were stored. */
  async watchTick(): Promise<number> {
    const { clients, channels } = await this.lookups();
    let stored = 0;
    for (const ch of channels) {
      const client = clients.get(ch.client_slug);
      if (!client) continue;
      const last = this.lastPoll.get(ch.id) ?? 0;
      if (this.now() - last < this.d.pollMs) continue;
      this.lastPoll.set(ch.id, this.now());
      stored += await this.pollChannel(client, ch);
    }
    return stored;
  }

  async pollChannel(client: OperatorClient, ch: OperatorChannel): Promise<number> {
    let read: Awaited<ReturnType<ChatDriver['read']>>;
    try {
      read = await this.d.chat.read(client, ch);
    } catch (e) {
      this.log(`[operator] ${client.slug}/${ch.name}: read failed: ${errMsg(e)}`);
      await this.d.db.channelPolled(ch.id, null, errMsg(e)).catch(() => undefined);
      return 0;
    }
    // No cursor yet = first good read of this chat: everything visible is history (a failed read never sets the cursor).
    const baseline = !ch.last_seen_key;
    // Only what came after the cursor (the unique key makes a re-ingest harmless when the cursor scrolled away).
    const idx = ch.last_seen_key ? read.messages.findIndex((m) => m.external_id === ch.last_seen_key) : -1;
    const fresh = idx >= 0 ? read.messages.slice(idx + 1) : read.messages;
    let stored = 0;
    for (const m of fresh) {
      const id = await this.d.db.ingest(ch.id, { ...m, space_name: read.title || ch.name, url: ch.url, baseline });
      if (id) stored++;
    }
    const lastKey = read.messages.at(-1)?.external_id ?? null;
    await this.d.db.channelPolled(ch.id, lastKey, null);
    if (stored) this.log(`[operator] ${client.slug}/${ch.name}: ${stored} new message(s)${baseline ? ' (baseline, not answered)' : ''}`);
    return stored;
  }

  // ---------- classify + draft ----------

  /** Classifies at most one message. Returns the SQL outcome, or null when nothing ran. */
  async classifyTick(): Promise<string | null> {
    const g = await this.d.gate();
    if (!g.ok) {
      // Messages simply wait as 'new'; say why at most every 30 minutes.
      if (g.reason !== this.lastBlockedLog.reason || this.now() - this.lastBlockedLog.at > 30 * 60_000) {
        this.lastBlockedLog = { reason: g.reason, at: this.now() };
        this.log(`[operator] not classifying: ${g.reason}`);
        await this.d.db.log('classify.waiting', null, null, { reason: g.reason }, false).catch(() => undefined);
      }
      return null;
    }
    const row = await this.d.db.claimNew();
    if (!row) return null;
    const { clients, channels } = await this.lookups();
    const client = clients.get(row.client_slug);
    const channel = channels.find((c) => c.id === row.channel_id);
    if (!client || !channel) {
      await this.d.db.classifyFailed(row.id, 'client or channel is disabled');
      return 'failed';
    }

    const [history, memory] = await Promise.all([
      this.d.db.history(row.channel_id, row.sent_at, 20).catch(() => [] as InboxRow[]),
      this.memory(client, row),
    ]);
    const prompt = buildUserPrompt({ client, channelName: channel.name, message: row, history, memory: memory.text });
    try {
      const out = await this.d.classify({ prompt, model: g.model, apiKey: g.apiKey, capUsd: g.capUsd });
      await this.d.db.recordUsage({ tokensIn: out.tokensIn, tokensOut: out.tokensOut, costUsd: out.costUsd,
        detail: { model: out.model, inbox_id: row.id, client: client.slug } });
      const outcome = await this.d.db.recordDraft(row.id, { ...out.result, project: memory.project, model: out.model, cost_usd: out.costUsd });
      this.log(`[operator] ${client.slug}: ${row.sender_name}'s message → ${out.result.category} (${out.result.action_types.join(',') || '-'}, ${out.result.confidence}) → ${outcome}`);
      return outcome;
    } catch (e) {
      if (e instanceof ClassifyError && (e.costUsd > 0 || e.tokensIn > 0)) {
        await this.d.db.recordUsage({ tokensIn: e.tokensIn, tokensOut: e.tokensOut, costUsd: e.costUsd,
          detail: { model: e.model, inbox_id: row.id, client: client.slug, failed: true } }).catch(() => undefined);
      }
      this.log(`[operator] ${client.slug}: classify failed: ${errMsg(e)}`);
      return this.d.db.classifyFailed(row.id, errMsg(e));
    }
  }

  private async memory(client: OperatorClient, row: InboxRow): Promise<{ text: string; project: string | null }> {
    const project = client.brain_project;
    if (!project) return { text: formatMemory(null, []), project: null };
    let bundle: BrainBundle | null = null;
    let hits: BrainHit[] = [];
    try { bundle = await this.d.db.brainBundle(project); } catch (e) { this.log(`[operator] brain bundle ${project}: ${errMsg(e)}`); }
    const q = searchQuery(row.body);
    if (q) { try { hits = await this.d.db.brainSearch(project, q, 6); } catch (e) { this.log(`[operator] brain search ${project}: ${errMsg(e)}`); } }
    return { text: formatMemory(bundle, hits), project };
  }

  // ---------- send ----------

  /** Sends at most one approved reply. Returns the SQL outcome, or null when nothing was claimed. */
  async sendTick(): Promise<string | null> {
    if (!this.d.sends) return null;
    const row = await this.d.db.claimSend();
    if (!row) return null;
    const { clients, channels } = await this.lookups();
    const client = clients.get(row.client_slug);
    const channel = channels.find((c) => c.id === row.channel_id);
    const text = (row.final_text ?? '').trim();
    if (!client || !channel || !text) {
      return this.d.db.sendDone(row.id, false, !text ? 'no approved text' : 'client or channel is disabled', {}, true);
    }
    const mentions = Array.isArray(row.analysis?.mentions) ? (row.analysis.mentions as unknown[]).filter((m): m is string => typeof m === 'string') : [];
    try {
      const r = await this.d.chat.send(client, channel, { externalId: row.external_id, threadKey: row.thread_key, text, mentions, quote: true }, {
        lastCheck: () => this.d.db.maySend(row.id),
        step: (what, detail = {}) => this.d.db.log(what, client.slug, row.id, detail).catch(() => undefined),
      });
      const outcome = await this.d.db.sendDone(row.id, r.sent, r.sent ? null : 'not sent', r);
      this.log(`[operator] ${client.slug}: reply to ${row.sender_name} ${r.sent ? 'posted' : 'not posted'} (${row.mode})`);
      return outcome;
    } catch (e) {
      const final = e instanceof MaybeSentError;
      this.log(`[operator] ${client.slug}: send failed${final ? ' (may have posted; not retried)' : ''}: ${errMsg(e)}`);
      return this.d.db.sendDone(row.id, false, errMsg(e), { may_have_posted: final }, final);
    }
  }
}
