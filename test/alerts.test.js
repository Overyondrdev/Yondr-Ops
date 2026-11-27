// Who gets which alert: severity filter, quiet hours (critical always delivered), owners forced for site down /
// exposed, paused people, Slack de-duplication; and what the message says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inQuietHours, passesSeverity, renderAlert, route } from '../src/alerts.js';
import { ADMIN, NEWBIE, OWNER, STAFF } from './helpers.js';

const NOON = Date.parse('2026-11-27T12:00:00Z');
const NIGHT = Date.parse('2026-11-27T23:30:00Z');
const person = (id, email, o = {}) => ({ id, email, active: 1, min_severity: 'all', quiet_start: null, quiet_end: null, timezone: 'UTC', ...o });
const rule = (subscriber_id, event_type, channel = 'email', webhook = '') => ({ subscriber_id, event_type, channel, webhook });

test('severity filter: all / high and critical / critical only', () => {
  assert.equal(passesSeverity('all', 'info'), true);
  assert.equal(passesSeverity('high', 'warning'), false);
  assert.equal(passesSeverity('high', 'high'), true);
  assert.equal(passesSeverity('high', 'critical'), true);
  assert.equal(passesSeverity('critical', 'high'), false);
  const subscribers = [person(1, STAFF, { min_severity: 'critical' }), person(2, ADMIN)];
  const subscriptions = [rule(1, 'deploy_failed'), rule(2, 'deploy_failed')];
  assert.deepEqual(route({ type: 'deploy_failed', severity: 'high' }, { subscribers, subscriptions, nowMs: NOON }).email, [ADMIN]);
});

test('quiet hours (wrapping past midnight, in the person\'s time zone) hold back non-critical alerts only', () => {
  assert.equal(inQuietHours(NIGHT, '22:00', '07:00', 'UTC'), true);
  assert.equal(inQuietHours(NOON, '22:00', '07:00', 'UTC'), false);
  assert.equal(inQuietHours(NOON, '12:00', '13:00', 'UTC'), true);
  // 12:00 UTC is 07:00 in New York (EST): not quiet any more; 11:30 UTC = 06:30 is.
  assert.equal(inQuietHours(NOON, '22:00', '07:00', 'America/New_York'), false);
  assert.equal(inQuietHours(Date.parse('2026-11-27T11:30:00Z'), '22:00', '07:00', 'America/New_York'), true);
  assert.equal(inQuietHours(NIGHT, null, null), false);

  const subscribers = [person(1, STAFF, { quiet_start: '22:00', quiet_end: '07:00' })];
  const subscriptions = [rule(1, 'deploy_failed'), rule(1, 'site_down')];
  const held = route({ type: 'deploy_failed', severity: 'high' }, { subscribers, subscriptions, nowMs: NIGHT });
  assert.deepEqual(held.email, []);
  assert.equal(held.skipped[0].reason, 'quiet hours');
  assert.deepEqual(route({ type: 'site_down', severity: 'critical' }, { subscribers, subscriptions, nowMs: NIGHT }).email, [STAFF]);
});

test('critical alerts are delivered even with quiet hours', () => {
  const subscribers = [person(1, STAFF, { quiet_start: '00:00', quiet_end: '23:59' })];
  const r = route({ type: 'deploy_failed', severity: 'critical' }, { subscribers, subscriptions: [rule(1, 'deploy_failed')], nowMs: NOON });
  assert.deepEqual(r.email, [STAFF]);
});

test('owners always get site_down and site_exposed, even unsubscribed, paused or filtered', () => {
  const owners = new Set([OWNER]);
  const subscribers = [person(1, OWNER, { active: 0, min_severity: 'critical', quiet_start: '00:00', quiet_end: '23:59' })];
  for (const type of ['site_down', 'site_exposed']) {
    assert.deepEqual(route({ type, severity: 'critical' }, { subscribers, subscriptions: [], owners, nowMs: NOON }).email, [OWNER]);
    // also when the incident is only "high" (e.g. unexpected answer)
    assert.deepEqual(route({ type, severity: 'high' }, { subscribers: [], subscriptions: [], owners, nowMs: NOON }).email, [OWNER]);
  }
  // Other events follow the owner's own choices.
  assert.deepEqual(route({ type: 'deploy_failed', severity: 'high' }, { subscribers, subscriptions: [rule(1, 'deploy_failed')], owners, nowMs: NOON }).email, []);
});

test('paused people get nothing; Slack rules post once per webhook; bad webhook names are ignored', () => {
  const subscribers = [person(1, STAFF, { active: 0 }), person(2, ADMIN), person(3, NEWBIE)];
  const subscriptions = [rule(1, 'backup_failed'), rule(2, 'backup_failed', 'slack', 'SLACK_WEBHOOK_OPS'), rule(3, 'backup_failed', 'slack', 'SLACK_WEBHOOK_OPS'),
    rule(3, 'backup_failed', 'slack', 'https://hooks.example/x')];
  const r = route({ type: 'backup_failed', severity: 'high' }, { subscribers, subscriptions, nowMs: NOON });
  assert.deepEqual(r.email, []);
  assert.deepEqual(r.slack, ['SLACK_WEBHOOK_OPS']);
  assert.equal(r.skipped.find((s) => s.who === STAFF).reason, 'paused');
});

test('the message is plain: what, which site, since when, what was done, a link', () => {
  const m = renderAlert({ type: 'site_exposed', kind: 'opened', severity: 'critical', title: 'Website V1 is open to the public', site: 'Website V1',
    detail: 'Anyone can see it.', since: '2026-11-27T10:00:00Z', nowMs: Date.parse('2026-11-27T10:25:00Z') });
  assert.match(m.subject, /Website V1 is open to the public \[Critical\]/);
  assert.match(m.text, /What's wrong: Website V1 is open to the public/);
  assert.match(m.text, /Which site: Website V1/);
  assert.match(m.text, /Since: 2026-11-27 10:00 UTC \(25 min ago\)/);
  assert.match(m.text, /What's been done automatically:/);
  assert.match(m.text, /https:\/\/ops\.overyondrdev\.com\/#incidents/);
  assert.doesNotMatch(m.html, /<script/);
  const r = renderAlert({ type: 'site_down', kind: 'resolved', severity: 'critical', title: 'Ads is down', since: '2026-11-27T10:00:00Z', nowMs: Date.parse('2026-11-27T11:30:00Z') });
  assert.match(r.subject, /^Resolved: Ads is down$/);
  assert.match(r.text, /broken for 1 h 30 min/);
  const x = renderAlert({ type: 'feedback_critical', severity: 'high', title: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(x.html, /<img src=x/);
});

test('subscribers: outside addresses are owners-only and marked external', async () => {
  const { validateSubscriber } = await import('../src/api.js');
  const env = { ALLOWED_EMAIL_DOMAINS: 'overyondr.com' };
  assert.ok(validateSubscriber({ email: 'name@example.com' }, env, { creating: true }).error, 'admin cannot add an outside address');
  const o = validateSubscriber({ email: 'name@example.com' }, env, { creating: true, owner: true });
  assert.equal(o.error, undefined);
  assert.equal(o.fields.external, true);
  const w = validateSubscriber({ email: 'you@overyondr.com' }, env, { creating: true });
  assert.equal(w.fields.external, undefined);
  assert.ok(validateSubscriber({ email: 'not-an-email' }, env, { creating: true, owner: true }).error);
});
