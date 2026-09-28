# SOP: seo-article

Owner: seo-1 (buying guides, product-led content) or seo-2 (service, local, long-form). Output: a publish-ready article draft in markdown with meta, schema and internal link plan. We never publish.

## Inputs to confirm
Primary keyword, market, audience, target URL/slug, word-count target, CTA destination, internal pages to link, author/reviewer (only if supplied), client English variant. Missing primary keyword → run a mini keyword check and state your choice; missing product/service facts → `ask_ceo`.

## Steps
1. Read client `profile.md`, `brand.md`, and any keyword map in `brain/clients/<slug>/`.
2. SERP analysis: `semrush` + `web_fetch` top 5 results. Record: format, average word count, headings covered, SERP features (snippet, PAA, video, AI overview), gaps nobody answers well.
3. Decide the angle: what we add that the top 5 lack (first-hand detail from the client, clearer steps, a comparison table, local specifics, an honest "who it's not for").
4. Outline: H1, H2/H3 tree, where each secondary keyword and PAA question goes, table/list placements, internal links, CTA spots. Self-check outline against intent before drafting.
5. Draft:
   - Intro ≤ 100 words: the reader's problem, the answer promise, primary keyword in the first 100 words.
   - Under each question H2, a direct 40–60 word answer first, then detail (AI-search and snippet friendly).
   - Short paragraphs (≤ 4 lines), bullet lists, one table where comparison helps.
   - Real examples and data only; cite every stat inline with a link to the primary source.
   - CTA mid-article (soft) and at the end (clear), matched to intent.
   - FAQ section (3–5 PAA questions) if the SERP shows PAA.
   - Key takeaways box for articles over 1,500 words.
6. On-page package: title (≤ 60 chars), meta description (≤ 155), slug, H1, 3+ internal links with descriptive anchors, 1–2 authoritative external links, image suggestions with alt text and file names.
7. Schema: Article (or BlogPosting) + FAQPage if FAQs exist + BreadcrumbList, as JSON-LD. Author only if supplied.
8. Verify: `link_checker`, fact-check every claim, readability pass, remove AI tells and em-dash chains.
9. Self-QA with `brain/qa-checklists/seo-article.md`; `submit_output`.

## Output template
```
Title tag: | Meta: | Slug: | Primary kw: | Secondary: | Word count:
# H1
Intro...
## H2 (question form where natural)
Direct answer (40–60 words)...
...
## FAQ
## Sources
Internal link plan: anchor → URL
Images: file-name.webp | alt text | placement
JSON-LD: { ... }
Placeholders / open questions:
```

## Writing rules
- Plain English, Grade 8 for consumer topics. Vary sentence length.
- No filler intros ("In today's world..."), no "ultimate guide" unless it truly is, no keyword stuffing.
- YMYL topics (health, money, legal): cite primary sources, add a reviewer placeholder, flag for CEO.
