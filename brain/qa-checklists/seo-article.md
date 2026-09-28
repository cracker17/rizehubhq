# QA checklist: seo-article

Severity: C = critical (auto-fail), M = major, m = minor.

1. **Title (M).** Title tag ≤ 60 characters and contains the primary keyword or close variant. Verify: count.
2. **Meta (M).** Meta description ≤ 155 characters, includes keyword and a reason to click.
3. **One H1 (M).** Exactly one H1; H2/H3 hierarchy never skips a level. Verify: scan headings.
4. **Keyword early (m).** Primary keyword in the first 100 words.
5. **Intent match (C).** Format matches what ranks in top 5 (guide vs list vs comparison). Verify: `web_fetch`/`semrush` SERP check.
6. **Length (M).** Word count within ±20% of the brief target.
7. **Direct answers (M).** Each question-style H2 opens with a 40–60 word answer.
8. **Facts cited (C).** Every stat or factual claim has an inline source link to a credible or primary source; no invented quotes, reviews or results.
9. **Links work (M).** All links return 200; 3+ internal links with descriptive anchors (no "click here"). Verify: `link_checker`.
10. **Original (C).** No passage copied from ranking pages. Verify: search 3 distinctive sentences in quotes with `web_search`.
11. **Schema valid (M).** JSON-LD parses; types match visible content; no AggregateRating without real reviews.
12. **Images (m).** Every image suggestion has descriptive alt text and file name.
13. **Readability (m).** Paragraphs ≤ 4 lines; no banned AI phrases; ≤ 1 em dash per 300 words.
14. **YMYL flag (C when applicable).** Health/money/legal topics flagged for CEO with reviewer placeholder.
