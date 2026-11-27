// Safe releases (README "Deploys"): recent deployments per Worker, the 15-minute deploy watch and one-click rollback.
//   Deployments  GET /accounts/<id>/workers/scripts/<name>/deployments (+ /versions), cached 4-5 minutes (cf_cache).
//   Deploy watch every 5 minutes (auto-fix cron, own subrequest budget): a deployment newer than an hour that ops
//                hasn't seen is watched. The hour before it is the baseline (error rate from worker_error_stats, and
//                which of the Worker's site checks were already failing). 15 minutes after it: worse error rate or a
//                site check that started failing = deploy_regression (with a link to the Deploys page) and an issue.
//   Rollback     owners only, confirm dialog, needs the separate secret CF_DEPLOY_TOKEN (Workers Scripts: Edit). Deploys
//                the previous version at 100 %: POST .../deployments { strategy: "percentage", versions: [{ version_id,
//                percentage: 100 }] }. Audited, sends rollback_done. The next normal deploy from main replaces it, and
//                database migrations (D1) are NOT rolled back.
import { dispatch } from './alerts.js';
import { cached } from './cfcache.js';
import { ACCOUNT_ID, DASHBOARD_URL, DEPLOY_WATCH, WORKERS, workerOf } from './checks.js';
import { cf } from './cloudflare.js';
import { errorTotals } from './errors.js';
import { issueForDeploy } from './issues.js';
import { getSettings } from './settings.js';

const MIN = 60_000;
const rate = (t) => (t && t.requests ? (t.errors / t.requests) * 100 : 0);
const round = (n) => Math.round(n * 100) / 100;

/** Normalise the API's deployments (newest first). Pure. */
export function normaliseDeployments(list) {
  return (list || []).map((d) => ({
    id: d.id, created_on: d.created_on, source: d.source || null, strategy: d.strategy || null,
    author: d.author_email || null,
    message: (d.annotations && d.annotations['workers/message']) || null,
    triggered_by: (d.annotations && d.annotations['workers/triggered_by']) || null,
    versions: (d.versions || []).map((v) => ({ version_id: v.version_id, percentage: Number(v.percentage) })),
  })).sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)));
}

/** The version serving (most of) the traffic in one deployment. */
const mainVersion = (d) => (d && d.versions.length ? [...d.versions].sort((a, b) => b.percentage - a.percentage)[0].version_id : null);

/** Current and previous version of a Worker from its deployments (newest first). Pure. */
export function previousVersion(deployments) {
  const current = mainVersion(deployments[0]);
  const prev = deployments.slice(1).map(mainVersion).find((v) => v && v !== current) || null;
  return { current, previous: prev };
}

export async function fetchDeployments(env, worker, token) {
  const body = await cf(env, `/accounts/${ACCOUNT_ID}/workers/scripts/${encodeURIComponent(worker)}/deployments`, token ? { token } : {});
  return normaliseDeployments((body.result && body.result.deployments) || []);
}
async function fetchVersions(env, worker) {
  const body = await cf(env, `/accounts/${ACCOUNT_ID}/workers/scripts/${encodeURIComponent(worker)}/versions`);
  const items = (body.result && (body.result.items || body.result)) || [];
  return (Array.isArray(items) ? items : []).slice(0, 20).map((v) => ({ id: v.id, number: v.number ?? null,
    created_on: (v.metadata && v.metadata.created_on) || null, source: (v.metadata && v.metadata.source) || null, author: (v.metadata && v.metadata.author_email) || null }));
}

export const deploymentsCached = (env, worker, opts = {}) => cached(env.DB, `deployments:${worker}`, () => fetchDeployments(env, worker), { maxAgeMs: 4 * MIN, ...opts });

/** GET /api/deploys: per Worker, recent deployments and versions, its watch history, and whether rollback is possible. */
export async function deploysReport(env, { force = false, nowMs = Date.now() } = {}) {
  const db = env.DB;
  const { results: watches } = await db.prepare('SELECT * FROM deploy_watch ORDER BY deployed_at DESC LIMIT 100').all();
  const workers = await Promise.all(WORKERS.map(async (w) => {
    const out = { worker: w.worker, label: w.label, deployments: [], versions: [], error: null, fetched_at: null,
      watches: watches.filter((x) => x.worker === w.worker).slice(0, 10).map((x) => ({ ...x, baseline: JSON.parse(x.baseline || 'null'), after: JSON.parse(x.after || 'null') })) };
    if (!env.CF_API_TOKEN) { out.error = 'CF_API_TOKEN is not set.'; return out; }
    try {
      const [d, v] = await Promise.all([deploymentsCached(env, w.worker, { force, nowMs }),
        cached(db, `versions:${w.worker}`, () => fetchVersions(env, w.worker), { force, nowMs }).catch(() => ({ value: [] }))]);
      out.deployments = d.value.slice(0, 10);
      out.versions = v.value;
      out.fetched_at = d.fetched_at;
      if (d.stale) out.error = `Showing an older answer: ${d.error}`;
      const pv = previousVersion(d.value);
      out.current_version = pv.current;
      out.previous_version = pv.previous;
    } catch (e) { out.error = e.message; }
    return out;
  }));
  return { workers, rollback_ready: !!env.CF_DEPLOY_TOKEN, watch: DEPLOY_WATCH };
}

