// Error tracking (README "Errors").
// (a) Server errors: every monitoring run reads each Worker's requests and errors of the last hour from the GraphQL
//     Analytics API (dataset workersInvocationsAdaptive, per Worker per 5 minutes; CF_API_TOKEN with "Account
//     Analytics: Read"), stores them in worker_error_stats and turns the last 15 minutes into one check per Worker,
//     `errors:<worker>`: warning above 2 % errors with at least 20 requests, high above 10 % (ERRORS in checks.js).
//     "Errors" = invocations that did not succeed (uncaught exceptions, exceeded CPU/memory, internal errors). A 5xx a
//     Worker returns on purpose is not an invocation error and is not counted.
// (b) Browser errors: the feedback widget reports JavaScript errors per project to POST /api/events
//     { type: "client_errors", project, count, sample: [{ message, source, page_path }], window_minutes } (ingest
//     token). Stored in client_errors (samples redacted, at most 10), and more than `client_errors_threshold`
//     (setting, default 20) in 15 minutes for one project sends client_errors_spike (at most once an hour per project).
import { dispatch } from './alerts.js';
import { ACCOUNT_ID, CLIENT_ERRORS, DASHBOARD_URL, ERRORS, WORKERS } from './checks.js';
import { graphql } from './cloudflare.js';
import { getInternal, getSettings, setInternal } from './settings.js';
import { redact } from './triage.js';

const MIN = 60_000;
const DAY = 86_400_000;
const pct = (errors, requests) => (requests ? Math.round((errors / requests) * 10000) / 100 : 0);

// ------------------------------------------------------------------------------------------- server errors (pure)
/** The check result for one Worker's last window. Pure. */
export function evaluateErrors(worker, requests, errors, cfg = ERRORS) {
  const id = `errors:${worker}`;
  const site = `Server errors: ${worker}`;
  const rate = pct(errors, requests);
  const shown = `${errors} errors in ${requests} requests (${rate} %) in the last ${cfg.windowMinutes} minutes`;
  if (requests < cfg.minRequests) return { id, site, ok: true, detail: `${shown}; too few requests to judge (fewer than ${cfg.minRequests}).` };
  if (rate > cfg.highPct) return { id, site, ok: false, event: 'error_rate', severity: 'high', title: `${worker}: ${rate} % of requests fail`, detail: `${shown}. Look at Workers → ${worker} → Logs (Workers Observability) for the errors. If it started with a deploy, owners can roll back on the Deploys page.` };
  if (rate > cfg.warnPct) return { id, site, ok: false, event: 'error_rate', severity: 'warning', title: `${worker}: ${rate} % of requests fail`, detail: `${shown}.` };
  return { id, site, ok: true, detail: `${shown}.` };
}

/** Sum stored buckets per Worker since sinceIso (and before untilIso). */
export async function errorTotals(db, sinceIso, untilIso = null) {
  const stmt = untilIso
    ? db.prepare('SELECT worker, SUM(requests) AS requests, SUM(errors) AS errors FROM worker_error_stats WHERE bucket >= ? AND bucket < ? GROUP BY worker').bind(sinceIso, untilIso)
    : db.prepare('SELECT worker, SUM(requests) AS requests, SUM(errors) AS errors FROM worker_error_stats WHERE bucket >= ? GROUP BY worker').bind(sinceIso);
  const { results } = await stmt.all();
  return new Map(results.map((r) => [r.worker, { requests: Number(r.requests) || 0, errors: Number(r.errors) || 0 }]));
}

