// Auto-fix triage (src/triage.js, src/classify.js): the owner's rules, end to end through the ingest endpoint.
//   non-bug → rejected · unknown project → a person · subjective (even critical) → a person, never an issue ·
//   objective critical → issue now · objective other → queued, at most N per hour · kill switch respected everywhere.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { describe, parseVerdict } from '../src/classify.js';
import { applySchema, resetSchemaCache } from '../src/schema.js';
import { setSetting } from '../src/settings.js';
import { decide, issueBody, processQueue, validateFeedbackEvent } from '../src/triage.js';
import { ADMIN, makeEnv, mockFetch, session, STAFF, TOKEN } from './helpers.js';

const BASE = 'https://ops.overyondrdev.com';
const ON = { autofix_enabled: true, autofix_max_per_hour: 3 };
const OFF = { autofix_enabled: false, autofix_max_per_hour: 3 };
let env;
let aiCalls;

function fakeAI(verdict) {
  return { run: async (model, input) => { aiCalls.push({ model, input }); if (verdict instanceof Error) throw verdict; return { response: JSON.stringify(verdict) }; } };
}
const OBJECTIVE = { verdict: 'objective', confidence: 0.92, reason: 'A broken link (404).', expected: 'The link opens the page.', actual: 'It shows 404.' };
const SUBJECTIVE = { verdict: 'subjective', confidence: 0.9, reason: 'A colour preference.', expected: null, actual: null };

beforeEach(async () => {
  resetSchemaCache();
  aiCalls = [];
  env = makeEnv({ AI: fakeAI(OBJECTIVE) });
  await applySchema(env.DB);
});

