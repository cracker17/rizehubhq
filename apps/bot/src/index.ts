// RizeHub HQ Telegram bot (docs/08-TELEGRAM-BOT.md). Long polling; only whitelisted users.
// Commands + approval buttons here; outbound notifications in notifier.ts (polls Supabase every 5 s).
import { Bot, GrammyError } from 'grammy';
import { createClient } from '@supabase/supabase-js';
import { summarizeSpend, localDate } from './budget';
import { parseCallback } from './callbacks';
import { createSupabaseBotDb } from './db';
import { onButton, onNoteText, type DecisionDeps } from './decisions';
import { loadBotConfig } from './env';
import { formatBudget, formatQuickSummary, formatReport, formatStatus, hhmmIn } from './format';
import type { InlineMarkup } from './keyboard';
import { notifierTick, renderApproval, tzOf, type NotifierState, type Sender } from './notifier';
import { parseAssign } from './parse';
import { PendingNotes } from './pending';

const cfg = loadBotConfig(process.env);
if (!cfg.supabaseUrl || !cfg.serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const db = createSupabaseBotDb(createClient(cfg.supabaseUrl, cfg.serviceKey, { auth: { persistSession: false } }));
const bot = new Bot(cfg.token);
const pending = new PendingNotes();

// ---------- cached lookups ----------
let names = new Map<string, string>();
let tz = 'Asia/Manila';
async function refreshLookups() {
  try {
    names = new Map((await db.agents()).map((a) => [a.id, a.name]));
    tz = tzOf(await db.getSettings());
  } catch (e) { console.error('[bot] lookup refresh failed', e); }
}

// ---------- Telegram I/O ----------
const html = (markup?: InlineMarkup) => ({ parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) });
const notModified = (e: unknown) => e instanceof GrammyError && /message is not modified/i.test(e.description);
const sender: Sender = {
  send: async (chatId, text, markup) => (await bot.api.sendMessage(chatId, text, html(markup))).message_id,
  edit: async (chatId, messageId, text, markup) => {
    try { await bot.api.editMessageText(chatId, messageId, text, html(markup ?? { inline_keyboard: [] })); }
    catch (e) { if (!notModified(e)) throw e; }
  },
};
const decisionDeps: DecisionDeps = { db, pending, names: () => names, dashboardUrl: cfg.dashboardUrl, tz: () => tz };

// Silently ignore everyone who is not whitelisted (messages and button taps).
bot.use(async (ctx, next) => { if (ctx.from && cfg.allowed.has(ctx.from.id)) await next(); });

const HELP = [
  '<b>RizeHub HQ commands</b>',
  '/assign &lt;request&gt; : give the team work (or just type it)',
  '   quick tags: !urgent @client-slug due:fri',
  '/approvals : pending approvals with buttons',
  '/status : who is working, on break or needs you',
  '/report : today\'s CEO digest (or a live summary)',
  '/budget : spend today and this month',
  '/pause · /resume : stop / restart new work',
  '/cancel : drop a pending change note',
  '/help : this list',
  `Dashboard: ${cfg.dashboardUrl}`,
].join('\n');

bot.command('start', (ctx) => ctx.reply(`Welcome, CEO.\n\n${HELP}`, html()));
bot.command('help', (ctx) => ctx.reply(HELP, html()));

async function createRequest(text: string, reply: (m: string) => Promise<unknown>) {
  const p = parseAssign(text, new Date(new Date().toLocaleString('en-US', { timeZone: tz })));
  if (!p.text) return reply('Tell me what you need, e.g. /assign @madam-muse due:fri bundle landing page with 3 ads');
  try {
    const r = await db.createRequest({ text: p.text, priority: p.priority, dueDate: p.dueDate, clientSlug: p.clientSlug });
    return reply(`Staged. The COO is planning it; the plan will come here for approval.${p.clientSlug && !r.clientFound ? `\n(Note: no client "${p.clientSlug}" found yet.)` : ''}`);
  } catch (e) {
    return reply(`Couldn't stage that: ${e instanceof Error ? e.message : String(e)}`);
  }
}

bot.command('assign', (ctx) => createRequest(ctx.match, (m) => ctx.reply(m)));

bot.command('status', async (ctx) => {
  try {
    const [agents, settings] = await Promise.all([db.agents(), db.getSettings()]);
    return ctx.reply(formatStatus(agents, settings.paused === true || settings.paused === 'true'), html());
  } catch (e) { return ctx.reply(`Couldn't read the office: ${e instanceof Error ? e.message : String(e)}`); }
});

