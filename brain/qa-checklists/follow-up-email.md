# QA checklist: follow-up-email

1. **Not suppressed**: recipient not opted out / not "not interested". Verify: lead record + thread.
2. **Right touch**: angle matches cadence day in the SOP. Verify: last send date vs draft.
3. **Adds value**: contains one new finding, tip, answer or example, not only "checking in". Verify: read.
4. **Facts verified**: any finding is visible on their site or in lead notes. Verify: `web_fetch`/notes.
5. **Length**: body ≤ 120 words. Verify: count.
6. **Subject**: ≤ 50 characters, specific, no fake "Re:". Verify: count/read.
7. **One CTA**: exactly one question or ask. Verify: read.
8. **Opt-out**: cold emails include an opt-out line. Verify: read.
9. **No invented proof or prices**: no stats/testimonials; prices only if in pricing.md and already proposed. Verify: compare.
10. **Names correct**: recipient and company spelled as in lead record. Verify: `rizehub_readonly`.
11. **Branding**: RizeHub sender block; no personal emails unless allowed. Verify: read.
12. **Not sent**: send only as pending `request_external_action`; stage unchanged. Verify: task log.
