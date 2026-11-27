// After the merge (src/verify.js): pull-request backstop, engine timeout, deploy + site verification, automatic revert.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { evaluateCommitBuild } from '../src/cloudflare.js';
import { applySchema, resetSchemaCache } from '../src/schema.js';
import { verdict, watchFixes } from '../src/verify.js';
import { makeEnv, mockFetch } from './helpers.js';

const SHA = 'a'.repeat(40);
const V1 = 'Overyondrdev/overyondr-website-v1';
const T0 = Date.parse('2026-11-27T10:00:00Z');
const MIN = 60_000;
let env;

beforeEach(async () => {
  resetSchemaCache();
  env = makeEnv();
  await applySchema(env.DB);
  // Someone who hears about every auto-fix outcome.
  const s = env.DB.sqlite.prepare("INSERT INTO subscribers (email, created_by, created_at, updated_at) VALUES ('dee.new@overyondr.com', 'x', 'x', 'x') RETURNING id").get();
  for (const e of ['autofix_merged', 'autofix_failed', 'autofix_reverted']) env.DB.sqlite.prepare("INSERT INTO subscriptions (subscriber_id, event_type, channel, created_at) VALUES (?, ?, 'email', 'x')").run(s.id, e);
});

function fix(over = {}) {
  const f = { repo: V1, title: 'Fix careers link', status: 'merged', merge_sha: SHA, merged_at: new Date(T0).toISOString(),
    pr_url: 'https://github.com/Overyondrdev/overyondr-website-v1/pull/9', feedback_id: 1, project: 'v1', created_at: 'x', updated_at: 'x', ...over };
  const keys = Object.keys(f);
  return env.DB.sqlite.prepare(`INSERT INTO autofixes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING id`).get(...keys.map((k) => f[k])).id;
}
const get = (id) => env.DB.sqlite.prepare('SELECT * FROM autofixes WHERE id = ?').get(id);
const events = (id) => env.DB.sqlite.prepare('SELECT * FROM autofix_events WHERE autofix_id = ? ORDER BY id').all(id);
const subjects = () => env.EMAIL.sent.map((m) => m.subject);
const built = (outcome) => async () => ({ checked: true, build: outcome ? { outcome } : null });
const notWatched = async () => ({ checked: false, reason: 'CF_API_TOKEN is not set, so the deploy could not be watched.' });

test('evaluateCommitBuild finds the production build of one commit', () => {
  const b = (sha, branch, outcome, at) => ({ build_trigger_metadata: { branch, commit_hash: sha }, build_outcome: outcome, created_on: at });
  const list = [b(SHA, 'feature', 'fail', '3'), b('b'.repeat(40), 'main', 'success', '2'), b(SHA, 'main', 'success', '1')];
  assert.equal(evaluateCommitBuild(list, SHA).outcome, 'success');
  assert.equal(evaluateCommitBuild([b(SHA, 'main', 'fail', '1')], SHA).outcome, 'failed');
  assert.equal(evaluateCommitBuild([b(SHA, 'main', null, '1')], SHA).outcome, 'running');
  assert.equal(evaluateCommitBuild([], SHA), null);
});

test('verdict: revert on a failing site or build; deployed; wait; verified with what was checked', () => {
  const e = { repo: V1, merge_sha: SHA, merged_at: new Date(T0).toISOString(), deployed_at: null };
  const ok = { checked: true, build: { outcome: 'success' } };
  assert.equal(verdict(e, ok, [{ id: 'gate:v1', site: 'Website V1' }], { nowMs: T0 + MIN }).action, 'revert');
  assert.match(verdict(e, { checked: true, build: { outcome: 'failed' } }, [], { nowMs: T0 + MIN }).reason, /build of the fix/);
  assert.equal(verdict(e, ok, [], { nowMs: T0 + MIN }).action, 'deployed');
  assert.equal(verdict(e, { checked: true, build: null }, [], { nowMs: T0 + 10 * MIN }).action, 'wait');
  const live = { ...e, deployed_at: new Date(T0 + 5 * MIN).toISOString() };
  assert.equal(verdict(live, ok, [], { nowMs: T0 + 15 * MIN }).action, 'wait', '15 minutes from the deploy, not the merge');
  const v = verdict(live, ok, [], { nowMs: T0 + 21 * MIN });
  assert.equal(v.action, 'verified');
  assert.match(v.detail, /production build of aaaaaaa succeeded; site checks stayed fine .*Website V1/);
  // Deploy can't be watched: site checks only, from the merge.
  const nw = verdict(e, { checked: false, reason: 'no token' }, [], { nowMs: T0 + 16 * MIN });
  assert.equal(nw.action, 'verified');
  assert.match(nw.detail, /deploy not watched \(no token\)/);
  // No build seen in 45 minutes: verified on site checks, saying the deploy wasn't confirmed.
  assert.match(verdict(e, { checked: true, build: null }, [], { nowMs: T0 + 46 * MIN }).detail, /deploy not confirmed/);
  assert.match(verdict(e, ok, [], { nowMs: T0, monitoring: false }).action, /deployed/);
  assert.match(verdict({ ...live }, ok, [], { nowMs: T0 + 30 * MIN, monitoring: false }).detail, /NOT run/);
});