bot.command('approvals', async (ctx) => {
  const { rows, total } = await db.pendingApprovals(10);
  if (!rows.length) return ctx.reply('📥 Inbox zero. Nothing is waiting for you.');
  for (const ap of rows) {
    const { text, markup } = renderApproval(ap, names, cfg.dashboardUrl, tz);
    const msg = await ctx.reply(text, html(markup));
    if (!ap.telegram_message_id) await db.setApprovalMessageId(ap.id, msg.message_id); // the notifier won't send it again
  }
  if (total > rows.length) await ctx.reply(`…and ${total - rows.length} more in the dashboard: ${cfg.dashboardUrl}/approvals`);
});

bot.command('report', async (ctx) => {
  const today = localDate(new Date(), tz);
  const digest = await db.latestReport('daily_digest', today);
  if (digest) return ctx.reply(formatReport(digest, names, cfg.dashboardUrl), html());
  const facts = await db.reportFacts(today);
  return ctx.reply(formatQuickSummary(facts, names, `today ${hhmmIn(new Date().toISOString(), tz)}`), html());
});

bot.command('pause', async (ctx) => {
  await db.setPaused(true);
  return ctx.reply('⏸ Paused. Agents finish what they are on; nothing new starts. /resume to continue.');
});
bot.command('resume', async (ctx) => {
  await db.setPaused(false);
  return ctx.reply('▶️ Resumed. The team is picking up work again.');
});

bot.command('budget', async (ctx) => {
  const [rows, settings] = await Promise.all([db.spendRows(new Date(Date.now() - 32 * 86400_000).toISOString()), db.getSettings()]);
  const monthly = cfg.monthlyBudgetUsd ?? (Number(settings.monthly_budget_usd) || 0);
  const daily = Number(settings.daily_budget_usd) || null;
  return ctx.reply(formatBudget(summarizeSpend(rows, new Date(), tzOf(settings)), monthly, daily, names), html());
});

bot.command('cancel', (ctx) => ctx.reply(pending.clear(ctx.chat.id) ? 'OK, no change note sent.' : 'Nothing to cancel.'));

// ---------- approval buttons ----------
bot.on('callback_query:data', async (ctx) => {
  const cb = parseCallback(ctx.callbackQuery.data);
  const msg = ctx.callbackQuery.message;
  if (!cb || !msg) return ctx.answerCallbackQuery({ text: 'Unknown button' });
  try {
    const out = await onButton(decisionDeps, msg.chat.id, msg.message_id, cb.approvalId, cb.action);
    if (out.kind === 'edit') {
      await sender.edit(msg.chat.id, msg.message_id, out.text, out.markup);
      return ctx.answerCallbackQuery({ text: out.toast });
    }
    await ctx.answerCallbackQuery({ text: out.toast });
    if (out.kind === 'ask_note') await ctx.reply(out.prompt, { reply_markup: { force_reply: true, input_field_placeholder: 'Your note…' } });
  } catch (e) {
    console.error('[bot] decision failed', e);
    return ctx.answerCallbackQuery({ text: `Couldn't apply that: ${e instanceof Error ? e.message.slice(0, 150) : 'error'}`, show_alert: true });
  }
});

// ---------- plain text: a pending change note, otherwise a new request ----------
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return ctx.reply(HELP, html());
  try {
    const note = await onNoteText(decisionDeps, ctx.chat.id, text);
    if (note) {
      // A 2FA code never stays in the chat history.
      if (note.secret) await ctx.deleteMessage().catch((e) => console.error('[bot] could not delete the code message', e instanceof Error ? e.message : e));
      await sender.edit(ctx.chat.id, note.messageId, note.edit.text, note.edit.markup).catch((e) => console.error('[bot] edit failed', e));
      return ctx.reply(note.reply);
    }
  } catch (e) {
    return ctx.reply(`Couldn't apply your note: ${e instanceof Error ? e.message : String(e)}`);
  }
  return createRequest(text, (m) => ctx.reply(m));
});

bot.catch((err) => console.error('[bot]', err.error));

// ---------- outbound notifier ----------
const state: NotifierState = { lastDecisionSync: new Date().toISOString() };
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const r = await notifierTick({ db, sender, chatId: cfg.notifyChatId, dashboardUrl: cfg.dashboardUrl, names: () => names }, state);
    if (r.sent || r.reports || r.synced) console.log(`[bot] sent ${r.sent} approval(s), ${r.reports} report(s), updated ${r.synced}${r.held ? `, holding ${r.held} (quiet hours)` : ''}`);
  } catch (e) {
    console.error('[bot] notifier tick failed', e instanceof Error ? e.message : e);
  } finally { ticking = false; }
}

await refreshLookups();
setInterval(() => { void refreshLookups(); }, 10 * 60_000);
setInterval(() => { void tick(); }, cfg.pollMs);
void tick();

bot.start({ onStart: (me) => console.log(`[bot] @${me.username} running for ${cfg.allowed.size} user(s); notifying chat ${cfg.notifyChatId} every ${cfg.pollMs / 1000}s`) });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void bot.stop().finally(() => process.exit(0)); });
