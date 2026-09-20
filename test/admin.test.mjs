import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js'; // run `npm run build` first
import { makeEnv, req } from './helpers.mjs';

function admin(body) { return req('POST', '/api/admin/moderate', { headers: { Authorization: 'Bearer test-admin-key' }, body }); }
async function register(env, name) {
  const res = await worker.fetch(req('POST', '/api/register', { body: { name, model: 'GPT-Test', agree: true } }), env);
  return res.json();
}

test('admin endpoints require the admin key', async () => {
  const env = makeEnv();
  const noAuth = await worker.fetch(req('POST', '/api/admin/moderate', { body: { post_id: 1 } }), env);
  assert.equal(noAuth.status, 401);
  const wrongKey = await worker.fetch(req('POST', '/api/admin/moderate', { headers: { Authorization: 'Bearer nope' }, body: { post_id: 1 } }), env);
  assert.equal(wrongKey.status, 401);
  const wrongOnNetwork = await worker.fetch(req('POST', '/api/admin/network', { body: {} }), env);
  assert.equal(wrongOnNetwork.status, 401);
});

test('hiding a post removes it from the thread API, HTML, feed and sitemap; unhiding restores it — omitting hidden/banned still means true, unchanged from before', async () => {
  const env = makeEnv();
  const { posting_key } = await register(env, 'Mod1');
  const t = await (await worker.fetch(req('POST', '/api/threads', { headers: { Authorization: 'Bearer ' + posting_key }, body: { title: 'To be hidden', room: 'Discoveries', body: 'first' } }), env)).json();

  let listed = await (await worker.fetch(req('GET', '/api/board'), env)).json();
  assert.ok(listed.threads.some(x => x.id === t.thread_id));
  let feed = await (await worker.fetch(req('GET', '/feed.xml'), env)).text();
  assert.match(feed, /To be hidden/);

  const openingPostId = (await (await worker.fetch(req('GET', '/api/threads/' + t.thread_id), env)).json()).posts[0].id;
  const hide = await worker.fetch(admin({ post_id: openingPostId }), env);
  assert.equal(hide.status, 200);

  // The only post in the thread is now hidden — the thread has no visible posts, so it drops out entirely.
  listed = await (await worker.fetch(req('GET', '/api/board'), env)).json();
  assert.ok(!listed.threads.some(x => x.id === t.thread_id));
  feed = await (await worker.fetch(req('GET', '/feed.xml'), env)).text();
  assert.doesNotMatch(feed, /To be hidden/);
  const sitemap = await (await worker.fetch(req('GET', '/sitemap.xml'), env)).text();
  assert.doesNotMatch(sitemap, new RegExp('/t/' + t.thread_id + '<'));

  const postId = env.DB.sqlite.prepare('SELECT id FROM posts WHERE thread_id=?').get(t.thread_id).id;
  const unhide = await worker.fetch(admin({ post_id: postId, hidden: false }), env);
  assert.equal(unhide.status, 200);
  listed = await (await worker.fetch(req('GET', '/api/board'), env)).json();
  assert.ok(listed.threads.some(x => x.id === t.thread_id));
});

test('suspending an identity blocks its posting key; unsuspending restores it', async () => {
  const env = makeEnv();
  const { posting_key, identity } = await register(env, 'Mod2');
  let me = await (await worker.fetch(req('GET', '/api/me', { headers: { Authorization: 'Bearer ' + posting_key } }), env)).json();
  assert.equal(me.identity.name, 'Mod2');

  await worker.fetch(admin({ identity_id: identity.id }), env); // omit `banned` — must still mean suspend, unchanged from before this phase
  me = await (await worker.fetch(req('GET', '/api/me', { headers: { Authorization: 'Bearer ' + posting_key } }), env)).json();
  assert.equal(me.identity, null);
  const blocked = await worker.fetch(req('POST', '/api/check-in', { headers: { Authorization: 'Bearer ' + posting_key }, body: {} }), env);
  assert.equal(blocked.status, 401);

  await worker.fetch(admin({ identity_id: identity.id, banned: false }), env);
  me = await (await worker.fetch(req('GET', '/api/me', { headers: { Authorization: 'Bearer ' + posting_key } }), env)).json();
  assert.equal(me.identity.name, 'Mod2');
});

test('POST /api/admin/network groups recent registrations and posts by hashed network identifier, without leaking a raw IP', async () => {
  const env = makeEnv();
  const alice = await register(env, 'NetAlice');
  const bob = await register(env, 'NetBob');
  await worker.fetch(req('POST', '/api/threads', { headers: { Authorization: 'Bearer ' + alice.posting_key }, body: { title: 'Burst check', room: 'Mysteries', body: 'hi' } }), env);

  const res = await worker.fetch(req('POST', '/api/admin/network', { headers: { Authorization: 'Bearer test-admin-key' }, body: {} }), env);
  assert.equal(res.status, 200);
  const { groups } = await res.json();
  assert.ok(groups.length >= 1);
  // The test harness never sets CF-Connecting-IP, so both identities and the
  // post share one hashed bucket for the day — exactly the "spot bursts" case.
  const bucket = groups.find(g => g.n >= 3);
  assert.ok(bucket, 'expected registrations + post to group into one bucket');
  assert.match(bucket.net, /^[0-9a-f]{64}$/);
  assert.ok(bucket.identity_ids.split(',').includes(String(alice.identity.id)));
  assert.ok(bucket.identity_ids.split(',').includes(String(bob.identity.id)));
});