// --------------------------------------------------------------------------------------------- deploy watch
/**
 * Is a deployment a regression? Pure.
 * @param baseline { requests, errors, failing: [check ids] } in the hour before
 * @param after    { requests, errors, failing: [check ids] } since the deploy
 */
export function deployVerdict(baseline, after, cfg = DEPLOY_WATCH) {
  const reasons = [];
  const before = new Set(baseline.failing || []);
  const newFailing = (after.failing || []).filter((c) => !before.has(c));
  if (newFailing.length) reasons.push(`site checks started failing: ${newFailing.join(', ')}`);
  const b = rate(baseline); const a = rate(after);
  if (after.requests >= cfg.minRequests && a > Math.max(cfg.floorPct, 2 * b + 1)) reasons.push(`error rate went from ${round(b)} % to ${round(a)} % (${after.errors} of ${after.requests} requests)`);
  return { regression: reasons.length > 0, reasons, before_pct: round(b), after_pct: round(a), new_failing: newFailing };
}

async function failingGates(db, gates, sinceIso = null) {
  if (!gates.length) return [];
  const marks = gates.map(() => '?').join(',');
  const { results } = await db.prepare(`SELECT check_id, since FROM check_state WHERE status = 'fail' AND check_id IN (${marks})`).bind(...gates).all();
  const failing = new Set(results.filter((r) => !sinceIso || r.since >= sinceIso).map((r) => r.check_id));
  if (sinceIso) {
    const { results: inc } = await db.prepare(`SELECT DISTINCT check_id FROM incidents WHERE opened_at >= ? AND check_id IN (${marks})`).bind(sinceIso, ...gates).all();
    for (const r of inc) failing.add(r.check_id);
  }
  return [...failing].sort();
}

