-- M13 Connectors (docs/15 §5b): Google Calendar, read-only, through the calendar's "Secret address in iCal format".
-- A calendar is a connector of kind 'ical'. The secret address is a credential (anyone holding it can read the
-- calendar), so the worker seals it like any connector secret (context 'connector:<id>') and the url column stays null.
-- Everything else reuses the existing connector functions: connector_insert (auth_type 'none'), connectors_for_agent
-- (p_kind 'ical'), connector_get_sealed, connector_mark, connector_set_grants, connector_set_status, connector_delete.
--
-- Only the kind list changes. 'storage' is included too: 20260929080000_storage.sql (another branch) adds it and
-- sorts before this file, so after both have run all four kinds are allowed, and this file works without it as well.
alter table connectors drop constraint if exists connectors_kind_check;
alter table connectors add constraint connectors_kind_check check (kind in ('gmail', 'mcp', 'storage', 'ical'));
