// What the CEO says to the bot (typed or a transcribed voice note): a pending change note / 2FA code first, otherwise a
// new request (docs/08). Framework-free so it is testable; index.ts adapts grammY contexts to ChatIO.
import type { BotDb } from './db';
import { onNoteText, type DecisionDeps } from './decisions';
import type { InlineMarkup } from './keyboard';
import { parseAssign } from './parse';

export interface IntakeDeps {
  decisions: DecisionDeps;
  db: BotDb;
  tz: () => string;
  /** Edits the approval message a note answered (errors are logged, never shown). */
  edit: (chatId: number, messageId: number, text: string, markup?: InlineMarkup) => Promise<void>;
  now?: () => Date;
}

export interface ChatIO {
  reply: (text: string) => Promise<unknown>;
  /** Removes the CEO's own message (used when it held a one-time code). */
  deleteMine: () => Promise<unknown>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function createRequest(d: Pick<IntakeDeps, 'db' | 'tz' | 'now'>, text: string, reply: ChatIO['reply']) {
  const now = d.now?.() ?? new Date();
  const p = parseAssign(text, new Date(now.toLocaleString('en-US', { timeZone: d.tz() })));
  if (!p.text) return reply('Tell me what you need, e.g. /assign @madam-muse due:fri bundle landing page with 3 ads');
  try {
    const r = await d.db.createRequest({ text: p.text, priority: p.priority, dueDate: p.dueDate, clientSlug: p.clientSlug });
    return reply(`Staged. The COO is planning it; the plan will come here for approval.${p.clientSlug && !r.clientFound ? `\n(Note: no client "${p.clientSlug}" found yet.)` : ''}`);
  } catch (e) {
    return reply(`Couldn't stage that: ${errText(e)}`);
  }
}

/** A plain message (not a command): the pending change note / 2FA code for this chat, else a new request. */
export async function processText(d: IntakeDeps, chatId: number, text: string, io: ChatIO): Promise<unknown> {
  try {
    const note = await onNoteText(d.decisions, chatId, text);
    if (note) {
      // A 2FA code never stays in the chat history.
      if (note.secret) await io.deleteMine().catch((e) => console.error('[bot] could not delete the code message', errText(e)));
      await d.edit(chatId, note.messageId, note.edit.text, note.edit.markup).catch((e) => console.error('[bot] edit failed', e));
      return io.reply(note.reply);
    }
  } catch (e) {
    return io.reply(`Couldn't apply your note: ${errText(e)}`);
  }
  return createRequest(d, text, io.reply);
}
