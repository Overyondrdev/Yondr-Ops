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

test('Access: no app on overyondrdev.com may cost seats (the catch-all included)', () => {
  const hosts = ['v1.overyondrdev.com'];
  const app = { name: 'Yondr sites (Google sign-in)', destinations: [{ uri: 'v1.overyondrdev.com' }], policies: [{ decision: 'bypass' }] };
  const wildcard = { name: 'catch-all', domain: '*.overyondrdev.com', destinations: [{ uri: '*.overyondrdev.com' }], policies: [{ decision: 'bypass' }] };
  assert.equal(evaluateAccess([app, wildcard], hosts).ok, true);
  const r = evaluateAccess([app, { ...wildcard, policies: [{ decision: 'allow' }] }], hosts);
  assert.equal(r.ok, false);
  assert.equal(r.severity, 'high');
  assert.match(r.detail, /catch-all/);
  assert.equal(r.fingerprint, 'seat:catch-all');
  // Apps for other domains are not ours to judge.
  assert.equal(evaluateAccess([app, { name: 'other', domain: 'example.com', policies: [{ decision: 'allow' }] }], hosts).ok, true);
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

test('Access: hosts covered by their own Bypass app count; wildcard Allow apps never do', async () => {
  const { evaluateAccess } = await import('../src/cloudflare.js');
  const apps = [
    { name: 'Main', destinations: [{ uri: 'a.example.com' }], policies: [{ decision: 'bypass' }] },
    { name: 'Own', destinations: [{ uri: 'b.example.com' }], policies: [{ decision: 'bypass' }] },
    { name: 'Wild', destinations: [{ uri: '*.example.com' }], policies: [{ decision: 'allow' }] },
    { name: 'Allow', destinations: [{ uri: 'c.example.com' }], policies: [{ decision: 'allow' }] },
  ];
  const r = evaluateAccess(apps, ['a.example.com', 'b.example.com', 'c.example.com'], 'Main');
  assert.equal(r.ok, false);
  assert.match(r.detail, /c\.example\.com/);
  assert.doesNotMatch(r.detail, /b\.example\.com/);
  assert.equal(evaluateAccess(apps, ['a.example.com', 'b.example.com'], 'Main').ok, true);
});