/** The 5-minute deploy watch. listFn(env, worker, nowMs) → deployments (newest first); injectable for tests. */
export async function watchDeploys(env, { nowMs = Date.now(), settings, listFn } = {}) {
  const db = env.DB;
  const out = { new: 0, watching: 0, ok: 0, regression: 0, skipped: null };
  if (!env.CF_API_TOKEN && !listFn) { out.skipped = 'CF_API_TOKEN is not set.'; return out; }
  listFn = listFn || (async (e, worker) => (await deploymentsCached(e, worker, { nowMs })).value);
  settings = settings || await getSettings(db);
  const now = new Date(nowMs).toISOString();
  for (const w of WORKERS) {
    let deployments;
    try { deployments = await listFn(env, w.worker, nowMs); } catch (e) { console.error('deploy watch: list failed', w.worker, e.message); continue; }
    const latest = deployments[0];
    if (!latest || !latest.id) continue;
    if (await db.prepare('SELECT id FROM deploy_watch WHERE deployment_id = ?').bind(latest.id).first()) continue;
    const seenBefore = await db.prepare('SELECT id FROM deploy_watch WHERE worker = ? LIMIT 1').bind(w.worker).first();
    const deployedMs = Date.parse(latest.created_on) || nowMs;
    const fresh = nowMs - deployedMs <= DEPLOY_WATCH.maxNewDeployAgeMinutes * MIN;
    let status = 'baseline';
    let baseline = null;
    if (seenBefore && fresh) {
      const deployedIso = new Date(deployedMs).toISOString();
      const t = (await errorTotals(db, new Date(deployedMs - DEPLOY_WATCH.baselineMinutes * MIN).toISOString(), deployedIso)).get(w.worker) || { requests: 0, errors: 0 };
      const failingNow = await failingGates(db, w.gates);
      baseline = { ...t, failing: failingNow };
      status = 'watching';
      out.new++;
    }
    await db.prepare(`INSERT OR IGNORE INTO deploy_watch (worker, deployment_id, version_id, deployed_at, source, author, status, baseline, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(w.worker, latest.id, mainVersion(latest), new Date(deployedMs).toISOString(), latest.source, latest.author, status,
      baseline ? JSON.stringify(baseline) : null, now).run();
  }

  const { results: watching } = await db.prepare("SELECT * FROM deploy_watch WHERE status = 'watching' ORDER BY deployed_at").all();
  for (const row of watching) {
    const deployedMs = Date.parse(row.deployed_at);
    if (nowMs - deployedMs < DEPLOY_WATCH.watchMinutes * MIN) { out.watching++; continue; }
    const w = workerOf(row.worker) || { gates: [] };
    const t = (await errorTotals(db, row.deployed_at)).get(row.worker) || { requests: 0, errors: 0 };
    const after = { ...t, failing: await failingGates(db, w.gates, row.deployed_at) };
    const baseline = JSON.parse(row.baseline || '{"requests":0,"errors":0,"failing":[]}');
    const v = deployVerdict(baseline, after);
    const detail = v.regression ? `Worse after the deploy: ${v.reasons.join('; ')}.` : `Fine: error rate ${v.before_pct} % before, ${v.after_pct} % after; no site check started failing.`;
    await db.prepare('UPDATE deploy_watch SET status = ?, after = ?, detail = ?, finished_at = ? WHERE id = ?')
      .bind(v.regression ? 'regression' : 'ok', JSON.stringify(after), detail, now, row.id).run();
    if (!v.regression) { out.ok++; continue; }
    out.regression++;
    const title = `${row.worker}: the deploy at ${row.deployed_at.slice(0, 16).replace('T', ' ')} UTC made things worse`;
    const link = `${DASHBOARD_URL}/#deploys/${row.worker}`;
    const text = `${detail}\nDeployment ${row.deployment_id}${row.source ? ` (${row.source})` : ''}${row.author ? ` by ${row.author}` : ''}.\nOwners can roll back to the previous version in one click: ${link}`;
    await dispatch(env, { type: 'deploy_regression', kind: 'event', severity: 'high', title, site: row.worker, detail: text,
      done: 'Nothing is rolled back automatically. An issue was opened in Ops.', link }, { settings, nowMs }).catch((e) => console.error('deploy_regression failed', e && e.stack));
    await issueForDeploy(env, { worker: row.worker, deployment_id: row.deployment_id, title, detail: text }, { settings, nowMs }).catch((e) => console.error('deploy issue failed', e && e.stack));
  }
  return out;
}

// --------------------------------------------------------------------------------------------- rollback
export const ROLLBACK_HELP = 'Rollback needs the CF_DEPLOY_TOKEN secret on yondr-ops: a Cloudflare user API token for account 3fac6c19…8085 with "Account · Workers Scripts: Edit" (README "Secrets"). Until it is set, roll back in the Cloudflare dashboard (Workers → the Worker → Deployments → Rollback).';

/** POST /api/deploys/<worker>/rollback (owners only; checked in src/api.js). */
export async function rollback(env, worker, actor, { nowMs = Date.now(), expectVersion = null } = {}) {
  const w = workerOf(worker);
  if (!w) return { status: 404, body: { error: 'Unknown Worker.' } };
  if (!env.CF_DEPLOY_TOKEN) return { status: 412, body: { error: ROLLBACK_HELP, needs: 'CF_DEPLOY_TOKEN' } };
  const db = env.DB;
  let deployments;
  try { deployments = await fetchDeployments(env, worker, env.CF_DEPLOY_TOKEN); }
  catch (e) { return { status: 502, body: { error: `Couldn't read the deployments: ${e.message}` } }; }
  const { current, previous } = previousVersion(deployments);
  if (!previous) return { status: 409, body: { error: 'There is no earlier version to roll back to.' } };
  if (expectVersion && expectVersion !== previous) return { status: 409, body: { error: 'The deployments changed since the page loaded. Reload and try again.' } };
  try {
    await cf(env, `/accounts/${ACCOUNT_ID}/workers/scripts/${encodeURIComponent(worker)}/deployments`, {
      method: 'POST', token: env.CF_DEPLOY_TOKEN,
      body: { strategy: 'percentage', versions: [{ version_id: previous, percentage: 100 }], annotations: { 'workers/message': 'Rollback from Yondr Ops (previous version)' } },
    });
  } catch (e) {
    await db.prepare('INSERT INTO audit (actor, action, detail, created_at) VALUES (?, ?, ?, ?)').bind(actor, 'deploy.rollback_failed', JSON.stringify({ worker, from: current, to: previous, error: e.message }), new Date(nowMs).toISOString()).run();
    return { status: 502, body: { error: `Cloudflare refused the rollback: ${e.message}` } };
  }
  const now = new Date(nowMs).toISOString();
  await db.prepare('INSERT INTO audit (actor, action, detail, created_at) VALUES (?, ?, ?, ?)').bind(actor, 'deploy.rollback', JSON.stringify({ worker, from: current, to: previous }), now).run();
  await db.prepare('DELETE FROM cf_cache WHERE key = ?').bind(`deployments:${worker}`).run();
  await dispatch(env, {
    type: 'rollback_done', kind: 'event', severity: 'warning', title: `${worker} was rolled back to its previous version`, site: worker,
    detail: `${actor} rolled ${worker} back from version ${String(current).slice(0, 8)} to ${previous.slice(0, 8)} in Yondr Ops.\nThe next normal deploy from main replaces this rollback. Database migrations are not rolled back.`,
    done: 'The previous version now serves 100 % of traffic.', link: `${DASHBOARD_URL}/#deploys/${worker}`,
  }, { settings: await getSettings(db), nowMs }).catch((e) => console.error('rollback_done failed', e && e.stack));
  return { status: 200, body: { ok: true, worker, from: current, to: previous } };
}
