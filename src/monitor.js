// The 5-minute monitoring run: signed-out gate checks, overyondr.com, Cloudflare API checks (each at its own
// cadence), then the state machine and alerts. Also sends the daily digest once a day.
import { dispatch } from './alerts.js';
import { ACCESS, ACCESS_SEATS, BUILDS, DIRECTORY, ERRORS, EXPECTED_INVENTORY, GATE, PUBLIC_SITE, USAGE } from './checks.js';
import { accessCheck, accessSeatsCheck, buildChecks, inventoryChecks, usageChecks } from './cloudflare.js';
import { maybeDailyDigest } from './digest.js';
import { directoryCheck } from './directory.js';
import { errorChecks } from './errors.js';
import { evaluateGate, evaluatePublicSite } from './evaluate.js';
import { issueForIncident, resolveForIncident } from './issues.js';
import { ensureSchema } from './schema.js';
import { getInternal, getSettings, setInternal } from './settings.js';
import { applyResult, decide, isMuted, loadMutes, loadStates } from './state.js';
import { recordHistory } from './status.js';

const TIMEOUT_MS = 10_000;

/** One signed-out request, never following redirects. */
export async function probe(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET', redirect: 'manual', cache: 'no-store',
      headers: { 'user-agent': 'yondr-ops-monitor/1 (+https://ops.overyondrdev.com)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Don't download bodies we don't need.
    if (res.body) await res.body.cancel().catch(() => {});
    return { status: res.status, location: res.headers.get('location'), server: res.headers.get('server'), ms: Date.now() - started };
  } catch (e) {
    return { error: e && e.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000} s` : String((e && e.message) || e), ms: Date.now() - started };
  }
}

async function gateResult(check, probeFn) {
  let r = evaluateGate(check, await probeFn(check.url));
  // One retry before calling a site down: a single dropped connection shouldn't wake anyone.
  if (!r.ok && r.event === 'site_down') {
    await new Promise((ok) => setTimeout(ok, 1500));
    r = evaluateGate(check, await probeFn(check.url));
  }
  return r;
}

async function due(db, group, everyMin, nowMs, force) {
  if (force) return true;
  const last = await getInternal(db, `last_run:${group}`);
  return !last || nowMs - Date.parse(last) >= (everyMin - 1) * 60_000;
}

/** All results for this run. probeFn is injectable for tests. */
export async function collect(env, nowMs, { force = false, probeFn = probe, extra = {} } = {}) {
  const db = env.DB;
  const tasks = [
    ...GATE.map((c) => gateResult(c, probeFn)),
    probeFn(PUBLIC_SITE.url).then((r) => evaluatePublicSite(PUBLIC_SITE, r)),
  ];
  const groups = [
    ['builds', BUILDS.every, () => buildChecks(env)],
    ['access', ACCESS.every, () => accessCheck(env).then((r) => [r])],
    ['inventory', EXPECTED_INVENTORY.every, () => inventoryChecks(env)],
    ['usage', USAGE.every, () => usageChecks(env, nowMs)],
    ['errors', ERRORS.every, () => errorChecks(env, nowMs)],
    ['seats', ACCESS_SEATS.every, () => accessSeatsCheck(env).then((r) => [r])],
    ['directory', DIRECTORY.every, () => directoryCheck(env, nowMs).then((r) => [r])],
  ];
  for (const [group, every, run] of groups) {
    if (await due(db, group, every, nowMs, force)) {
      tasks.push(extra[group] ? extra[group](env, nowMs) : run());
      await setInternal(db, `last_run:${group}`, new Date(nowMs).toISOString());
    }
  }
  return (await Promise.all(tasks)).flat();
}

export async function runMonitor(env, { nowMs = Date.now(), force = false, probeFn, extra } = {}) {
  const db = env.DB;
  await ensureSchema(db);
  const settings = await getSettings(db);
  if (!settings.monitoring_enabled && !force) return { skipped: 'monitoring switched off' };
  const run = await db.prepare("INSERT INTO runs (kind, started_at) VALUES ('monitor', ?) RETURNING id").bind(new Date(nowMs).toISOString()).first();
  const results = await collect(env, nowMs, { force, probeFn, extra });
  const [states, mutes] = await Promise.all([loadStates(db), loadMutes(db, nowMs)]);
  const summary = { checks: results.length, failing: 0, unknown: 0, alerts: 0 };
  for (const r of results) {
    const prev = states.get(r.id) || null;
    const muted = isMuted(mutes.get(r.id), nowMs);
    const d = decide(prev, r, nowMs, { realertMinutes: settings.realert_minutes, muted });
    const incidentId = await applyResult(db, r, d, prev, nowMs);
    // Issues (src/issues.js): an incident opens one (or adds to the check's open issue); resolving it resolves the issue.
    if (d.transition === 'opened' && incidentId) {
      const inc = await db.prepare('SELECT * FROM incidents WHERE id = ?').bind(incidentId).first();
      await issueForIncident(env, inc, { settings, nowMs }).catch((e) => console.error('incident issue failed', r.id, e && e.stack));
    } else if (d.transition === 'resolved' && incidentId) {
      await resolveForIncident(env, incidentId, { nowMs }).catch((e) => console.error('issue auto-resolve failed', r.id, e && e.stack));
    }
    if (r.ok === false) summary.failing++;
    if (r.ok === null) summary.unknown++;
    if (d.alert) {
      summary.alerts++;
      const res = d.alert === 'resolved' ? prev : r;
      await dispatch(env, {
        type: res.event, kind: d.alert, severity: res.severity, title: res.title, site: r.site, detail: r.detail,
        since: d.alert === 'resolved' ? prev.since : d.state.since, incident_id: incidentId,
      }, { settings, nowMs }).catch((e) => console.error('alert failed', r.id, e && e.stack));
    }
  }
  await recordHistory(db, results, nowMs).catch((e) => console.error('check history failed', e && e.stack));
  await maybeDailyDigest(env, settings, nowMs).catch((e) => console.error('digest failed', e && e.stack));
  await db.prepare('UPDATE runs SET finished_at = ?, ok = 1, summary = ? WHERE id = ?').bind(new Date().toISOString(), JSON.stringify(summary), run.id).run();
  return summary;
}
