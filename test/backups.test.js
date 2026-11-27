// Backups: retention (30 days, monthly for 12 months, personal-data rule), a dump that restores to the same data,
// read-only access to other databases, and the nightly run with its log and failure alert.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { dumpDatabase, gzipParts, planRetention, runBackups, sqlValue } from '../src/backups.js';
import { readOnly } from '../src/readonly.js';
import { resetSchemaCache } from '../src/schema.js';
import { fakeD1, makeEnv, OWNER } from './helpers.js';

const key = (db, day) => `backups/${db}/${day}.sql.gz`;

test('retention: daily for 30 days, the 1st of the month for 12 months, today always kept', () => {
  const today = '2026-11-27';
  const keys = [key('yondr-feedback', '2026-11-27'), key('yondr-feedback', '2026-10-29'), key('yondr-feedback', '2026-10-28'),
    key('yondr-feedback', '2026-10-01'), key('yondr-feedback', '2025-12-01'), key('yondr-feedback', '2025-11-01'), 'backups/other/notes.txt'];
  const del = planRetention(keys, today, { retentionDays: 30, monthlyMonths: 12, piiDays: 30, pii: new Set() });
  assert.deepEqual(del.sort(), [key('yondr-feedback', '2025-11-01'), key('yondr-feedback', '2026-10-28')].sort());
});

test('retention: personal-data databases lose every backup (monthly ones too) after the PII setting', () => {
  const pii = new Set(['yondr-christmas-cards']);
  const keys = [key('yondr-christmas-cards', '2026-11-20'), key('yondr-christmas-cards', '2026-11-01'), key('yondr-christmas-cards', '2026-10-01')];
  assert.deepEqual(planRetention(keys, '2026-11-27', { piiDays: 30, pii }), [key('yondr-christmas-cards', '2026-10-01')]);
  assert.deepEqual(planRetention(keys, '2026-11-27', { piiDays: 7, pii }).sort(), [key('yondr-christmas-cards', '2026-10-01'), key('yondr-christmas-cards', '2026-11-01'), key('yondr-christmas-cards', '2026-11-20')].sort());
});

test('SQL values are escaped', () => {
  assert.equal(sqlValue("it's"), "'it''s'");
  assert.equal(sqlValue(null), 'NULL');
  assert.equal(sqlValue(3.5), '3.5');
  assert.equal(sqlValue([1, 255]), "X'01ff'");
  assert.equal(sqlValue(new Uint8Array([0, 16])), "X'0010'");
});

test('a dump restores into an empty database with the same rows (incl. many pages and WITHOUT ROWID)', async () => {
  const src = fakeD1();
  src.sqlite.exec(`CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, note TEXT, pic BLOB);
    CREATE INDEX people_name ON people(name);
    CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
    CREATE VIEW names AS SELECT name FROM people;`);
  const ins = src.sqlite.prepare('INSERT INTO people (name, note, pic) VALUES (?, ?, ?)');
  for (let i = 0; i < 2345; i++) ins.run(`Person ${i}`, i % 7 ? `it's "row" ${i}\nline 2` : null, i % 100 ? null : new Uint8Array([i % 256, 1]));
  src.sqlite.exec("INSERT INTO kv VALUES ('a', '1'), ('b', '2')");
  const stats = { tables: 0, rows: 0 };
  const gz = await gzipParts(dumpDatabase(readOnly(src), stats));
  assert.equal(stats.tables, 2);
  assert.equal(stats.rows, 2347);
  const sql = gunzipSync(gz).toString('utf8');
  const dst = new DatabaseSync(':memory:');
  dst.exec(sql);
  const q = (db, s) => db.prepare(s).all().map((r) => ({ ...r }));
  assert.deepEqual(q(dst, 'SELECT * FROM people ORDER BY id'), q(src.sqlite, 'SELECT * FROM people ORDER BY id'));
  assert.deepEqual(q(dst, 'SELECT * FROM kv ORDER BY k'), [{ k: 'a', v: '1' }, { k: 'b', v: '2' }]);
  assert.equal(q(dst, 'SELECT COUNT(*) AS n FROM names')[0].n, 2345);
  assert.ok(q(dst, "SELECT name FROM sqlite_master WHERE name = 'people_name'").length);
});

test('other tools\' databases are read-only', async () => {
  const ro = readOnly(fakeD1());
  for (const sql of ['DELETE FROM x', 'UPDATE x SET a = 1', 'DROP TABLE x', 'INSERT INTO x VALUES (1)', 'SELECT 1; DELETE FROM x', 'PRAGMA writable_schema = 1']) {
    assert.throws(() => ro.prepare(sql), /Read-only/, sql);
  }
  assert.ok(ro.prepare("SELECT 'a;b' AS x"));
});

test('nightly run: every database to R2, logged; a failure alerts owners/subscribers; PII flagged', async () => {
  resetSchemaCache();
  const env = makeEnv();
  env.CARDS_DB.sqlite.exec("CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO clients (name) VALUES ('Fictional Client');");
  delete env.REQUESTS_DB; // binding missing → that one fails, the rest still run
  const now = Date.parse('2026-11-27T03:17:00Z');
  env.BACKUPS.map.set('backups/yondr-feedback/2026-09-01.sql.gz', { bytes: new Uint8Array(1), opts: {} }); // 1st of the month: kept for 12 months
  env.BACKUPS.map.set('backups/yondr-christmas-cards/2026-09-01.sql.gz', { bytes: new Uint8Array(1), opts: {} }); // personal data: deleted after 30 days
  const r = await runBackups(env, { nowMs: now });
  assert.equal(r.ok, 4);
  assert.equal(r.failed, 1);
  assert.ok(env.BACKUPS.map.has('backups/yondr-christmas-cards/2026-11-27.sql.gz'));
  assert.ok(env.BACKUPS.map.has('backups/yondr-feedback/2026-09-01.sql.gz'));
  assert.ok(!env.BACKUPS.map.has('backups/yondr-christmas-cards/2026-09-01.sql.gz'));
  const cards = await env.DB.prepare("SELECT * FROM backups WHERE db = 'yondr-christmas-cards'").first();
  assert.equal(cards.pii, 1);
  assert.equal(cards.rows, 1);
  assert.match(gunzipSync(env.BACKUPS.map.get(cards.object_key).bytes).toString(), /Fictional Client/);
  // backup_failed goes to subscribers of that event (none here), and is logged as an alert attempt only if routed.
  assert.equal(env.EMAIL.sent.length, 0);
  await env.DB.prepare("INSERT INTO subscribers (email, active, min_severity, timezone, created_by, created_at, updated_at) VALUES (?, 1, 'all', 'UTC', 'x', 'x', 'x')").bind(OWNER).run();
  await env.DB.prepare("INSERT INTO subscriptions (subscriber_id, event_type, channel, webhook, created_at) VALUES (1, 'backup_failed', 'email', '', 'x')").run();
  await env.DB.prepare("DELETE FROM runs").run();
  await runBackups(env, { nowMs: now + 60_000 });
  const sent = env.EMAIL.sent.find((m) => /Backup failed for yondr-marketing-requests-db/.test(m.subject));
  assert.ok(sent);
  assert.equal(sent.to, OWNER);
  assert.match(sent.text, /Binding REQUESTS_DB is missing/);
  const logged = await env.DB.prepare("SELECT * FROM alerts WHERE event_type = 'backup_failed'").first();
  assert.equal(logged.status, 'sent');
});
