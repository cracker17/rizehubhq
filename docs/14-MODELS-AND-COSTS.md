# 14 · AI Models, Providers & Costs

RizeHub HQ is **provider-agnostic**. Every agent asks for a *role* ("lead", "specialist", "qa", "light"), not a specific model. A single config file maps roles to models, so moving from free models to Claude or OpenAI is a config change, not a rewrite.

## How it works

- **Vercel AI SDK** (`ai` package, free, open-source) is the agent runtime. The same code talks to Gemini, Groq, OpenRouter, Anthropic (Claude), OpenAI and Moonshot (Kimi), and it supports tool calling and multi-step agent loops on all of them.
- **Model router** (`apps/worker/src/models/router.ts`) picks the model for each call from the active **profile**, checks the provider's remaining free quota and the budget, and falls back to the next provider when a limit is hit. Provider errors skip only the model that failed (free-tier limits are per model): a daily quota 429 (Gemini free tier is 20 requests/day per model; OpenRouter free accounts about 50/day across all free models), a 404 (retired model) or a 413 (request over the model's per-minute size cap, e.g. Groq free tier 8k tokens/min on a long agent loop) skip it until the next Manila day; a per-minute 429 for 2 minutes; an overloaded model (Gemini 503 "high demand", Anthropic 529, other 5xx after the SDK's retries) for 10 minutes. Speech-to-text (voice input, docs/06) uses the `transcription:` list in `config/models.yaml` (Groq Whisper on the free key). **Free-tier reality (checked 2026-09-29):** those limits carry roughly 5 to 10 agent tasks a day in total; for regular use add a paid provider with MONTHLY_BUDGET_USD / DAILY_AI_BUDGET_USD caps (docs/15 §7).
- **Usage meter**: every call logs provider, model, tokens in/out, cached tokens and cost into `activity_log`. The dashboard shows spend per agent, per workflow and per client.

```
Agent (role: specialist) ─► Router ─► profile "free"   → gemini-flash  ─(quota hit)→ groq llama/qwen ─→ openrouter :free
                                  └► profile "claude" → claude-sonnet-5
                                  └► profile "openai" → gpt mid-tier
```

## Profiles (`config/models.yaml`)

```yaml
active_profile: free        # free | paid | hybrid | claude | openai | kimi
                            # can also be overridden per agent in the Agents page

profiles:
  free:
    lead:       [google:gemini-flash, groq:qwen-or-llama-large, openrouter:free-large]
    specialist: [google:gemini-flash, groq:qwen-or-llama-large, openrouter:free-large]
    qa:         [google:gemini-flash, groq:qwen-or-llama-large]
    light:      [groq:llama-small, google:gemini-flash-lite]
  hybrid:                    # first paid step: pay only where quality matters most
    lead:       [anthropic:claude-sonnet-5]
    specialist: [google:gemini-flash, groq:qwen-or-llama-large]   # leads, jobs, content, design briefs
    dev:        [anthropic:claude-sonnet-5]                        # dev agents get their own role
    reports:    [anthropic:claude-sonnet-5]
    qa:         [anthropic:claude-sonnet-5]
    light:      [groq:llama-small]
  claude:
    lead:       [anthropic:claude-opus-5-5]     # or claude-sonnet-5 for value
    specialist: [anthropic:claude-sonnet-5]
    dev:        [anthropic:claude-sonnet-5]
    reports:    [anthropic:claude-sonnet-5]
    qa:         [anthropic:claude-opus-5-5]     # or claude-sonnet-5 for value
    light:      [anthropic:claude-haiku-4-5]
  openai:
    lead:       [openai:<flagship>]
    specialist: [openai:<mid-tier>]
    dev:        [openai:<mid-tier>]
    reports:    [openai:<mid-tier>]
    qa:         [openai:<flagship>]
    light:      [openai:<nano/mini>]
```
Exact model IDs change often. Put the current IDs from each provider's docs into this file; the code never hard-codes them.

## Paid profile, per-role model IDs and the daily cap (six-agent roster)

- `MODEL_PROFILE=paid`: Anthropic for COO (lead), Web Developer (dev), Sales (sales) on Sonnet and Graphic Designer (design), Content Writer (writer), chat/reports on Haiku; QA on OpenAI (a different provider on purpose), Sonnet only if OpenAI is unavailable. Needs `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `MONTHLY_BUDGET_USD > 0`.
- Model IDs are not hard-coded: `MODEL_ID_LEAD`, `MODEL_ID_DEV`, `MODEL_ID_DESIGN`, `MODEL_ID_WRITER`, `MODEL_ID_SALES`, `MODEL_ID_QA`, `MODEL_ID_LIGHT` (format `provider:model`) win over `config/models.yaml`; the yaml lists are the documented defaults and fallbacks. Order: agent override (Agents page) → env → profile list.
- Prompt caching: every Anthropic call sends the system prompt as a cached system message (`models/cache.ts` `cachedPrompt`, used by the planner, runner and QA) and the runner adds a rolling breakpoint on the newest message.
- `DAILY_AI_BUDGET_USD` (0 = no cap; else `settings.daily_budget_usd`): every model run is logged with its cost per task (`tasks.cost_usd`), agent (`activity_log.actor`) and client (`activity_log.client_id`); query them through the `ai_usage` view. At 80% of today's (Asia/Manila) spend the worker records one alert (`budget_alerts`, once per day and level) and the bot sends it to Telegram; at 100% another alert, and **paid providers stop**: new planning, tasks and QA run on the `free` profile when a free provider key is set, otherwise nothing new starts until midnight Manila time. Running work finishes. The dashboard `/costs` page shows the meter and the breakdowns.

## Which models count as paid

The router (`isPaidSpec` in `models/router.ts`) and the price table (`priceFor` in `models/usage.ts`) use one rule:

| Provider | Key | Paid? | Priced at |
|---|---|---|---|
| `google` (Gemini) | `GOOGLE_GENERATIVE_AI_API_KEY` | no (free tier) | $0 |
| `groq` | `GROQ_API_KEY` | no (free tier) | $0 |
| `openrouter` model ending in `:free` | `OPENROUTER_API_KEY` | no | $0 |
| `openrouter` model **without** `:free` | `OPENROUTER_API_KEY` | **yes** | the matching `PRICES` entry (vendor prefix dropped: `anthropic/claude-sonnet-5` → Sonnet price), else the fallback $2 / $10 |
| `anthropic` | `ANTHROPIC_API_KEY` | yes | `PRICES` |
| `openai` | `OPENAI_API_KEY` | yes | `PRICES` (placeholder tiers) |
| `moonshot` (Kimi) | `MOONSHOT_API_KEY` | yes | `PRICES` (below) |

Paid models only run when `MONTHLY_BUDGET_USD > 0` and stop for the day at `DAILY_AI_BUDGET_USD`. Before M13.1 every OpenRouter call counted as $0, so a non-`:free` OpenRouter model bypassed both caps; it is now priced and gated like any paid model. The `/costs` model mix marks it paid too.

## Kimi backup (Moonshot, docs/15 §7)

- Provider `moonshot`: OpenAI-compatible chat/completions at `https://api.moonshot.ai/v1`, key `MOONSHOT_API_KEY` (platform.kimi.ai). The router builds it with `@ai-sdk/openai` `createOpenAI({ baseURL }).chat(model)` (chat/completions, not the Responses API).
- **Free profile**: `moonshot:kimi-k2.6` is the last entry of every role, so it only runs when every Gemini, Groq and OpenRouter-free model is unavailable (quota, 404, overload) **and** `MONTHLY_BUDGET_USD > 0`. With a budget of 0 it is skipped and the task waits, as before.
- **`kimi` profile** (`MODEL_PROFILE=kimi`): lead and QA on `kimi-k3`, every other role on `kimi-k2.6`.
- Prices (USD per million tokens, verified 2026-09-29 on platform.kimi.ai):

| Model | Input | Cache read | Output |
|---|---|---|---|
| kimi-k3 | $3.00 | $0.30 | $15.00 |
| kimi-k2.7-code | $0.95 | $0.19 | $4.00 |
| kimi-k2.6 | $0.95 | $0.16 | $4.00 |

- Moonshot's new-account tier allows 3 requests/minute (too low for agent loops): top up past tier 0 before relying on it. A 429 per-minute limit skips the model for 2 minutes like any other provider.
- **Verify in production (not covered by tests):** (1) multi-turn tool calls with Kimi. Kimi may return `reasoning_content` alongside tool calls, and Moonshot may expect it sent back on the next turn; the OpenAI chat provider does not echo it. If tool loops fail on the second step, that is the cause. (2) Whether Moonshot reports cached tokens where the OpenAI provider reads them (`prompt_tokens_details.cached_tokens`); if not, cache reads are billed here at the full input price (overstates cost, never understates).

## Environment keys (only fill what you use)

```
GOOGLE_GENERATIVE_AI_API_KEY=...   # Gemini (free tier)
GROQ_API_KEY=...                   # Groq (free tier)
OPENROUTER_API_KEY=...             # OpenRouter (free models as fallback)
ANTHROPIC_API_KEY=                 # later: Claude
OPENAI_API_KEY=                    # later: OpenAI
MOONSHOT_API_KEY=                  # optional: Kimi, paid last-resort backup (see "Kimi backup" below)
MODEL_PROFILE=free                 # free | paid | hybrid | claude | openai | kimi
MONTHLY_BUDGET_USD=0               # 0 = free models only (no Anthropic/OpenAI/Kimi/paid OpenRouter); raise when you switch to paid
DAILY_AI_BUDGET_USD=0              # 0 = no daily cap; at 100% paid providers stop for the day
MODEL_ID_QA=                       # optional per-role override, e.g. openai:gpt-5.5 (also LEAD, DEV, DESIGN, WRITER, SALES, LIGHT)
```

## Free-tier rules the router enforces

| Rule | Why |
|---|---|
| Track requests per provider per day; switch provider at 90% of the daily limit | Free tiers cap requests per day (roughly 1,000–1,500 per model, and it changes; check each console) |
| Queue low-priority tasks (job hunt, digests) for the next day when all free quota is used | Keeps urgent client work running |
| **Never send secrets or sensitive client data to Gemini's free tier** | Google may use free-tier prompts to improve its models; route client-confidential tasks to Groq or a paid provider |
| Keep prompts lean: send file excerpts, not whole files | Free tiers also cap tokens per minute |
| Dev agents on free models = "draft for review" mode | Free models are weaker at long coding tasks; you review and apply |

## Chat with agents ("what are you doing?")

Uses the **light** role (fast and cheap). The reply is built from the agent's live state: current task, progress, last 10 activity entries, blockers and queue. It never interrupts the running task. Instructions typed in chat ("stop that, do X first") become a request to the COO.

---

## What would Claude cost? (estimate)

**Prices used** (Claude API, per million tokens, from the official pricing page, Sep 2026):

| Model | Input | Cache write | Cache read | Output |
|---|---|---|---|---|
| Claude Opus 5.5 | $4 | $5 | $0.20 | $20 |
| Claude Sonnet 5 | $2 | $2.50 | $0.20 | $10 |
| Claude Haiku 4.5 | $1 | $1.25 | $0.10 | $5 |

**Assumptions**
- Agent tasks make many calls, because each tool step is a call. Per-run numbers are in the table below.
- Prompt caching is on: about 60% of input is read from cache, 10% is written to cache, and 30% is fresh. The system prompt, role file and tool list repeat on every call, so this is realistic.
- Exchange rate: ₱62.75 per $1 (BSP reference rate, 25 Sep 2026).
- These are planning estimates. Real usage can be ±50%. Newer Claude models also count about 30% more tokens for the same text, so budget with a buffer.

**Cost per run**

| Workflow | Calls | Setup A (Opus lead+QA) | Setup B (Sonnet) |
|---|---|---|---|
| COO plan | 3 | $0.13 | $0.07 |
| Find leads (30 leads researched + drafts) | 40 | $0.79 | $0.79 |
| Job hunt (20 screened, 5 drafts) | 25 | $0.32 | $0.32 |
| Client onboarding | 20 | $0.35 | $0.35 |
| Monthly client report | 10 | $0.30 | $0.30 |
| Content piece (article / captions) | 12 | $0.33 | $0.33 |
| Dev task (e.g. a Shopify section) | 60 | $2.65 | $2.65 |
| Design / graphic brief | 8 | $0.13 | $0.13 |
| QA review (per deliverable) | 8 | $0.38 | $0.20 |
| Chat with an agent | 1 | $0.002 | $0.002 |
| Daily digest | 5 | $0.05 | $0.05 |

**Monthly volume per scenario**

| | Starter | Growing | Busy |
|---|---|---|---|
| COO plans | 60 | 150 | 300 |
| Lead searches (30 leads each) | 8 | 20 | 40 |
| Job hunts | 20 | 30 | 30 |
| Onboardings | 2 | 5 | 10 |
| Client reports | 5 | 15 | 30 |
| Content pieces | 20 | 60 | 120 |
| Dev tasks | 8 | 30 | 60 |
| Design briefs | 10 | 30 | 60 |
| QA reviews (incl. revisions) | 70 | 190 | 380 |
| Agent chats | 300 | 900 | 1,800 |

**Monthly cost**

| Scenario | A. Best quality (Opus COO+QA, Sonnet team, Haiku chat) | B. Smart value (Sonnet + Haiku) | C. Hybrid (free models for leads, jobs, content, chat; Sonnet for COO, dev, reports, QA) |
|---|---|---|---|
| **Starter** | $82 ≈ ₱5,150 | $65 ≈ ₱4,100 | **$41 ≈ ₱2,600** |
| **Growing** | $232 ≈ ₱14,500 | $187 ≈ ₱11,700 | **$133 ≈ ₱8,400** |
| **Busy** | $451 ≈ ₱28,300 | $362 ≈ ₱22,700 | **$266 ≈ ₱16,700** |

Where the money goes (Growing, setup B, $187): dev tasks $79 (42%), QA $37, content $20, leads $16, COO plans $10, jobs $10, everything else under $5 each. **Dev work is the big cost**, so moving only the dev and QA agents to Claude (setup C) buys most of the quality for less money.

Not included: VPS hosting (you already pay), Supabase (free tier is enough to start), web search tools, and image generation (Magnific credits).

## Claude runtime (Claude Agent SDK) costs

An agent switched to `runtime: claude` (docs/05 "Claude runtime") runs Claude Code as its agent loop instead of the
built-in runner. It is paid only: it needs `ANTHROPIC_API_KEY` (an Anthropic Console API key; Anthropic does not allow
products built on the Agent SDK to use a claude.ai Pro/Max login) and `MONTHLY_BUDGET_USD > 0`.

- **Prices**: the same `PRICES` table as every Anthropic call (`models/usage.ts`, table above: Opus 5.5 $4/$20, Sonnet
  $2/$10, Haiku $1/$5 per million in/out; cache writes 1.25× input, cache reads $0.20 / $0.20 / $0.10). The worker prices
  each run from the SDK's per-model token totals (`modelUsage`) with this table, records it as `usage.task` with
  `detail.runtime = 'claude'` (plus `sdk_cost_usd`, Claude Code's own estimate, for comparison) and adds it to the month
  and day totals the model picker and the budget guards use.
- **Model**: `CLAUDE_MODEL_<AGENT>` → `CLAUDE_MODEL` → the role's first Anthropic model in the usual order (agent
  override → `MODEL_ID_<ROLE>` → active profile) → the role in the `claude` profile. Never hard-coded.
- **Cap per run**: `maxBudgetUsd` = the smallest of the task cap (role `budget_usd_per_task` and `MAX_COST_PER_TASK_USD`),
  what is left of `MONTHLY_BUDGET_USD` this month and what is left of the daily AI budget today. Claude Code stops the run
  there and the task fails with "exceeded $X task budget", like the built-in runner. Turns: `max_turns` /
  `MAX_STEPS_PER_TASK`, whichever is stricter. Less than $0.05 left → the task runs on the built-in runner instead.
- **Expect** about the dev-task figure above per Claude dev run (Sonnet, ~60 tool steps ≈ $2–3). Raise the role's
  `budget_usd_per_task` (and `MAX_COST_PER_TASK_USD`) to what one task may cost; the defaults ($1.50) stop long dev tasks early.

## Recommended path

1. **Now: profile `free`.** Gemini, Groq and OpenRouter; set `MONTHLY_BUDGET_USD=0`. Leads, jobs, reports and content work well; dev agents draft for review.
2. **First paying clients: profile `hybrid`.** About $40–130 a month. Claude Sonnet 5 for the COO, dev, reports and QA; free models for the rest.
3. **Growing: profile `claude` (setup B), then A.** Switch the COO and QA to Opus only if plans or reviews miss things.
4. At any time you can switch one agent to OpenAI or Claude from the Agents page to compare quality on real tasks. Cost per task is visible in the dashboard.

**Cost controls built in:** monthly and daily budget caps, per-task budget limits, prompt caching on every call, Batch API (50% off) for non-urgent jobs like overnight job hunts and digests, and Haiku or free models for chat and summaries.
