// Auto-fix spending (src/budget.js): the owner's rules. Cost per run (unknown = $2), 50 % / 70 % warnings once each,
// forecast alert at most daily, pause at 90 % (triage still queues, nothing starts, the workflow gate says "budget"),
// owners-only approval that lifts the pause for the current month only.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { route } from '../src/alerts.js';
import { approveSpend, BUDGET, checkBudget, computeBudget, digestLine, loadBudget, monthOf, parseCost, recordCost } from '../src/budget.js';
import { applySchema, resetSchemaCache } from '../src/schema.js';
import { getSettings, setSetting } from '../src/settings.js';
import { decide, processQueue, startFix } from '../src/triage.js';
import { ADMIN, makeEnv, OWNER, session, TOKEN } from './helpers.js';

const BASE = 'https://ops.overyondrdev.com';
const NOV_10 = Date.parse('2026-11-10T12:00:00Z');
const NOV_20 = Date.parse('2026-11-20T12:00:00Z');
const DEC_02 = Date.parse('2026-12-02T12:00:00Z');
const DEFAULTS = { autofix_monthly_budget_usd: 50, autofix_pause_at_pct: 90, autofix_warn_first_pct: 50, autofix_warn_second_pct: 70 };
let env;
let settings;

beforeEach(async () => {
  resetSchemaCache();
  env = makeEnv();
  await applySchema(env.DB);
  settings = await getSettings(env.DB);
});

