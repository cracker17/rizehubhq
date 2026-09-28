// "✏️ Changes" → "What should change?" → the CEO's next text in that chat is the note.
// One pending note per chat, forgotten after 10 minutes. `decision` is what the text is applied as:
// 'changes' for a change note / answer, 'approve' for a Vault 2FA code.
import type { Decision } from './types';

export interface PendingNote { approvalId: string; messageId: number; at: number; decision: Decision }

export class PendingNotes {
  private byChat = new Map<number, PendingNote>();
  constructor(private ttlMs = 10 * 60_000) {}

  set(chatId: number, approvalId: string, messageId: number, now = Date.now(), decision: Decision = 'changes'): void {
    this.byChat.set(chatId, { approvalId, messageId, at: now, decision });
  }

  /** The live entry for this chat (without consuming it), or null. Expired entries are dropped. */
  peek(chatId: number, now = Date.now()): PendingNote | null {
    const p = this.byChat.get(chatId);
    if (!p) return null;
    if (now - p.at > this.ttlMs) { this.byChat.delete(chatId); return null; }
    return p;
  }

  /** Consumes the entry: the next message is the note. */
  take(chatId: number, now = Date.now()): PendingNote | null {
    const p = this.peek(chatId, now);
    if (p) this.byChat.delete(chatId);
    return p;
  }

  clear(chatId: number): boolean { return this.byChat.delete(chatId); }
  get size(): number { return this.byChat.size; }
}
