# QA checklist: web-app

Pass = every check is Yes. Grade each with evidence.

1. **Green checks.** `typecheck`, `lint`, `test` pass on the branch. Verify: run them.
2. **Tests added.** New logic has unit tests incl. ≥2 edge/failure cases; critical flow has a Playwright test. Verify: diff + test output.
3. **Criteria met.** Each acceptance criterion demonstrably works on the preview. Verify: `playwright` walkthrough + screenshots.
4. **RLS on.** Every new table has RLS enabled and explicit policies; non-owner and anon access denied as intended. Verify: migration SQL + RLS test.
5. **Migrations safe.** New migration files only; no edits to applied migrations. Verify: git diff of `supabase/migrations`.
6. **Input validated.** Server Actions/route handlers authenticate, authorise and zod-validate. Verify: code read.
7. **No secrets.** No keys/tokens in code, fixtures, logs or `NEXT_PUBLIC_*`; `.env.example` lists names only. Verify: grep + diff.
8. **States handled.** Loading, empty and error states exist for new UI. Verify: preview/screenshots.
9. **Responsive + accessible.** No overflow at 375 px; labelled inputs; keyboard operable; Lighthouse a11y ≥ 90. Verify: `playwright`, `lighthouse`.
10. **Console clean.** No console errors or hydration warnings on changed pages. Verify: console log.
11. **Scope.** PR limited to the task; no unrelated refactors. Verify: diff.
12. **Not merged/deployed.** PR open, production untouched. Verify: `github`.
