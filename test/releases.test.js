// Error tracking (server + browser), deploy watch and rollback.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { deployVerdict, normaliseDeployments, previousVersion, watchDeploys } from '../src/deploys.js';
import { errorChecks, evaluateErrors, validateClientErrors } from '../src/errors.js';
import { applySchema, resetSchemaCache } from '../src/schema.js';
import { ADMIN, callWorker, makeEnv, mockFetch, OWNER, subscribe, TOKEN } from './helpers.js';

let env;
beforeEach(async () => { resetSchemaCache(); env = makeEnv(); await applySchema(env.DB); });
const call = (path, opts) => callWorker(env, worker, path, opts);
const rows = (sql, ...a) => env.DB.sqlite.prepare(sql).all(...a).map((r) => ({ ...r }));
const MIN = 60_000;
const T0 = Date.parse('2026-11-27T10:00:00Z');

test('server errors: thresholds (≥ 20 requests; > 2 % warning, > 10 % high)', () => {
  assert.equal(evaluateErrors('w', 19, 19).ok, true, 'too few requests to judge');
  assert.equal(evaluateErrors('w', 100, 2).ok, true, 'exactly 2 % is fine');
  const warn = evaluateErrors('w', 100, 3);
  assert.equal(warn.ok, false);
  assert.equal(warn.severity, 'warning');
  assert.equal(warn.event, 'error_rate');
  assert.equal(warn.id, 'errors:w');
  assert.equal(evaluateErrors('w', 100, 10).severity, 'warning');
  assert.equal(evaluateErrors('w', 100, 11).severity, 'high');
  assert.equal(evaluateErrors('w', 20, 3).severity, 'high');
});

test('server errors: one GraphQL read per run, stored per 5 minutes, one check per Worker; no token = not checked', async (t) => {
  const none = await errorChecks(env, T0);
  assert.ok(none.every((r) => r.ok === null));
  env.CF_API_TOKEN = 'x';
  const buckets = [
    { worker: 'yondr-ad-portal', bucket: new Date(T0 - 10 * MIN).toISOString(), requests: 100, errors: 20 },
    { worker: 'yondr-ad-portal', bucket: new Date(T0 - 40 * MIN).toISOString(), requests: 100, errors: 90 }, // outside the 15 minutes
    { worker: 'yondr-feedback', bucket: new Date(T0 - 5 * MIN).toISOString(), requests: 500, errors: 1 },
  ];
  const r = await errorChecks(env, T0, { fetchFn: async () => buckets });
  assert.equal(r.find((x) => x.id === 'errors:yondr-ad-portal').severity, 'high');
  assert.equal(r.find((x) => x.id === 'errors:yondr-feedback').ok, true);
  assert.equal(rows('SELECT COUNT(*) AS n FROM worker_error_stats')[0].n, 3);
  // The real query: dataset and fields as documented.
  const calls = mockFetch(t, async () => Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
    { sum: { requests: 40, errors: 4 }, dimensions: { scriptName: 'yondr-auth', datetimeFiveMinutes: new Date(T0 - 5 * MIN).toISOString() } }] }] } } }));
  const live = await errorChecks(env, T0);
  assert.match(calls[0].init.body, /workersInvocationsAdaptive/);
  assert.equal(live.find((x) => x.id === 'errors:yondr-auth').severity, 'warning');
});

