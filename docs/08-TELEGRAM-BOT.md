# 08 · Telegram Bot

Your pocket command line. Long polling (no domain or webhook needed), so it runs the same on your laptop and on the VPS. **Only whitelisted Telegram user IDs** can use it — everyone else gets no response.

## Commands

| Command | What it does |
|---|---|
| `/start` | Links your Telegram (checks whitelist), shows menu |
| `/assign <text>` | Creates a request (`source=telegram`). Supports `!urgent`, `@client-slug`, `due:fri` |
| *(plain message)* | Treated as `/assign` — just type what you need |
| *(voice note — later)* | Transcribed → `/assign` |
| `/status` | Office snapshot: working / idle / waiting / blocked counts + who's on what |
| `/approvals` | Pending approvals, one message each with buttons |
| `/request <id>` | Progress of one request (tasks + statuses) |
| `/report` | Today's CEO digest now |
| `/pause` / `/resume` | Pause all agents (worker stops claiming) / resume |
| `/budget` | Today's spend vs limit, top costs |
| `/leads <criteria>` | Shortcut for the Find Leads playbook, e.g. `/leads 30 shopify AU slow-site` |
| `/jobs` | Today's job shortlist with drafts (Copy / Open / Mark applied buttons) |
| `/onboard <client> <package>` | Starts the onboarding playbook |
| `/report <client> [month]` | Generates a client report via RizeHub report tools |
| `/help` | Command list |

## Approval messages

```
📋 PLAN · Madam Muse — Bundle landing page
4 tasks · est. $4.20 · due Fri Oct 2
1. Content Writer — landing copy
2. Graphic Designer — wireframe (after 1)
3. Web Developer — build on unpublished theme (after 2)
4. Graphic Designer — 3 ad graphics (after 1)

[✅ Approve] [✏️ Changes] [❌ Reject] [🔗 Open]
```
```
✅ QA PASSED 92/100 · Landing copy (Content Writer)
"Build your bundle…" — 540 words, keyword in H1, 3 CTAs
[✅ Approve] [✏️ Changes] [❌ Reject] [🔗 Open]
```
- **Changes** → bot asks "What should change?" → your reply becomes the change note.
- **Open** → deep link to the item in the dashboard.
- After a decision the message is edited to show the result ("✅ Approved by you 14:02") so it's never actioned twice. Callback data = `ap:<approval_id>:<action>`; the bot re-checks `status='pending'` before applying.

## Notifications (bot → you)

| Event | Default |
|---|---|
| New approval (plan / deliverable / action) | Instant |
| New client signed up / paid (RizeHub webhook) | Instant |
| Lead replied | Instant |
| Agent blocked / task failed / QA loop exhausted | Instant |
| Budget 80% / 100% | Instant |
| 2FA code needed (`vault_request_2fa`) | Instant; reply with the code, it's passed to the login and deleted from the chat |
| Client submitted logins via access link | Instant, with a button to set agent grants |
| Morning brief 08:00, daily digest 18:00 | Scheduled |
| Task done / QA pass | Batched into digest (to avoid spam) |
Quiet hours setting (e.g. 22:00–07:00) → only urgent + blocked.

## Implementation sketch

```ts
// apps/bot/src/index.ts
import { Bot, InlineKeyboard } from 'grammy';
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
const allowed = new Set(process.env.TELEGRAM_ALLOWED_USER_IDS!.split(',').map(Number));

bot.use(async (ctx, next) => { if (ctx.from && allowed.has(ctx.from.id)) await next(); });

bot.command('assign', ctx => createRequest(ctx, ctx.match));
bot.on('message:text', ctx => { if (!ctx.message.text.startsWith('/')) return createRequest(ctx, ctx.message.text); });

bot.callbackQuery(/^ap:(.+):(approve|changes|reject)$/, async ctx => {
  const [, id, action] = ctx.match!;
  await decideApproval(id, action, 'telegram');   // re-checks pending, updates row, logs activity
  await ctx.editMessageReplyMarkup();             // remove buttons
  await ctx.answerCallbackQuery({ text: 'Done' });
});

// Outbound: subscribe to Supabase realtime on approvals INSERT → send message with keyboard
bot.start();
```
Outbound notifications can live in the bot (subscribe to realtime inserts) — keeps the worker free of Telegram code.

## Setup
1. `@BotFather` → `/newbot` twice: **RizeHub HQ Dev** (local) and **RizeHub HQ** (production).
2. `/setcommands` in BotFather with the list above.
3. Put tokens in each environment's `.env`. Never run both environments on the same token.
