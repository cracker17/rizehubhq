-- The office got a gym (treadmill + dumbbells): agents on a break can work out.
-- agents.idle_activity is free text; this only extends the list of activities the worker may pick.
update settings
   set value = value || '["gym"]'::jsonb
 where key = 'idle_activities'
   and not value ? 'gym';