test('browser errors: validated and redacted; a spike over the threshold in 15 minutes alerts once an hour', async () => {
  assert.ok(validateClientErrors({ project: 'v1', count: -1 }).error);
  assert.ok(validateClientErrors({ count: 1 }).error);
  const v = validateClientErrors({ project: 'V1', count: 3, window_minutes: 5, sample: [{ message: 'x is undefined for dee.new@overyondr.com', source: 'app.js:12', page_path: '/careers?token=abc' }] });
  assert.equal(v.report.project, 'v1');
  assert.doesNotMatch(v.report.sample[0].message, /dee\.new/);
  assert.equal(v.report.sample[0].page_path, '/careers');
  subscribe(env, 'dee.new@overyondr.com', ['client_errors_spike']);
  const send = (body) => worker.fetch(new Request('https://ops.overyondrdev.com/api/events', { method: 'POST', headers: { 'x-ops-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client_errors', ...body }) }), env, {}).then(async (r) => ({ status: r.status, data: await r.json() }));
  const sample = [{ message: 'TypeError: a is null', source: 'site.js:40', page_path: '/' }];
  let r = await send({ project: 'v1', count: 15, sample, window_minutes: 5 });
  assert.equal(r.status, 201);
  assert.equal(r.data.alerted, false);
  r = await send({ project: 'v1', count: 10, sample, window_minutes: 5 });
  assert.equal(r.data.total_in_window, 25);
  assert.equal(r.data.alerted, true);
  assert.match(env.EMAIL.sent.at(-1).subject, /25 browser errors on v1/);
  r = await send({ project: 'v1', count: 30, sample, window_minutes: 5 });
  assert.equal(r.data.alerted, false, 'at most once an hour per project');
  assert.equal((await send({ project: 'v2', count: 5 })).data.alerted, false);
  // Without the token it is refused; the Errors page shows it to admins.
  const bad = await worker.fetch(new Request('https://ops.overyondrdev.com/api/events', { method: 'POST', body: JSON.stringify({ type: 'client_errors', project: 'v1', count: 1 }) }), env, {});
  assert.equal(bad.status, 401);
  const page = await call('/api/errors');
  assert.equal(page.data.client.find((c) => c.project === 'v1').count_24h, 55);
});

test('deploy verdict: new failing site checks or a clearly worse error rate', () => {
  assert.equal(deployVerdict({ requests: 100, errors: 1, failing: [] }, { requests: 100, errors: 1, failing: [] }).regression, false);
  assert.equal(deployVerdict({ requests: 100, errors: 0, failing: [] }, { requests: 100, errors: 2, failing: [] }).regression, false, '2 % is within the floor');
  assert.equal(deployVerdict({ requests: 100, errors: 0, failing: [] }, { requests: 100, errors: 5, failing: [] }).regression, true);
  assert.equal(deployVerdict({ requests: 100, errors: 10, failing: [] }, { requests: 100, errors: 15, failing: [] }).regression, false, 'not worse than 2× + 1 point');
  assert.equal(deployVerdict({ requests: 0, errors: 0, failing: [] }, { requests: 10, errors: 10, failing: [] }).regression, false, 'too few requests');
  const v = deployVerdict({ requests: 0, errors: 0, failing: ['gate:ads'] }, { requests: 0, errors: 0, failing: ['gate:ads', 'gate:v1'] });
  assert.deepEqual(v.new_failing, ['gate:v1']);
});

