// People & permissions (proxy to the feedback tool's admin API), the directory, and the staff status page.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { reviewList } from '../src/people.js';
import { runMonitor } from '../src/monitor.js';
import { applySchema, resetSchemaCache } from '../src/schema.js';
import { ADMIN, callWorker, makeEnv, NEWBIE, OWNER, probes, STAFF } from './helpers.js';

let env;
beforeEach(async () => { resetSchemaCache(); env = makeEnv(); await applySchema(env.DB); });
const call = (path, opts) => callWorker(env, worker, path, opts);
const audit = () => env.DB.sqlite.prepare('SELECT * FROM audit ORDER BY id').all().map((r) => ({ ...r, detail: JSON.parse(r.detail) }));

/** A stand-in for the FEEDBACK service binding: records requests, answers with `reply`. */
function feedbackService(reply) {
  const seen = [];
  return { seen, async fetch(req) { seen.push({ url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body: req.method === 'GET' ? null : await req.text() }); return reply(req); } };
}

test('role changes go through the feedback tool: the person\'s own session cookie, X-Yondr-Feedback and the ops Origin', async () => {
  env.FEEDBACK = feedbackService(() => Response.json({ admins: [{ email: NEWBIE, role: 'admin' }] }));
  const r = await call('/api/permissions/feedback-admins', { method: 'POST', as: OWNER, body: { email: NEWBIE, role: 'admin' } });
  assert.equal(r.status, 200);
  const req = env.FEEDBACK.seen[0];
  assert.equal(req.url, 'https://feedback.overyondrdev.com/api/admins');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['x-yondr-feedback'], '1');
  assert.equal(req.headers.origin, 'https://ops.overyondrdev.com');
  assert.match(req.headers.cookie, /^yondr_session=[\w-]+\.[\w-]+\.[\w-]+$/, 'only the sign-in cookie is forwarded');
  assert.deepEqual(JSON.parse(req.body), { email: NEWBIE, role: 'admin' });
  const a = audit().at(-1);
  assert.equal(a.actor, OWNER);
  assert.equal(a.action, 'permission.feedback_admin.set');
  assert.equal(a.detail.result, 'done');
  // Ops never writes the feedback database itself.
  assert.equal(env.FEEDBACK_DB.sqlite.prepare('SELECT COUNT(*) AS n FROM admins WHERE email = ?').get(NEWBIE).n, 0);
});

test('the feedback tool\'s own rules apply: its 403 is shown to the admin and audited as refused', async () => {
  env.FEEDBACK = feedbackService(() => Response.json({ error: 'Only an owner can change an owner’s role.' }, { status: 403 }));
  const r = await call('/api/permissions/feedback-admins', { method: 'POST', as: ADMIN, body: { email: OWNER, role: 'admin' } });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'Only an owner can change an owner’s role.');
  assert.equal(r.data.from, 'feedback');
  assert.match(audit().at(-1).detail.result, /^refused \(403\)/);
  // Removing: DELETE with the email in the body, as the feedback API defines.
  env.FEEDBACK = feedbackService(() => Response.json({ admins: [] }));
  await call('/api/permissions/feedback-admins', { method: 'DELETE', as: OWNER, body: { email: ADMIN } });
  assert.equal(env.FEEDBACK.seen[0].method, 'DELETE');
  assert.deepEqual(JSON.parse(env.FEEDBACK.seen[0].body), { email: ADMIN });
  assert.equal(audit().at(-1).action, 'permission.feedback_admin.remove');
});

test('permission changes: CSRF-protected, admins only, work addresses only', async () => {
  env.FEEDBACK = feedbackService(() => Response.json({ admins: [] }));
  assert.equal((await call('/api/permissions/feedback-admins', { method: 'POST', body: { email: NEWBIE }, csrf: false })).status, 403);
  assert.equal((await call('/api/permissions/feedback-admins', { method: 'POST', as: STAFF, body: { email: NEWBIE } })).status, 403);
  assert.equal((await call('/api/permissions/feedback-admins', { method: 'POST', body: { email: 'x@gmail.com' } })).status, 422);
  assert.equal(env.FEEDBACK.seen.length, 0);
});

