-- Integration fixtures (applied after migrations + seed.sql, as the DB owner).
-- CEO + a non-CEO account (normally created in Supabase Auth), one client and one vaulted credential.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'ceo@rizehub.test'),
  ('22222222-2222-4222-8222-222222222222', 'intern@rizehub.test');
insert into ceo_users (user_id) values ('11111111-1111-4111-8111-111111111111');

insert into clients (id, name, slug, platforms, website) values
  ('33333333-3333-4333-8333-333333333333', 'Madam Muse', 'madam-muse', '{shopify}', 'https://madammuse.co');

insert into client_credentials (client_id, platform, label, username, secret_type, secret_cipher, secret_iv)
values ('33333333-3333-4333-8333-333333333333', 'shopify', 'Madam Muse Shopify collaborator', 'hq@rizehub.test',
        'password', '\xdeadbeef'::bytea, '\x00112233'::bytea);