test('deploy watch: a new deployment is watched for 15 minutes; a regression alerts with a link and opens an issue', async () => {
  subscribe(env, 'dee.new@overyondr.com', ['deploy_regression']);
  const dep = (id, at, version) => ({ id, created_on: new Date(at).toISOString(), source: 'wrangler', author: 'ci', versions: [{ version_id: version, percentage: 100 }] });
  let deployments = { 'yondr-ad-portal': [dep('d1', T0 - 3 * 3_600_000, 'v1')] };
  const listFn = async (_e, w) => deployments[w] || [];
  // First sight of a Worker: recorded as the baseline, not watched.
  await watchDeploys(env, { nowMs: T0, listFn });
  assert.equal(rows('SELECT status FROM deploy_watch')[0].status, 'baseline');
  // Before the deploy: a clean hour.
  env.DB.sqlite.prepare('INSERT INTO worker_error_stats VALUES (?, ?, 200, 0)').run('yondr-ad-portal', new Date(T0 - 30 * MIN).toISOString());
  deployments['yondr-ad-portal'] = [dep('d2', T0, 'v2'), ...deployments['yondr-ad-portal']];
  let out = await watchDeploys(env, { nowMs: T0 + 2 * MIN, listFn });
  assert.equal(out.new, 1);
  assert.equal(rows("SELECT status FROM deploy_watch WHERE deployment_id = 'd2'")[0].status, 'watching');
  // After: errors jump.
  env.DB.sqlite.prepare('INSERT INTO worker_error_stats VALUES (?, ?, 100, 30)').run('yondr-ad-portal', new Date(T0 + 5 * MIN).toISOString());
  out = await watchDeploys(env, { nowMs: T0 + 10 * MIN, listFn });
  assert.equal(out.watching, 1, 'still inside the 15 minutes');
  out = await watchDeploys(env, { nowMs: T0 + 16 * MIN, listFn });
  assert.equal(out.regression, 1);
  const w = rows("SELECT * FROM deploy_watch WHERE deployment_id = 'd2'")[0];
  assert.equal(w.status, 'regression');
  assert.match(w.detail, /error rate went from 0 % to 30 %/);
  const mail = env.EMAIL.sent.find((m) => /made things worse/.test(m.subject));
  assert.ok(mail);
  assert.match(mail.text, /#deploys\/yondr-ad-portal/);
  assert.equal(rows("SELECT source FROM issues WHERE source = 'deploy'").length, 1);
  // A clean deploy finishes "ok".
  deployments['yondr-ad-portal'] = [dep('d3', T0 + 20 * MIN, 'v3'), ...deployments['yondr-ad-portal']];
  await watchDeploys(env, { nowMs: T0 + 21 * MIN, listFn });
  env.DB.sqlite.exec('DELETE FROM worker_error_stats');
  await watchDeploys(env, { nowMs: T0 + 40 * MIN, listFn });
  assert.equal(rows("SELECT status FROM deploy_watch WHERE deployment_id = 'd3'")[0].status, 'ok');
});

test('previous version: the newest deployment whose main version differs from the current one', () => {
  const d = normaliseDeployments([
    { id: 'a', created_on: '2026-11-27T10:00:00Z', versions: [{ version_id: 'v3', percentage: 100 }] },
    { id: 'b', created_on: '2026-11-26T10:00:00Z', versions: [{ version_id: 'v3', percentage: 100 }] },
    { id: 'c', created_on: '2026-11-25T10:00:00Z', versions: [{ version_id: 'v2', percentage: 90 }, { version_id: 'v1', percentage: 10 }] },
  ]);
  assert.deepEqual(previousVersion(d), { current: 'v3', previous: 'v2' });
  assert.deepEqual(previousVersion(d.slice(0, 1)), { current: 'v3', previous: null });
});

test('rollback: owners only, refused without CF_DEPLOY_TOKEN, deploys the previous version at 100 %, audited, alerts', async (t) => {
  assert.equal((await call('/api/deploys/yondr-ad-portal/rollback', { method: 'POST', as: ADMIN, body: {} })).status, 403);
  const noToken = await call('/api/deploys/yondr-ad-portal/rollback', { method: 'POST', as: OWNER, body: {} });
  assert.equal(noToken.status, 412);
  assert.match(noToken.data.error, /CF_DEPLOY_TOKEN/);
  assert.match(noToken.data.error, /Workers Scripts: Edit/);
  assert.equal((await call('/api/deploys/not-a-worker/rollback', { method: 'POST', as: OWNER, body: {} })).status, 404);
  env.CF_DEPLOY_TOKEN = 'deploy-token';
  const calls = mockFetch(t, async (url, init) => {
    if ((init.method || 'GET') === 'GET') return Response.json({ success: true, result: { deployments: [
      { id: 'a', created_on: '2026-11-27T10:00:00Z', versions: [{ version_id: 'new-version', percentage: 100 }] },
      { id: 'b', created_on: '2026-11-26T10:00:00Z', versions: [{ version_id: 'old-version', percentage: 100 }] }] } });
    return Response.json({ success: true, result: {} });
  });
  const r = await call('/api/deploys/yondr-ad-portal/rollback', { method: 'POST', as: OWNER, body: { version_id: 'old-version' } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.from, r.data.to], ['new-version', 'old-version']);
  const post = calls.find((c) => c.init.method === 'POST');
  assert.equal(post.url, 'https://api.cloudflare.com/client/v4/accounts/3fac6c19097c5692e17198cffa818085/workers/scripts/yondr-ad-portal/deployments');
  assert.equal(post.init.headers.authorization, 'Bearer deploy-token');
  const b = JSON.parse(post.init.body);
  assert.equal(b.strategy, 'percentage');
  assert.deepEqual(b.versions, [{ version_id: 'old-version', percentage: 100 }]);
  assert.equal(rows("SELECT actor FROM audit WHERE action = 'deploy.rollback'")[0].actor, OWNER);
  assert.ok(env.EMAIL.sent.some((m) => m.to === OWNER && /rolled back/.test(m.subject)));
  // CSRF still applies.
  assert.equal((await call('/api/deploys/yondr-ad-portal/rollback', { method: 'POST', as: OWNER, body: {}, csrf: false })).status, 403);
});