async function fix(status = 'pr_open', over = {}) {
  const now = new Date().toISOString();
  const r = await env.DB.prepare(`INSERT INTO autofixes (feedback_id, project, repo, title, classification, status, severity, created_at, updated_at)
    VALUES (?, 'v1', 'Overyondrdev/overyondr-website-v1', ?, 'objective', ?, ?, ?, ?) RETURNING id`)
    .bind(over.feedback_id ?? null, over.title || 'Broken link', status, over.severity || 'normal', now, now).first();
  return r.id;
}
const spend = async (usd, nowMs, runKey) => recordCost(env, await fix(), { cost_usd: usd, unknown: false, run_key: runKey || `run-${Math.random()}` }, { nowMs });
const subjects = () => env.EMAIL.sent.map((m) => m.subject);
async function call(path, { method = 'GET', as = ADMIN, body } = {}) {
  const h = { cookie: `yondr_session=${await session(as)}` };
  if (method !== 'GET') { h.origin = BASE; h['x-yondr-ops'] = '1'; }
  if (body) h['content-type'] = 'application/json';
  const res = await worker.fetch(new Request(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
  return { status: res.status, data: await res.json() };
}
const gate = () => worker.fetch(new Request(BASE + '/api/autofix/config', { headers: { 'x-ops-token': TOKEN } }), env, {}).then((r) => r.json());

// ------------------------------------------------------------------------------------------------ pure
test('computeBudget: effective budget, pause level, forecast with a 3-day floor and $2 per pending fix', () => {
  const b = computeBudget({ settings: DEFAULTS, spent: 10, nowMs: NOV_10 });
  assert.equal(b.effective, 50);
  assert.equal(b.pause_at, 45);
  assert.equal(b.forecast, Math.round(10 / 9.5 * 30 * 100) / 100, '10 dollars in 9.5 days of a 30-day month');
  assert.equal(b.paused, false);
  const early = computeBudget({ settings: DEFAULTS, spent: 4, nowMs: Date.parse('2026-11-01T06:00:00Z') });
  assert.equal(early.forecast, 40, 'day 0.25 counts as 3 days: 4 / 3 × 30');
  const pending = computeBudget({ settings: DEFAULTS, spent: 0, queued: 2, running: 1, nowMs: NOV_10 });
  assert.equal(pending.forecast, 6);
  const approved = computeBudget({ settings: DEFAULTS, spent: 46, approvedExtra: 25, nowMs: NOV_20 });
  assert.equal(approved.effective, 75);
  assert.equal(approved.pause_at, 70, 'the owner gets exactly what they approved on top of the $45 pause level');
  assert.equal(approved.paused, false);
});

test('pause at 90 % ($45 of $50); no new start when one more fix could pass the budget', () => {
  assert.equal(computeBudget({ settings: DEFAULTS, spent: 44.99, nowMs: NOV_20 }).paused, false);
  assert.equal(computeBudget({ settings: DEFAULTS, spent: 45, nowMs: NOV_20 }).paused, true);
  assert.equal(computeBudget({ settings: DEFAULTS, spent: 40, running: 0, nowMs: NOV_20 }).can_start, true);
  assert.equal(computeBudget({ settings: DEFAULTS, spent: 40, running: 5, nowMs: NOV_20 }).can_start, false, '40 + 6 × $2 > 50');
});

test('parseCost: numbers, numeric strings, unknown, garbage → unknown ($2); nothing reported → null', () => {
  assert.equal(parseCost({ status: 'pr_open' }), null);
  assert.deepEqual(parseCost({ cost_usd: 0.4312, run_id: '123-1' }), { cost_usd: 0.4312, unknown: false, run_key: '123-1' });
  assert.equal(parseCost({ cost_usd: '1.25' }).cost_usd, 1.25);
  assert.equal(parseCost({ cost_usd: null, cost_unknown: true }).unknown, true);
  assert.equal(parseCost({ cost_usd: 'lots' }).unknown, true);
  assert.equal(parseCost({ cost_usd: -1 }).unknown, true);
  assert.equal(parseCost({ cost_usd: 1e9 }).unknown, true);
  assert.equal(parseCost({ cost_usd: 1, run_id: 'bad id; drop' }).run_key, null);
});

test('budget alerts ignore quiet hours and always reach owners', () => {
  const r = route({ type: 'autofix_budget_warning', severity: 'warning' }, {
    subscribers: [{ id: 1, email: 'cy.staff@overyondr.com', active: 1, min_severity: 'all', quiet_start: '00:00', quiet_end: '23:59', timezone: 'UTC' }],
    subscriptions: [{ subscriber_id: 1, event_type: 'autofix_budget_warning', channel: 'email', webhook: '' }],
    owners: new Set([OWNER]), nowMs: NOV_10,
  });
  assert.deepEqual(r.email, [OWNER, 'cy.staff@overyondr.com'].sort());
});

// ------------------------------------------------------------------------------------------------ with D1
test('cost aggregation: per month, unknown runs count $2, a repeated report of the same run counts once', async () => {
  const id = await fix();
  assert.equal(await recordCost(env, id, { cost_usd: 3.5, unknown: false, run_key: 'r1' }, { nowMs: NOV_10 }), true);
  assert.equal(await recordCost(env, id, { cost_usd: 3.5, unknown: false, run_key: 'r1' }, { nowMs: NOV_10 }), false, 'same run again');
  await recordCost(env, id, { cost_usd: null, unknown: true, run_key: 'r2' }, { nowMs: NOV_10 });
  await recordCost(env, id, { cost_usd: 9, unknown: false, run_key: 'oct' }, { nowMs: Date.parse('2026-10-30T10:00:00Z') });
  const b = await loadBudget(env.DB, settings, NOV_10);
  assert.equal(b.spent, 3.5 + BUDGET.unknownRunUsd);
  assert.equal(b.runs, 2);
  assert.equal((await loadBudget(env.DB, settings, Date.parse('2026-10-31T10:00:00Z'))).spent, 9);
});

test('warnings at 50 % and 70 % fire once each per month; a jump sends only the highest', async () => {
  // (The forecast alert is tested on its own below; only warnings count here.)
  const warnings = async (nowMs) => (await checkBudget(env, settings, { nowMs })).filter((t) => t === 'autofix_budget_warning');
  await spend(20, NOV_10);
  assert.deepEqual(await warnings(NOV_10), []);
  await spend(6, NOV_10); // 26 ≥ 25
  assert.deepEqual(await warnings(NOV_20), ['autofix_budget_warning']);
  assert.deepEqual(await warnings(NOV_20), [], 'not again');
  await spend(10, NOV_20); // 36 ≥ 35
  assert.deepEqual(await warnings(NOV_20), ['autofix_budget_warning']);
  assert.deepEqual(await warnings(NOV_20), []);
  const warn = env.EMAIL.sent.filter((m) => /spending at/.test(m.subject));
  assert.equal(warn.length, 2);
  assert.match(warn[0].subject, /50 %/);
  assert.match(warn[1].subject, /70 %/);
  assert.equal(warn[0].to, OWNER);
  assert.match(warn[1].text, /Spent so far in November 2026: \$36\.00 of the \$50\.00 budget/);
  assert.match(warn[1].text, /Forecast for the whole month/);

  // Next month starts afresh; a jump straight past both thresholds sends one warning (70 %).
  await spend(36, DEC_02);
  const sent = await checkBudget(env, settings, { nowMs: DEC_02 });
  assert.deepEqual(sent.filter((t) => t === 'autofix_budget_warning'), ['autofix_budget_warning']);
  assert.match(env.EMAIL.sent.filter((m) => /spending at/.test(m.subject)).at(-1).subject, /70 %/);
});

test('projection: forecast over budget alerts at most once a day', async () => {
  await spend(20, NOV_10); // 20 / 9.5 days × 30 = 63 > 50
  assert.ok((await checkBudget(env, settings, { nowMs: NOV_10 })).includes('autofix_budget_projection'));
  assert.ok(!(await checkBudget(env, settings, { nowMs: NOV_10 + 3_600_000 })).includes('autofix_budget_projection'), 'same day');
  assert.ok((await checkBudget(env, settings, { nowMs: NOV_10 + 86_400_000 })).includes('autofix_budget_projection'), 'next day');
  const m = env.EMAIL.sent.find((x) => /on course for/.test(x.subject));
  assert.match(m.subject, /over the \$50\.00 budget/);
  assert.match(m.text, /Nothing is paused yet/);
});

test('pause at 90 %: alert once, gate says budget, triage queues but nothing starts', async () => {
  await setSetting(env.DB, 'autofix_enabled', true, 'test');
  settings = await getSettings(env.DB);
  const now = Date.now();
  await spend(45, now);
  const sent = await checkBudget(env, settings, { nowMs: now });
  assert.deepEqual(sent, ['autofix_budget_paused'], 'the pause message replaces the warnings');
  assert.deepEqual(await checkBudget(env, settings, { nowMs: now }), []);
  const m = env.EMAIL.sent.find((x) => /^Auto-fix paused/.test(x.subject));
  assert.equal(m.to, OWNER);
  assert.match(m.text, /What is paused: no new automatic fixes start/);
  assert.match(m.text, /#autofix\/spend/);

  assert.deepEqual(await gate(), { autofix_enabled: false, reason: 'budget' });
  const cfg = await call('/api/autofix/config');
  assert.equal(cfg.data.reason, 'budget');
  assert.equal(cfg.data.switched_on, true);

  const budget = await loadBudget(env.DB, settings, now);
  const d = decide({ item: { type: 'bug', priority: 'critical', project: 'v1' }, repo: 'Overyondrdev/overyondr-website-v1', target: { workflow: true },
    classification: { classification: 'objective', reason: 'r' }, settings, budget });
  assert.equal(d.status, 'queued');
  assert.equal(d.start, false);
  assert.match(d.message, /paused/);

  env.GITHUB_TOKEN = 'gh-test';
  const queued = await fix('queued');
  assert.deepEqual(await processQueue(env, { nowMs: now, settings }), { skipped: 'paused: monthly budget' });
  assert.equal(await startFix(env, queued, { settings, nowMs: now }), false, 'no GitHub call: fetch is not mocked');
  const row = await env.DB.prepare('SELECT status FROM autofixes WHERE id = ?').bind(queued).first();
  assert.equal(row.status, 'queued');
  const ev = await env.DB.prepare('SELECT message FROM autofix_events WHERE autofix_id = ? ORDER BY id DESC').bind(queued).first();
  assert.match(ev.message, /paused/);
});

test('gate: switched off says so; on and within budget is enabled', async () => {
  assert.deepEqual(await gate(), { autofix_enabled: false, reason: 'switched_off' });
  await setSetting(env.DB, 'autofix_enabled', true, 'test');
  assert.deepEqual(await gate(), { autofix_enabled: true, reason: null });
});

test('approval: owners only, validated, audited, alerts owners, lifts the pause for the current month only', async () => {
  await setSetting(env.DB, 'autofix_enabled', true, 'test');
  settings = await getSettings(env.DB);
  await spend(46, Date.now());
  assert.equal((await gate()).reason, 'budget');

  const admin = await call('/api/autofix/budget/approve', { method: 'POST', as: ADMIN, body: { amount_usd: 25 } });
  assert.equal(admin.status, 403);
  assert.equal((await call('/api/autofix/budget/approve', { method: 'POST', as: OWNER, body: { amount_usd: 101 } })).status, 422);
  assert.equal((await call('/api/autofix/budget/approve', { method: 'POST', as: OWNER, body: { amount_usd: 2.5 } })).status, 422);
  const noCsrf = await worker.fetch(new Request(BASE + '/api/autofix/budget/approve', { method: 'POST',
    headers: { cookie: `yondr_session=${await session(OWNER)}`, origin: BASE, 'content-type': 'application/json' }, body: '{}' }), env, {});
  assert.equal(noCsrf.status, 403, 'CSRF header required');

  const ok = await call('/api/autofix/budget/approve', { method: 'POST', as: OWNER, body: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.budget.approved_extra, BUDGET.defaultApprovalUsd);
  assert.equal(ok.data.budget.effective, 75);
  assert.equal(ok.data.budget.pause_at, 70);
  assert.equal(ok.data.budget.paused, false);
  assert.deepEqual(await gate(), { autofix_enabled: true, reason: null });
  const audit = await env.DB.prepare("SELECT * FROM audit WHERE action = 'autofix.budget.approve'").first();
  assert.equal(audit.actor, OWNER);
  assert.ok(env.EMAIL.sent.some((m) => /^More auto-fix spend approved/.test(m.subject) && m.to === OWNER));

  // Next month the approval no longer counts.
  const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 1, 2);
  const nb = await loadBudget(env.DB, settings, next.getTime());
  assert.equal(nb.approved_extra, 0);
  assert.equal(nb.effective, 50);

  const spendPanel = await call('/api/autofix/spend', { as: ADMIN });
  assert.equal(spendPanel.status, 200);
  assert.equal(spendPanel.data.approvals.length, 1);
  assert.equal(spendPanel.data.costs.length, 1);
  assert.equal(spendPanel.data.costs[0].counted_usd, 46);
});

test('an approval in one month does not lift a pause in the next', async () => {
  await approveSpend(env, 50, OWNER, { settings, nowMs: NOV_20 });
  await spend(45, DEC_02);
  const dec = await loadBudget(env.DB, settings, DEC_02);
  assert.equal(dec.paused, true);
  assert.equal(monthOf(DEC_02), '2026-12');
});

test('workflow report: cost_usd / cost_unknown recorded through /api/autofix/events, once per run_id', async () => {
  const id = await fix('fixing');
  const post = (b) => worker.fetch(new Request(BASE + '/api/autofix/events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ops-token': TOKEN },
    body: JSON.stringify(b) }), env, {});
  assert.equal((await post({ id, status: 'pr_open', message: 'PR', cost_usd: 1.234, cost_unknown: false, run_id: '555-1' })).status, 200);
  assert.equal((await post({ id, status: 'pr_open', message: 'PR again', cost_usd: 1.234, cost_unknown: false, run_id: '555-1' })).status, 200);
  assert.equal((await post({ id, status: 'failed', message: 'Needs a human', cost_usd: null, cost_unknown: true, run_id: '556-1' })).status, 200);
  const b = await loadBudget(env.DB, settings, Date.now());
  assert.equal(b.spent, 3.23, '1.234 + $2 for the unknown run');
  const { results } = await env.DB.prepare('SELECT message FROM autofix_events WHERE autofix_id = ?').bind(id).all();
  assert.ok(results.some((r) => /Claude API cost of this run: \$1\.23/.test(r.message)));
  assert.ok(results.some((r) => /could not be read: counted as \$2\.00/.test(r.message)));
});

test('daily digest line: month-to-date spend and forecast', () => {
  const b = computeBudget({ settings: DEFAULTS, spent: 12, nowMs: NOV_10 });
  assert.match(digestLine(b), /^Auto-fix spend in November 2026: \$12\.00 of \$50\.00 \(forecast \$37\.89\)\.$/);
  assert.match(digestLine(computeBudget({ settings: DEFAULTS, spent: 45, nowMs: NOV_20 })), /PAUSED/);
});
