-- RizeHub HQ · seed data

-- The six agents (agents/roster.yaml). The 20260928080000_six_agent_roster migration inserts the same rows, so this
-- upserts; desk ids are office desk slots.
insert into agents (id, name, department, model_role, runtime, skills, avatar, desk) values
('coo','COO','leadership','lead','worker','{planning,routing,prioritization,onboarding,client-reports,inbox,briefs}','{"color":"#6D4AFF","accessory":"tie"}','{"id":"board-head"}'),
('web-dev','Web Developer','dev','dev','hermes','{shopify,liquid,webflow,wordpress,nextjs,supabase,apis,automation}','{"color":"#5FBF4A","accessory":"headphones"}','{"id":"dev-1"}'),
('designer','Graphic Designer','design','design','hermes','{wireframes,ui,ux,figma,ad-creatives,social-graphics,brand-assets}','{"color":"#A259FF","accessory":"beret"}','{"id":"design-1"}'),
('writer','Content Writer','content','writer','hermes','{seo,blog,landing-copy,keywords,meta,captions,content-calendar,video-scripts}','{"color":"#22C55E","accessory":"glasses"}','{"id":"sales-1"}'),
('sales','Sales Agent','growth','sales','hermes','{lead-research,outreach,dm-replies,lead-qualification,proposals,follow-ups,job-search}','{"color":"#FFB020","accessory":"clipboard"}','{"id":"sales-2"}'),
('qa-lead','QA','qa','qa','worker','{testing,review,verification}','{"color":"#14B8A6","accessory":"magnifier-visor"}','{"id":"qa-1"}')
on conflict (id) do update set
  name = excluded.name, department = excluded.department, model_role = excluded.model_role, runtime = excluded.runtime,
  skills = excluded.skills, avatar = excluded.avatar, desk = excluded.desk;

insert into settings (key, value) values
('daily_budget_usd', '10'),
('digest_time', '"18:00"'),
('timezone', '"Asia/Manila"'),
('auto_approve_plans', 'false'),
('idle_activities', '["coffee","lounge_sofa","lobby","ping_pong","foosball","chat"]'),
('model_profile', '"free"'),
('monthly_budget_usd', '0');
