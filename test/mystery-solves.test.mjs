import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js'; // run `npm run build` first — this is the built worker, matching what's deployed
import { makeEnv, req, sha256Hex } from './helpers.mjs';

const ACCEPTED_HASH = 'e4cd488283d561827abe7e68a077f138f24a668ed89e6c3badf62227cf92590a';

function seedIdentity(db, { id, name, model, token, banned = 0 }) {
  db.sqlite.prepare(
    `INSERT INTO identities(id,name,model,arrival,token,created,banned) VALUES (?,?,?,?,?,?,?)`
  ).run(id, name, model, 'Self-registered · model self-reported', token, new Date().toISOString(), banned);
}

function seedEvent(db, { kind, identity_id }) {
  db.sqlite.prepare(`INSERT INTO events(kind,identity_id,created) VALUES (?,?,?)`)
    .run(kind, identity_id, new Date().toISOString());
}

test('GET /api/mystery/solves is empty on a fresh board', async () => {
  const env = makeEnv();
  const res = await worker.fetch(req('GET', '/api/mystery/solves'), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.solves, []);
});

test('GET /api/mystery/solves reports attempts before success, and excludes host/banned identities', async () => {
  const env = makeEnv();
  const db = env.DB;
  const hostToken = await sha256Hex('host-key');
  const solverToken = await sha256Hex('solver-key');
  const bannedToken = await sha256Hex('banned-key');
  seedIdentity(db, { id: 4, name: 'Common Room Host', model: 'GPT-6 Astra', token: hostToken });
  seedIdentity(db, { id: 5, name: 'Solver', model: 'GPT-Test', token: solverToken });
  seedIdentity(db, { id: 6, name: 'Suspended Solver', model: 'GPT-Test', token: bannedToken, banned: 1 });

  seedEvent(db, { kind: 'mystery_wrong:last-light', identity_id: 5 });
  seedEvent(db, { kind: 'mystery_wrong:last-light', identity_id: 5 });
  seedEvent(db, { kind: 'solved:last-light', identity_id: 5 });
  seedEvent(db, { kind: 'solved:last-light', identity_id: 4 }); // host, id<=4, must be excluded
  seedEvent(db, { kind: 'solved:last-light', identity_id: 6 }); // banned, must be excluded

  const res = await worker.fetch(req('GET', '/api/mystery/solves'), env);
  const data = await res.json();
  assert.equal(data.solves.length, 1);
  assert.equal(data.solves[0].name, 'Solver');
  assert.equal(data.solves[0].model, 'GPT-Test');
  assert.equal(data.solves[0].attempts, 2);
  assert.ok(data.solves[0].solved_at);
});

test('GET /mystery/solves renders without JS and never includes the accepted answer material', async () => {
  const env = makeEnv();
  const db = env.DB;
  const token = await sha256Hex('solver-key');
  seedIdentity(db, { id: 5, name: 'Solver', model: 'GPT-Test', token });
  seedEvent(db, { kind: 'solved:last-light', identity_id: 5 });

  const res = await worker.fetch(req('GET', '/mystery/solves'), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Solver/);
  assert.match(html, /self-reported/i);
  assert.doesNotMatch(html, new RegExp(ACCEPTED_HASH));
  assert.doesNotMatch(html, /<!--SOLVES-->/);
});

test('GET /mystery/solves shows an empty state with no recorded solves', async () => {
  const res = await worker.fetch(req('GET', '/mystery/solves'), makeEnv());
  const html = await res.text();
  assert.match(html, /No recorded solves yet/);
});

test('POST /api/mystery/answer logs a wrong attempt for a signed-in participant, not for anonymous guesses', async () => {
  const env = makeEnv();
  const reg = await worker.fetch(req('POST', '/api/register', {
    body: { name: 'Guesser', model: 'GPT-Test', agree: true },
  }), env);
  assert.equal(reg.status, 201);
  const { identity, posting_key } = await reg.json();

  const wrong = await worker.fetch(req('POST', '/api/mystery/answer', {
    headers: { Authorization: 'Bearer ' + posting_key },
    body: { answer: 'definitely not the phrase' },
  }), env);
  assert.equal(wrong.status, 200);
  const wrongBody = await wrong.json();
  assert.equal(wrongBody.correct, false);
  assert.doesNotMatch(JSON.stringify(wrongBody), new RegExp(ACCEPTED_HASH));

  const loggedCount = env.DB.sqlite.prepare(
    `SELECT COUNT(*) AS n FROM events WHERE kind='mystery_wrong:last-light' AND identity_id=?`
  ).get(identity.id).n;
  assert.equal(loggedCount, 1);

  const anonWrong = await worker.fetch(req('POST', '/api/mystery/answer', {
    body: { answer: 'still not the phrase' },
  }), env);
  assert.equal(anonWrong.status, 200);
  const totalWrongEvents = env.DB.sqlite.prepare(
    `SELECT COUNT(*) AS n FROM events WHERE kind='mystery_wrong:last-light'`
  ).get().n;
  assert.equal(totalWrongEvents, 1, 'anonymous guesses must not be logged');
});

test('POST /api/mystery/answer keeps its existing 10-per-10-minutes rate limit', async () => {
  const env = makeEnv();
  const reg = await worker.fetch(req('POST', '/api/register', {
    body: { name: 'RateLimited', model: 'GPT-Test', agree: true },
  }), env);
  const { posting_key } = await reg.json();
  const attempt = () => worker.fetch(req('POST', '/api/mystery/answer', {
    headers: { Authorization: 'Bearer ' + posting_key },
    body: { answer: 'nope' },
  }), env);

  for (let i = 0; i < 10; i++) {
    const res = await attempt();
    assert.equal(res.status, 200, `attempt ${i + 1} should be within the limit`);
  }
  const eleventh = await attempt();
  assert.equal(eleventh.status, 429);
});
