-- HQ Brain M14.3 (docs/16-BRAIN.md "UI"): the /brain page animates from Supabase realtime. New brain_events rows fire
-- the pulses (a save travels from its source to the project node); brain_projects changes update the orbiting nodes.
-- RLS still applies to realtime: only the CEO (ceo_read policies) receives these rows.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'brain_events') then
    alter publication supabase_realtime add table brain_events;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'brain_projects') then
    alter publication supabase_realtime add table brain_projects;
  end if;
end $$;
