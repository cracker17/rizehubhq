# SOP: webflow-cms

Owner: webflow-dev. Output: CMS collections designed/updated and items created or updated as DRAFTS via the Data API, with a mapping file and item log. Nothing published.

## Inputs to confirm
Site + token grant, collection(s), source data (CSV/sheet/doc from client or another task), field mapping, which items are new vs updates, image sources and licences, reference relationships, slug rules. Missing source content → `ask_ceo`; never generate content to fill a collection unless the brief is a copy task.

## Steps
1. `vault_list` → site API token. `webflow_api` GET site, collections and fields. Save `schema.json` in the workspace.
2. **Collection design** (if new/changed): name singular/plural, slug pattern, required fields marked, field types chosen for editing and filtering (Option for fixed categories, Reference/Multi-reference for shared entities, Switch for flags, Rich Text only where formatting is needed), SEO fields (meta title, meta description, OG image) on public templates. Creating or changing fields alters the live schema → describe it and get approval via `request_external_action` unless the scope note allows it.
3. **Mapping file** `mapping.csv`: source column → field slug → type → transform (trim, title case, HTML clean, date ISO 8601) → required?
4. **Clean the data**: trim whitespace, dedupe on slug/title, validate URLs/emails, convert Markdown/Docs to clean HTML (`<p>`, `<h2>`–`<h4>`, `<ul>`, `<a>`; no inline styles/spans), normalise dates, flag missing required values.
5. **Resolve references**: fetch referenced collection items, map names → item IDs; Option values → option IDs. Unresolved reference → list it, don't create a guessed item.
6. **Slugs**: lowercase, hyphenated, ≤ 60 chars, unique. For updates never change an existing slug unless asked; if asked, list 301 redirects needed (old → new).
7. **Images**: licensed URLs only; supply alt text from source or `[PLACEHOLDER: alt]`; target ≤ 2000 px wide.
8. **Dry run**: validate 3 items against the schema; create them as drafts (`isDraft: true`); view on the Designer/CMS to confirm rich text and references render.
9. **Batch**: bulk create/update in chunks ≤ 100 with backoff on 429. Never call publish or `/live` endpoints. Log each result to `items-log.csv` (source row, item ID, slug, status, error).
10. **Verify**: re-GET all items; count matches source; spot-check 10% (min 5) field by field; collection list/template renders on staging (if staging publish approved).
11. `submit_output`: counts (created/updated/skipped/failed), mapping.csv, items-log.csv, issues list (unresolved refs, missing data, redirects needed), screenshots of 2 items in the template, criteria map, and the publish action for approval ("Publish 48 draft items in 'Projects'").

## items-log.csv template
```
source_row,slug,item_id,action,status,note
2,roof-repair-austin,65f…,create,draft,ok
3,gutter-cleaning,,create,skipped,missing required field "summary"
```

## Rules
- Draft only. Deleting or archiving items is never done by agents; propose it.
- Keep a copy of original field values before any update (`before.json`) so changes can be reverted.