test('merged → deployed → verified, and only then autofix_merged', async () => {
  const id = fix();
  await watchFixes(env, { nowMs: T0 + 3 * MIN, buildFn: built(null) });
  assert.equal(get(id).status, 'merged');
  await watchFixes(env, { nowMs: T0 + 6 * MIN, buildFn: built('success') });
  assert.equal(get(id).status, 'deployed');
  assert.deepEqual(subjects(), []);
  await watchFixes(env, { nowMs: T0 + 6 * MIN + 16 * MIN, buildFn: built('success') });
  const e = get(id);
  assert.equal(e.status, 'verified');
  assert.match(e.verify_detail, /site checks stayed fine/);
  assert.equal(subjects().length, 1);
  assert.match(subjects()[0], /^Auto-fix live and verified: Fix careers link/);
  assert.match(env.EMAIL.sent[0].text || env.EMAIL.sent[0].html || '', /site checks stayed fine|Checked/);
});

test('a site check failing after the merge → automatic revert (actor auto-revert) and autofix_reverted', async (t) => {
  const id = fix({ status: 'deployed', deployed_at: new Date(T0 + 2 * MIN).toISOString() });
  // A check that was already failing before the merge is not blamed on the fix…
  env.DB.sqlite.prepare("INSERT INTO check_state (check_id, site, status, since, last_run) VALUES ('gate:ads', 'Ad library', 'fail', ?, 'x')").run(new Date(T0 + 4 * MIN).toISOString());
  env.DB.sqlite.prepare("INSERT INTO check_state (check_id, site, status, since, last_run) VALUES ('gate:www', 'Portal (www)', 'fail', ?, 'x')").run(new Date(T0 - 60 * MIN).toISOString());
  await watchFixes(env, { nowMs: T0 + 5 * MIN, buildFn: built('success') });
  assert.equal(get(id).status, 'deployed', 'other sites and older failures are not the fix\'s fault');
  // …but the fix's own site starting to fail after the merge is.
  env.DB.sqlite.prepare("INSERT INTO check_state (check_id, site, status, since, last_run) VALUES ('gate:v1', 'Website V1', 'fail', ?, 'x')").run(new Date(T0 + 7 * MIN).toISOString());
  env.GITHUB_TOKEN = 'gh-test';
  mockFetch(t, (url, init) => {
    const m = init.method || 'GET';
    const p = new URL(url).pathname;
    if (p.endsWith(`/commits/${SHA}`)) return Response.json({ sha: SHA, parents: [{ sha: 'c'.repeat(40) }], files: [{ filename: 'public/js/site.js', status: 'modified' }] });
    if (m === 'GET' && p.endsWith('/commits')) return Response.json([{ sha: SHA }]);
    if (p.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'd'.repeat(40) } });
    if (m === 'GET' && p.includes('/git/commits/')) return Response.json({ tree: { sha: 'e'.repeat(40) } });
    if (m === 'GET' && p.includes('/git/trees/')) return Response.json({ truncated: false, tree: [{ path: 'public/js/site.js', mode: '100644', type: 'blob', sha: '1'.repeat(40) }] });
    if (m === 'POST' && p.endsWith('/pulls')) return Response.json({ number: 10, html_url: 'https://github.com/Overyondrdev/overyondr-website-v1/pull/10', node_id: 'N' });
    if (m === 'POST') return Response.json({ sha: '9'.repeat(40), data: {} });
    return Response.json({}, { status: 500 });
  });
  const r = await watchFixes(env, { nowMs: T0 + 8 * MIN, buildFn: built('success') });
  assert.equal(r.reverted, 1);
  const e = get(id);
  assert.equal(e.status, 'reverted');
  assert.equal(e.reverted_by, 'auto-revert');
  assert.equal(e.revert_pr_url, 'https://github.com/Overyondrdev/overyondr-website-v1/pull/10');
  assert.ok(events(id).some((ev) => ev.actor === 'auto-revert' && /Website V1 started failing/.test(ev.message)));
  assert.ok(subjects().some((s) => /^Auto-fix revert requested/.test(s)));
});

