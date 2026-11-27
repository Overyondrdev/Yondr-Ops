// Issues: incident → issue → auto-resolve, automatic issues, manual issues, assignment alerts, filters, feedback items.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { issueForAutofix, validateIssue } from '../src/issues.js';
import { runMonitor } from '../src/monitor.js';
import { applySchema, resetSchemaCache } from '../src/schema.js';
import { ADMIN, callWorker, makeEnv, NEWBIE, OWNER, probes, STAFF, subscribe } from './helpers.js';

let env;
beforeEach(async () => { resetSchemaCache(); env = makeEnv(); await applySchema(env.DB); });
const call = (path, opts) => callWorker(env, worker, path, opts);
const rows = (sql, ...a) => env.DB.sqlite.prepare(sql).all(...a).map((r) => ({ ...r }));
const T0 = Date.parse('2026-11-27T10:00:00Z');

test('incident → issue → auto-resolved when the incident resolves; a reopened check adds to the open issue', async () => {
  const exposed = probes({ 'https://v2.overyondrdev.com/': { status: 200 } });
  await runMonitor(env, { nowMs: T0, force: true, probeFn: exposed });
  let issues = rows('SELECT * FROM issues');
  assert.equal(issues.length, 1);
  const i = issues[0];
  assert.equal(i.source, 'incident');
  assert.equal(i.source_ref, 'check:gate:v2');
  assert.equal(i.priority, 'critical');
  assert.equal(i.status, 'open');
  const inc = rows('SELECT * FROM incidents')[0];
  assert.equal(inc.issue_id, i.id);
  // Owners got the site_exposed alert only (no duplicate issue_critical for an incident issue).
  assert.deepEqual(env.EMAIL.sent.map((m) => m.subject).filter((s) => /Critical issue/.test(s)), []);

  // Fixed → the issue resolves itself with a timeline entry.
  await runMonitor(env, { nowMs: T0 + 5 * 60_000, force: true, probeFn: probes() });
  issues = rows('SELECT * FROM issues');
  assert.equal(issues[0].status, 'resolved');
  assert.ok(issues[0].resolved_at);
  const ev = rows('SELECT kind, message FROM issue_events WHERE issue_id = ? ORDER BY id', i.id);
  assert.match(ev.at(-1).message, /^auto-resolved: incident resolved/);

  // Someone reopens it, the check breaks again: linked to the same open issue, not a new one.
  assert.equal((await call(`/api/issues/${i.id}`, { method: 'PATCH', body: { status: 'in_progress' } })).status, 200);
  await runMonitor(env, { nowMs: T0 + 10 * 60_000, force: true, probeFn: exposed });
  assert.equal(rows('SELECT COUNT(*) AS n FROM issues')[0].n, 1);
  assert.ok(rows('SELECT * FROM issue_events WHERE issue_id = ? AND kind = ?', i.id, 'linked').length);
});

test('an issue nobody closed is auto-resolved, but one people already resolved or closed is left alone', async () => {
  const exposed = probes({ 'https://v2.overyondrdev.com/': { status: 200 } });
  await runMonitor(env, { nowMs: T0, force: true, probeFn: exposed });
  const id = rows('SELECT id FROM issues')[0].id;
  await call(`/api/issues/${id}`, { method: 'PATCH', body: { status: 'wont_fix' } });
  await runMonitor(env, { nowMs: T0 + 5 * 60_000, force: true, probeFn: probes() });
  assert.equal(rows('SELECT status FROM issues WHERE id = ?', id)[0].status, 'wont_fix');
});

test('a failed deploy opens an issue with source "deploy"; failed and reverted auto-fixes open "autofix" issues', async () => {
  const inc = { id: 7, check_id: 'build:yondr-ad-portal', site: 'Deploys of yondr-ad-portal', event: 'deploy_failed', severity: 'high', title: 'Deploy of yondr-ad-portal failed', detail: 'x' };
  env.DB.sqlite.prepare("INSERT INTO incidents (id, check_id, event, severity, title, opened_at) VALUES (7, 'build:yondr-ad-portal', 'deploy_failed', 'high', 't', 'x')").run();
  const { issueForIncident } = await import('../src/issues.js');
  const id = await issueForIncident(env, inc);
  assert.equal(rows('SELECT source, priority FROM issues WHERE id = ?', id)[0].source, 'deploy');
  const entry = { id: 3, title: 'Fix careers link', repo: 'Overyondrdev/overyondr-website-v1', project: 'v1' };
  const a = await issueForAutofix(env, entry, 'autofix_failed', { detail: 'Checks failed.' });
  const b = await issueForAutofix(env, entry, 'autofix_reverted', {});
  assert.equal(a, b, 'one open issue per auto-fix');
  assert.equal(rows('SELECT source, priority FROM issues WHERE id = ?', a)[0].source, 'autofix');
});

