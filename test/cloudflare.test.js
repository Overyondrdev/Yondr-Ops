// Cloudflare API evaluations: builds, Access Bypass app, inventory and usage thresholds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAccess, evaluateBuilds, evaluateInventory, evaluateUsage, usageChecks } from '../src/cloudflare.js';
import { mockFetch } from './helpers.js';

const build = (outcome, branch, at, uuid = at) => ({ build_uuid: uuid, build_outcome: outcome, created_on: at, build_trigger_metadata: { branch, commit_hash: 'abcdef0123' } });

test('builds: only the latest finished production build counts (PR previews ignored)', () => {
  const ok = evaluateBuilds('overyondr-website-v1', 'main', [build('fail', 'feature-x', '2026-11-27T10:00:00Z'), build('success', 'main', '2026-11-27T09:00:00Z')]);
  assert.equal(ok.ok, true);
  const bad = evaluateBuilds('overyondr-website-v1', 'main', [build('success', 'main', '2026-11-26T09:00:00Z'), build('fail', 'main', '2026-11-27T09:00:00Z', 'b2')]);
  assert.equal(bad.event, 'deploy_failed');
  assert.equal(bad.severity, 'high');
  assert.equal(bad.fingerprint, 'b2');
  const cancelled = evaluateBuilds('w', 'main', [build('cancelled', 'main', '2026-11-27T10:00:00Z'), build('success', 'main', '2026-11-27T09:00:00Z')]);
  assert.equal(cancelled.ok, true);
  assert.equal(evaluateBuilds('w', 'main', []).ok, null);
});

test('Access: every gated host must be in the Bypass app', () => {
  const hosts = ['v1.overyondrdev.com', 'ops.overyondrdev.com'];
  const app = { name: 'Yondr sites (Google sign-in)', domain: 'v1.overyondrdev.com', destinations: [{ type: 'public', uri: 'v1.overyondrdev.com' }], policies: [{ decision: 'bypass' }] };
  const r = evaluateAccess([app], hosts);
  assert.equal(r.ok, false);
  assert.equal(r.event, 'config_drift');
  assert.equal(r.severity, 'warning');
  assert.match(r.detail, /ops\.overyondrdev\.com/);
  assert.equal(evaluateAccess([{ ...app, destinations: [...app.destinations, { uri: 'ops.overyondrdev.com/' }] }], hosts).ok, true);
  assert.equal(evaluateAccess([], hosts).fingerprint, 'missing-app');
  assert.match(evaluateAccess([{ ...app, self_hosted_domains: hosts, policies: [{ decision: 'allow' }] }], hosts).detail, /no Bypass policy/);
});

test('inventory: new or missing resources are a warning with a stable fingerprint', () => {
  assert.equal(evaluateInventory('d1', ['a', 'b'], ['b', 'a']).ok, true);
  const r = evaluateInventory('r2', ['a', 'c'], ['a', 'b']);
  assert.equal(r.ok, false);
  assert.match(r.detail, /New .*c/);
  assert.match(r.detail, /Missing: b/);
  assert.equal(r.fingerprint, '+c-b');
});

test('usage: warning at 70 %, high at 90 %', () => {
  assert.equal(evaluateUsage('workers_requests', 69_999).ok, true);
  assert.equal(evaluateUsage('workers_requests', 70_000).severity, 'warning');
  assert.equal(evaluateUsage('workers_requests', 95_000).severity, 'high');
  assert.equal(evaluateUsage('d1_rows_written', 91_000).event, 'usage_limit');
});

test('usage checks: one unavailable GraphQL dataset is skipped without hiding the others', async (t) => {
  mockFetch(t, (url, init) => {
    const q = JSON.parse(init.body).query;
    if (q.includes('aiInferenceAdaptiveGroups')) return Response.json({ data: null, errors: [{ message: 'unknown field' }] });
    const node = q.includes('workersInvocationsAdaptive') ? { workersInvocationsAdaptive: [{ sum: { requests: 80_000 } }] }
      : { d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 10, rowsWritten: 10 } }] };
    return Response.json({ data: { viewer: { accounts: [node] } } });
  });
  const r = await usageChecks({ CF_API_TOKEN: 'x' }, Date.parse('2026-11-27T12:00:00Z'));
  assert.equal(r.find((x) => x.id === 'cf:usage:workers_requests').severity, 'warning');
  assert.equal(r.find((x) => x.id === 'cf:usage:d1_rows_read').ok, true);
  assert.equal(r.find((x) => x.id === 'cf:usage:ai_neurons').ok, null);
  const none = await usageChecks({}, Date.now());
  assert.ok(none.every((x) => x.ok === null));
});
