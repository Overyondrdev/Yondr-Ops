// The state machine: alert on change only, resolved alerts, hourly critical reminders, mutes, and the incident log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySchema } from '../src/schema.js';
import { applyResult, decide } from '../src/state.js';
import { fakeD1 } from './helpers.js';

const T0 = Date.parse('2026-11-27T10:00:00Z');
const min = (n) => T0 + n * 60_000;
const down = { id: 'gate:v1', site: 'Website V1', ok: false, event: 'site_down', severity: 'critical', title: 'Website V1 is down' };
const up = { id: 'gate:v1', site: 'Website V1', ok: true, detail: 'fine' };

test('ok → fail opens and alerts; fail → fail stays quiet; fail → ok resolves and alerts', () => {
  const a = decide(null, up, min(0));
  assert.equal(a.alert, null);
  const b = decide(a.state, down, min(5));
  assert.equal(b.transition, 'opened');
  assert.equal(b.alert, 'opened');
  const c = decide(b.state, down, min(10));
  assert.equal(c.alert, null);
  assert.equal(c.state.since, b.state.since);
  const d = decide(c.state, up, min(15));
  assert.equal(d.transition, 'resolved');
  assert.equal(d.alert, 'resolved');
});

test('critical problems are re-alerted every 60 minutes while they last (not others)', () => {
  let s = decide(null, down, min(0)).state;
  let reminders = 0;
  for (let m = 5; m <= 130; m += 5) { const d = decide(s, down, min(m), { realertMinutes: 60 }); if (d.alert === 'reminder') reminders++; s = d.state; }
  assert.equal(reminders, 2); // at 60 and 120 minutes
  const warn = { ...down, event: 'config_drift', severity: 'warning' };
  let w = decide(null, warn, min(0)).state;
  for (let m = 5; m <= 130; m += 5) { const d = decide(w, warn, min(m)); assert.equal(d.alert, null); w = d.state; }
});

test('a change while failing (exposed instead of down, or a new fingerprint) alerts again', () => {
  const s = decide(null, down, min(0)).state;
  const d = decide(s, { ...down, event: 'site_exposed', title: 'exposed' }, min(5));
  assert.equal(d.alert, 'changed');
  const inv = { id: 'cf:inventory:d1', ok: false, event: 'config_drift', severity: 'warning', title: 'D1 changed', fingerprint: '+a-' };
  const s2 = decide(null, inv, min(0)).state;
  assert.equal(decide(s2, inv, min(60)).alert, null);
  assert.equal(decide(s2, { ...inv, fingerprint: '+a,b-' }, min(60)).alert, 'changed');
});

test('muted: nothing is sent; after the mute, a still-failing check alerts; a silent incident resolves silently', () => {
  const m = decide(null, down, min(0), { muted: true });
  assert.equal(m.transition, 'opened');
  assert.equal(m.alert, null);
  const still = decide(m.state, down, min(5), { muted: true });
  assert.equal(still.alert, null);
  const after = decide(still.state, down, min(10), { muted: false });
  assert.equal(after.alert, 'opened');
  const quietFix = decide(m.state, up, min(5));
  assert.equal(quietFix.transition, 'resolved');
  assert.equal(quietFix.alert, null);
});

test('a check that could not run leaves the state alone', () => {
  const s = decide(null, down, min(0)).state;
  const d = decide(s, { id: 'gate:v1', ok: null, detail: 'no token' }, min(5));
  assert.equal(d.alert, null);
  assert.equal(d.state.status, 'fail');
});

test('applyResult keeps an incident log with duration', async () => {
  const db = fakeD1();
  await applySchema(db);
  let prev = null;
  for (const [r, at] of [[down, 0], [down, 5], [up, 30]]) {
    const d = decide(prev, r, min(at));
    await applyResult(db, r, d, prev, min(at));
    prev = await db.prepare('SELECT * FROM check_state WHERE check_id = ?').bind('gate:v1').first();
  }
  const inc = await db.prepare('SELECT * FROM incidents').all();
  assert.equal(inc.results.length, 1);
  assert.equal(inc.results[0].duration_s, 1800);
  assert.ok(inc.results[0].resolved_at);
  assert.equal(prev.status, 'ok');
  assert.equal(prev.incident_id, null);
});
