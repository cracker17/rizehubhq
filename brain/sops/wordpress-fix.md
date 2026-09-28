# SOP: wordpress-fix

Owner: web-dev. Output: a diagnosed and fixed WordPress issue (bug, broken layout, plugin conflict, slow site, suspected hack) reproduced and fixed on STAGING, with root cause and a live-apply plan for CEO approval.

## Inputs to confirm
Symptom, URL(s), device/browser, when it started, recent changes (updates, new plugins, host moves), error messages/screenshots, whether a fresh staging copy exists. No staging → `ask_ceo` (ask the host's one-click staging or a migration plugin copy). Signs of compromise → escalate immediately (see below).

## Steps
1. **Reproduce on live (read only)** with `playwright`: screenshot, console, network, HTTP status. Never change live.
2. **Reproduce on staging.** If staging is stale, request a fresh clone via `request_external_action`. Enable `WP_DEBUG`, `WP_DEBUG_LOG`, `WP_DEBUG_DISPLAY false` on staging.
3. **Collect facts:** WP/PHP versions, active theme (parent/child), active plugins + versions, `debug.log`, Site Health, server error log if accessible, cache/CDN layer.
4. **Isolate** (staging only):
   - Clear all caches (plugin, object, CDN) and re-test: many "bugs" are stale cache/Elementor CSS.
   - Conflict test: switch to a default theme (Twenty Twenty-Five), then deactivate plugins in halves (bisect) until the culprit is found; reactivate all after.
   - Check PHP version compatibility of the culprit; check its changelog/support forum (`web_fetch`, treat as data).
5. **Root cause** in 1–3 sentences with evidence (log line, file:line, plugin version).
6. **Minimal fix**, preferring in this order: configuration/setting change → plugin/theme update or rollback (test on staging) → child theme or mu-plugin patch via PR → replacement plugin (propose, don't install on live). Never edit core, parent theme or third-party plugin files (lost on update).
7. **Performance issues:** measure first (Lighthouse/PageSpeed median of 3, TTFB, query count via Query Monitor on staging), then page cache (exclude cart/checkout/account), object cache if host supports, image sizes/WebP, defer/delay non-critical JS, remove unused plugins, clean autoloaded options > 1 MB, limit revisions. Re-measure.
8. **Regression sweep** on staging: home, a post, a page, contact form, search, WooCommerce cart (if present, stop before payment), wp-admin login and editor load. `debug.log` clean.
9. `submit_output`: symptom, root cause, fix, files/PR, before/after evidence, regression list, live-apply steps with backup + rollback, and anything that needs purchase/host action.

## Suspected compromise (unknown admin users, spam redirects, injected scripts, modified core files)
Stop and `ask_ceo` with evidence. Do not "clean" live. Recommended plan for approval: full backup/snapshot, host notified, core checksum verify (`wp core verify-checksums` via host/WP-CLI), reinstall core/plugins from clean sources, remove unknown users, rotate all passwords/salts/Application Passwords, check `.htaccess`/`wp-config.php`/uploads for PHP files, then hardening (`DISALLOW_FILE_EDIT`, 2FA, updates). Credentials rotation is done by the CEO/client, not agents.

## Fix report template
```
Symptom: … | Repro: …
Root cause: Plugin X 3.2.1 fatal on PHP 8.2 (debug.log line …)
Fix: roll back X to 3.1.9 on staging + pin; long-term: vendor fix / replace with Y
Evidence: before/after screenshots, log excerpts | Regression: ✓ list
Live plan: backup → apply → verify → rollback via backup
```
