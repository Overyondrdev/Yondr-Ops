// End to end through the Worker's fetch and scheduled handlers: sign-in gate, admins only, CSRF, the ingest token,
// event de-duplication, people & rules, settings, backups download, the auto-fix log and revert, monitoring.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { applySchema, resetSchemaCache } from '../src/schema.js';
import { ADMIN, makeEnv, mockFetch, NEWBIE, OWNER, session, STAFF, TOKEN } from './helpers.js';

const BASE = 'https://ops.overyondrdev.com';
let env;
beforeEach(() => { resetSchemaCache(); env = makeEnv(); });

async function call(path, { method = 'GET', as = ADMIN, body, origin = BASE, csrf = true, headers = {}, base = BASE } = {}) {
  const h = { ...headers };
  if (as) h.cookie = `other=1; yondr_session=${await session(as)}`;
  if (origin && method !== 'GET') h.origin = origin;
  if (method !== 'GET' && csrf) h['x-yondr-ops'] = '1';
  if (body) h['content-type'] = 'application/json';
  const pending = [];
  const res = await worker.fetch(new Request(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  const type = res.headers.get('content-type') || '';
  return { res, status: res.status, data: type.includes('json') ? await res.json() : null };
}
const ingest = (path, body, token = TOKEN) => worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-ops-token': token } : {}) }, body: JSON.stringify(body) }), env, {});

test('signed out: pages redirect to the Yondr sign-in, the API answers 401; brand files are public', async () => {
  const page = await call('/', { as: null });
  assert.equal(page.status, 302);
  assert.equal(page.res.headers.get('location'), 'https://auth.overyondrdev.com/login?return=https%3A%2F%2Fops.overyondrdev.com%2F');
  assert.equal((await call('/api/status', { as: null })).status, 401);
  assert.equal((await call('/app.js', { as: null })).status, 302);
  const logo = await call('/brand/yondr-lichen.svg', { as: null });
  assert.equal(logo.status, 200);
  assert.equal((await call('/robots.txt', { as: null })).status, 200);
});

test('only admins get in: non-admins see /api/me with role null and 403 elsewhere', async () => {
  const me = await call('/api/me', { as: STAFF });
  assert.equal(me.status, 200);
  assert.equal(me.data.role, null);
  assert.equal((await call('/api/status', { as: STAFF })).status, 403);
  assert.equal((await call('/api/me', { as: OWNER })).data.role, 'owner');
  const page = await call('/', { as: ADMIN });
  assert.equal(page.status, 200);
  assert.match(page.res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(page.res.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('CSRF: changes need X-Yondr-Ops and the site\'s own Origin; no CORS headers ever', async () => {
  const body = { email: NEWBIE };
  assert.equal((await call('/api/people', { method: 'POST', body, csrf: false })).status, 403);
  assert.equal((await call('/api/people', { method: 'POST', body, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/api/people', { method: 'POST', body, origin: 'https://ads.overyondrdev.com' })).status, 403);
  assert.equal((await call('/api/people', { method: 'POST', body, origin: null })).status, 403);
  const ok = await call('/api/people', { method: 'POST', body });
  assert.equal(ok.status, 201);
  assert.equal(ok.res.headers.get('access-control-allow-origin'), null);
});

test('DEV_EMAIL signs in on localhost only', async () => {
  env.DEV_EMAIL = ADMIN;
  const local = await call('/api/me', { as: null, base: 'http://localhost:8787' });
  assert.equal(local.data.email, ADMIN);
  assert.equal((await call('/api/me', { as: null })).status, 401);
  const localPost = await call('/api/people', { method: 'POST', as: null, base: 'http://localhost:8787', origin: 'http://localhost:8787', body: { email: NEWBIE } });
  assert.equal(localPost.status, 201);
});

test('ingest token: required, constant-time checked, never a substitute for sign-in on other routes', async () => {
  const ev = { type: 'feedback_critical', title: 'Checkout page broken', site: 'v1', source: 'yondr-feedback' };
  assert.equal((await ingest('/api/events', ev, null)).status, 401);
  assert.equal((await ingest('/api/events', ev, 'wrong-token-wrong-token-wrong-token-xx')).status, 401);
  assert.equal((await ingest('/api/events', ev)).status, 201);
  // The token does not open the admin API.
  const r = await worker.fetch(new Request(BASE + '/api/status', { headers: { 'x-ops-token': TOKEN } }), env, {});
  assert.equal(r.status, 401);
  // A short token on the Worker disables ingest entirely.
  env.OPS_INGEST_TOKEN = 'short';
  assert.equal((await ingest('/api/events', ev, 'short')).status, 401);
});

test('events are validated, de-duplicated within the window and routed to subscribers', async () => {
  await call('/api/people', { method: 'POST', body: { email: NEWBIE, name: 'Dee', rules: [{ event_type: 'feedback_critical', channel: 'email' }] } });
  assert.equal((await ingest('/api/events', { type: 'nope', title: 'x' })).status, 422);
  assert.equal((await ingest('/api/events', { type: 'site_down', severity: 'apocalyptic', title: 'x' })).status, 422);
  assert.equal((await ingest('/api/events', { type: 'site_down', title: 'x', url: 'javascript:alert(1)' })).status, 422);
  const ev = { type: 'feedback_critical', title: 'Checkout page broken', site: 'v1', source: 'yondr-feedback', url: 'https://feedback.overyondrdev.com/admin#item-12' };
  const first = await (await ingest('/api/events', ev)).json();
  assert.equal(first.duplicate, false);
  const again = await (await ingest('/api/events', ev)).json();
  assert.equal(again.duplicate, true);
  assert.equal(env.EMAIL.sent.length, 1);
  assert.equal(env.EMAIL.sent[0].to, NEWBIE);
  assert.equal(env.EMAIL.sent[0].from.email, 'alerts@overyondrdev.com');
  assert.match(env.EMAIL.sent[0].text, /Reported by yondr-feedback/);
  const log = await call('/api/alerts');
  assert.equal(log.data.alerts[0].status, 'sent');
  assert.deepEqual(log.data.alerts[0].recipients, [NEWBIE]);
  assert.equal(log.data.events.length, 2);
});

test('people: validation, default rules, editing rules, Slack webhooks by name only, test alert, removal', async (t) => {
  env.SLACK_WEBHOOK_OPS = 'https://hooks.slack.com/services/fake/fake/fake';
  assert.equal((await call('/api/people', { method: 'POST', body: { email: 'someone@gmail.com' } })).status, 422);
  const add = await call('/api/people', { method: 'POST', body: { email: 'Dee.New@overyondr.com', name: 'Dee' } });
  assert.equal(add.status, 201);
  assert.equal((await call('/api/people', { method: 'POST', body: { email: NEWBIE } })).status, 409);
  let list = (await call('/api/people')).data;
  assert.deepEqual(list.webhooks, ['SLACK_WEBHOOK_OPS']);
  const dee = list.people[0];
  assert.equal(dee.email, NEWBIE);
  assert.ok(dee.rules.length >= 5);
  assert.equal((await call(`/api/people/${dee.id}`, { method: 'PATCH', body: { rules: [{ event_type: 'site_down', channel: 'slack', webhook: 'SLACK_WEBHOOK_NOPE' }] } })).status, 422);
  assert.equal((await call(`/api/people/${dee.id}`, { method: 'PATCH', body: { quiet_start: '25:00' } })).status, 422);
  assert.equal((await call(`/api/people/${dee.id}`, { method: 'PATCH', body: { timezone: 'Mars/Base' } })).status, 422);
  const upd = await call(`/api/people/${dee.id}`, { method: 'PATCH', body: { min_severity: 'high', quiet_start: '22:00', quiet_end: '07:00', timezone: 'Europe/London',
    rules: [{ event_type: 'site_down', channel: 'email' }, { event_type: 'site_down', channel: 'slack', webhook: 'SLACK_WEBHOOK_OPS' }] } });
  assert.equal(upd.status, 200);
  list = (await call('/api/people')).data;
  assert.equal(list.people[0].rules.length, 2);
  assert.equal(list.people[0].min_severity, 'high');
  const slackCalls = mockFetch(t, () => new Response('ok'));
  const t1 = await call('/api/alerts/test', { method: 'POST', body: { id: dee.id } });
  assert.equal(t1.status, 200);
  assert.equal(t1.data.sent, 2);
  assert.equal(slackCalls[0].url, 'https://hooks.slack.com/services/fake/fake/fake');
  assert.equal((await call(`/api/people/${dee.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call('/api/people')).data.people.length, 0);
  const audit = (await call('/api/settings')).data.audit.map((a) => a.action);
  assert.ok(audit.includes('person.add') && audit.includes('person.remove') && audit.includes('alerts.test'));
});

test('settings: owners only, validated; secrets reported as set/not set, never their values', async () => {
  assert.equal((await call('/api/settings', { method: 'PATCH', body: { alerts_enabled: false } })).status, 403);
  assert.equal((await call('/api/settings', { method: 'PATCH', as: OWNER, body: { realert_minutes: 1 } })).status, 422);
  assert.equal((await call('/api/settings', { method: 'PATCH', as: OWNER, body: { email_transport: 'pigeon' } })).status, 422);
  const ok = await call('/api/settings', { method: 'PATCH', as: OWNER, body: { autofix_enabled: true, pii_backup_retention_days: 14, email_transport: 'resend' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.settings.pii_backup_retention_days, 14);
  const s = await call('/api/settings');
  assert.equal(s.data.secrets.OPS_INGEST_TOKEN, true);
  assert.equal(s.data.secrets.GITHUB_TOKEN, false);
  assert.doesNotMatch(JSON.stringify(s.data), new RegExp(TOKEN));
  const cfg = await worker.fetch(new Request(BASE + '/api/autofix/config', { headers: { 'x-ops-token': TOKEN } }), env, {});
  assert.deepEqual(await cfg.json(), { autofix_enabled: true });
});

test('alerts switched off: logged as skipped, nothing sent; resend transport uses the Resend API', async (t) => {
  await call('/api/people', { method: 'POST', body: { email: NEWBIE, rules: [{ event_type: 'feedback_critical', channel: 'email' }] } });
  await call('/api/settings', { method: 'PATCH', as: OWNER, body: { alerts_enabled: false } });
  await ingest('/api/events', { type: 'feedback_critical', title: 'One' });
  assert.equal(env.EMAIL.sent.length, 0);
  assert.equal((await call('/api/alerts')).data.alerts[0].status, 'skipped');
  await call('/api/settings', { method: 'PATCH', as: OWNER, body: { alerts_enabled: true, email_transport: 'resend' } });
  env.RESEND_API_KEY = 're_test';
  const calls = mockFetch(t, () => Response.json({ id: 'x' }));
  await ingest('/api/events', { type: 'feedback_critical', title: 'Two' });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.deepEqual(JSON.parse(calls[0].init.body).to, [NEWBIE]);
  assert.equal(JSON.parse(calls[0].init.body).from, 'Yondr Ops <alerts@overyondrdev.com>');
});

test('backups: listed for admins, personal-data downloads for owners only, streamed', async () => {
  env.FEEDBACK_DB.sqlite.exec("INSERT INTO feedback (message, created_at) VALUES ('hello', 'x')");
  env.CARDS_DB.sqlite.exec("CREATE TABLE clients (name TEXT); INSERT INTO clients VALUES ('Fictional Client')");
  const run = await call('/api/backups/run', { method: 'POST', as: OWNER });
  assert.equal(run.status, 202);
  const list = (await call('/api/backups')).data;
  assert.equal(list.backups.length, 5);
  const fb = list.backups.find((b) => b.db === 'yondr-feedback');
  const cards = list.backups.find((b) => b.db === 'yondr-christmas-cards');
  const dl = await call(`/api/backups/${fb.id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(dl.res.headers.get('content-type'), 'application/gzip');
  assert.match(dl.res.headers.get('content-disposition'), /yondr-feedback-\d{4}-\d{2}-\d{2}\.sql\.gz/);
  assert.equal((await call(`/api/backups/${cards.id}/download`)).status, 403);
  assert.equal((await call(`/api/backups/${cards.id}/download`, { as: OWNER })).status, 200);
  assert.equal((await call('/api/backups/run', { method: 'POST', as: OWNER })).status, 429);
});

const SHA = 'a'.repeat(40);
test('auto-fix log: ingest creates and updates with an append-only timeline and alerts on status changes', async () => {
  await call('/api/people', { method: 'POST', body: { email: NEWBIE, rules: ['autofix_started', 'autofix_merged', 'autofix_failed', 'autofix_reverted'].map((e) => ({ event_type: e, channel: 'email' })) } });
  assert.equal((await ingest('/api/autofix/events', { repo: 'evil/repo', title: 'x' })).status, 422);
  assert.equal((await ingest('/api/autofix/events', { repo: 'Overyondrdev/overyondr-website-v1', title: 'x', status: 'bogus' })).status, 422);
  assert.equal((await ingest('/api/autofix/events', { title: 'x' }, null)).status, 401);
  const created = await (await ingest('/api/autofix/events', { repo: 'Overyondrdev/overyondr-website-v1', title: 'Fix footer link', feedback_id: 12, project: 'v1',
    classification: 'objective', classification_reason: 'Broken link (404)', severity: 'normal', status: 'triaged', actor: 'autofix-engine', message: 'Triaged as objective' })).json();
  const id = created.autofix.id;
  await ingest('/api/autofix/events', { id, status: 'fixing', message: 'Working on it' });
  await ingest('/api/autofix/events', { id, status: 'merged', pr_url: 'https://github.com/Overyondrdev/overyondr-website-v1/pull/99', merge_sha: SHA });
  const d = (await call(`/api/autofix/${id}`)).data.autofix;
  assert.equal(d.status, 'merged');
  assert.equal(d.events.length, 3);
  assert.deepEqual(env.EMAIL.sent.map((m) => m.subject.split(':')[0]), ['Auto-fix started', 'Auto-fix merged']);
  assert.equal((await call('/api/autofix')).data.autofixes.length, 1);
});

test('revert: CSRF required; refusal recorded and explained; success opens the PR, records who and alerts', async (t) => {
  const created = await (await ingest('/api/autofix/events', { repo: 'Overyondrdev/overyondr-website-v1', title: 'Fix footer link', status: 'merged', merge_sha: SHA,
    pr_url: 'https://github.com/Overyondrdev/overyondr-website-v1/pull/99' })).json();
  const id = created.autofix.id;
  assert.equal((await call(`/api/autofix/${id}/revert`, { method: 'POST', csrf: false })).status, 403);
  assert.equal((await call(`/api/autofix/${id}/revert`, { method: 'POST', as: STAFF })).status, 403);
  // No GitHub token yet → refused, explained, nothing claimed.
  const refused = await call(`/api/autofix/${id}/revert`, { method: 'POST' });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /GITHUB_TOKEN/);
  let d = (await call(`/api/autofix/${id}`)).data.autofix;
  assert.equal(d.revert_pr_url, null);
  assert.match(d.events.at(-1).message, /Revert refused/);
  env.GITHUB_TOKEN = 'gh-test';
  mockFetch(t, (url, init) => {
    const m = init.method || 'GET';
    const p = new URL(url).pathname;
    if (p.endsWith(`/commits/${SHA}`)) return Response.json({ sha: SHA, parents: [{ sha: 'c'.repeat(40) }], files: [{ filename: 'a.html', status: 'modified' }] });
    if (m === 'GET' && p.endsWith('/commits')) return Response.json([{ sha: SHA }]);
    if (p.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'd'.repeat(40) } });
    if (m === 'GET' && p.includes('/git/commits/')) return Response.json({ tree: { sha: 'e'.repeat(40) } });
    if (m === 'GET' && p.includes('/git/trees/')) return Response.json({ truncated: false, tree: [{ path: 'a.html', mode: '100644', type: 'blob', sha: '1'.repeat(40) }] });
    if (m === 'POST' && p.endsWith('/pulls')) return Response.json({ number: 5, html_url: 'https://github.com/Overyondrdev/overyondr-website-v1/pull/5', node_id: 'N' });
    if (m === 'POST') return Response.json({ sha: '9'.repeat(40), data: {} });
    return Response.json({}, { status: 404 });
  });
  const ok = await call(`/api/autofix/${id}/revert`, { method: 'POST' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  d = ok.data.autofix;
  assert.equal(d.status, 'reverted');
  assert.equal(d.reverted_by, ADMIN);
  assert.equal(d.revert_pr_url, 'https://github.com/Overyondrdev/overyondr-website-v1/pull/5');
  assert.ok(d.events.some((e) => /Revert pull request opened/.test(e.message)));
  assert.equal((await call(`/api/autofix/${id}/revert`, { method: 'POST' })).status, 409);
});

test('monitoring via the dashboard: a gated site that answers 200 is an exposed incident; owners are emailed', async (t) => {
  mockFetch(t, (url) => {
    if (url === 'https://v2.overyondrdev.com/') return new Response('<h1>open</h1>', { status: 200 });
    if (url === 'https://cards.overyondrdev.com/') return new Response(null, { status: 302, headers: { location: 'https://cards.overyondrdev.com/auth' } });
    if (url === 'https://auth.overyondrdev.com/login' || url.endsWith('/widget.js')) return new Response('ok');
    if (url.endsWith('/api/me')) return new Response('{}', { status: 401 });
    if (url === 'https://overyondr.com/') return new Response(null, { status: 301, headers: { location: 'https://www.overyondr.com/', server: 'Squarespace' } });
    return new Response(null, { status: 302, headers: { location: 'https://auth.overyondrdev.com/login?return=x' } });
  });
  const r = await call('/api/checks/run', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.data.summary.failing, 1);
  const st = (await call('/api/status')).data;
  const v2 = st.checks.find((c) => c.id === 'gate:v2');
  assert.equal(v2.state.event, 'site_exposed');
  assert.equal(st.open_incidents, 1);
  assert.equal(env.EMAIL.sent.length, 1);
  assert.equal(env.EMAIL.sent[0].to, OWNER);
  assert.match(env.EMAIL.sent[0].subject, /Website V2 is open to the public \[Critical\]/);
  assert.equal((await call('/api/checks/run', { method: 'POST' })).status, 429);
  // Muting is logged and needs a reason.
  assert.equal((await call('/api/checks/gate:v2/mute', { method: 'POST', body: { hours: 2 } })).status, 422);
  assert.equal((await call('/api/checks/gate:v2/mute', { method: 'POST', body: { hours: 2, reason: 'Testing' } })).status, 200);
  assert.ok((await call('/api/status')).data.checks.find((c) => c.id === 'gate:v2').mute);
});

test('the cron handler runs monitoring every 5 minutes and backups at 03:17', async (t) => {
  mockFetch(t, () => new Response(null, { status: 302, headers: { location: 'https://auth.overyondrdev.com/login?return=x' } }));
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.parse('2026-11-27T12:00:00Z') }, env, ctx);
  await Promise.all(waits);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE kind = 'monitor'").first()).n, 1);
  await worker.scheduled({ cron: '17 3 * * *', scheduledTime: Date.parse('2026-11-27T03:17:00Z') }, env, ctx);
  await Promise.all(waits);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM backups WHERE status = 'ok'").first()).n, 5);
});

test('schema is idempotent', async () => {
  await applySchema(env.DB);
  await applySchema(env.DB);
  const t = await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").first();
  assert.ok(t.n >= 14);
});
