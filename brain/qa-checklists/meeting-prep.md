# QA checklist: meeting-prep

1. **Correct meeting**: title, date and link match the calendar event. Verify: `calendar_read`.
2. **Time zones right**: PHT and attendee time zone both shown and converted correctly (DST aware). Verify: convert.
3. **Goal stated**: one-sentence outcome for the call. Verify: read.
4. **Attendees accurate**: names/roles match calendar or email signatures; no personal-life info. Verify: sources.
5. **Context sourced**: every bullet traces to brain, HQ tasks, email or RizeHub. Verify: sources list.
6. **Numbers correct**: each metric matches source with its period. Verify: `rizehub_readonly`/report.
7. **Open items listed**: open tasks for this client in HQ appear with owner and status. Verify: query tasks.
8. **Agenda timed**: agenda items with minutes summing to the meeting length or less. Verify: add.
9. **Questions**: 3–5 questions included. Verify: count.
10. **No invented prices/cases**: prices only from pricing file, case examples only from brain. Verify: cross-check.
11. **Length**: ≤ 400 words. Verify: count.
12. **Nothing sent or changed**: no invites accepted/moved, no emails sent. Verify: activity log.