test('assignment: issue_assigned goes to the assignee only (always), not to subscribers, not when assigning yourself', async () => {
  subscribe(env, 'ada.owner@overyondr.com', ['issue_assigned']); // a rule for someone else's assignments is ignored
  const r = await call('/api/issues', { method: 'POST', body: { title: 'Update the careers page', priority: 'normal', assignee_email: NEWBIE } });
  assert.equal(r.status, 201);
  assert.deepEqual(env.EMAIL.sent.map((m) => m.to), [NEWBIE]);
  assert.match(env.EMAIL.sent[0].subject, /^Assigned to you: Update the careers page/);
  assert.match(env.EMAIL.sent[0].text, /#issues\/\d+/);
  const id = r.data.issue.id;
  // Reassign to someone else → they are told; assigning yourself → no email.
  await call(`/api/issues/${id}`, { method: 'PATCH', body: { assignee_email: STAFF } });
  assert.equal(env.EMAIL.sent.at(-1).to, STAFF);
  const before = env.EMAIL.sent.length;
  await call(`/api/issues/${id}`, { method: 'PATCH', body: { assignee_email: ADMIN } });
  assert.equal(env.EMAIL.sent.length, before);
  const kinds = rows('SELECT kind FROM issue_events WHERE issue_id = ? ORDER BY id', id).map((e) => e.kind);
  assert.deepEqual(kinds, ['created', 'assigned', 'assigned', 'assigned']);
  // Personal alert types never route by subscription.
  const log = rows("SELECT recipients FROM alerts WHERE event_type = 'issue_assigned'").map((x) => JSON.parse(x.recipients));
  assert.ok(log.every((l) => !l.includes(OWNER)));
});

test('a new critical issue alerts owners (issue_critical); validation, comments, filters', async () => {
  const r = await call('/api/issues', { method: 'POST', body: { title: 'Ads export leaks', priority: 'critical' } });
  assert.equal(r.status, 201);
  assert.ok(env.EMAIL.sent.some((m) => m.to === OWNER && /Critical issue: Ads export leaks/.test(m.subject)));
  assert.equal((await call('/api/issues', { method: 'POST', body: { title: '' } })).status, 422);
  assert.equal((await call('/api/issues', { method: 'POST', body: { title: 'x', assignee_email: 'someone@gmail.com' } })).status, 422);
  assert.equal(validateIssue({ title: 'x', due_at: 'tomorrow' }, env, { creating: true }).error.includes('Due date'), true);
  const id = r.data.issue.id;
  assert.equal((await call(`/api/issues/${id}/comments`, { method: 'POST', body: { body: 'Looking at it' } })).status, 201);
  await call('/api/issues', { method: 'POST', body: { title: 'Low thing', priority: 'low', site: 'Ad library' } });
  const crit = await call('/api/issues?priority=critical');
  assert.deepEqual(crit.data.issues.map((i) => i.title), ['Ads export leaks']);
  assert.equal((await call('/api/issues?site=Ad%20library')).data.issues.length, 1);
  assert.equal((await call('/api/issues?assignee=none&status=active')).data.issues.length, 2);
  const one = await call(`/api/issues/${id}`);
  assert.deepEqual(one.data.issue.events.map((e) => e.kind), ['created', 'comment']);
  // Staff who aren't admins can't see issues.
  assert.equal((await call('/api/issues', { as: STAFF })).status, 403);
});

test('create an issue from a feedback item: title/text only (redacted), linked by id, once', async () => {
  env.FEEDBACK_DB.sqlite.prepare(`INSERT INTO feedback (id, message, title, project, priority, author_email, created_at)
    VALUES (12, 'Form fails. Call me on 07700 900123 or mail dee.new@overyondr.com', 'Contact form broken', 'v1', 'high', 'dee.new@overyondr.com', 'x')`).run();
  const r = await call('/api/issues/from-feedback', { method: 'POST', body: { feedback_id: 12 } });
  assert.equal(r.status, 201);
  const i = r.data.issue;
  assert.equal(i.source, 'feedback');
  assert.equal(i.source_ref, 'feedback:12');
  assert.equal(i.priority, 'high');
  assert.equal(i.site, 'v1');
  assert.doesNotMatch(i.description, /dee\.new|07700/);
  assert.equal((await call('/api/issues/from-feedback', { method: 'POST', body: { feedback_id: 12 } })).status, 409);
  assert.equal((await call('/api/issues/from-feedback', { method: 'POST', body: { feedback_id: 999 } })).status, 404);
});
