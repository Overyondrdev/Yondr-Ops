// The staff status page (/status, any signed-in @overyondr.com person) and the uptime history behind it.
// check_history keeps one row per check per UTC day (ok / fail run counts), written by every monitoring run and kept
// HISTORY_DAYS days. The public view shows only: each site, up or down, uptime over 7 and 30 days, current incidents
// in plain words and when it was last checked. No check details, hosts, errors or people.
import { GATE, PUBLIC_SITE } from './checks.js';

export const HISTORY_DAYS = 35;
const DAY = 86_400_000;

/** Record one monitoring run's results (ok true/false only; "couldn't check" isn't counted). */
export async function recordHistory(db, results, nowMs = Date.now()) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const stmts = results.filter((r) => r.ok === true || r.ok === false).map((r) => db.prepare(
    `INSERT INTO check_history (check_id, day, ok, fail) VALUES (?, ?, ?, ?)
     ON CONFLICT(check_id, day) DO UPDATE SET ok = ok + excluded.ok, fail = fail + excluded.fail`).bind(r.id, day, r.ok ? 1 : 0, r.ok ? 0 : 1));
  if (stmts.length) await db.batch(stmts);
}

/** Retention for check_history (own bookkeeping data). */
export async function pruneHistory(db, nowMs = Date.now()) {
  const cutoff = new Date(nowMs - HISTORY_DAYS * DAY).toISOString().slice(0, 10);
  await db.prepare('DELETE FROM check_history WHERE day < ?').bind(cutoff).run();
}

/** Uptime % over the last `days` days (today included) from history rows. null = no data. Pure. */
export function uptime(rows, days, nowMs = Date.now()) {
  const from = new Date(nowMs - (days - 1) * DAY).toISOString().slice(0, 10);
  let ok = 0; let fail = 0;
  for (const r of rows) if (r.day >= from) { ok += r.ok; fail += r.fail; }
  return ok + fail ? Math.round((ok / (ok + fail)) * 10000) / 100 : null;
}

// Plain words for staff (no technical detail).
const PLAIN = {
  site_down: (s) => `${s} is not working right now. The team has been alerted.`,
  site_exposed: (s) => `${s} has a sign-in problem. The team has been alerted.`,
};

/** The sites staff care about: every signed-out gate check plus overyondr.com. */
export function publicChecks() {
  return [...GATE.map((g) => ({ id: g.id, site: g.site })), { id: PUBLIC_SITE.id, site: PUBLIC_SITE.site }];
}

/** GET /api/status/public. */
export async function publicStatus(db, nowMs = Date.now()) {
  const checks = publicChecks();
  const ids = checks.map((c) => c.id);
  const marks = ids.map(() => '?').join(',');
  const since = new Date(nowMs - 29 * DAY).toISOString().slice(0, 10);
  const [{ results: states }, { results: hist }, last, { results: incidents }] = await Promise.all([
    db.prepare(`SELECT check_id, status, event, since, last_run FROM check_state WHERE check_id IN (${marks})`).bind(...ids).all(),
    db.prepare(`SELECT check_id, day, ok, fail FROM check_history WHERE day >= ? AND check_id IN (${marks})`).bind(since, ...ids).all(),
    db.prepare("SELECT finished_at, started_at FROM runs WHERE kind = 'monitor' ORDER BY id DESC LIMIT 1").first(),
    db.prepare(`SELECT check_id, site, event, opened_at, resolved_at FROM incidents WHERE check_id IN (${marks}) AND (resolved_at IS NULL OR resolved_at >= ?)
      ORDER BY opened_at DESC LIMIT 20`).bind(...ids, new Date(nowMs - 7 * DAY).toISOString()).all(),
  ]);
  const st = new Map(states.map((s) => [s.check_id, s]));
  const siteOf = new Map(checks.map((c) => [c.id, c.site]));
  const sites = checks.map((c) => {
    const s = st.get(c.id);
    const rows = hist.filter((h) => h.check_id === c.id);
    const state = !s || s.status === 'unknown' ? 'unknown' : s.status === 'ok' ? 'up' : s.event === 'site_down' || s.event === 'site_exposed' ? 'down' : 'degraded';
    return { id: c.id, site: c.site, state, since: s ? s.since : null, uptime_7d: uptime(rows, 7, nowMs), uptime_30d: uptime(rows, 30, nowMs) };
  });
  const plain = (i) => {
    const name = siteOf.get(i.check_id) || i.site || 'A site';
    if (i.resolved_at) return `${name} had a problem, now fixed.`;
    return (PLAIN[i.event] || ((x) => `${x} is not quite right. The team is looking at it.`))(name);
  };
  return {
    sites,
    incidents: incidents.map((i) => ({ site: siteOf.get(i.check_id) || i.site, text: plain(i), open: !i.resolved_at, opened_at: i.opened_at, resolved_at: i.resolved_at })),
    all_up: sites.every((s) => s.state === 'up' || s.state === 'unknown'),
    updated_at: last ? (last.finished_at || last.started_at) : null,
  };
}
