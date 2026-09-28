# SOP: keyword-research

Owner: writer. Output: a clustered keyword map that tells the team which page targets which query, and what to create next.

## Inputs to confirm
Client, domain, market (Semrush database: us, au, uk), seed topics/products/services, locations served, competitors (if known), goal (traffic, sales, leads), existing pages. Missing market or services → `ask_ceo`.

## Steps
1. Read client `profile.md` and site structure (`web_fetch` sitemap.xml or nav).
2. Baseline: `semrush` domain overview + current organic positions for the domain (note database and date). If Search Console read access is granted (`vault_list`), pull top queries with `vault_api` read-only.
3. Competitors: 3–5 organic competitors from `semrush` (true SERP competitors, not just business rivals). Run keyword gap: keywords they rank top 20 for that the client does not.
4. Expand seeds: related, question and long-tail keywords. Local: "service + city", "service near me" (target via location pages + GBP, not by stuffing "near me").
5. Filter: drop irrelevant, branded competitor terms, zero-intent terms, and anything the client does not sell/offer.
6. Classify intent from the live SERP (check top 10 for 1 keyword per cluster): informational, commercial, transactional, navigational, local.
7. Cluster by SERP overlap: keywords sharing 3+ of the same top-10 URLs belong on one page.
8. Map each cluster to one URL: existing page (optimise) or new page (create). Flag cannibalisation: two client URLs ranking for one cluster.
9. Prioritise: Priority score = business value (1–3) × intent (transactional 3, commercial 2, info 1) ÷ difficulty band (KD <30 = 1, 30–50 = 2, >50 = 3). Note quick wins: client ranks positions 8–20.
10. Note SERP features to target (featured snippet, PAA, local pack, shopping, video, AI overview) per cluster.
11. Self-QA with `brain/qa-checklists/keyword-research.md`; `submit_output`.

## Output template (CSV + summary)
| Cluster | Primary keyword | Secondary keywords | Volume | KD | Intent | SERP features | Target URL (existing/new) | Page type | Current pos | Priority |
|---|---|---|---|---|---|---|---|---|---|---|
| linen dresses | linen dresses | linen summer dress, women's linen dress | 12,100 | 38 | Transactional | Shopping, PAA | /collections/linen-dresses (existing) | Collection | 14 | High |

Summary (≤ 300 words): data source + date + database; top 5 quick wins; top 5 new pages; cannibalisation issues; recommended next tasks for the COO (e.g. "seo-article: linen dress care guide").

## Rules
- Use real tool numbers only; never estimate volumes from memory. If Semrush has no data, write "no data".
- One primary keyword per URL. Every cluster maps to exactly one URL.
- Recommendations respect what the client actually sells and where they operate.
