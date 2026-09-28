# SOP: wordpress-plugin

Owner: web-dev. Output: a secure, standards-compliant custom plugin (or mu-plugin) in a Git PR, installed and tested on STAGING only, with a readme and install notes.

## Inputs to confirm
Problem the plugin solves, users/roles involved, data it stores, admin UI needed, integrations/APIs, WP/PHP/WooCommerce versions of the site, whether an existing maintained plugin already does it (check first; propose it to the CEO if so, with licence/cost).

## Structure
```
rizehub-<slug>/
  rizehub-<slug>.php      # header, constants, bootstrap only
  includes/class-plugin.php
  includes/class-admin.php  (Settings API)
  includes/class-rest.php   (if REST routes)
  assets/ (admin.js, admin.css, built, versioned)
  languages/
  uninstall.php
  readme.txt
```
Header: `Plugin Name`, `Description`, `Version`, `Requires at least`, `Requires PHP` (≥ 7.4, prefer 8.1), `Author: RizeHub`, `Text Domain`, `License: GPL-2.0-or-later`.

## Security rules (non-negotiable)
- Every file: `defined( 'ABSPATH' ) || exit;`
- Prefix everything (`rzh_`/namespace `RizeHub\<Slug>`); no global functions without prefix.
- State-changing requests: nonce (`wp_nonce_field` + `check_admin_referer`/`wp_verify_nonce`) **and** `current_user_can( '<specific_cap>' )`.
- Sanitise input on arrival (`sanitize_text_field`, `sanitize_key`, `absint`, `sanitize_email`, `esc_url_raw`, `wp_kses_post`); validate against allowlists.
- Escape late on output (`esc_html`, `esc_attr`, `esc_url`, `wp_kses_post`, `esc_js` rarely).
- SQL only via `$wpdb->prepare()`; prefer WP APIs (options, post meta, custom post types) over custom tables.
- REST: `register_rest_route` with real `permission_callback` (never `__return_true` for writes), `args` with `sanitize_callback`/`validate_callback`.
- AJAX: `wp_ajax_` only (not `nopriv`) unless public; nonce + capability.
- Secrets/API keys: stored as options not autoloaded, never output to front end or logs; external calls via `wp_remote_*` with timeout and error handling.
- File uploads: `wp_handle_upload` with mime allowlist.

## Steps
1. Branch `agent/<task-id>` in the plugin repo (create repo structure if new). Write a short spec in the PR: hooks used, data stored, capabilities, uninstall behaviour.
2. Implement with hooks (`add_action`/`add_filter`), enqueue assets only on the screens that need them (`$hook_suffix` check), i18n all strings (`__()`, `esc_html__()`).
3. WooCommerce: declare HPOS compatibility; use CRUD (`wc_get_order`, `$order->get_meta`), not direct post meta.
4. `uninstall.php`: remove options/tables only if the setting "delete data on uninstall" is on.
5. Checks: `php -l` on all files; PHPCS with `WordPress-Extra` + `PHPCompatibilityWP`; Plugin Check (PCP) on staging if available. If a tool isn't available in the sandbox, say so.
6. Zip build (plugin folder at zip root). Install on staging (via `vault_login` upload if scope allows staging installs; else `request_external_action`).
7. Test on staging with `WP_DEBUG`/`WP_DEBUG_LOG`: activate, main flows as admin and as a lower role (should be denied), deactivate, uninstall; no notices in `debug.log`; front end unaffected (Lighthouse not worse).
8. `submit_output`: PR, zip path, readme, settings screenshots, test matrix (role × action), check results, criteria map, and the install-on-live action for approval.