test('directory: admins, ad library and marketing request people, subscribers; only name/email/role/last seen', async () => {
  env.ADS_DB.sqlite.exec(`CREATE TABLE users (email TEXT PRIMARY KEY, role TEXT, added_by TEXT, first_seen_at TEXT, last_seen_at TEXT, created_at TEXT, updated_at TEXT, tour_role TEXT);
    INSERT INTO users VALUES ('cy.staff@overyondr.com', 'editor', 'x', 'x', '2026-11-20T00:00:00Z', 'x', 'x', NULL);`);
  env.REQUESTS_DB.sqlite.exec(`CREATE TABLE users (email TEXT PRIMARY KEY, name TEXT, title TEXT, department TEXT, manager_email TEXT, role TEXT, is_approver INTEGER, email_updates INTEGER, active INTEGER, added_by TEXT, tour_done_at TEXT, first_seen_at TEXT, last_seen_at TEXT);
    INSERT INTO users VALUES ('ben.admin@overyondr.com', 'Ben Admin', 'Secret title', 'Dept', 'ada.owner@overyondr.com', 'admin', 1, 1, 1, 'x', NULL, 'x', '2026-01-01T00:00:00Z');`);
  const r = await call('/api/directory');
  assert.equal(r.status, 200);
  const ben = r.data.people.find((p) => p.email === ADMIN);
  assert.deepEqual(ben.roles, { feedback: 'admin', requests: 'admin' });
  assert.equal(ben.name, 'Ben Admin');
  assert.ok(!JSON.stringify(r.data).includes('Secret title'), 'nothing beyond name/email/role/last seen');
  const cy = r.data.people.find((p) => p.email === STAFF);
  assert.equal(cy.roles.ads, 'editor');
  // The review list flags people not seen for 90 days.
  const list = reviewList(r.data.people, Date.parse('2026-11-27T00:00:00Z'));
  assert.equal(list.find((p) => p.email === STAFF).stale, false);
  assert.equal(list.find((p) => p.email === OWNER).stale, true);
});

test('status page: any signed-in staff member can read it; everything else stays admins only', async () => {
  await runMonitor(env, { force: true, probeFn: probes({ 'https://v2.overyondrdev.com/': { status: 200 } }) });
  const me = await call('/api/me', { as: STAFF });
  assert.equal(me.data.role, null);
  assert.equal(me.data.staff, true);
  const s = await call('/api/status/public', { as: STAFF });
  assert.equal(s.status, 200);
  const v2 = s.data.sites.find((x) => x.id === 'gate:v2');
  assert.equal(v2.state, 'down');
  assert.equal(v2.uptime_7d, 0);
  assert.equal(s.data.sites.find((x) => x.id === 'gate:v1').uptime_30d, 100);
  assert.match(s.data.incidents[0].text, /Website V2 has a sign-in problem/);
  assert.ok(!JSON.stringify(s.data).includes('detail'), 'no technical detail for staff');
  assert.ok(s.data.updated_at);
  for (const path of ['/api/overview', '/api/status', '/api/issues', '/api/directory', '/api/keys', '/api/deploys']) {
    assert.equal((await call(path, { as: STAFF })).status, 403, path);
  }
  const page = await call('/status', { as: STAFF });
  assert.equal(page.status, 200);
  assert.match(page.text, /app\.js/);
  assert.equal((await call('/status', { as: null })).status, 302);
  assert.equal((await call('/api/status/public', { as: null })).status, 401);
});

test('overview: one call with sites, incidents, issues, auto-fix, backups, setup gaps, feedback numbers, keys', async () => {
  env.FEEDBACK_DB.sqlite.exec(`INSERT INTO feedback (message, created_at, project, priority, status) VALUES
    ('a', '${new Date().toISOString()}', 'v1', 'critical', 'new'), ('b', '${new Date().toISOString()}', 'v2', 'normal', 'new'), ('c', '2020-01-01', 'v1', 'critical', 'done')`);
  const r = await call('/api/overview');
  assert.equal(r.status, 200);
  const d = r.data;
  assert.equal(d.sites.length, 7);
  assert.equal(d.feedback.critical_open, 1);
  assert.equal(d.feedback.new_total, 2);
  assert.ok(d.setup.secrets.find((s) => s.worker === 'yondr-ops').missing.includes('CF_API_TOKEN'));
  assert.equal(d.setup.secrets.find((s) => s.worker === 'yondr-feedback').unknown, true);
  assert.equal(d.keys.total, 10);
  assert.ok(d.access.next_review);
  assert.equal(d.issues.total, 0);
});
