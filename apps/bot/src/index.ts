// RizeHub HQ Telegram bot (docs/08-TELEGRAM-BOT.md). Long polling; only whitelisted users.
import { Bot } from 'grammy';
import { createClient } from '@supabase/supabase-js';
import { parseAssign } from './parse';

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowed = new Set((process.env.TELEGRAM_ALLOWED_USER_IDS ?? '').split(',').map((s) => Number(s.trim())).filter(Boolean));
const dashboard = process.env.DASHBOARD_URL ?? 'https://hq.rizehub.ph';
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (allowed.size === 0) throw new Error('TELEGRAM_ALLOWED_USER_IDS is required (your numeric Telegram id)');

const db = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', { auth: { persistSession: false } });
const bot = new Bot(token);

// Silently ignore everyone who is not whitelisted.
bot.use(async (ctx, next) => { if (ctx.from && allowed.has(ctx.from.id)) await next(); });

const HELP = [
  'RizeHub HQ commands:',
  '/assign <request> : give the team work (or just type it)',
  '   quick tags: !urgent @client-slug due:fri',
  '/status : who is working, on break or needs you',
  '/help : this list',
  `Dashboard: ${dashboard}`,
].join('\n');

bot.command('start', (ctx) => ctx.reply(`Welcome, CEO. ${HELP}`));
bot.command('help', (ctx) => ctx.reply(HELP));

async function createRequest(text: string, reply: (m: string) => Promise<unknown>) {
  const p = parseAssign(text, new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })));
  if (!p.text) return reply('Tell me what you need, e.g. /assign @madam-muse due:fri bundle landing page with 3 ads');
  let clientId: string | null = null;
  if (p.clientSlug) {
    const { data } = await db.from('clients').select('id').eq('slug', p.clientSlug).maybeSingle();
    clientId = data?.id ?? null;
  }
  const { data, error } = await db.from('requests')
    .insert({ source: 'telegram', raw_text: p.text, priority: p.priority, due_date: p.dueDate, client_id: clientId })
    .select('id').single();
  if (error) return reply(`Couldn't stage that: ${error.message}`);
  await db.from('activity_log').insert({ actor: 'ceo', action: 'request.created', request_id: data.id, detail: { source: 'telegram' } });
  return reply(`Staged. The COO is planning it; the plan will come here for approval.${p.clientSlug && !clientId ? `\n(Note: no client "${p.clientSlug}" found yet.)` : ''}`);
}

bot.command('assign', (ctx) => createRequest(ctx.match, (m) => ctx.reply(m)));

bot.command('status', async (ctx) => {
  const { data, error } = await db.from('agents').select('name,status').eq('enabled', true);
  if (error || !data) return ctx.reply(`Couldn't read the office: ${error?.message}`);
  const by = (s: string) => data.filter((a) => a.status === s).map((a) => a.name);
  const working = by('working'), idle = by('idle'), needs = [...by('waiting'), ...by('blocked')];
  return ctx.reply(`Working (${working.length}): ${working.join(', ') || 'nobody'}\nOn break (${idle.length}): ${idle.join(', ') || 'nobody'}\nNeed you (${needs.length}): ${needs.join(', ') || 'nobody'}`);
});

bot.on('message:text', (ctx) => {
  if (ctx.message.text.startsWith('/')) return ctx.reply(HELP);
  return createRequest(ctx.message.text, (m) => ctx.reply(m));
});

bot.catch((err) => console.error('[bot]', err.error));
bot.start({ onStart: (me) => console.log(`[bot] @${me.username} running for ${allowed.size} user(s)`) });