test('a failed production build of the fix → revert; if the revert is refused, a person is told (critical)', async () => {
  const id = fix();
  await watchFixes(env, { nowMs: T0 + 6 * MIN, buildFn: built('failed') }); // no GITHUB_TOKEN → the revert is refused
  const e = get(id);
  assert.equal(e.status, 'failed');
  assert.match(e.verify_detail, /Automatic revert failed: .*GITHUB_TOKEN/);
  assert.ok(events(id).some((ev) => /Reverting automatically: The production build of the fix/.test(ev.message)));
  assert.ok(subjects().some((s) => /^Auto-fix failed/.test(s) && /Critical/.test(s)));
  // Not retried every 5 minutes.
  const n = events(id).length;
  await watchFixes(env, { nowMs: T0 + 11 * MIN, buildFn: built('failed') });
  assert.equal(events(id).length, n);
});

test('deploy not watchable: verified on the site checks alone, 15 minutes after the merge', async () => {
  const id = fix();
  await watchFixes(env, { nowMs: T0 + 10 * MIN, buildFn: notWatched });
  assert.equal(get(id).status, 'merged');
  await watchFixes(env, { nowMs: T0 + 16 * MIN, buildFn: notWatched });
  assert.equal(get(id).status, 'verified');
  assert.match(get(id).verify_detail, /deploy not watched/);
});

test('backstop: open pull requests are checked on GitHub (merged / closed); silent engines time out', async (t) => {
  env.GITHUB_TOKEN = 'gh-test';
  const merged = fix({ status: 'pr_open', merge_sha: null, merged_at: null });
  const closed = fix({ status: 'pr_open', merge_sha: null, merged_at: null, pr_url: 'https://github.com/Overyondrdev/overyondr-website-v1/pull/11' });
  const silent = fix({ status: 'fixing', merge_sha: null, merged_at: null, pr_url: null, started_at: new Date(T0 - 181 * MIN).toISOString() });
  const busy = fix({ status: 'fixing', merge_sha: null, merged_at: null, pr_url: null, started_at: new Date(T0 - 30 * MIN).toISOString() });
  mockFetch(t, (url) => {
    if (url.endsWith('/pulls/9')) return Response.json({ merged: true, state: 'closed', merge_commit_sha: 'B'.repeat(40), merged_at: new Date(T0).toISOString() });
    if (url.endsWith('/pulls/11')) return Response.json({ merged: false, state: 'closed' });
    return Response.json({}, { status: 500 });
  });
  const r = await watchFixes(env, { nowMs: T0, buildFn: built(null) });
  assert.deepEqual([r.merged, r.closed, r.timed_out], [1, 1, 1]);
  assert.equal(get(merged).status, 'merged');
  assert.equal(get(merged).merge_sha, 'b'.repeat(40));
  assert.equal(get(closed).status, 'failed');
  assert.equal(get(silent).status, 'failed');
  assert.equal(get(busy).status, 'fixing');
});

test('the auto-fix cron runs the queue and the watch in their own invocation', async () => {
  const pending = [];
  const id = fix();
  await worker.scheduled({ cron: '2-59/5 * * * *', scheduledTime: T0 + 16 * MIN }, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.equal(get(id).status, 'verified', 'no CF token in tests: verified on site checks after 15 minutes');
});
