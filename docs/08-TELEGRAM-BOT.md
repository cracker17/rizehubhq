# 08 · Telegram Bot

Your pocket command line. Long polling (no domain or webhook needed), so it runs the same on your laptop and on the VPS. **Only whitelisted Telegram user IDs** can use it — everyone else gets no response.

## Commands

| Command | What it does |
|---|---|
| `/start` | Links your Telegram (checks whitelist), shows menu |
| `/assign <text>` | Creates a request (`source=telegram`). Supports `!urgent`, `@client-slug`, `due:fri` |
| *(plain message)* | Treated as `/assign` — just type what you need |
| *(voice note / audio file)* | Transcribed, echoed as "🎙 Heard: …", then handled exactly like a typed message (see *Voice notes*) |
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
- **2FA on (docs/09):** ✅ on a high-risk external action (publish, send, merge, deploy, spend…) answers "Needs your 2FA code: approve this one in the dashboard" and changes nothing; ✏️ and ❌ still work. Plans, deliverables and questions are unaffected. Plans approved by an auto-approve rule read "⚡ Auto-approved" with the rule.
- After a decision the message is edited to show the result ("✅ Approved by you 14:02") so it's never actioned twice. Callback data = `ap:<approval_id>:<action>`; the bot re-checks `status='pending'` before applying.

## Voice notes

Hold the mic in the chat and say what you would have typed (up to **2 minutes / 8 MB**; audio files such as mp3 / m4a
work too). The bot has no worker secret (CLAUDE.md rule 2), so the clip goes through Supabase:

1. Bot (`apps/bot/src/voice.ts`): whitelisted users only; checks length / size / type first (a friendly reply
   otherwise), downloads the file (`getFile` → `https://api.telegram.org/file/bot<token>/<file_path>`), inserts it
   into `voice_notes` (service role) and replies "🎙 Transcribing…".
2. Worker (`apps/worker/src/voiceNotes.ts`, every 3 s): `voice_note_claim()` (oldest pending, `for update skip locked`
   → `working`), transcribes with the same Whisper chain as the dashboard mic (`config/models.yaml` `transcription:`),
   then `voice_note_finish()` → `done` with the text or `failed` with the reason. Logs `usage.transcribe` with
   `source: telegram` (model, seconds; never the text).
3. Bot polls the row every 1.5 s for up to 60 s. Done → "🎙 Heard: <text>", then the text goes through the same
   function as a typed message (`intake.ts` `processText`: a pending change note / answer first, otherwise a new
   request). Failed or timed out → the reason and "Please type it instead."

Privacy: the audio is stored only until it is transcribed. Finishing (done or failed) clears it, a check constraint
keeps finished rows audio-free, the bot drops it when it stops waiting, and clips older than 5 minutes are expired on
the next claim. Only the service role writes or claims (`20260929050000_voice_notes.sql`); the CEO can read status and
transcript, never the audio. Neither app logs audio or transcripts. A spoken 2FA code (Vault question pending) is
never echoed: the bot says "Heard your code (not shown)" and deletes the voice message, like a typed code.

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

### Email (second channel, built 2026-10-09: "Email me updates")
Telegram and the dashboard stay the place to decide. On top, the worker can email the CEO a **copy** of each update
(`apps/worker/src/notify/ceoEmail.ts`, every 30 s, skipped while HQ is paused). Off until the CEO turns it on in
Admin → Connectors → *Email me updates* (docs/15 §5c).

| Switch (default) | What is emailed | Subject |
|---|---|---|
| Results (on) | every `deliverable` approval (QA passed): request text, agent, QA score + notes, summary, the **full content** (Markdown rendered to safe HTML, cut at 50,000 characters), links, the saved files and folder (`output.storage`) | `✅ Result ready: <task>` |
| Questions (on) | `ask_ceo` questions (`payload.type = 'question'`) with the options | `❓ <agent> asks: <question>` |
| Failures (on) | `task_failed`, `planning_failed` (the request itself failed), `qa_escalation`, `qa_stuck` | `⚠️ Task failed: …` / `⚠️ Request failed: …` / `⚠️ QA keeps failing: …` |
| Plans (off) | the COO's plan: tasks with agents, estimated cost, questions | `📋 Plan to approve: …` |

- Never emailed: action approvals (send / publish / app calls / RizeHub actions) and Vault 2FA questions; they stay on
  Telegram and in the dashboard.
- Every email has an **Open in HQ** button (`<DASHBOARD_URL>/approvals?id=<id>`) and says that approving happens in HQ
  or Telegram: there are no buttons that act. Plain-text alternative included; branded "RizeHub HQ" only.
- Once per approval (`ceo_email_log` key `approval:<id>`), only approvals created after the emails were turned on
  (`enabled_at`, no backfill), at most 10 per tick. A fresh deliverable waits up to 2 minutes for its storage links.
  A failed send is retried up to 3 times, 2 minutes apart; a rejected App Password marks the account *needs a new App
  Password* and stops sending until it is replaced.
- Quiet hours do not apply (email is not a push notification).

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
