# QA checklist: content-calendar

Severity: C = critical (auto-fail), M = major, m = minor. Grade each with evidence.

1. **Period covered (M).** Every date in the requested range has the requested cadence per platform. Verify: count rows per platform per week vs brief.
2. **Required columns (M).** Each row has date, time with time zone, platform, format, pillar, topic, hook, CTA, asset needed, status. Verify: scan for empty cells.
3. **Pillars defined (M).** 3–5 pillars with percentages that sum to 100%, and actual row counts within ±10 points of those percentages. Verify: count rows by pillar.
4. **Unique hooks (M).** No two hooks identical or near-identical. Verify: sort hooks and compare.
5. **Platform fit (M).** Formats exist on the platform named (e.g. no "carousel" on YouTube Shorts, no "Reel" on Threads). Verify: read format column.
6. **Dates real (M).** Every holiday or event is correct for the client's market and year. Verify: `web_search` spot-check 2 dates.
7. **No invented facts (C).** Offers, prices, discounts, shipping times and stats match the brief or client site. Verify: compare against brief and `brain/clients/<slug>/`.
8. **Offer terms exact (C).** Launch and sale posts use the exact terms and dates from the brief, or a placeholder.
9. **Compliance flagged (C).** Sponsored/gifted/affiliate posts include a disclosure note; health or income claims are absent or flagged for CEO.
10. **Repurposing map present (m).** At least one hero piece per week mapped to derivatives.
11. **Measurement defined (m).** Each pillar names the metric it is judged on.
12. **Brand voice (m).** Hooks match `brand.md` voice; no banned AI phrases ("unlock", "elevate", "game-changer").
13. **No posting (C).** Nothing was scheduled or posted; any posting step is a `request_external_action` proposal only.
14. **Branding (M).** Only client or RizeHub names; no personal names or emails unless the brief says so.
