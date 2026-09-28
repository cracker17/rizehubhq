import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerChat } from './chat';
import { createHttpServer } from './http';
import { FakeHqDb } from './fakeHqDb';
import { makeDeps, mockModel, promptText, textResponse } from './testing';

test('answerChat answers from live state and stores both messages', async () => {
  const db = new FakeHqDb();
  const task = db.addTask({ agent_id: 'seo-1', title: 'Shopify speed article', status: 'working' });
  Object.assign(db.agents.get('seo-1')!, { status: 'working', current_task_id: task.id });
  await db.reportProgress(task.id, 60, 'Writing section 3', { app: 'doc', title: 'article.md' });
  const model = mockModel([textResponse("I'm 60% through the Shopify speed article, writing section 3.")]);
  const deps = makeDeps({ db, model });

  const { answer } = await answerChat('seo-1', 'What are you doing?', deps);
  assert.match(answer, /60%/);
  assert.deepEqual(db.messages.map((m) => [m.sender, m.task_id]), [['ceo', task.id], ['agent', task.id]]);
  assert.equal(db.messages[0]?.body, 'What are you doing?');
  const text = promptText(model.doGenerateCalls[0]!);
  assert.match(text, /Shopify speed article/);
  assert.match(text, /Writing section 3/);
  assert.equal(db.usage.at(-1)?.kind, 'chat');
});

test('HTTP API: secret required, /health and /chat work', async () => {
  const server = createHttpServer({
    chat: async (agentId, q) => ({ answer: `${agentId}: ${q}` }),
    health: () => ({ running: 0 }),
  }, 's3cret');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 401);
    assert.equal((await fetch(`${base}/health`, { headers: { 'x-hq-secret': 'wrong' } })).status, 401);
    const h = await fetch(`${base}/health`, { headers: { 'x-hq-secret': 's3cret' } });
    assert.equal(h.status, 200);
    assert.equal((await h.json()).ok, true);
    const c = await fetch(`${base}/chat`, { method: 'POST', headers: { 'x-hq-secret': 's3cret', 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'seo-1', question: 'hi' }) });
    assert.deepEqual(await c.json(), { answer: 'seo-1: hi' });
    const bad = await fetch(`${base}/chat`, { method: 'POST', headers: { 'x-hq-secret': 's3cret' }, body: JSON.stringify({ agentId: '../x' }) });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});
