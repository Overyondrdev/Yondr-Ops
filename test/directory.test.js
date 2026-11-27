// People directory (yondr-auth's KV, read-only here): the directory:sync check, the digest line and the Overview line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { maybeDailyDigest } from '../src/digest.js';
import { directoryDigestLine, evaluateDirectory, KV_DATA, KV_META } from '../src/directory.js';
import { runMonitor } from '../src/monitor.js';
import { overview } from '../src/overview.js';
import { getSettings } from '../src/settings.js';
import { applySchema, resetSchemaCache } from '../src/schema.js';
import { ADMIN, makeEnv as baseEnv, NEWBIE, probes, STAFF, subscribe } from './helpers.js';

const makeEnv = async (extra) => { resetSchemaCache(); const env = baseEnv(extra); await applySchema(env.DB); return env; };

const NOW = Date.parse('2026-11-27T12:00:00Z');
const hAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const good = (o = {}) => ({ ok: true, error: null, guard: false, last_ok: hAgo(2), last_attempt: hAgo(2), active: 103, skipped_rows: [], history: [], last_change: null, ...o });

/** The KV as ops sees it: get only. Any write fails the test. */
function readOnlyKv(values = {}) {
  const no = () => { throw new Error('ops must never write the directory KV'); };
  return {
    async get(key, type) { const v = values[key]; return v === undefined ? null : type === 'json' ? JSON.parse(JSON.stringify(v)) : JSON.stringify(v); },
    put: no, delete: no,
  };
}

test('directory check: never synced or not set up = unknown with a plain message', () => {
  for (const meta of [null, { ok: false, error: 'Not set up: DIRECTORY_SA_KEY or DIRECTORY_SHEET_ID is missing.', last_attempt: hAgo(1) }, {}]) {
    const r = evaluateDirectory(meta, NOW);
    assert.equal(r.id, 'directory:sync');
    assert.equal(r.ok, null);
    assert.equal(r.detail, 'Directory not set up yet (service account key missing).');
  }
  // Never synced for another reason: still unknown, but the reason is shown.
  const r = evaluateDirectory({ ok: false, error: "Couldn't read the sheet (403).", last_attempt: hAgo(1) }, NOW);
  assert.equal(r.ok, null);
  assert.match(r.detail, /403/);
});

test('directory check: recent good sync is fine', () => {
  const r = evaluateDirectory(good({ skipped_rows: [4, 9] }), NOW);
  assert.equal(r.ok, true);
  assert.match(r.detail, /^103 people, last updated 2026-11-27 10:00 UTC \(2 sheet rows/);
});

test('directory check: failing, stale or held back = config_drift warning', () => {
  const failing = evaluateDirectory(good({ ok: false, error: "Couldn't read the sheet (403)." }), NOW);
  assert.equal(failing.ok, false);
  assert.equal(failing.event, 'config_drift');
  assert.equal(failing.severity, 'warning');
  assert.match(failing.detail, /403/);

  assert.equal(evaluateDirectory(good({ last_ok: hAgo(12) }), NOW).ok, true);
  const stale = evaluateDirectory(good({ last_ok: hAgo(14) }), NOW);
  assert.equal(stale.ok, false);
  assert.equal(stale.event, 'config_drift');
  assert.match(stale.detail, /14 hours ago/);

  const guard = evaluateDirectory(good({ ok: false, guard: true, error: 'Not applied: 30 of 103 people would have been removed at once (limit 20 %).' }), NOW);
  assert.equal(guard.ok, false);
  assert.equal(guard.severity, 'warning');
  assert.equal(guard.fingerprint, 'guard');
  assert.match(guard.title, /held back/);
  assert.match(guard.detail, /too many people would have been removed/);
  assert.notEqual(guard.fingerprint, failing.fingerprint); // a held-back update after a failure is a change people hear about
});

test('directory digest line: count, and names added/left since the previous digest', () => {
  const people = [{ email: NEWBIE, name: 'Dee New' }, { email: STAFF, name: 'Cy Staff', active: false }];
  const meta = good({ last_change: { at: hAgo(3), added: [NEWBIE], removed: [STAFF], changed: [] } });
  assert.deepEqual(directoryDigestLine(meta, people, hAgo(24)), ['Directory: 103 people.', '• Added: Dee New', '• Left: Cy Staff']);
  assert.deepEqual(directoryDigestLine(meta, people, hAgo(1)), ['Directory: 103 people.']); // already reported
  assert.deepEqual(directoryDigestLine(null, [], hAgo(24)), ['Directory: not set up yet.']);
  assert.match(directoryDigestLine(good({ ok: false, guard: true }), [], hAgo(24))[0], /held back/);
  const many = Array.from({ length: 12 }, (_, i) => `p${i}@example.com`);
  assert.match(directoryDigestLine(good({ last_change: { at: hAgo(1), added: many, removed: [] } }), [], hAgo(24))[1], /and 2 more$/);
});

test('monitor: directory:sync runs hourly from the KV, never writes it', async () => {
  const env = await makeEnv({ DIRECTORY: readOnlyKv({ [KV_META]: good({ last_ok: hAgo(20) }) }) });
  await runMonitor(env, { nowMs: NOW, force: true, probeFn: probes() });
  const s = env.DB.sqlite.prepare("SELECT * FROM check_state WHERE check_id = 'directory:sync'").get();
  assert.equal(s.status, 'fail');
  assert.equal(s.event, 'config_drift');
  // Without the binding the check simply can't run.
  const env2 = await makeEnv();
  await runMonitor(env2, { nowMs: NOW, force: true, probeFn: probes() });
  assert.equal(env2.DB.sqlite.prepare("SELECT status FROM check_state WHERE check_id = 'directory:sync'").get().status, 'unknown');
});

test('overview and daily digest show the directory', async () => {
  const meta = good({ last_change: { at: hAgo(3), added: [NEWBIE], removed: [], changed: [] } });
  const env = await makeEnv({ DIRECTORY: readOnlyKv({ [KV_META]: meta, [KV_DATA]: { people: [{ email: NEWBIE, name: 'Dee New', title: 'Director' }] } }) });
  const o = await overview(env, { nowMs: NOW });
  assert.deepEqual({ ...o.directory, detail: undefined }, { bound: true, status: 'ok', title: null, detail: undefined, active: 103, last_ok: hAgo(2) });

  subscribe(env, ADMIN, ['daily_digest']);
  const settings = await getSettings(env.DB);
  assert.equal(await maybeDailyDigest(env, settings, NOW), true);
  const first = JSON.stringify(env.EMAIL.sent);
  assert.match(first, /Directory: 103 people\./);
  assert.match(first, /Added: Dee New/);
  // Next day: the same change is not repeated.
  env.EMAIL.sent.length = 0;
  assert.equal(await maybeDailyDigest(env, settings, NOW + 86_400_000), true);
  const second = JSON.stringify(env.EMAIL.sent);
  assert.match(second, /Directory: 103 people\./);
  assert.doesNotMatch(second, /Dee New/);
});
