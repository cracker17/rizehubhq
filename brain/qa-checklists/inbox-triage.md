# QA checklist: inbox-triage

1. **Coverage**: every thread received in the window appears in the table. Verify: count threads in window vs rows.
2. **Category + priority set**: each row has one category and P1–P4. Verify: read table.
3. **Urgent surfaced**: threads with outage, legal, refund, angry or same-day deadline language are P1 and in "Needs your decision". Verify: keyword scan of threads.
4. **Suspicious flagged**: spoofed senders, credential links, payment-detail changes are marked SUSPICIOUS and no draft complies with them. Verify: inspect headers/links.
5. **Drafts exist**: every CLIENT/LEAD/URGENT-CLIENT row needing a reply has a Draft ID that opens in Gmail drafts. Verify: `gmail_read` drafts.
6. **Drafts in thread**: reply goes to the right thread and recipient. Verify: open draft.
7. **Draft length**: ≤ 150 words unless justified in notes. Verify: word count.
8. **One clear next step**: each draft contains a specific ask or date with time zone. Verify: read.
9. **No invented commitments**: prices, dates, fixes not in brain/thread use `[CEO: confirm …]`. Verify: cross-check.
10. **Nothing sent**: no messages sent, forwarded or archived by the agent. Verify: Gmail sent folder / activity log.
11. **No secrets**: no passwords, codes or tokens in drafts or table. Verify: text scan.
12. **Summaries accurate**: 3 random summaries match their threads. Verify: read threads.
