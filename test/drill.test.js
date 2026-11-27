// Monthly restore drill, key-expiry calendar, quarterly access review, the daily cron.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { runBackups } from '../src/backups.js';
import { isDrillDay, runDaily } from '../src/daily.js';
import { compareRestore, runDrills, splitSql } from '../src/drill.js';
import { checkKeys, keyAlertDue, validateKey } from '../src/keys.js';
import { firstWeekday, isReviewDay, maybeQuarterlyReview, nextReviewDate } from '../src/review.js';
import { applySchema, resetSchemaCache } from '../src/schema.js';
import { ADMIN, callWorker, fakeD1, makeEnv, OWNER } from './helpers.js';

let env;
beforeEach(async () => { resetSchemaCache(); env = makeEnv(); await applySchema(env.DB); });
const call = (path, opts) => callWorker(env, worker, path, opts);
const rows = (db, sql, ...a) => db.sqlite.prepare(sql).all(...a).map((r) => ({ ...r }));

/** Wrap a fake D1 so every statement run on it is recorded. */
function spy(db, log, name) {
  const wrap = (stmt) => ({ bind: (...a) => wrap(stmt.bind(...a)), first: () => { log.push([name, stmt.sql]); return stmt.first(); }, all: () => { log.push([name, stmt.sql]); return stmt.all(); }, run: () => { log.push([name, stmt.sql]); return stmt.run(); }, sql: stmt.sql });
  return { sqlite: db.sqlite, prepare: (sql) => wrap(db.prepare(sql)), batch: (stmts) => { for (const s of stmts) log.push([name, s.sql]); return db.batch(stmts.map((s) => db.prepare(s.sql).bind(...(s._args || [])))); } };
}

test('splitSql: strings with semicolons and newlines, quoted identifiers, triggers, comments; PRAGMA skipped', () => {
  const sql = `-- Backup by yondr-ops\nPRAGMA defer_foreign_keys = true;\nCREATE TABLE "a;b" (x TEXT);\nINSERT INTO "a;b" ("x") VALUES ('one; two\n-- not a comment ''quoted''');\n` +
    `CREATE TRIGGER t AFTER INSERT ON "a;b" BEGIN UPDATE "a;b" SET x = x; SELECT 1; END;\nCREATE INDEX i ON "a;b"(x);\n`;
  const s = splitSql(sql);
  assert.equal(s.length, 4);
  assert.match(s[1], /'one; two\n-- not a comment ''quoted'''\)$/);
  assert.match(s[2], /^CREATE TRIGGER t .* END$/s);
});

test('compareRestore: table list and per-table rows', () => {
  assert.equal(compareRestore({ tables: { a: 2, b: 0 } }, { a: 2, b: 0 }).ok, true);
  const bad = compareRestore({ tables: { a: 2, b: 1 } }, { a: 1, c: 0 });
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join('; '), /missing tables: b/);
  assert.match(bad.problems.join('; '), /unexpected tables: c/);
  assert.match(bad.problems.join('; '), /a: 1 rows restored, backup had 2/);
});