// ------------------------------------------------------------------------------------------- server errors (fetch)
/** The last hour per Worker per 5 minutes. Returns [{ worker, bucket, requests, errors }]. */
export async function fetchErrorBuckets(env, nowMs) {
  const data = await graphql(env, `query($a:string!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
    workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){sum{requests errors}dimensions{scriptName datetimeFiveMinutes}}}}}`,
  { a: ACCOUNT_ID, s: new Date(nowMs - 60 * MIN).toISOString(), e: new Date(nowMs).toISOString() });
  const rows = (data.viewer.accounts[0] || {}).workersInvocationsAdaptive || [];
  const out = new Map();
  for (const r of rows) {
    const d = r.dimensions || {};
    if (!d.scriptName || !d.datetimeFiveMinutes) continue;
    const key = `${d.scriptName}|${new Date(d.datetimeFiveMinutes).toISOString()}`;
    const cur = out.get(key) || { worker: d.scriptName, bucket: new Date(d.datetimeFiveMinutes).toISOString(), requests: 0, errors: 0 };
    cur.requests += Number((r.sum || {}).requests || 0);
    cur.errors += Number((r.sum || {}).errors || 0);
    out.set(key, cur);
  }
  return [...out.values()];
}

/** The monitoring part: one `errors:<worker>` result per Worker in WORKERS. fetchFn is injectable for tests. */
export async function errorChecks(env, nowMs = Date.now(), { fetchFn = fetchErrorBuckets } = {}) {
  const skip = (w, detail) => ({ id: `errors:${w.worker}`, site: `Server errors: ${w.worker}`, ok: null, detail });
  if (!env.CF_API_TOKEN) return WORKERS.map((w) => skip(w, 'CF_API_TOKEN is not set.'));
  let buckets;
  try { buckets = await fetchFn(env, nowMs); }
  catch (e) { return WORKERS.map((w) => skip(w, `Couldn't read Workers analytics: ${e.message}`)); }
  const db = env.DB;
  const stmts = buckets.map((b) => db.prepare(`INSERT INTO worker_error_stats (worker, bucket, requests, errors) VALUES (?, ?, ?, ?)
    ON CONFLICT(worker, bucket) DO UPDATE SET requests = excluded.requests, errors = excluded.errors`).bind(b.worker, b.bucket, b.requests, b.errors));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  const since = nowMs - ERRORS.windowMinutes * MIN;
  return WORKERS.map((w) => {
    const mine = buckets.filter((b) => b.worker === w.worker && Date.parse(b.bucket) >= since);
    return evaluateErrors(w.worker, mine.reduce((n, b) => n + b.requests, 0), mine.reduce((n, b) => n + b.errors, 0));
  });
}

// ------------------------------------------------------------------------------------------- browser errors
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Validate a client_errors report. Returns { report } or { error }. Pure. Samples are redacted (no personal data). */
export function validateClientErrors(b) {
  if (!b || typeof b !== 'object') return { error: 'Send a JSON object.' };
  const project = str(b.project, 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(project)) return { error: 'project is required (e.g. v1, v2, portal).' };
  const count = Number(b.count);
  if (!Number.isInteger(count) || count < 0 || count > 100000) return { error: 'count must be a whole number.' };
  const windowMinutes = b.window_minutes == null ? 5 : Number(b.window_minutes);
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440) return { error: 'window_minutes must be 1 to 1440.' };
  if (b.sample != null && !Array.isArray(b.sample)) return { error: 'sample must be a list.' };
  const sample = (b.sample || []).slice(0, CLIENT_ERRORS.maxSamples).filter((x) => x && typeof x === 'object').map((x) => ({
    message: redact(str(x.message, 300)), source: redact(str(x.source, 200)), page_path: redact(str(x.page_path, 200).split('?')[0]),
  }));
  return { report: { project, count, window_minutes: windowMinutes, sample } };
}

/** Is this a spike? Pure. */
export function isSpike(totalInWindow, threshold) { return totalInWindow > threshold; }

