# Playbook: proposal (proposals & follow-ups)

**Trigger:** "Send a proposal to the lead from Brisbane Coffee Co for a Shopify speed fix", a lead replying positively (`lead.replied` webhook), or the COO flagging an out-of-scope client request.

**Owner of the plan:** COO. **Main agent:** sales (Sales Agent). **Work types:** proposal, follow-up-email.

## Steps
| # | Owner | Step | Output |
|---|---|---|---|
| 1 | coo | Plan: lead/client, service, deliverables, deadline for the proposal; supporting tasks if needed (e.g. sales `lead-report` for fresh audit numbers, designer `ux-audit`) | Plan |
| 2 | CEO | Approve plan | ✅ |
| 3 | sales (`proposal`) | Pull lead from RizeHub (notes, audit findings, thread) + `brain/company/pricing.md` + `services.md`; draft RizeHub-branded proposal: problem (their verified findings), scope (in/out), deliverables, timeline, price only from the pricing file, terms, next step | Proposal PDF/doc + cover email draft |
| 4 | qa-lead | Checks below | Verdict |
| 5 | CEO | Approve (or edit price/scope) | ✅ |
| 6 | worker | Sends proposal via approved external action; lead stage → "proposal sent" | Sent |
| 7 | sales (`follow-up-email`) | Follow-up drafts at day 3 and day 7 (value-add, not "just checking in"); each needs approval; stop on reply | Drafts |
| 8 | worker/webhook | Signed/paid → `client.signed_up` / `payment.received` → **onboarding** playbook starts | Onboarding request |

## Approvals
Plan · proposal + price · every send · every follow-up.

## QA focus
Every price and package matches `brain/company/pricing.md` exactly; findings match the lead's notes and live site (re-measure PageSpeed if cited); scope has in/out lists; timeline realistic for scope; no guarantees of rankings/revenue; no fake case studies or testimonials; lead name/company/URL correct; RizeHub branding; opt-out line for cold follow-ups.

## Rules
- Custom pricing not in the pricing file → `ask_ceo`, never improvise.
- Results claims only from real, documented work in `brain/` with client permission (FTC rules).
- Maximum two follow-ups unless the CEO asks otherwise.

## Output
Approved, sent proposal; lead stage updated; follow-up drafts scheduled; automatic hand-off to onboarding on signature/payment.