test('restore drill: only DRILL_DB is written or dropped; counts compared; personal data dropped straight after', async () => {
  env.FEEDBACK_DB.sqlite.exec("INSERT INTO feedback (message, created_at) VALUES ('it''s; fine', 'x'), ('two', 'y')");
  env.CARDS_DB.sqlite.exec("CREATE TABLE addresses (id INTEGER PRIMARY KEY, name TEXT, street TEXT); INSERT INTO addresses (name, street) VALUES ('Client A', '1 High St'), ('Client B', '2 Low Rd');");
  env.ADS_DB.sqlite.exec("CREATE TABLE ads (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO ads (title) VALUES ('x');");
  await runBackups(env, { force: true, nowMs: Date.parse('2026-12-01T03:17:00Z') });
  assert.ok(JSON.parse(rows(env.DB, "SELECT table_stats FROM backups WHERE db = 'yondr-christmas-cards'")[0].table_stats).addresses === 2);

  const log = [];
  const drillDb = fakeD1();
  drillDb.sqlite.exec('CREATE TABLE leftover (x); INSERT INTO leftover VALUES (1);'); // anything in the scratch DB is dropped first
  env.DRILL_DB = drillDb;
  for (const b of ['FEEDBACK_DB', 'ADS_DB', 'REQUESTS_DB', 'CARDS_DB']) env[b] = spy(env[b], log, b);
  const r = await runDrills(env, { triggeredBy: OWNER, nowMs: Date.parse('2026-12-01T03:30:00Z') });
  assert.equal(r.failed, 0, JSON.stringify(r.results.filter((x) => x.status !== 'ok')));
  assert.equal(r.ok, 5);
  assert.deepEqual(log, [], 'the live databases are not touched at all by the drill');
  const drills = rows(env.DB, 'SELECT * FROM restore_drills ORDER BY id');
  const fb = drills.find((d) => d.db === 'yondr-feedback');
  assert.equal(fb.rows_restored, fb.rows_expected);
  assert.match(fb.detail, /tables and \d+ rows, as recorded/);
  const cards = drills.find((d) => d.db === 'yondr-christmas-cards');
  assert.equal(cards.status, 'ok');
  assert.equal(cards.rows_restored, 2);
  assert.equal(cards.pii_dropped, 1);
  // The last database restored (yondr-ops) is what remains; no personal data, no leftovers.
  const tables = rows(drillDb, "SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
  assert.ok(!tables.includes('addresses'));
  assert.ok(!tables.includes('leftover'));
  assert.ok(tables.includes('issues'));
});

test('restore drill: a mismatch fails, alerts owners, and still drops personal data', async () => {
  env.CARDS_DB.sqlite.exec("CREATE TABLE addresses (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO addresses (name) VALUES ('Client A');");
  await runBackups(env, { force: true });
  env.DB.sqlite.exec(`UPDATE backups SET table_stats = '{"addresses":5}' WHERE db = 'yondr-christmas-cards'`);
  env.DRILL_DB = fakeD1();
  const r = await runDrills(env, {});
  assert.equal(r.failed, 1);
  const cards = rows(env.DB, "SELECT * FROM restore_drills WHERE db = 'yondr-christmas-cards'")[0];
  assert.equal(cards.status, 'failed');
  assert.match(cards.detail, /addresses: 1 rows restored, backup had 5/);
  assert.equal(cards.pii_dropped, 1);
  assert.equal(rows(env.DRILL_DB, "SELECT name FROM sqlite_master WHERE name = 'addresses'").length, 0);
  assert.ok(env.EMAIL.sent.some((m) => m.to === OWNER && /Restore drill failed for yondr-christmas-cards/.test(m.subject)));
});

test('restore drill on demand: owners only; the daily cron runs it on the 1st only', async () => {
  env.DRILL_DB = fakeD1();
  assert.equal((await call('/api/drills/run', { method: 'POST', as: ADMIN })).status, 403);
  assert.equal((await call('/api/drills/run', { method: 'POST', as: OWNER })).status, 202);
  assert.equal((await call('/api/drills/run', { method: 'POST', as: OWNER })).status, 429);
  assert.equal(isDrillDay(Date.parse('2026-12-01T03:17:00Z')), true);
  assert.equal(isDrillDay(Date.parse('2026-12-02T03:17:00Z')), false);
  const noBackups = async () => ({ ok: 0 });
  const day2 = await runDaily(env, { nowMs: Date.parse('2026-12-02T03:17:00Z'), backups: noBackups });
  assert.equal(day2.drill, undefined);
  const day1 = await runDaily(env, { nowMs: Date.parse('2027-01-01T03:17:00Z'), backups: noBackups });
  assert.ok(day1.drill);
});

test('key expiry: alerts at 30 and 14 days and on the day, once per level', () => {
  const today = '2026-11-27';
  assert.equal(keyAlertDue(null, today), null);
  assert.equal(keyAlertDue('2026-12-28', today), null, '31 days');
  assert.deepEqual(keyAlertDue('2026-12-27', today), { level: 30, days: 30 });
  assert.equal(keyAlertDue('2026-12-20', today, [30]), null);
  assert.deepEqual(keyAlertDue('2026-12-11', today, [30]), { level: 14, days: 14 });
  assert.deepEqual(keyAlertDue('2026-12-07', today, []), { level: 14, days: 10 }, 'added late: the most urgent level reached');
  assert.deepEqual(keyAlertDue('2026-11-27', today, [30, 14]), { level: 0, days: 0 });
  assert.deepEqual(keyAlertDue('2026-11-20', today, [30, 14]), { level: 0, days: -7 });
  assert.equal(keyAlertDue('2026-11-20', today, [30, 14, 0]), null);
});

test('key calendar: never key values; owners and the key owner are alerted once per level', async () => {
  assert.ok(validateKey({ name: 'X', location: 'gh' + 'p_abcdefghijklmnopqrstuvwxyz0123' }, env, { creating: true }).error);
  assert.ok(validateKey({ name: 'X', location: 'y', expires_on: '31/12/2026' }, env, { creating: true }).error);
  const add = await call('/api/keys', { method: 'POST', body: { name: 'TEST_TOKEN', location: 'somewhere', expires_on: '2026-12-11', owner_email: 'cy.staff@overyondr.com' } });
  assert.equal(add.status, 201);
  const keys = (await call('/api/keys')).data.keys;
  assert.equal(keys.length, 11, 'ten seeded + one');
  assert.ok(keys.every((k) => !('value' in k)));
  const now = Date.parse('2026-11-27T03:17:00Z');
  await checkKeys(env, { nowMs: now });
  const to = env.EMAIL.sent.map((m) => m.to).sort();
  assert.deepEqual(to, [OWNER, 'cy.staff@overyondr.com'].sort());
  assert.match(env.EMAIL.sent[0].subject, /TEST_TOKEN expires in 14 days/);
  await checkKeys(env, { nowMs: now + 86_400_000 });
  assert.equal(env.EMAIL.sent.length, 2, 'not again until the next level');
  await checkKeys(env, { nowMs: Date.parse('2026-12-11T03:17:00Z') });
  assert.equal(env.EMAIL.sent.length, 4);
  // Removing a key is for owners; changes are audited.
  const id = add.data.id;
  assert.equal((await call(`/api/keys/${id}`, { method: 'DELETE', as: ADMIN })).status, 403);
  assert.equal((await call(`/api/keys/${id}`, { method: 'PATCH', body: { expires_on: '2027-12-01', last_rotated: '2026-11-27' } })).status, 200);
  assert.ok(rows(env.DB, "SELECT * FROM audit WHERE action IN ('key.add', 'key.update')").length === 2);
});

test('quarterly access review: first weekday of Jan/Apr/Jul/Oct, once per quarter, assigned to an owner', async () => {
  assert.equal(firstWeekday(2027, 0), '2027-01-01'); // Friday
  assert.equal(firstWeekday(2028, 6), '2028-07-03'); // 1 July 2028 is a Saturday
  assert.equal(isReviewDay(Date.parse('2027-01-01T03:17:00Z')), true);
  assert.equal(isReviewDay(Date.parse('2028-07-01T03:17:00Z')), false);
  assert.equal(isReviewDay(Date.parse('2028-07-03T03:17:00Z')), true);
  assert.equal(isReviewDay(Date.parse('2026-11-02T03:17:00Z')), false, 'not a quarter month');
  assert.equal(nextReviewDate(Date.parse('2026-11-27T00:00:00Z')), '2027-01-01');
  assert.equal(nextReviewDate(Date.parse('2027-01-01T12:00:00Z')), '2027-01-01');
  assert.equal(nextReviewDate(Date.parse('2027-01-02T12:00:00Z')), '2027-04-01');
  assert.equal(await maybeQuarterlyReview(env, { nowMs: Date.parse('2026-11-27T03:17:00Z') }), null);
  const id = await maybeQuarterlyReview(env, { nowMs: Date.parse('2027-01-01T03:17:00Z') });
  assert.ok(id);
  assert.equal(await maybeQuarterlyReview(env, { nowMs: Date.parse('2027-01-01T03:18:00Z') }), null, 'once per quarter');
  const issue = rows(env.DB, 'SELECT * FROM issues WHERE id = ?', id)[0];
  assert.equal(issue.title, 'Quarterly access review 2027 Q1');
  assert.equal(issue.assignee_email, OWNER);
  assert.equal(issue.source, 'security');
  assert.match(issue.description, /\[ \] ben\.admin@overyondr\.com — feedback: admin — last seen never — NOT SEEN FOR 90\+ DAYS/);
  assert.ok(env.EMAIL.sent.some((m) => m.to === OWNER && /Quarterly access review/.test(m.subject)));
});
