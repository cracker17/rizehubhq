# 13 · Workflows (playbooks the AI team runs)

Each workflow is what the COO turns a request into. You type a sentence in the dashboard (or Telegram); the COO matches it to a playbook, fills in the details, and sends you the plan to approve. Playbooks live in `brain/playbooks/<name>.md` so you can edit them without touching code.

Legend: 🤖 agent does it · ✅ your approval · 🔍 QA checks it

---

## 1. Find leads (RizeHub Lead Finder)

**You type:** "Find 30 Shopify stores in Australia with slow sites and draft outreach"

| Step | Who | What |
|---|---|---|
| 1 | 🤖 COO | Plan: search criteria, list name, number of leads, outreach channel |
| 2 | ✅ You | Approve plan |
| 3 | 🤖 Sales Agent | `leads_search` in RizeHub Lead Finder → waits for `job.completed` |
| 4 | 🤖 Sales Agent | For each lead: visit the site, confirm the signal (e.g. real PageSpeed score), check fit, write notes + fit score (0–100) via `lead_add_notes`; drop poor fits |
| 5 | 🤖 Sales Agent | Save the top leads to a RizeHub list; draft a personalized first message per lead (email or DM) using one real finding from their site |
| 6 | 🔍 QA | Every claim in each message matches the lead's actual site; names/URLs correct; no fake stats; tone matches `brain/company/brand-voice.md`; opt-out line on emails |
| 7 | ✅ You | Lead report + drafts in one approval: approve all, edit some, drop some |
| 8 | You send | You send DMs yourself; approved emails can be sent by the worker from the RizeHub mailbox (volume-capped, see rules) |
| 9 | 🤖 Sales Agent | Stage → "contacted"; schedules follow-up drafts for day 3 and day 7 (each needs approval) |

**Output you get:** a lead report (table: company, site, platform, signal found, fit score, recommended angle) + message drafts.

**Rules:**
- Business contact info only (company emails, published business profiles). No personal data scraping.
- Every email: real sender name, RizeHub address, one-click opt-out; honor opt-outs permanently (RizeHub stores a suppression list). Follow the anti-spam law of the lead's country (e.g. CAN-SPAM, Australia's Spam Act, PH Data Privacy Act).
- Max 30–50 cold emails/day from one warmed-up domain; never from your main domain. Social DMs are always sent by you.

---

## 2. Find jobs & draft applications (you apply)

**You type:** "Find remote Shopify developer jobs posted this week and draft applications"

| Step | Who | What |
|---|---|---|
| 1 | 🤖 Sales Agent | Collect listings from **allowed sources only**: job-alert emails in your Gmail (OnlineJobs.ph, Indeed, LinkedIn, Upwork alerts), public RSS/APIs of remote job boards, and links you paste |
| 2 | 🤖 Sales Agent | Screen each job against `brain/career/job-filters.md` (role, rate, hours, platform, red flags like "free test project", recruiters posing as clients) → score |
| 3 | 🤖 Sales Agent | For the top matches: tailored application (hook on their exact problem, 3–5 portfolio links for that platform from `brain/career/portfolio.md`, right resume link, screening answers) |
| 4 | 🔍 QA | Answers every screening question; portfolio links match the platform; word count fits the site (e.g. 200–250 for OnlineJobs.ph); no invented experience |
| 5 | ✅ You | Review the shortlist: each job with score, why it fits, and the draft |
| 6 | You apply | Open the job link, paste the draft, submit |
| 7 | 🤖 Sales Agent | You tap "Applied" → it's tracked in HQ (`job_opportunities`); follow-up reminder drafted after 5 days |

**Why you click apply:** most job sites ban bots from submitting applications and suspend accounts that do. The AI does 95% of the work; your click keeps your accounts safe.

**Files to write first:** `brain/career/job-filters.md`, `brain/career/portfolio.md`, `brain/career/application-style.md` (your tone rules, example winning applications).

---

## 3. Onboard a new client

**Trigger:** you type "Onboard Madam Muse on the SEO retainer" **or** RizeHub sends `client.signed_up` / `payment.received` (auto-creates the request).

