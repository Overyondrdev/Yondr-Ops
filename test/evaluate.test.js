// Signed-out gate checks and the overyondr.com check: what counts as fine, down, exposed or changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GATE, GATED_HOSTS, PUBLIC_SITE } from '../src/checks.js';
import { evaluateGate, evaluatePublicSite } from '../src/evaluate.js';

const byId = (id) => GATE.find((c) => c.id === id);
const LOGIN = 'https://auth.overyondrdev.com/login?return=https%3A%2F%2Fv1.overyondrdev.com%2F';

test('a gated site that redirects to the Yondr sign-in is OK', () => {
  const r = evaluateGate(byId('gate:v1'), { status: 302, location: LOGIN });
  assert.equal(r.ok, true);
});

test('a gated site answering 200 to a signed-out visit is "site exposed" (critical)', () => {
  const r = evaluateGate(byId('gate:v1'), { status: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.event, 'site_exposed');
  assert.equal(r.severity, 'critical');
  assert.match(r.title, /open to the public/);
});

test('5xx and timeouts are "site down" (critical)', () => {
  for (const r of [evaluateGate(byId('gate:ads'), { status: 503 }), evaluateGate(byId('gate:ads'), { error: 'timed out after 10 s' })]) {
    assert.equal(r.event, 'site_down');
    assert.equal(r.severity, 'critical');
  }
});

test('a redirect to Cloudflare Access is a warning (costs seats), any other answer is high', () => {
  const a = evaluateGate(byId('gate:v2'), { status: 302, location: 'https://overyondr.cloudflareaccess.com/cdn-cgi/access/login/v2' });
  assert.equal(a.event, 'config_drift');
  assert.equal(a.severity, 'warning');
  const b = evaluateGate(byId('gate:v2'), { status: 404 });
  assert.equal(b.event, 'site_down');
  assert.equal(b.severity, 'high');
  // A redirect to a look-alike login host is not accepted.
  const c = evaluateGate(byId('gate:v2'), { status: 302, location: 'https://auth.overyondrdev.com.evil.example/login?x' });
  assert.equal(c.ok, false);
});

test('cards uses its own /auth step', () => {
  const c = byId('gate:cards');
  assert.equal(evaluateGate(c, { status: 302, location: 'https://cards.overyondrdev.com/auth' }).ok, true);
  assert.equal(evaluateGate(c, { status: 302, location: '/auth?next=/' }).ok, true);
  assert.equal(evaluateGate(c, { status: 302, location: LOGIN }).ok, false);
  assert.equal(evaluateGate(c, { status: 200 }).event, 'site_exposed');
});

test('status checks: sign-in page 200, widget 200, feedback API 401 (200 there = exposed)', () => {
  assert.equal(evaluateGate(byId('gate:auth'), { status: 200 }).ok, true);
  assert.equal(evaluateGate(byId('gate:auth'), { status: 404 }).event, 'site_down');
  assert.equal(evaluateGate(byId('gate:feedback-widget'), { status: 200 }).ok, true);
  assert.equal(evaluateGate(byId('gate:feedback-api'), { status: 401 }).ok, true);
  const exposed = evaluateGate(byId('gate:feedback-api'), { status: 200 });
  assert.equal(exposed.event, 'site_exposed');
  // A public endpoint answering 200 when something else was expected is never "exposed".
  assert.notEqual(evaluateGate({ ...byId('gate:auth'), expect: { status: 204 } }, { status: 200 }).event, 'site_exposed');
});

test('every host in the brief is checked, and the Bypass list includes ops itself', () => {
  const hosts = GATE.map((c) => new URL(c.url).hostname);
  for (const h of ['overyondrdev.com', 'www.overyondrdev.com', 'v1.overyondrdev.com', 'v2.overyondrdev.com', 'ads.overyondrdev.com',
    'requests.overyondrdev.com', 'feedback.overyondrdev.com', 'cards.overyondrdev.com', 'auth.overyondrdev.com']) assert.ok(hosts.includes(h), h);
  assert.ok(GATED_HOSTS.includes('ops.overyondrdev.com'));
});

test('overyondr.com: Squarespace redirect is fine; anything else is a warning', () => {
  assert.equal(evaluatePublicSite(PUBLIC_SITE, { status: 301, location: 'https://www.overyondr.com/', server: 'Squarespace' }).ok, true);
  const moved = evaluatePublicSite(PUBLIC_SITE, { status: 200, server: 'cloudflare' });
  assert.equal(moved.event, 'config_drift');
  assert.equal(moved.severity, 'warning');
  // Seen from inside Cloudflare, Squarespace's redirect carries server "cloudflare": still the Squarespace site.
  assert.equal(evaluatePublicSite(PUBLIC_SITE, { status: 301, location: 'https://www.overyondr.com/', server: 'cloudflare' }).ok, true);
  assert.equal(evaluatePublicSite(PUBLIC_SITE, { status: 301, location: 'https://overyondr-website-v1.example/', server: 'cloudflare' }).ok, false);
});
