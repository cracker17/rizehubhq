// M9a Client Vault (supabase/migrations/20260928040000_client_vault.sql): grants, column security,
// secure client links, failed-login counter, 2FA code handoff, problem reports, archive auto-revoke.
export default async function ({ db, step, val, as, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const CL = 'c4000000-0000-0000-0000-000000000001';
  const CL2 = 'c4000000-0000-0000-0000-000000000002';
  const hex = (n) => new Uint8Array(n).fill(0xab);
  const hash = (c) => c.repeat(64);
  let cred, cred2, task;

  const insertCred = (id, client, label, grants, platform = 'shopify') => val(
    `select vault_insert_credential($1, $2, $3, $4, 'https://x.myshopify.com/admin', 'dev@rizehub.ph', 'password',
       $5::bytea, $6::bytea, 1, 'collaborator', 'Themes only', '{https://x.myshopify.com/admin/themes}', null, 'ceo', $7::text[])`,
    [id, client, platform, label, hex(60), hex(24), grants]);

  await step('vault: worker stores a credential with grants (ciphertext only, audit row written)', () => as('service_role', null, async () => {
    await db.exec(`insert into clients (id, name, slug, platforms) values ('${CL}', 'Vault Co', 'vault-co', '{shopify}'),
                                                                         ('${CL2}', 'Archive Me', 'archive-me', '{webflow}')`);
    cred = await insertCred('c4000000-0000-0000-0000-00000000aaaa', CL, 'Vault Co Shopify', ['web-dev', 'qa-lead', 'nobody']);
    assert.equal(cred, 'c4000000-0000-0000-0000-00000000aaaa');
    assert.deepEqual((await db.query(`select agent_id from credential_grants where credential_id = $1 order by 1`, [cred])).rows.map((r) => r.agent_id),
      ['qa-lead', 'web-dev']); // unknown agents are ignored
    assert.equal(await val(`select count(*)::int from credential_access_log where credential_id = $1 and action = 'store'`, [cred]), 1);
    cred2 = await insertCred(null, CL2, 'Archive Me Webflow', ['web-dev'], 'webflow');
  }));

  await step('vault: bad input is refused (unknown client, bad platform, archived client)', async () => {
    await assert.rejects(insertCred(null, 'c4000000-0000-0000-0000-0000000000ff', 'x', []), /client not found/);
    await assert.rejects(insertCred(null, CL, 'x', [], 'Shop ify!'), /bad platform/);
  });

  await step('vault: grants are enforced when an agent asks for a credential', () => as('service_role', null, async () => {
    const row = (await db.query(`select * from vault_get_for_agent($1, 'web-dev')`, [cred])).rows[0];
    assert.equal(row.label, 'Vault Co Shopify');
    assert.ok(row.secret_cipher instanceof Uint8Array && row.secret_cipher.length === 60);
    await assert.rejects(db.query(`select * from vault_get_for_agent($1, 'writer')`, [cred]), /not granted/);
    const list = await val(`select vault_list_for_agent('writer', $1)`, [CL]);
    assert.equal(list.granted.length, 0);
    assert.equal(list.not_granted, 1);
    const mine = await val(`select vault_list_for_agent('web-dev', $1)`, [CL]);
    assert.equal(mine.granted.length, 1);
    assert.equal(mine.granted[0].secret_cipher, undefined);
    assert.deepEqual(mine.granted[0].url_allowlist, ['https://x.myshopify.com/admin/themes']);
  }));

  await step('vault: the CEO can read metadata but never secret columns; browser roles cannot write or decrypt', () => as('authenticated', CEO, async () => {
    assert.equal(await val(`select label from client_credentials where id = $1`, [cred]), 'Vault Co Shopify');
    assert.equal(await val(`select failed_login_count from client_credentials where id = $1`, [cred]), 0);
    await assert.rejects(db.query(`select secret_cipher from client_credentials`), /permission denied/);
    await assert.rejects(db.query(`select secret_iv from client_credentials`), /permission denied/);
    await assert.rejects(db.query(`select * from client_credentials`), /permission denied/);
    await assert.rejects(db.query(`update client_credentials set status = 'active'`), /permission denied/);
    await assert.rejects(db.query(`insert into client_credentials (client_id, platform, label, secret_type, secret_cipher, secret_iv)
                                   values ($1, 'x', 'x', 'password', '\\x00', '\\x00')`, [CL]), /permission denied/);
    await assert.rejects(db.query(`select * from vault_get_for_agent($1, 'web-dev')`, [cred]), /permission denied/);
    await assert.rejects(db.query(`select * from vault_get_sealed($1)`, [cred]), /permission denied/);
    await assert.rejects(insertCred(null, CL, 'from browser', []), /permission denied/);
    await assert.rejects(db.query(`select vault_log_access($1, 'web-dev', null, 'failed_login', false, '{}')`, [cred]), /permission denied/);
    await assert.rejects(db.query(`select token_hash from access_requests`), /permission denied/);
    await assert.rejects(db.query(`insert into credential_access_log (action, success) values ('login', true)`), /permission denied/);
  }));

  await step('vault: the CEO sets grants and edits metadata through functions', () => as('authenticated', CEO, async () => {
    assert.deepEqual(await val(`select vault_set_grants($1, '{web-dev,writer}')`, [cred]), ['web-dev', 'writer']);
    await db.query(`select vault_revoke_grant($1, 'writer')`, [cred]);
    await db.query(`select vault_grant($1, 'qa-lead')`, [cred]);
    assert.equal(await val(`select string_agg(agent_id, ',' order by agent_id) from credential_grants where credential_id = $1`, [cred]), 'qa-lead,web-dev');
    await db.query(`select vault_update_credential($1, 'Vault Co Shopify (collab)', 'https://x.myshopify.com/admin', 'dev@rizehub.ph',
                    'collaborator', 'Themes only; never orders', '{https://x.myshopify.com/admin/themes,https://x.myshopify.com/admin/api}', null)`, [cred]);
    assert.equal(await val(`select label from client_credentials where id = $1`, [cred]), 'Vault Co Shopify (collab)');
    await assert.rejects(db.query(`select vault_update_credential($1, 'x', null, null, 'none', null, '{}', null, null, 'revoked')`, [cred]), /vault_revoke/);
  }));

  await step('vault: a non-CEO account and anonymous visitors cannot use vault functions', async () => {
    await as('authenticated', OTHER, async () => {
      await assert.rejects(db.query(`select vault_set_grants($1, '{writer}')`, [cred]), /not allowed/);
      await assert.rejects(db.query(`select create_access_request($1, '{shopify}', $2)`, [CL, hash('a')]), /not allowed/);
      assert.equal(await val(`select count(*)::int from client_credentials`), 0);
    });
    await as('anon', null, async () => {
      await assert.rejects(db.query(`select vault_revoke($1)`, [cred]), /permission denied/);
      await assert.rejects(db.query(`select vault_access_request_state($1)`, [hash('a')]), /permission denied/);
      await assert.rejects(db.query(`select vault_redeem_access_request($1, null, 'shopify', 'x', null, null, 'password', '\\x00', '\\x00', 1)`, [hash('a')]), /permission denied/);
    });
  });

  await step('vault: secure client link is single use', async () => {
    let req;
    await as('authenticated', CEO, async () => {
      req = (await db.query(`select * from create_access_request($1, '{shopify,wordpress}', $2, 500, 'Please add a collaborator')`, [CL, hash('b')])).rows[0];
      assert.equal(req.token_hash, null);
      // capped at 72 h
      assert.ok(await val(`select expires_at <= now() + interval '72 hours 1 minute' from access_requests where id = $1`, [req.id]));
      await assert.rejects(db.query(`select create_access_request($1, '{}', $2)`, [CL, hash('c')]), /at least one platform/);
      await assert.rejects(db.query(`select create_access_request($1, '{shopify}', 'short')`, [CL]), /bad token hash/);
    });
    await as('service_role', null, async () => {
      assert.equal((await val(`select vault_access_request_state($1)`, [hash('b')])).state, 'open');
      const redeem = (h, platform = 'shopify') => val(`select vault_redeem_access_request($1, null, $2, 'Client-added Shopify', 'https://x.myshopify.com/admin',
                    'owner@vaultco.com', 'password', '\\x0102', '\\x0304', 1, 'sms', 'from the client')`, [h, platform]);
      await assert.rejects(redeem(hash('b'), 'github'), /platform not requested/); // rolled back: the link is still open
      assert.equal((await val(`select vault_access_request_state($1)`, [hash('b')])).state, 'open');
      const id = await redeem(hash('b'));
      assert.ok(id);
      assert.equal(await val(`select created_by from client_credentials where id = $1`, [id]), 'client_link');
      assert.equal(await val(`select count(*)::int from credential_grants where credential_id = $1`, [id]), 0); // no grants until the CEO adds them
      assert.equal(await val(`select credential_id from access_requests where id = $1`, [req.id]), id);
      assert.equal(await redeem(hash('b')), null);
      assert.equal((await val(`select vault_access_request_state($1)`, [hash('b')])).state, 'used');
      assert.equal(await redeem(hash('9')), null);
      assert.equal((await val(`select vault_access_request_state($1)`, [hash('9')])).state, 'invalid');
    });
  });

  await step('vault: expired and cancelled links cannot be used', async () => {
    let cancelId;
    await as('authenticated', CEO, async () => {
      await db.query(`select create_access_request($1, '{shopify}', $2)`, [CL, hash('d')]);
      cancelId = (await db.query(`select id from create_access_request($1, '{shopify}', $2)`, [CL, hash('e')])).rows[0].id;
      await db.query(`select vault_cancel_access_request($1)`, [cancelId]);
    });
    await db.exec(`update access_requests set expires_at = now() - interval '1 minute' where token_hash = '${hash('d')}'`);
    await as('service_role', null, async () => {
      assert.equal((await val(`select vault_access_request_state($1)`, [hash('d')])).state, 'expired');
      assert.equal((await val(`select vault_access_request_state($1)`, [hash('e')])).state, 'invalid');
      for (const h of [hash('d'), hash('e')]) {
        assert.equal(await val(`select vault_redeem_access_request($1, null, 'shopify', 'x', null, null, 'password', '\\x00', '\\x00', 1)`, [h]), null);
      }
    });
  });

  await step('vault: success updates last used; 2 failed logins → check_needed + approval, then no more attempts', () => as('service_role', null, async () => {
    const r = await val(`select create_request('dashboard', 'Vault work')`);
    task = await val(`insert into tasks (request_id, client_id, agent_id, title, instructions, work_type, status)
                      values ($1, $2, 'web-dev', 'Theme fix', 'x', 'shopify-theme-fix', 'working') returning id`, [r, CL]);
    await db.query(`select vault_log_access($1, 'web-dev', $2, 'api_call', true, '{"status":200}')`, [cred, task]);
    assert.equal(await val(`select last_used_by from client_credentials where id = $1`, [cred]), 'web-dev');
    assert.equal(await val(`select detail->>'label' from activity_log where action = 'vault.api_call' order by id desc limit 1`), 'Vault Co Shopify (collab)');
    await db.query(`select vault_log_access($1, 'web-dev', $2, 'failed_login', false, '{}')`, [cred, task]);
    assert.equal(await val(`select status from client_credentials where id = $1`, [cred]), 'active');
    await db.query(`select vault_log_access($1, 'web-dev', $2, 'failed_login', false, '{}')`, [cred, task]);
    assert.equal(await val(`select status from client_credentials where id = $1`, [cred]), 'check_needed');
    assert.equal(await val(`select count(*)::int from approvals where payload->>'type' = 'vault_problem' and payload->>'credential_id' = $1`, [cred]), 1);
    await assert.rejects(db.query(`select * from vault_get_for_agent($1, 'web-dev')`, [cred]), /check needed/);
    // a third failure doesn't pile up approvals
    await db.query(`select vault_log_access($1, 'web-dev', $2, 'failed_login', false, '{}')`, [cred, task]);
    assert.equal(await val(`select count(*)::int from approvals where payload->>'type' = 'vault_problem' and payload->>'credential_id' = $1`, [cred]), 1);
  }));

  await step('vault: rotating the secret re-activates it and resets the counter', () => as('service_role', null, async () => {
    await db.query(`select vault_rotate_secret($1, $2::bytea, $3::bytea, 2)`, [cred, hex(61), hex(24)]);
    assert.equal(await val(`select status || ':' || failed_login_count || ':' || key_version from client_credentials where id = $1`, [cred]), 'active:0:2');
    assert.ok((await db.query(`select * from vault_get_for_agent($1, 'web-dev')`, [cred])).rows[0]);
  }));

  await step('vault: report_problem flags check_needed and asks the CEO', () => as('service_role', null, async () => {
    const ap = await val(`select vault_report_problem($1, 'web-dev', $2, 'Token expired (401)')`, [cred, task]);
    assert.equal(await val(`select status from client_credentials where id = $1`, [cred]), 'check_needed');
    assert.equal(await val(`select summary from approvals where id = $1`, [ap]), 'Token expired (401)');
    assert.equal(await val(`select status::text from tasks where id = $1`, [task]), 'working'); // the task isn't paused
    await assert.rejects(db.query(`select vault_report_problem($1, 'writer', $2, 'x')`, [cred, task]), /not granted/);
  }));

  await step('vault: CEO marks it fixed; 2FA code is handed over once and scrubbed', async () => {
    await as('authenticated', CEO, async () => {
      await db.query(`select vault_update_credential($1, 'Vault Co Shopify (collab)', null, 'dev@rizehub.ph', 'sms', null, '{https://x.myshopify.com/admin}', null, null, 'active')`, [cred]);
    });
    let ap;
    await as('service_role', null, async () => {
      ap = await val(`select vault_request_2fa($1, 'web-dev', $2, 'Code sent by SMS to ••42. Reply with it.')`, [cred, task]);
      assert.equal(await val(`select payload->>'type' from approvals where id = $1`, [ap]), 'question');
      assert.deepEqual(await val(`select vault_take_2fa_code($1)`, [ap]), { status: 'pending' });
    });
    await as('authenticated', CEO, async () => {
      assert.equal(await val(`select decide_approval($1, 'approve', '482913', 'telegram')`, [ap]), 'action_approved');
    });
    assert.equal(await val(`select status::text from tasks where id = $1`, [task]), 'working'); // still running; the tool was waiting
    await as('service_role', null, async () => {
      assert.deepEqual(await val(`select vault_take_2fa_code($1)`, [ap]), { status: 'approved', code: '482913' });
      assert.deepEqual(await val(`select vault_take_2fa_code($1)`, [ap]), { status: 'used' });
    });
    assert.equal(await val(`select ceo_note from approvals where id = $1`, [ap]), '[2FA code used]');
    assert.equal(await val(`select count(*)::int from activity_log where detail::text like '%482913%'`), 0);
  });

  await step('vault: revoke drops grants and blocks use', async () => {
    const extra = await insertCred(null, CL, 'Temp token', ['web-dev'], 'github');
    await as('authenticated', CEO, async () => { await db.query(`select vault_revoke($1, 'project ended')`, [extra]); });
    assert.equal(await val(`select status from client_credentials where id = $1`, [extra]), 'revoked');
    assert.equal(await val(`select count(*)::int from credential_grants where credential_id = $1`, [extra]), 0);
    await assert.rejects(db.query(`select vault_set_grants($1, '{web-dev}')`, [extra]), /revoked/);
    await assert.rejects(db.query(`select vault_rotate_secret($1, '\\x00', '\\x00', 1)`, [extra]), /revoked/);
  });

  await step('vault: archiving a client revokes every grant and open link', async () => {
    await as('authenticated', CEO, async () => {
      await db.query(`select create_access_request($1, '{webflow}', $2)`, [CL2, hash('f')]);
      await db.exec(`update clients set status = 'archived' where id = '${CL2}'`);
    });
    assert.equal(await val(`select count(*)::int from credential_grants where credential_id = $1`, [cred2]), 0);
    assert.equal(await val(`select detail->>'reason' from credential_access_log where credential_id = $1 and action = 'revoke'`, [cred2]), 'client_archived');
    assert.equal((await val(`select vault_access_request_state($1)`, [hash('f')])).state, 'invalid');
    await assert.rejects(db.query(`select * from vault_get_for_agent($1, 'web-dev')`, [cred2]), /not granted/);
    await assert.rejects(db.query(`select vault_set_grants($1, '{web-dev}')`, [cred2]), /archived/);
    await assert.rejects(insertCred(null, CL2, 'late', []), /archived/);
  });
}