| Step | Who | What |
|---|---|---|
| 1 | 🤖 COO | Plan from `brain/playbooks/onboarding.md` + the service package |
| 2 | ✅ You | Approve plan |
| 3 | 🤖 COO | Collect intake: company, contacts, website, platform, goals, brand files, access needed (from the signed proposal, intake form, or email thread) |
| 4 | 🤖 COO | `account_create` + `workspace_create` from the right template in **dry run** → preview |
| 5 | ✅ You | Approve: "Create account + workspace for Madam Muse (SEO retainer template)" |
| 6 | 🤖 Worker | Executes the real calls; configures workspace (site URL, services, report schedule) |
| 7 | 🤖 COO | Creates `brain/clients/<slug>/profile.md` + `brand.md`; adds client row in HQ with RizeHub IDs; lists the access still needed (Shopify collaborator, GA4, Search Console, hosting…) with step-by-step instructions, and prepares a **secure access link** so the client enters logins straight into the Client Vault |
| 7b | ✅ You | Approve sending the access link; when the client submits, you set which agents may use each login (grants) |
| 8 | 🤖 COO | Drafts the welcome email + RizeHub invite + kickoff call agenda |
| 9 | 🔍 QA | Reads the account/workspace back from RizeHub and checks every field against the intake; checks the welcome email |
| 10 | ✅ You | Approve sending the invite + welcome email |
| 11 | 🤖 COO | Creates the first-month work plan (e.g. baseline audit, first report date) as a new request for your approval |

**Output:** a live RizeHub account + configured workspace, client file in the brain, access checklist, welcome email sent, first-month plan waiting for you.

---

## 4. Monthly client report (RizeHub report tools)

**Trigger:** schedule (e.g. the 1st of each month per workspace) or "Make the September report for Vinyl Icons".

| Step | Who | What |
|---|---|---|
| 1 | 🤖 COO | `report_generate` (type from the workspace, previous month) → waits for job |
| 2 | 🤖 Content Writer | Reads metrics, writes the human part: summary, wins, drops and why, next month's plan; `report_add_notes` |
| 3 | 🔍 QA | Every number in the text matches the report data; period correct; comparisons (MoM/YoY) re-computed; client name right; RizeHub branding only; links work |
| 4 | ✅ You | Preview link + QA score → approve |
| 5 | 🤖 Worker | `report_publish` (client sees it in RizeHub) + drafts cover email |
| 6 | ✅ You | Approve the email (or enable "auto-send report emails after QA pass" per client later) |

---

## 5. Client work requests (build, fix, content)

**You type:** "Madam Muse needs a bundle landing page + 3 ad graphics by Friday"
Covered in 05-ORCHESTRATION. With RizeHub connected, the COO also:
- reads the client's workspace (services included, open projects) to check the request is in scope; out-of-scope → flags it and has the Sales Agent draft a quote
- logs the finished deliverables into the client's RizeHub workspace (`POST /workspaces/{id}/projects` updates) so the client sees progress

---

## 6. Proposals & follow-ups (Sales Agent)

**You type:** "Send a proposal to the lead from Brisbane Coffee Co for a Shopify speed fix"
1. 🤖 Sales Agent pulls the lead from RizeHub (notes, audit findings) + `brain/company/pricing.md`
2. 🤖 drafts the proposal (scope, timeline, price only from the pricing file) as a RizeHub-branded PDF
3. 🔍 QA checks prices against the pricing file and the findings against the lead
4. ✅ You approve → sent → stage "proposal sent" → follow-ups scheduled as drafts
5. When signed/paid → webhook → **Onboard** workflow starts automatically

---

## 7. Daily rhythm (automatic)

| Time (Manila) | What |
|---|---|
| 08:00 | Morning brief: new leads, job matches, approvals waiting, reports due, deadlines |
| Throughout | Approvals pushed to Telegram as they're ready |
| 18:00 | CEO digest: done today, pipeline movement (leads → replies → proposals → clients), jobs applied, spend |
| Monday 08:00 | Weekly: pipeline, client health (reports late? access missing?), QA pass rate, cost per workflow |

---

## Adding a new workflow

1. Write `brain/playbooks/<name>.md`: trigger, steps, owner agent per step, approvals, QA checks, output.
2. Add the `work_type`s to `agents/roster.yaml`.
3. Add a QA checklist to `brain/qa-checklists/`.
4. If it needs RizeHub, add the endpoint to 12 and the tool to the worker.
5. Run it 3 times with you watching before letting it run on a schedule.
