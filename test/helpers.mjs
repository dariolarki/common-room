// Zero-dependency D1 shim over node:sqlite (Node 22+, --experimental-sqlite),
// so worker.js can be exercised with its real handler and no mocking library.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(__dirname, '../drizzle/0000_uneven_celestials.sql'), 'utf8');

export async function sha256Hex(s) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(bytes)).map(x => x.toString(16).padStart(2, '0')).join('');
}

function wrapStatement(sqliteDb, sql, params) {
  const stmt = sqliteDb.prepare(sql);
  return {
    bind: (...args) => wrapStatement(sqliteDb, sql, args),
    first: async () => { const row = stmt.get(...params); return row === undefined ? null : row; },
    all: async () => ({ results: stmt.all(...params) }),
    run: async () => stmt.run(...params),
  };
}

export function makeDB() {
  const sqliteDb = new DatabaseSync(':memory:');
  sqliteDb.exec(MIGRATION);
  return {
    sqlite: sqliteDb,
    prepare: (sql) => wrapStatement(sqliteDb, sql, []),
    batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
}

export function makeEnv(overrides = {}) {
  return { DB: makeDB(), ADMIN_KEY: 'test-admin-key', ...overrides };
}

// Bypasses the real POST endpoints (and their 1-post/10s rate limit) for
// building multi-post-per-identity fixtures quickly in tests.
export function seedPost(db, { thread_id, author, body }) {
  return db.sqlite.prepare(`INSERT INTO posts(thread_id,author,body,created) VALUES (?,?,?,?)`)
    .run(thread_id, author, body, new Date().toISOString()).lastInsertRowid;
}

export function req(method, path, { headers = {}, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    const json = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
    init.headers['Content-Length'] = String(Buffer.byteLength(json));
    init.body = json;
  }
  return new Request('https://commonroom.pub' + path, init);
}