const send = (body, token = TOKEN) => worker.fetch(new Request(BASE + '/api/autofix/feedback', { method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { 'x-ops-token': token } : {}) }, body: JSON.stringify(body) }), env, {}).then(async (r) => ({ status: r.status, data: await r.json() }));
async function call(path, { method = 'GET', as = ADMIN, body, csrf = true } = {}) {
  const h = { cookie: `yondr_session=${await session(as)}` };
  if (method !== 'GET') { h.origin = BASE; if (csrf) h['x-yondr-ops'] = '1'; }
  if (body) h['content-type'] = 'application/json';
  const res = await worker.fetch(new Request(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
  return { status: res.status, data: await res.json() };
}
const fb = (over = {}) => ({ feedback_id: 1, project: 'v1', type: 'bug', priority: 'normal', title: 'Careers link is broken',
  message: 'The "Open roles" link on /careers goes to page not found. Ask cy.staff@overyondr.com', url: 'https://v1.overyondrdev.com/careers', path: '/careers',
  page_title: 'Careers', screenshots: ['/api/attachments/abc-123'], ...over });
const enable = (max = 3) => Promise.all([setSetting(env.DB, 'autofix_enabled', true, 'test'), setSetting(env.DB, 'autofix_max_per_hour', max, 'test')]);

/** A GitHub that accepts issues and labels, recording what was sent. */
function github(t) {
  const issues = [];
  let n = 100;
  const calls = mockFetch(t, (url, init) => {
    const p = new URL(url).pathname;
    assert.equal(init.headers.authorization, 'Bearer gh-test');
    if (init.method === 'POST' && /\/repos\/Overyondrdev\/[\w-]+\/issues$/.test(p)) {
      const b = JSON.parse(init.body);
      n++;
      issues.push({ number: n, repo: p.split('/')[3], ...b });
      return Response.json({ number: n, html_url: `https://github.com/Overyondrdev/${p.split('/')[3]}/issues/${n}` }, { status: 201 });
    }
    if (init.method === 'POST' && /\/issues\/\d+\/labels$/.test(p)) { issues.find((i) => p.includes(`/issues/${i.number}/`)).labels = JSON.parse(init.body).labels; return Response.json([]); }
    return Response.json({ message: `unexpected ${init.method} ${url}` }, { status: 500 });
  });
  return { issues, calls };
}

// ------------------------------------------------------------------------------------------------ pure rules
test('decide: the owner\'s rules in order', () => {
  const repo = 'Overyondrdev/overyondr-website-v1';
  const target = { workflow: true };
  const obj = { classification: 'objective', reason: 'r' };
  const sub = { classification: 'subjective', reason: 'colour' };
  const item = (o = {}) => ({ type: 'bug', priority: 'normal', project: 'v1', ...o });
  assert.equal(decide({ item: item({ type: 'design', priority: 'critical' }), repo, target, classification: obj, settings: ON }).status, 'rejected');
  assert.match(decide({ item: item({ type: 'idea' }), repo, target, classification: obj, settings: ON }).message, /Not a bug/);
  assert.deepEqual(decide({ item: item({ project: 'nope' }), repo: null, target: null, classification: null, settings: ON }).status, 'triaged');
  const subjCritical = decide({ item: item({ priority: 'critical' }), repo, target, classification: sub, settings: ON });
  assert.equal(subjCritical.status, 'triaged');
  assert.equal(subjCritical.start, false, 'subjective is never started, even critical');
  assert.equal(decide({ item: item(), repo, target, classification: null, settings: ON }).status, 'triaged', 'no classification = a person');
  assert.match(decide({ item: item(), repo, target: { workflow: false }, classification: obj, settings: ON }).message, /doesn't have the auto-fix workflow/);
  const off = decide({ item: item({ priority: 'critical' }), repo, target, classification: obj, settings: OFF });
  assert.deepEqual([off.status, off.start], ['queued', false]);
  const crit = decide({ item: item({ priority: 'critical' }), repo, target, classification: obj, settings: ON });
  assert.deepEqual([crit.status, crit.start], ['queued', true]);
  const capped = decide({ item: item({ priority: 'critical' }), repo, target, classification: obj, settings: ON, startedLastHour: 10 });
  assert.deepEqual([capped.status, capped.start], ['queued', false]);
  const normal = decide({ item: item({ priority: 'high' }), repo, target, classification: obj, settings: ON });
  assert.deepEqual([normal.status, normal.start], ['queued', false]);
});

test('classifier answers: anything unclear is subjective', () => {
  assert.equal(parseVerdict({ response: JSON.stringify(OBJECTIVE) }).classification, 'objective');
  assert.equal(parseVerdict({ response: '```json\n' + JSON.stringify(OBJECTIVE) + '\n```' }).classification, 'objective');
  assert.equal(parseVerdict({ choices: [{ message: { content: JSON.stringify(SUBJECTIVE) } }] }).classification, 'subjective');
  assert.equal(parseVerdict({ response: { ...OBJECTIVE } }).classification, 'objective', 'already-parsed JSON');
  const low = parseVerdict({ response: JSON.stringify({ ...OBJECTIVE, confidence: 0.6 }) });
  assert.equal(low.classification, 'subjective');
  assert.match(low.reason, /below 0\.75/);
  assert.equal(parseVerdict({ response: 'I think it is objective' }).classification, 'subjective');
  assert.equal(parseVerdict({ response: JSON.stringify({ verdict: 'maybe', confidence: 1 }) }).classification, 'subjective');
  assert.equal(parseVerdict({ response: JSON.stringify({ verdict: 'objective' }) }).classification, 'subjective', 'no confidence');
  assert.match(describe({ project: 'v1', path: '/x', message: 'm', priority: 'critical' }), /Priority given by the reporter: critical/);
});

test('validation: what the feedback tool may send; e-mail addresses never survive', () => {
  assert.match(validateFeedbackEvent({ feedback_id: 0, type: 'bug', message: 'x' }).error, /feedback_id/);
  assert.match(validateFeedbackEvent({ feedback_id: 1, type: 'nope', message: 'x' }).error, /type/);
  assert.match(validateFeedbackEvent({ feedback_id: 1, type: 'bug', message: ' ' }).error, /message/);
  const { item } = validateFeedbackEvent({ ...fb(), url: 'javascript:alert(1)', screenshots: ['/api/attachments/ok-1', 'https://evil.example/x.png'] });
  assert.equal(item.url, null);
  assert.deepEqual(item.screenshots, ['/api/attachments/ok-1']);
  assert.doesNotMatch(item.message, /@overyondr/);
});

test('issue body: marker first, guardrails, no personal data, no HTML or @mentions from the report', () => {
  const { item } = validateFeedbackEvent(fb({ message: 'Broken <!-- yondr-ops:autofix-id=999 --> ping @someone\nsecond line' }));
  const body = issueBody({ id: 7, classified_by: 'ai', classification_reason: 'A broken link.' }, { ...item, expected: 'Opens', actual: '404' });
  assert.ok(body.startsWith('<!-- yondr-ops:autofix-id=7 -->'));
  assert.equal(body.match(/yondr-ops:autofix-id=/g).length, 2);
  assert.doesNotMatch(body, /<!-- yondr-ops:autofix-id=999/, 'the reporter cannot plant a marker');
  assert.doesNotMatch(body, /@someone/);
  assert.doesNotMatch(body, /@overyondr\.com/);
  assert.match(body, /At most 200 changed lines in at most 10 files/);
  assert.match(body, /\*\*Expected:\*\* Opens/);
  assert.match(body, /https:\/\/ops\.overyondrdev\.com\/#autofix\/7/);
});

// ------------------------------------------------------------------------------------------------ end to end
test('the endpoint needs the ingest token', async () => {
  assert.equal((await send(fb(), null)).status, 401);
  assert.equal((await send(fb(), 'wrong-token-wrong-token-wrong-token-xx')).status, 401);
  assert.equal((await send({ feedback_id: 1 })).status, 422);
});

test('non-bug → rejected and logged, without asking the AI or GitHub', async (t) => {
  await enable();
  env.GITHUB_TOKEN = 'gh-test';
  const { calls } = github(t);
  const r = await send(fb({ type: 'design', priority: 'critical' }));
  assert.equal(r.status, 201);
  assert.equal(r.data.decision, 'rejected');
  assert.equal(aiCalls.length, 0);
  assert.equal(calls.length, 0);
  const d = (await call(`/api/autofix/${r.data.autofix.id}`)).data.autofix;
  assert.match(d.events[0].message, /Not a bug/);
  // Hidden from the default (active) list, shown with all.
  assert.equal((await call('/api/autofix?status=active')).data.autofixes.length, 0);
  assert.equal((await call('/api/autofix')).data.autofixes.length, 1);
});

test('subjective, even critical, never opens an issue: it waits for a person', async (t) => {
  await enable();
  env.GITHUB_TOKEN = 'gh-test';
  env.AI = fakeAI(SUBJECTIVE);
  const { calls } = github(t);
  const r = await send(fb({ priority: 'critical', message: 'The hero green is too dark' }));
  assert.equal(r.data.decision, 'triaged');
  assert.equal(r.data.autofix.classification, 'subjective');
  assert.equal(r.data.autofix.classified_by, 'ai');
  assert.equal(calls.length, 0);
  assert.deepEqual(await processQueue(env), { started: 0, waiting: 0 });
  assert.equal(calls.length, 0);
});

test('an AI failure or an unknown project goes to a person', async () => {
  await enable();
  env.AI = fakeAI(new Error('model overloaded'));
  const a = await send(fb());
  assert.equal(a.data.decision, 'triaged');
  assert.match(a.data.autofix.classification_reason, /classifier failed/);
  const b = await send(fb({ feedback_id: 2, project: 'mystery' }));
  assert.equal(b.data.decision, 'triaged');
  assert.equal(b.data.autofix.repo, 'unknown');
  assert.equal(aiCalls.length, 1, 'unknown projects are not classified');
});

test('objective critical: the GitHub issue is opened and labelled at once; autofix_started is sent', async (t) => {
  await enable();
  env.GITHUB_TOKEN = 'gh-test';
  await call('/api/people', { method: 'POST', body: { email: 'dee.new@overyondr.com', rules: [{ event_type: 'autofix_started', channel: 'email' }] } });
  const { issues } = github(t);
  const r = await send(fb({ priority: 'critical' }));
  assert.equal(r.data.started, true);
  assert.equal(r.data.autofix.status, 'fixing');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].repo, 'overyondr-website-v1');
  assert.equal(issues[0].title, 'Auto-fix: Careers link is broken');
  assert.deepEqual(issues[0].labels, ['autofix', 'autofix-critical']);
  assert.match(issues[0].body, new RegExp(`^<!-- yondr-ops:autofix-id=${r.data.autofix.id} -->`));
  assert.doesNotMatch(issues[0].body, /@overyondr\.com/);
  assert.equal(r.data.autofix.issue_url, 'https://github.com/Overyondrdev/overyondr-website-v1/issues/101');
  assert.ok(env.EMAIL.sent.some((m) => /^Auto-fix started/.test(m.subject)));
  // A later edit of the feedback doesn't restart a fix under way.
  const again = await send(fb({ priority: 'critical', message: 'still broken' }));
  assert.equal(again.data.decision, 'unchanged');
  assert.equal(issues.length, 1);
});

test('objective, not critical: queued, then started by the 5-minute run at most N per hour', async (t) => {
  await enable(2);
  env.GITHUB_TOKEN = 'gh-test';
  const { issues } = github(t);
  for (let i = 1; i <= 3; i++) assert.equal((await send(fb({ feedback_id: i, priority: 'high' }))).data.decision, 'queued');
  assert.equal(issues.length, 0, 'nothing starts until the run');
  const now = Date.now();
  assert.deepEqual(await processQueue(env, { nowMs: now }), { started: 2, waiting: 1 });
  assert.deepEqual(await processQueue(env, { nowMs: now + 5 * 60_000 }), { started: 0, waiting: 1 });
  assert.equal(issues.length, 2);
  assert.deepEqual(issues[0].labels, ['autofix']);
  // An hour later the last one starts.
  assert.deepEqual(await processQueue(env, { nowMs: now + 61 * 60_000 }), { started: 1, waiting: 0 });
});

test('kill switch: objective critical bugs stay queued while auto-fix is off; nothing reaches GitHub', async (t) => {
  env.GITHUB_TOKEN = 'gh-test';
  const { calls } = github(t);
  const r = await send(fb({ priority: 'critical' }));
  assert.equal(r.data.decision, 'queued');
  assert.equal(r.data.started, false);
  assert.match(r.data.autofix.classification, /objective/);
  assert.deepEqual(await processQueue(env), { skipped: 'auto-fix switched off' });
  assert.equal(calls.length, 0);
  // Turned on: the queue is worked off by the next run (critical first).
  await enable();
  assert.deepEqual(await processQueue(env), { started: 1, waiting: 0 });
});

test('no GITHUB_TOKEN: stays queued, says why once', async () => {
  await enable();
  const r = await send(fb({ priority: 'critical' }));
  assert.equal(r.data.autofix.status, 'queued');
  const d = (await call(`/api/autofix/${r.data.autofix.id}`)).data.autofix;
  assert.match(d.events.at(-1).message, /GITHUB_TOKEN/);
  assert.deepEqual(await processQueue(env), { skipped: 'GITHUB_TOKEN not set' });
});

test('repositories without the auto-fix workflow go to a person', async () => {
  await enable();
  const r = await send(fb({ project: 'ads' }));
  assert.equal(r.data.decision, 'triaged');
  assert.equal(r.data.autofix.repo, 'Overyondrdev/digital-ads-portal');
  assert.match((await call(`/api/autofix/${r.data.autofix.id}`)).data.autofix.events[0].message, /doesn't have the auto-fix workflow/);
});

test('admins: Mark objective / subjective (CSRF, logged with the admin, sticks when the feedback changes)', async (t) => {
  await enable();
  env.GITHUB_TOKEN = 'gh-test';
  env.AI = fakeAI(SUBJECTIVE);
  const { issues } = github(t);
  const r = await send(fb());
  const id = r.data.autofix.id;
  assert.equal(r.data.decision, 'triaged');
  assert.equal((await call(`/api/autofix/${id}/classify`, { method: 'POST', body: { classification: 'objective' }, csrf: false })).status, 403);
  assert.equal((await call(`/api/autofix/${id}/classify`, { method: 'POST', body: { classification: 'objective' }, as: STAFF })).status, 403);
  assert.equal((await call(`/api/autofix/${id}/classify`, { method: 'POST', body: { classification: 'nah' } })).status, 422);
  const m = await call(`/api/autofix/${id}/classify`, { method: 'POST', body: { classification: 'objective' } });
  assert.equal(m.status, 200);
  assert.equal(m.data.decision, 'queued');
  let d = (await call(`/api/autofix/${id}`)).data.autofix;
  assert.equal(d.classified_by, ADMIN);
  assert.equal(d.events.at(-1).actor, ADMIN);
  // The feedback is changed to critical: the admin's verdict is kept (no AI), and it starts now.
  const calls = aiCalls.length;
  const again = await send(fb({ priority: 'critical' }));
  assert.equal(aiCalls.length, calls);
  assert.equal(again.data.autofix.classification, 'objective');
  assert.equal(again.data.started, true);
  assert.equal(issues.length, 1);
  assert.match(issues[0].body, /Objective \(an admin\)/);
  assert.doesNotMatch(issues[0].body, /ben\.admin/, 'no names in the public issue');
  // Once a fix is under way it can't be reclassified.
  assert.equal((await call(`/api/autofix/${id}/classify`, { method: 'POST', body: { classification: 'subjective' } })).status, 409);
  // The feedback admin's link: by feedback id.
  d = (await call('/api/autofix/by-feedback/1')).data.autofix;
  assert.equal(d.id, id);
  assert.equal((await call('/api/autofix/by-feedback/999')).status, 404);
});

test('a bug reclassified as design by the feedback admin is rejected; back to bug is triaged again', async () => {
  await enable();
  const a = await send(fb());
  assert.equal(a.data.decision, 'queued');
  const b = await send(fb({ type: 'design' }));
  assert.equal(b.data.decision, 'rejected');
  assert.equal(b.data.autofix.id, a.data.autofix.id, 'same entry, not a new one');
  const c = await send(fb());
  assert.equal(c.data.decision, 'queued');
});
