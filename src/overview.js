// GET /api/overview: the admin home page in one call. Everything here is read from ops' own tables except:
//   - setup gaps: secret NAMES of yondr-feedback and yondr-christmas-cards (Cloudflare API, cached 5 minutes);
//     ops' own secrets are read from its env (presence only)
//   - the latest deployment per Worker (Cloudflare API, cached; src/deploys.js)
//   - feedback numbers (FEEDBACK_DB, read-only)
// Each part fails on its own: one broken source shows as an error on its card, the rest still loads.
import { cached } from './cfcache.js';
import { EXPECTED_SECRETS, WORKERS } from './checks.js';
import { workerSecretNames } from './cloudflare.js';
import { deploymentsCached } from './deploys.js';
import { lastDrills } from './drill.js';
import { errorTotals } from './errors.js';
import { issueCounts } from './issues.js';
import { keysReport } from './keys.js';
import { loadBudget } from './budget.js';
import { readOnly } from './readonly.js';
import { nextReviewDate } from './review.js';
import { getSettings } from './settings.js';

const DAY = 86_400_000;
const part = async (fn) => { try { return await fn(); } catch (e) { return { error: String(e && e.message) }; } };

/** Missing secrets per Worker. Pure. */
export function secretGaps(expected, present) {
  const out = [];
  for (const [worker, names] of Object.entries(expected)) {
    const have = present[worker];
    if (have === undefined) { out.push({ worker, unknown: true, missing: [] }); continue; }
    const missing = names.filter((n) => !have.includes(n));
    out.push({ worker, missing, unknown: false });
  }
  return out;
}

export async function overview(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const settings = await getSettings(db);
  const since24 = new Date(nowMs - DAY).toISOString();
  const weekAgo = new Date(nowMs - 7 * DAY).toISOString();

  const [states, errors24, incidents, issues, autofix, backups, alerts, setup, feedback, keys, clientErrors] = await Promise.all([
    db.prepare('SELECT check_id, status, severity, title, since FROM check_state').all().then((r) => new Map(r.results.map((s) => [s.check_id, s]))),
    errorTotals(db, since24),
    part(async () => {
      const { results } = await db.prepare('SELECT id, title, site, severity, opened_at, issue_id FROM incidents WHERE resolved_at IS NULL ORDER BY opened_at DESC LIMIT 10').all();
      return { open: results.length, list: results };
    }),
    part(() => issueCounts(db)),
    part(async () => {
      const b = await loadBudget(db, settings, nowMs);
      const { results } = await db.prepare("SELECT status, COUNT(*) AS n FROM autofixes WHERE status NOT IN ('rejected') AND updated_at >= ? GROUP BY status").bind(new Date(nowMs - 30 * DAY).toISOString()).all();
      return { enabled: settings.autofix_enabled, paused: b.paused, spent: b.spent, forecast: b.forecast, budget: b.effective, by_status: Object.fromEntries(results.map((r) => [r.status, r.n])) };
    }),
    part(async () => {
      const { results } = await db.prepare(`SELECT db, MAX(CASE WHEN status = 'ok' THEN created_at END) AS last_ok, MAX(created_at) AS last_run,
        (SELECT status FROM backups b2 WHERE b2.db = backups.db ORDER BY id DESC LIMIT 1) AS last_status FROM backups GROUP BY db ORDER BY db`).all();
      return { databases: results, drills: await lastDrills(db) };
    }),
    part(async () => {
      const r = await db.prepare("SELECT COUNT(*) AS n, SUM(status = 'failed') AS failed FROM alerts WHERE created_at >= ? AND kind != 'test'").bind(since24).first();
      return { sent_24h: r.n || 0, failed_24h: r.failed || 0 };
    }),
    part(() => setupGaps(env, nowMs)),
    part(() => feedbackStats(env, weekAgo)),
    part(async () => {
      const all = await keysReport(db, nowMs);
      return { soon: all.filter((k) => k.days_left !== null && k.days_left <= 30), no_date: all.filter((k) => !k.expires_on).length, total: all.length };
    }),
    part(async () => (await db.prepare('SELECT project, SUM(count) AS n FROM client_errors WHERE received_at >= ? GROUP BY project ORDER BY n DESC').bind(since24).all()).results),
  ]);

  const siteList = await Promise.all(WORKERS.map(async (w) => {
    const gates = w.gates.map((g) => states.get(g)).filter(Boolean);
    const failing = gates.filter((g) => g.status === 'fail');
    const status = !gates.length ? (states.get(`errors:${w.worker}`) || {}).status || 'unknown'
      : failing.length ? 'fail' : gates.every((g) => g.status === 'ok') ? 'ok' : 'unknown';
    const err = errors24.get(w.worker) || { requests: 0, errors: 0 };
    const build = states.get(`build:${w.worker}`);
    let deploy = null;
    if (env.CF_API_TOKEN) {
      const d = await deploymentsCached(env, w.worker, { nowMs }).catch(() => null);
      if (d && d.value[0]) deploy = { at: d.value[0].created_on, source: d.value[0].source };
    }
    const watch = await db.prepare('SELECT status, deployed_at FROM deploy_watch WHERE worker = ? ORDER BY deployed_at DESC LIMIT 1').bind(w.worker).first();
    return {
      worker: w.worker, label: w.label, status, problems: failing.map((f) => f.title).filter(Boolean),
      requests_24h: err.requests, errors_24h: err.errors, error_rate_24h: err.requests ? Math.round((err.errors / err.requests) * 10000) / 100 : null,
      last_deploy: deploy ? deploy.at : watch ? watch.deployed_at : null,
      deploy_result: build && build.status === 'fail' ? 'failed' : watch ? watch.status : build && build.status === 'ok' ? 'ok' : null,
    };
  }));
  const seats = states.get('cf:access-seats');
  return {
    sites: siteList, incidents, issues, autofix, backups, alerts, setup, feedback, keys, client_errors: clientErrors,
    access: { next_review: nextReviewDate(nowMs), seats: seats ? { status: seats.status, title: seats.title } : null },
    cloudflare_token: !!env.CF_API_TOKEN, generated_at: new Date(nowMs).toISOString(),
  };
}

