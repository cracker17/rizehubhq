// HQ Brain agents (supabase/migrations/20260930040000_brain_agents.sql, docs/16-BRAIN.md "Agents on the brain"):
// scoped reads (COO: all; the others: only their task's project), proposals as normal approvals the CEO decides
// (never high-risk, never pausing the task or marking the agent waiting), then hq-brain claims and applies them.
export default async function ({ db, step, val, as, assert }) {
  const j = (v) => JSON.stringify(v);
  const CL = 'c0000000-0000-0000-0000-0000000000b1';
  const CL2 = 'c0000000-0000-0000-0000-0000000000b2';
  let task, cooTask, otherTask, proposal, approval;

  await step('brain agents: fixtures (two projects, a client that maps by alias, tasks)', async () => {
    await db.query(`select brain_sync_projects($1::jsonb)`, [j([
      { slug: 'spicy-voyage', name: 'Spicy Voyage', aliases: ['spicy voyage shopify', 'spicy-co'] },
      { slug: 'powerg-solar', name: 'PowerG Solar', aliases: ['powerg'] },
      { slug: 'inbox', name: 'Inbox (unsorted sessions)', aliases: [] },
    ])]);
    const doc = (path, project, kind, title, body, text) => db.query(`select brain_upsert_document($1::jsonb, $2::jsonb, '[]'::jsonb, $3::jsonb)`, [
      j({ path, project_slug: project, kind, title, doc_date: '2026-09-30', frontmatter: {}, body, content_sha: path, git_sha: 'abc' }),
      j([{ heading: 'Status', text, text_sha: `${path}-1` }]),
      j(kind === 'memory' ? [{ text: 'Launch the preorder page', done: false }] : []),
    ]);
    await doc('projects/spicy-voyage/memory.md', 'spicy-voyage', 'memory', 'Spicy Voyage', '# Spicy Voyage\n\n## Status\n- Weekly preorder theme built', 'Weekly preorder theme built on Horizon');
    await doc('projects/powerg-solar/memory.md', 'powerg-solar', 'memory', 'PowerG Solar', '# PowerG\n\n## Status\n- Live on Hostinger', 'Live on Hostinger, preorder not used');
    await doc('profile/profile.md', null, 'profile', 'Julev', '# Julev\n- WhatsApp +63', 'Julev preorder profile');
    await db.query(`select brain_refresh_projects()`);
    await db.exec(`insert into clients (id, name, slug) values ('${CL}', 'Spicy Co', 'spicy-co'), ('${CL2}', 'PowerG Solar', 'powerg-client')`);
    const r = await val(`select create_request('dashboard', 'Spicy work')`);
    task = await val(`insert into tasks (request_id, client_id, agent_id, title, instructions, work_type, status)
                      values ($1, '${CL}', 'writer', 'Preorder copy', 'x', 'landing-copy', 'working') returning id`, [r]);
    otherTask = await val(`insert into tasks (request_id, client_id, agent_id, title, instructions, work_type, status)
                      values ($1, '${CL2}', 'designer', 'Banner', 'x', 'landing-copy', 'working') returning id`, [r]);
    cooTask = await val(`insert into tasks (request_id, client_id, agent_id, title, instructions, work_type, status)
                      values ($1, null, 'coo', 'Weekly review', 'x', 'landing-copy', 'working') returning id`, [r]);
    assert.equal(await val(`select brain_project_for_client($1)`, [CL]), 'spicy-voyage', 'alias match');
    assert.equal(await val(`select brain_project_for_client($1)`, [CL2]), 'powerg-solar', 'name match');
    await db.query(`update clients set brain_project_slug = 'inbox' where id = $1`, [CL2]);
    assert.equal(await val(`select brain_project_for_client($1)`, [CL2]), 'inbox', 'explicit mapping wins');
    await db.query(`update clients set brain_project_slug = null where id = $1`, [CL2]);
    assert.equal(await val(`select read_scope from brain_agent_access where agent_id = 'coo'`), 'all');
    assert.deepEqual(await val(`select propose from brain_agent_access where agent_id = 'qa-lead'`), ['lesson']);
  });

  await step('brain agents: the writer sees only its task\'s project; never the profile; never through another agent\'s task', () => as('service_role', null, async () => {
    const ctx = await val(`select brain_agent_context('writer', $1)`, [task]);
    assert.equal(ctx.project, 'spicy-voyage');
    assert.match(ctx.memory, /Weekly preorder/);
    assert.deepEqual(ctx.next_steps, ['Launch the preorder page']);
    const hits = await val(`select brain_agent_search('writer', $1, 'preorder')`, [task]);
    assert.ok(hits.length >= 1);
    assert.ok(hits.every((h) => h.project === 'spicy-voyage'), 'task_project scope');
    // asking for another project is ignored for task_project agents
    const other = await val(`select brain_agent_search('writer', $1, 'preorder', 'powerg-solar')`, [task]);
    assert.ok(other.every((h) => h.project === 'spicy-voyage'));
    assert.equal(await val(`select brain_agent_get('writer', $1, 'projects/powerg-solar/memory.md')`, [task]), null);
    assert.equal(await val(`select brain_agent_get('writer', $1, 'profile/profile.md')`, [task]), null);
    assert.ok(await val(`select brain_agent_get('writer', $1, 'projects/spicy-voyage/memory.md')`, [task]));
    await assert.rejects(db.query(`select brain_agent_context('writer', $1)`, [otherTask]), /not assigned/);
    await assert.rejects(db.query(`select brain_agent_search('nobody', $1, 'x')`, [task]), /no brain access|not assigned/);
  }));

  await step('brain agents: the COO reads every project (still no profile), a project filter works', () => as('service_role', null, async () => {
    const all = await val(`select brain_agent_search('coo', $1, 'preorder')`, [cooTask]);
    assert.deepEqual([...new Set(all.map((h) => h.project))].sort(), ['powerg-solar', 'spicy-voyage']);
    const one = await val(`select brain_agent_search('coo', $1, 'preorder', 'powerg-solar')`, [cooTask]);
    assert.ok(one.length && one.every((h) => h.project === 'powerg-solar'));
    assert.equal(await val(`select brain_agent_get('coo', $1, 'profile/profile.md')`, [cooTask]), null);
    // planning (no task): the client's project
    assert.equal((await val(`select brain_agent_context('coo', null, $1)`, [CL])).project, 'spicy-voyage');
  }));

  await step('brain agents: proposals are limited by kind and scope, and become normal-risk approvals', () => as('service_role', null, async () => {
    await assert.rejects(db.query(`select brain_agent_propose('writer', $1, 'decision', 'Use Horizon')`, [task]), /may not propose/);
    await assert.rejects(db.query(`select brain_agent_propose('writer', $1, 'session_note', 'x')`, [task]), /3 to 2000/);
    const r = await val(`select brain_agent_propose('writer', $1, 'session_note', 'Wrote the preorder hero copy, 3 variants', 'powerg-solar')`, [task]);
    assert.equal(r.project, 'spicy-voyage', 'a task_project agent cannot aim at another project');
    proposal = r.proposal_id; approval = r.approval_id;
    const ap = await val(`select to_jsonb(a) from approvals a where id = $1`, [approval]);
    assert.equal(ap.kind, 'external_action');
    assert.equal(ap.payload.type, 'brain_proposal');
    assert.equal(ap.status, 'pending');
    assert.equal(await val(`select approval_is_high_risk(a) from approvals a where a.id = $1`, [approval]), false);
    assert.equal(await val(`select status::text from agents where id = 'writer'`) === 'waiting', false, 'a proposal does not make the agent wait');
    await db.query(`select refresh_agent_status('writer')`);
    assert.notEqual(await val(`select status::text from agents where id = 'writer'`), 'waiting');
    // COO may aim at any listed project, not an unknown one
    const c = await val(`select brain_agent_propose('coo', $1, 'decision', 'PowerG mail stays off until the mailbox exists', 'powerg-solar')`, [cooTask]);
    assert.equal(c.project, 'powerg-solar');
    await assert.rejects(db.query(`select brain_agent_propose('coo', $1, 'fact', 'x y z', 'nope')`, [cooTask]), /unknown project/);
    await assert.rejects(db.query(`select brain_agent_propose('coo', $1, 'decision', 'no project here')`, [cooTask]), /not a project/);
    // at most 10 pending per task
    for (let i = 0; i < 9; i++) await db.query(`select brain_agent_propose('writer', $1, 'session_note', $2)`, [task, `note number ${i}`]);
    await assert.rejects(db.query(`select brain_agent_propose('writer', $1, 'session_note', 'one too many')`, [task]), /too many pending/);
  }));

  await step('brain agents: the CEO decides through decide_approval; hq-brain claims approved ones once and records the result', async () => {
    assert.equal(await val(`select decide_approval($1, 'approve')`, [approval]), 'action_approved');
    assert.equal(await val(`select status from brain_proposals where id = $1`, [proposal]), 'approved');
    assert.equal(await val(`select status::text from tasks where id = $1`, [task]), 'working', 'the task was never paused');
    const rejectMe = await val(`select approval_id from brain_proposals where text = 'note number 0'`);
    await val(`select decide_approval($1, 'reject', 'not useful')`, [rejectMe]);
    assert.equal(await val(`select status || ':' || ceo_note from brain_proposals where approval_id = $1`, [rejectMe]), 'rejected:not useful');
    await as('service_role', null, async () => {
      const claimed = await val(`select brain_proposals_claim(10)`);
      assert.deepEqual(claimed.map((p) => p.id), [proposal]);
      assert.deepEqual(await val(`select brain_proposals_claim(10)`), [], 'claimed exactly once');
      await db.query(`select brain_proposal_done($1, 'abc1234', null)`, [proposal]);
    });
    assert.equal(await val(`select status || ':' || applied_sha from brain_proposals where id = $1`, [proposal]), 'applied:abc1234');
    const d = await val(`select brain_digest_facts(now() - interval '1 day')`);
    assert.equal(d.proposals_applied, 1);
    assert.ok(d.proposals_pending >= 9);
  });

  await step('brain agents: nobody but the service role calls the agent functions; the CEO lists proposals', async () => {
    const CEO = '11111111-1111-1111-1111-111111111111';
    await as('authenticated', CEO, async () => {
      await assert.rejects(db.query(`select brain_agent_search('coo', $1, 'x')`, [cooTask]), /permission denied/);
      await assert.rejects(db.query(`select brain_agent_propose('coo', $1, 'decision', 'sneaky', 'powerg-solar')`, [cooTask]), /permission denied/);
      await assert.rejects(db.query(`select brain_proposals_claim(1)`), /permission denied/);
    });
    await as('anon', null, async () => {
      await assert.rejects(db.query(`select brain_list_proposals(5)`), /permission denied/);
      await assert.rejects(db.query(`select * from brain_proposals`), /permission denied/);
    });
    const list = await val(`select brain_list_proposals(100)`);
    assert.ok(list.some((p) => p.id === proposal && p.agent_name && p.project_name === 'Spicy Voyage'));
  });
}
