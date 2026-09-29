// Claude runtime (supabase/migrations/20260929100000_claude_runtime.sql): agents.runtime accepts 'claude' next to
// 'worker' and 'hermes'; anything else is still rejected; no agent changed runtime.
export default async function ({ db, step, val, assert }) {
  await step('claude runtime: no agent was switched by the migration', async () => {
    assert.equal(await val(`select count(*)::int from agents where runtime = 'claude'`), 0);
    assert.equal(await val(`select runtime from agents where id = 'web-dev'`), 'hermes');
  });

  await step('claude runtime: agents.runtime accepts claude, rejects unknown values', async () => {
    await db.query(`update agents set runtime = 'claude' where id = 'web-dev'`);
    assert.equal(await val(`select runtime from agents where id = 'web-dev'`), 'claude');
    await assert.rejects(db.query(`update agents set runtime = 'docker' where id = 'web-dev'`), /check/);
    await db.query(`update agents set runtime = 'hermes' where id = 'web-dev'`);
  });
}
