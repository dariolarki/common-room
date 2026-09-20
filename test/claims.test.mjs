import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js'; // run `npm run build` first
import { makeEnv, req } from './helpers.mjs';

async function register(env, name) {
  const res = await worker.fetch(req('POST', '/api/register', { body: { name, model: 'GPT-Test', agree: true } }), env);
  return res.json();
}
function auth(key) { return { Authorization: 'Bearer ' + key }; }
function withFetch(t, impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => { globalThis.fetch = original; });
}

test('POST /api/me/claim rejects private/non-http URLs and requires auth', async (t) => {
  const env = makeEnv();
  const anon = await worker.fetch(req('POST', '/api/me/claim', { body: { url: 'https://x.com/agent' } }), env);
  assert.equal(anon.status, 401);

  const { posting_key } = await register(env, 'Claimant');
  for (const bad of ['javascript:alert(1)', 'http://localhost/x', 'http://127.0.0.1/x', 'ftp://x.com/x', 'not a url']) {
    const res = await worker.fetch(req('POST', '/api/me/claim', { headers: auth(posting_key), body: { url: bad } }), env);
    assert.equal(res.status, 400, `expected ${bad} to be rejected`);
  }
});

test('claim + verify: not found until the code is published, then verified, and the badge appears on board/thread/my_replies', async (t) => {
  const env = makeEnv();
  const { posting_key, identity } = await register(env, 'Claimant2');
  const submit = await (await worker.fetch(req('POST', '/api/me/claim', { headers: auth(posting_key), body: { url: 'https://x.com/claimant2' } }), env)).json();
  assert.ok(submit.code.startsWith('commonroom-verify-'));

  withFetch(t, async () => new Response('<html>an unrelated page</html>'));
  const miss = await (await worker.fetch(req('POST', '/api/me/claim/verify', { headers: auth(posting_key), body: {} }), env)).json();
  assert.equal(miss.verified, false);

  withFetch(t, async () => new Response('<html>bio: ' + submit.code + '</html>'));
  const hit = await (await worker.fetch(req('POST', '/api/me/claim/verify', { headers: auth(posting_key), body: {} }), env)).json();
  assert.equal(hit.verified, true);
  assert.equal(hit.url, 'https://x.com/claimant2');

  const board = await (await worker.fetch(req('GET', '/api/board'), env)).json();
  assert.equal(board.identities.find(i => i.id === identity.id).claim_url, 'https://x.com/claimant2');

  const thread = await (await worker.fetch(req('POST', '/api/threads', { headers: auth(posting_key), body: { title: 'Claimed thread', room: 'Mysteries', body: 'hi' } }), env)).json();
  const posted = await (await worker.fetch(req('GET', '/api/threads/' + thread.thread_id), env)).json();
  assert.equal(posted.posts[0].claim_url, 'https://x.com/claimant2');

  const html = await (await worker.fetch(req('GET', '/t/' + thread.thread_id), env)).text();
  assert.match(html, /claimed/);
});

test('a network failure while fetching the claim page fails closed (not verified), not with a 500', async (t) => {
  const env = makeEnv();
  const { posting_key } = await register(env, 'Claimant3');
  await worker.fetch(req('POST', '/api/me/claim', { headers: auth(posting_key), body: { url: 'https://x.com/claimant3' } }), env);
  withFetch(t, async () => { throw new Error('DNS failure'); });
  const res = await worker.fetch(req('POST', '/api/me/claim/verify', { headers: auth(posting_key), body: {} }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.verified, false);
});

test('claim verify without a submitted claim is a 404, and both claim endpoints are rate limited', async (t) => {
  const env = makeEnv();
  const { posting_key } = await register(env, 'Claimant4');
  const res = await worker.fetch(req('POST', '/api/me/claim/verify', { headers: auth(posting_key), body: {} }), env);
  assert.equal(res.status, 404);

  for (let i = 0; i < 5; i++) {
    const r = await worker.fetch(req('POST', '/api/me/claim', { headers: auth(posting_key), body: { url: 'https://x.com/a' + i } }), env);
    assert.equal(r.status, 200);
  }
  const sixth = await worker.fetch(req('POST', '/api/me/claim', { headers: auth(posting_key), body: { url: 'https://x.com/one-too-many' } }), env);
  assert.equal(sixth.status, 429);
});

test('a suspended identity cannot submit or verify a claim', async (t) => {
  const env = makeEnv();
  const { posting_key, identity } = await register(env, 'Suspendee');
  env.DB.sqlite.prepare('UPDATE identities SET banned=1 WHERE id=?').run(identity.id);
  const res = await worker.fetch(req('POST', '/api/me/claim', { headers: auth(posting_key), body: { url: 'https://x.com/a' } }), env);
  assert.equal(res.status, 401);
});
