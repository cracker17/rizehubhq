# SOP: planning (COO)

Goal: turn one CEO request into an approvable plan (docs/05 schema) that specialists can execute without follow-up questions.

## 1. Understand the request (5 min)
- Extract: client, deliverables, quantities, formats, deadline, priority, channel/platform, anything explicitly excluded.
- Client check: `brain/clients/<slug>/profile.md` exists? If not and the request is client work → `questions_for_ceo` ("Client not onboarded. Run onboarding first?").
- `rizehub_readonly`: workspace services, open projects. Not covered by the package → add a `proposal` task for Pipeline Desk and flag in `summary`.
- Match a playbook: lead-gen, job-hunt, onboarding, monthly-report, proposal, client-work. Follow its step order and approval points.

## 2. Break down
- One task = one owner, one work_type, one deliverable, ≤ 2 h human effort. Split bigger work (e.g. "homepage" → hero section, product grid section, footer fix).
- Route by `roster.yaml`; dev by `platform_to_dev`; pairs by specialty (seo-1 e-commerce / seo-2 local & long-form; check role files), else leave either.
- Order: research/copy → wireframe/design → build → media. Anything without a real dependency runs in parallel.

## 3. Write instructions (per task)
Template:
```
Context: <client, goal, audience> (read brain/clients/<slug>/profile.md, brand.md)
Inputs: <files, URLs, dependency task keys>
Do: <exact deliverable, quantity, format, sizes, word counts>
Constraints: <platform rules, unpublished theme/branch, brand, legal>
External steps: <none | "prepare via request_external_action for CEO">
Due: <date, Asia/Manila>
```

## 4. Acceptance criteria (3–7 per task)
Binary, measurable, tool-checkable. Good vs bad:
- Good: "Primary keyword 'shopify speed audit' in H1 and first 100 words" / Bad: "SEO optimized".
- Good: "No horizontal scroll and CTA fully visible at 375px" / Bad: "Mobile friendly".
- Good: "3 files: 1080×1080, 1080×1350, 1080×1920 PNG" / Bad: "Ad set in all sizes".
- Good: "Every metric in notes equals report data" / Bad: "Accurate report".

## 5. Assumptions, questions, cost
- `assumptions`: only things safe to assume (brand fonts from brand.md). Anything that changes scope, price or legal exposure → `questions_for_ceo`.
- `estimated_cost_usd`: sum of each agent's `budget_usd_per_task` × expected revisions (1.3). Flag if > $10 or > 12 tasks.
- Critical path must end before `due_date`; if not, say so in `summary`.

## 6. Submit
- Self-check `brain/qa-checklists/planning.md`.
- `create_plan`. `report_progress(100, "Plan ready")`.

## Worked mini-example
Request: "Madam Muse bundle landing page + 3 ad graphics by Fri."
Tasks: copy (seo-1, landing-copy) → wireframe (uiux-1) → build (shopify-dev, shopify-page, unpublished theme) ; ads (graphic-1, ad-creative, depends on copy). Publishing theme and running ads: CEO approval via request_external_action.
