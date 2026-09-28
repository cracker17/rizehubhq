# QA checklist: wordpress-plugin

Pass = every check is Yes. Grade each with evidence.

1. **Direct access blocked.** Every PHP file has the ABSPATH guard. Verify: grep files.
2. **Prefixed.** All functions, classes, options, hooks, handles prefixed/namespaced. Verify: code read.
3. **Nonce + capability.** Every form, AJAX and REST write checks a nonce (or REST auth) and a specific capability. Verify: grep handlers; test as Subscriber → denied.
4. **Sanitise in, escape out.** All `$_POST/$_GET/$_REQUEST` input sanitised; all output escaped. Verify: PHPCS `WordPress.Security` sniffs = 0 errors.
5. **Safe SQL.** Custom queries use `$wpdb->prepare`. Verify: grep `$wpdb->`.
6. **REST permissions.** No write route uses `__return_true`. Verify: grep `permission_callback`.
7. **Standards.** PHPCS (WordPress-Extra) 0 errors; `php -l` clean; or explicit statement why not run. Verify: output logs.
8. **No debug noise.** Activate, use, deactivate, uninstall on staging with no notices/warnings/fatals in `debug.log`. Verify: log.
9. **Scoped assets.** Admin CSS/JS load only on the plugin's screens. Verify: check another admin page's network.
10. **i18n + header.** Strings translatable with the plugin text domain; header has Requires at least/PHP, GPL licence, Author RizeHub. Verify: code.
11. **Uninstall behaviour.** Matches spec; no data deleted unless setting enabled. Verify: test.
12. **Staging only.** Not installed on live; PR not merged; install action proposed. Verify: live plugin list via output/logs.
13. **Acceptance flows.** Each specified feature works as described. Verify: test matrix + screenshots.