export async function ingestClientErrors(env, body, nowMs = Date.now()) {
  const v = validateClientErrors(body);
  if (v.error) return { status: 422, body: { error: v.error } };
  const r = v.report;
  const db = env.DB;
  const now = new Date(nowMs).toISOString();
  await db.prepare('INSERT INTO client_errors (project, count, window_minutes, sample, received_at) VALUES (?, ?, ?, ?, ?)')
    .bind(r.project, r.count, r.window_minutes, JSON.stringify(r.sample), now).run();
  const settings = await getSettings(db);
  const total = (await db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM client_errors WHERE project = ? AND received_at >= ?')
    .bind(r.project, new Date(nowMs - CLIENT_ERRORS.windowMinutes * MIN).toISOString()).first()).n;
  let alerted = false;
  if (isSpike(total, settings.client_errors_threshold)) {
    const key = `client_spike:${r.project}`;
    const last = await getInternal(db, key);
    if (!last || nowMs - Date.parse(last) >= CLIENT_ERRORS.realertMinutes * MIN) {
      await setInternal(db, key, now);
      const top = r.sample.slice(0, 3).map((x) => `• ${x.message || '(no message)'}${x.source ? ` at ${x.source}` : ''}${x.page_path ? ` on ${x.page_path}` : ''}`);
      await dispatch(env, {
        type: 'client_errors_spike', kind: 'event', severity: 'warning', site: r.project,
        title: `${total} browser errors on ${r.project} in ${CLIENT_ERRORS.windowMinutes} minutes`,
        detail: [`The feedback widget reported ${total} JavaScript errors on ${r.project} in the last ${CLIENT_ERRORS.windowMinutes} minutes (alert above ${settings.client_errors_threshold}).`, top.length ? 'Examples:' : null, ...top].filter(Boolean).join('\n'),
        done: 'Nothing automatic. Next alert for this project at the earliest in an hour.', link: `${DASHBOARD_URL}/#errors`,
      }, { settings, nowMs }).catch((e) => console.error('client_errors_spike failed', e && e.stack));
      alerted = true;
    }
  }
  return { status: 201, body: { ok: true, project: r.project, total_in_window: total, alerted } };
}

// ------------------------------------------------------------------------------------------- reports
export async function pruneErrors(db, nowMs = Date.now()) {
  const cutoff = new Date(nowMs - ERRORS.keepDays * DAY).toISOString();
  await db.batch([
    db.prepare('DELETE FROM worker_error_stats WHERE bucket < ?').bind(cutoff),
    db.prepare('DELETE FROM client_errors WHERE received_at < ?').bind(cutoff),
  ]);
}

/** The Errors page (and Overview numbers). */
export async function errorsReport(db, nowMs = Date.now()) {
  const day = new Date(nowMs - DAY).toISOString();
  const hour = new Date(nowMs - 60 * MIN).toISOString();
  const [d24, h1, { results: series }, { results: client }, { results: recent }] = await Promise.all([
    errorTotals(db, day), errorTotals(db, hour),
    db.prepare(`SELECT worker, substr(bucket, 1, 13) AS hour, SUM(requests) AS requests, SUM(errors) AS errors FROM worker_error_stats
      WHERE bucket >= ? GROUP BY worker, hour ORDER BY hour`).bind(day).all(),
    db.prepare('SELECT project, SUM(count) AS n, MAX(received_at) AS last FROM client_errors WHERE received_at >= ? GROUP BY project ORDER BY n DESC').bind(day).all(),
    db.prepare('SELECT project, sample, received_at, count FROM client_errors WHERE received_at >= ? ORDER BY id DESC LIMIT 30').bind(day).all(),
  ]);
  const workers = WORKERS.map((w) => {
    const a = d24.get(w.worker) || { requests: 0, errors: 0 };
    const b = h1.get(w.worker) || { requests: 0, errors: 0 };
    return { worker: w.worker, label: w.label, requests_24h: a.requests, errors_24h: a.errors, rate_24h: pct(a.errors, a.requests),
      requests_1h: b.requests, errors_1h: b.errors, rate_1h: pct(b.errors, b.requests),
      hourly: series.filter((s) => s.worker === w.worker).map((s) => ({ hour: s.hour, requests: s.requests, errors: s.errors })) };
  });
  return {
    workers, thresholds: ERRORS,
    client: client.map((c) => ({ project: c.project, count_24h: c.n, last: c.last })),
    client_recent: recent.map((r) => ({ project: r.project, count: r.count, received_at: r.received_at, sample: JSON.parse(r.sample || '[]') })),
  };
}
