# SOP: shopify-theme-fix

Owner: shopify-dev. Output: a minimal, verified fix on an UNPUBLISHED copy of the live theme, with root cause, before/after evidence and a PR.

## Inputs to confirm
Exact symptom (what, where: URL, device, browser), expected behaviour, when it started (after an app install or theme edit?), screenshots/recording from the reporter. Can't reproduce from the info given → `ask_ceo` with specific questions.

## Steps
1. **Reproduce on live (read only).** `playwright` at the reported device width; capture screenshot + console + network errors. Note URL and steps. Never change the live theme.
2. **Get a faithful copy.** The fix must be made on an unpublished theme that matches live. If no fresh duplicate exists (live edited since last pull), request duplication via `request_external_action` ("Duplicate live theme #<id> as 'RizeHub fix <task-id>'"), or pull live read-only into the workspace for diagnosis.
3. **Branch** `agent/<task-id>` in `workspaces/<task-id>`; commit the pulled state first so the diff shows only your fix.
4. **Isolate.** Bisect the cause: theme code vs app (app embeds in `settings_data.json`, app blocks, injected scripts) vs content/settings vs Shopify platform. Tools: disable an app embed on the unpublished copy, search the theme (`grep -r`), check recent file history (GitHub or theme versions).
5. **Root-cause statement** (1–3 sentences): "Sticky header stops sticking because `body { overflow-x: hidden }` was added in `base.css` line 42; overflow creates a scroll container."
6. **Minimal fix.** Change the fewest lines; no refactors, no reformatting unrelated code. Comment `/* RizeHub fix <task-id>: reason */` where helpful. If the cause is an app, don't edit app code: document and propose app-setting change or support ticket for CEO.
7. **Regression sweep.** Test the fixed page plus home, a product, a collection, cart drawer, search, header/footer menus at 375 and 1440 px. Console clean. Lighthouse mobile not worse.
8. `shopify theme check` on changed files; push with `--only <files>` to the unpublished theme.
9. PR + `submit_output`: symptom, root cause, fix (diff summary), files, preview URL, before/after screenshots, regression list, and how to apply to live (which files) as the requested external action.

## Common root causes to check first
- CSS: `overflow-x: hidden` breaking sticky; z-index stacking vs app widgets; `100vh` on iOS (use `100dvh`).
- JS: duplicate jQuery/library loads from apps; errors thrown before theme scripts; missing `defer` order dependencies; custom elements defined twice.
- Liquid: `nil` metafield without `.value`/`blank` guard; filters in bracket notation; `paginate` scope; `richtext` double `<p>`; variant selector not updating `selected_or_first_available_variant` via Section Rendering API.
- Content: missing images/alt, deleted menu/collection handles referenced in settings.
- Apps: leftover snippets from uninstalled apps (`{% render 'app-name' %}`) → note for cleanup approval.

## Fix report template
```
Symptom: … | Repro: URL, device, steps
Root cause: …
Fix: file:line → change (N lines)
Regression tested: home, PDP, PLP, cart drawer, search, nav @375/1440 ✓
Evidence: before.png, after.png, console-before.txt
To apply live: copy files X, Y to live theme (needs approval)
```