async function setupGaps(env, nowMs) {
  const present = { 'yondr-ops': Object.keys(EXPECTED_SECRETS['yondr-ops'].reduce((o, n) => (env[n] ? { ...o, [n]: 1 } : o), {})) };
  const errors = {};
  if (env.CF_API_TOKEN) {
    for (const worker of Object.keys(EXPECTED_SECRETS)) {
      if (worker === 'yondr-ops') continue;
      try { present[worker] = (await cached(env.DB, `secrets:${worker}`, () => workerSecretNames(env, worker), { nowMs })).value; }
      catch (e) { errors[worker] = e.message; }
    }
  }
  const drill = env.DRILL_DB ? [] : ['DRILL_DB binding (restore drill)'];
  const feedbackBinding = env.FEEDBACK ? [] : ['FEEDBACK service binding (role changes go over the public host)'];
  return { secrets: secretGaps(EXPECTED_SECRETS, present), errors, other: [...drill, ...feedbackBinding], cloudflare_token: !!env.CF_API_TOKEN };
}

async function feedbackStats(env, weekAgo) {
  const fb = readOnly(env.FEEDBACK_DB);
  if (!fb) return null;
  const { results } = await fb.prepare('SELECT COALESCE(project, site) AS project, COUNT(*) AS n FROM feedback WHERE created_at >= ? GROUP BY COALESCE(project, site) ORDER BY n DESC').bind(weekAgo).all();
  const crit = await fb.prepare("SELECT COUNT(*) AS n FROM feedback WHERE priority = 'critical' AND status NOT IN ('done', 'wont_do')").first();
  return { new_this_week: results, new_total: results.reduce((s, r) => s + r.n, 0), critical_open: crit.n };
}
