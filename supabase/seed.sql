-- RizeHub HQ · seed data

insert into agents (id, name, department, model_role, skills, avatar, desk) values
('coo','COO','leadership','lead','{planning,routing,prioritization}','{"color":"#6D4AFF","accessory":"tie"}','{"x":2,"y":1}'),
('ea','EA & Report Desk','ops','reports','{inbox,calendar,reports,digest}','{"color":"#3BA7FF","accessory":"headset"}','{"x":4,"y":1}'),
('pipeline','Pipeline Desk','growth','specialist','{crm,proposals,follow-ups,pricing}','{"color":"#FFB020","accessory":"clipboard"}','{"x":6,"y":1}'),
('prospector','Social Prospecting','growth','specialist','{lead-research,outreach-drafts,threads,linkedin}','{"color":"#FF7A59","accessory":"binoculars"}','{"x":8,"y":1}'),
('inbound','Social + Inbound','growth','specialist','{comments,dm-drafts,lead-qualification}','{"color":"#FF5FA2","accessory":"phone"}','{"x":10,"y":1}'),
('job-scout','Job Scout','growth','specialist','{job-search,screening,applications}','{"color":"#EAB308","accessory":"backpack"}','{"x":12,"y":1}'),
('client-success','Client Success','ops','specialist','{onboarding,workspaces,access-checklists}','{"color":"#38BDF8","accessory":"lanyard"}','{"x":4,"y":2}'),
('video-editor','Video Editor','multimedia','specialist','{video-editing,reels,subtitles,color-grading,motion}','{"color":"#E11D48","accessory":"clapperboard"}','{"x":2,"y":13}'),
('sound-engineer','Sound & Voice Specialist','multimedia','specialist','{voiceover,tts,voice-design,audio-cleanup,music,sfx,mixing}','{"color":"#7C3AED","accessory":"studio-headphones"}','{"x":4,"y":13}'),
('shopify-dev','Shopify Dev','dev','dev','{shopify,liquid,theme,sections,metafields}','{"color":"#5FBF4A","accessory":"headphones"}','{"x":2,"y":4}'),
('webflow-dev','Webflow Dev','dev','dev','{webflow,cms,interactions,gsap}','{"color":"#4353FF","accessory":"headphones"}','{"x":4,"y":4}'),
('wordpress-dev','WordPress Dev','dev','dev','{wordpress,elementor,php,plugins}','{"color":"#21759B","accessory":"headphones"}','{"x":6,"y":4}'),
('fullstack-dev','Full-Stack Dev','dev','dev','{nextjs,react,node,supabase,apis}','{"color":"#00C2A8","accessory":"hoodie"}','{"x":8,"y":4}'),
('uiux-1','UI/UX Designer 1','design','specialist','{wireframes,ux,figma,design-systems}','{"color":"#A259FF","accessory":"beret"}','{"x":2,"y":7}'),
('uiux-2','UI/UX Designer 2','design','specialist','{wireframes,ux,figma,design-systems}','{"color":"#C084FC","accessory":"beret"}','{"x":4,"y":7}'),
('graphic-1','Graphic Designer 1','design','specialist','{ad-creatives,social-graphics,banners}','{"color":"#F97316","accessory":"paint-cap"}','{"x":6,"y":7}'),
('graphic-2','Graphic Designer 2','design','specialist','{ad-creatives,social-graphics,banners}','{"color":"#FB923C","accessory":"paint-cap"}','{"x":8,"y":7}'),
('social-1','Social Media Marketer 1','content','specialist','{content-calendar,captions,hashtags,scheduling}','{"color":"#EC4899","accessory":"sunglasses"}','{"x":2,"y":10}'),
('social-2','Social Media Marketer 2','content','specialist','{content-calendar,captions,hashtags,scheduling}','{"color":"#F472B6","accessory":"sunglasses"}','{"x":4,"y":10}'),
('seo-1','SEO Content Writer 1','content','specialist','{seo,blog,landing-copy,keywords,meta}','{"color":"#22C55E","accessory":"glasses"}','{"x":6,"y":10}'),
('seo-2','SEO Content Writer 2','content','specialist','{seo,blog,landing-copy,keywords,meta}','{"color":"#4ADE80","accessory":"glasses"}','{"x":8,"y":10}'),
('qa-lead','QA Lead','qa','qa','{testing,review,verification}','{"color":"#14B8A6","accessory":"magnifier-visor"}','{"x":10,"y":4}');

insert into settings (key, value) values
('daily_budget_usd', '10'),
('digest_time', '"18:00"'),
('timezone', '"Asia/Manila"'),
('auto_approve_plans', 'false'),
('idle_activities', '["coffee","lounge_sofa","lobby","ping_pong","foosball","chat"]'),
('model_profile', '"free"'),
('monthly_budget_usd', '0');
