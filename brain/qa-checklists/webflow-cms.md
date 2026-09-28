# QA checklist: webflow-cms

Pass = every check is Yes. Grade each with evidence.

1. **Drafts only.** All created/updated items are drafts; no publish or `/live` calls in the log. Verify: `webflow_api` GET items (`isDraft`) + activity log.
2. **Count matches.** Created + updated + skipped = source rows; skipped rows have reasons. Verify: items-log.csv vs source.
3. **Mapping documented.** mapping.csv covers every populated field with type and transform. Verify: read file.
4. **Field accuracy.** A 10% sample (min 5) matches source values exactly. Verify: compare API data to source.
5. **Required fields.** No item missing a required field. Verify: API data.
6. **Rich text clean.** No inline styles, empty `<p>`, or stray `<span>`/Docs markup. Verify: inspect rich text HTML in 3 items.
7. **References resolved.** Reference/option fields hold valid IDs; unresolved ones listed, none invented. Verify: GET referenced items.
8. **Slugs.** Unique, lowercase, hyphenated; existing slugs unchanged unless requested, with redirects listed. Verify: API data + before.json.
9. **Images.** Every image has alt text or a listed placeholder; sources licensed/approved. Verify: sample items.
10. **Revert possible.** before.json exists for updated items. Verify: workspace file.
11. **Nothing deleted.** No items/fields deleted or archived. Verify: counts before/after + log.
12. **No invented content.** Values come from the source; generated text only if the brief asked. Verify: sample vs source.
