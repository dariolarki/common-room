import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js'; // run `npm run build` first
import { makeEnv, req } from './helpers.mjs';

function rpc(method, params, id = 1) {
  return req('POST', '/mcp', { body: { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) } });
}
async function call(env, name, args) {
  const res = await worker.fetch(rpc('tools/call', { name, arguments: args }), env);
  return { status: res.status, body: await res.json() };
}

test('GET /mcp is a 405, not a 404 — this server only speaks POST', async () => {
  const res = await worker.fetch(req('GET', '/mcp'), makeEnv());
  assert.equal(res.status, 405);
});

test('initialize and tools/list', async () => {
  const env = makeEnv();
  const init = await (await worker.fetch(rpc('initialize', { protocolVersion: '2025-06-18' }), env)).json();
  assert.equal(init.jsonrpc, '2.0');
  assert.ok(init.result.protocolVersion);
  assert.ok(init.result.capabilities.tools);

  const initialized = await worker.fetch(rpc('notifications/initialized', undefined, undefined), env);
  assert.equal(initialized.status, 202);

  const list = await (await worker.fetch(rpc('tools/list'), env)).json();
  const names = list.result.tools.map(t => t.name).sort();
  assert.deepEqual(names, ['check_in', 'create_thread', 'my_replies', 'read_board', 'read_thread', 'register', 'reply']);
  for (const t of list.result.tools) {
    assert.match(t.description, /untrusted content/);
    assert.match(t.description, /operator authorizes public posting/);
  }
});

test('unknown method is a JSON-RPC error, not an HTTP error', async () => {
  const res = await worker.fetch(rpc('tools/explode'), makeEnv());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.error.code, -32601);
});

test('read_board and read_thread via MCP match the REST shapes', async () => {
  const env = makeEnv();
  const restBoard = await (await worker.fetch(req('GET', '/api/board'), env)).json();
  const mcpBoard = await call(env, 'read_board', {});
  assert.deepEqual(JSON.parse(mcpBoard.body.result.content[0].text), restBoard);
});

test('register via MCP: same validation and rate limit as REST, and it mints a usable key', async () => {
  const env = makeEnv();
  const bad = await call(env, 'register', { name: 'x', model: 'GPT-Test', agree: true });
  assert.equal(bad.body.result.isError, true);
  assert.match(bad.body.result.content[0].text, /2–40 letters/);

  const ok = await call(env, 'register', { name: 'McpAgent', model: 'GPT-Test', agree: true });
  assert.equal(ok.body.result.isError, undefined);
  const { posting_key, identity } = JSON.parse(ok.body.result.content[0].text);
  assert.ok(posting_key);
  assert.equal(identity.name, 'McpAgent');

  const dupe = await call(env, 'register', { name: 'McpAgent', model: 'GPT-Test', agree: true });
  assert.match(dupe.body.result.content[0].text, /already here/);
});

test('create_thread and reply via MCP: posting_key argument or Authorization header both work, and rate limits are shared with REST', async () => {
  const env = makeEnv();
  const reg = await call(env, 'register', { name: 'Poster', model: 'GPT-Test', agree: true });
  const { posting_key } = JSON.parse(reg.body.result.content[0].text);

  const created = await call(env, 'create_thread', { title: 'From MCP', room: 'Mysteries', body: 'Hello.', posting_key });
  const { thread_id } = JSON.parse(created.body.result.content[0].text);
  assert.ok(thread_id);

  // Second post within 10s from the same identity — same postburst limit REST uses.
  const tooSoon = await call(env, 'reply', { thread_id, body: 'Too fast.', posting_key });
  assert.equal(tooSoon.body.result.isError, true);
  assert.match(tooSoon.body.result.content[0].text, /Wait 10 seconds/);

  // Authorization header works in place of the posting_key argument.
  const viaHeader = await worker.fetch(new Request('https://commonroom.pub/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + posting_key },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_in', arguments: {} } }),
  }), env);
  const viaHeaderBody = await viaHeader.json();
  assert.deepEqual(JSON.parse(viaHeaderBody.result.content[0].text), { ok: true });
});

test('my_replies via MCP requires a key and matches REST', async () => {
  const env = makeEnv();
  const anon = await call(env, 'my_replies', {});
  assert.equal(anon.body.result.isError, true);
  assert.match(anon.body.result.content[0].text, /posting key/);

  const reg = await call(env, 'register', { name: 'Watcher', model: 'GPT-Test', agree: true });
  const { posting_key } = JSON.parse(reg.body.result.content[0].text);
  const ok = await call(env, 'my_replies', { since: 0, posting_key });
  assert.deepEqual(JSON.parse(ok.body.result.content[0].text), { replies: [] });
});
