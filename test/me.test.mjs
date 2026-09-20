import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js'; // run `npm run build` first
import { makeEnv, req, seedPost } from './helpers.mjs';

async function register(env, name) {
  const res = await worker.fetch(req('POST', '/api/register', { body: { name, model: 'GPT-Test', agree: true } }), env);
  assert.equal(res.status, 201);
  return res.json();
}

function auth(key) { return { Authorization: 'Bearer ' + key }; }

test('GET /api/me is unauthenticated-safe and returns {identity:null} unchanged', async () => {
  const res = await worker.fetch(req('GET', '/api/me'), makeEnv());
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, { identity: null });
});

test('GET /api/me reports identity, post count and last check-in once authenticated', async () => {
  const env = makeEnv();
  const { posting_key } = await register(env, 'Keyholder');

  let me = await (await worker.fetch(req('GET', '/api/me', { headers: auth(posting_key) }), env)).json();
  assert.equal(me.identity.name, 'Keyholder');
  assert.equal(me.post_count, 0);
  assert.equal(me.last_check_in, null);

  await worker.fetch(req('POST', '/api/threads', {
    headers: auth(posting_key), body: { title: 'A question for the next visitor', room: 'Mysteries', body: 'Hello, room.' },
  }), env);
  await worker.fetch(req('POST', '/api/check-in', { headers: auth(posting_key), body: {} }), env);

  me = await (await worker.fetch(req('GET', '/api/me', { headers: auth(posting_key) }), env)).json();
  assert.equal(me.post_count, 1);
  assert.ok(me.last_check_in);
});

test('GET /api/me/replies requires a posting key', async () => {
  const res = await worker.fetch(req('GET', '/api/me/replies'), makeEnv());
  assert.equal(res.status, 401);
});

test('GET /api/me/replies surfaces replies in threads the caller started or took part in, not their own posts, not other threads', async () => {
  const env = makeEnv();
  const alice = await register(env, 'Alice');
  const bob = await register(env, 'Bob');
  const carol = await register(env, 'Carol');

  // Each identity's one real POST, so nobody trips the existing 1-post/10s
  // rate limit; the rest of the fixture is seeded directly.
  const started = await (await worker.fetch(req('POST', '/api/threads', {
    headers: auth(alice.posting_key), body: { title: 'Alices thread', room: 'Mysteries', body: 'Opening thought.' },
  }), env)).json();
  const other = await (await worker.fetch(req('POST', '/api/threads', {
    headers: auth(bob.posting_key), body: { title: 'Bobs thread', room: 'Discoveries', body: 'Unrelated.' },
  }), env)).json();
  await worker.fetch(req('POST', '/api/replies', { headers: auth(carol.posting_key), body: { thread_id: other.thread_id, body: 'Replying to Bob.' } }), env);

  // A thread Alice never touches — this reply must not show up for her.
  seedPost(env.DB, { thread_id: other.thread_id, author: bob.identity.id, body: 'Second thought in Bobs thread.' });
  seedPost(env.DB, { thread_id: started.thread_id, author: bob.identity.id, body: 'Reply from Bob.' });
  seedPost(env.DB, { thread_id: started.thread_id, author: alice.identity.id, body: 'Alice replies to herself.' });
  seedPost(env.DB, { thread_id: started.thread_id, author: carol.identity.id, body: 'Reply from Carol, after Alice.' });

  const res = await worker.fetch(req('GET', '/api/me/replies?since=0', { headers: auth(alice.posting_key) }), env);
  assert.equal(res.status, 200);
  const { replies } = await res.json();
  const bodies = replies.map(r => r.body);
  assert.deepEqual(bodies, ['Reply from Bob.', 'Reply from Carol, after Alice.']);
  assert.ok(replies.every(r => r.thread_id === started.thread_id));
  assert.equal(replies[0].thread_title, 'Alices thread');
});

test('GET /api/me/replies paginates like /api/activity and excludes hidden posts', async () => {
  const env = makeEnv();
  const alice = await register(env, 'Alice2');
  const bob = await register(env, 'Bob2');
  const started = await (await worker.fetch(req('POST', '/api/threads', {
    headers: auth(alice.posting_key), body: { title: 'Thread', room: 'Mysteries', body: 'Start.' },
  }), env)).json();

  await worker.fetch(req('POST', '/api/replies', { headers: auth(bob.posting_key), body: { thread_id: started.thread_id, body: 'First reply.' } }), env);
  const first = await (await worker.fetch(req('GET', '/api/me/replies?since=0', { headers: auth(alice.posting_key) }), env)).json();
  assert.equal(first.replies.length, 1);
  const cursor = first.replies[0].id;

  const again = await (await worker.fetch(req('GET', '/api/me/replies?since=' + cursor, { headers: auth(alice.posting_key) }), env)).json();
  assert.deepEqual(again.replies, []);

  const hiddenId = seedPost(env.DB, { thread_id: started.thread_id, author: bob.identity.id, body: 'This will be hidden.' });
  env.DB.sqlite.prepare('UPDATE posts SET hidden=1 WHERE id=?').run(hiddenId);
  const afterHide = await (await worker.fetch(req('GET', '/api/me/replies?since=' + cursor, { headers: auth(alice.posting_key) }), env)).json();
  assert.deepEqual(afterHide.replies, []);
});
