// Digests: the daily summary (first monitoring run after daily_digest_hour_utc) and the weekly backup summary
// (Mondays, after the nightly backups).
import { dispatch } from './alerts.js';
import { digestLine, loadBudget } from './budget.js';
import { DASHBOARD_URL } from './checks.js';
import { getInternal, setInternal } from './settings.js';

export async function maybeDailyDigest(env, settings, nowMs) {
  const db = env.DB;
  const now = new Date(nowMs);
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < settings.daily_digest_hour_utc) return false;
  if ((await getInternal(db, 'last_daily_digest')) === today) return false;
  await setInternal(db, 'last_daily_digest', today);

  const since = new Date(nowMs - 86_400_000).toISOString();
  const [{ results: failing }, { results: incidents }, { results: backups }, alerts, { results: fixes }] = await Promise.all([
    db.prepare("SELECT site, title, severity, since FROM check_state WHERE status = 'fail' ORDER BY since").all(),
    db.prepare('SELECT title, severity, opened_at, resolved_at FROM incidents WHERE opened_at >= ? ORDER BY opened_at').bind(since).all(),
    db.prepare('SELECT db, status FROM backups WHERE created_at >= ?').bind(since).all(),
    db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE created_at >= ? AND kind != 'digest'").bind(since).first(),
    db.prepare('SELECT title, status FROM autofixes WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT 10').bind(since).all(),
  ]);
  const lines = [];
  lines.push(failing.length ? `Open problems (${failing.length}):` : 'Open problems: none. Every check passes.');
  for (const f of failing) lines.push(`• [${f.severity}] ${f.title} (since ${f.since.slice(0, 16).replace('T', ' ')} UTC)`);
  lines.push(`Incidents in the last 24 hours: ${incidents.length}${incidents.length ? ` (${incidents.filter((i) => i.resolved_at).length} resolved)` : ''}.`);
  for (const i of incidents.slice(0, 10)) lines.push(`• ${i.title}${i.resolved_at ? ' (resolved)' : ''}`);
  const okB = backups.filter((b) => b.status === 'ok').length;
  lines.push(`Backups: ${okB} of ${backups.length} succeeded${backups.length - okB ? `, ${backups.length - okB} failed` : ''}.`);
  lines.push(`Alerts sent: ${alerts.n}.`);
  if (fixes.length) { lines.push(`Auto-fixes updated: ${fixes.length}.`); for (const f of fixes) lines.push(`• ${f.title} (${f.status})`); }
  const budget = await loadBudget(db, settings, nowMs).catch(() => null);
  if (budget) lines.push(digestLine(budget));
  await dispatch(env, {
    type: 'daily_digest', kind: 'digest', severity: 'info',
    title: failing.length ? `Daily digest: ${failing.length} open problem${failing.length > 1 ? 's' : ''}` : 'Daily digest: all clear',
    detail: lines.join('\n'), done: 'This is a summary; nothing needs doing unless a problem is listed.', link: DASHBOARD_URL,
  }, { settings, nowMs });
  return true;
}

export async function weeklyBackupDigest(env, settings, nowMs) {
  const db = env.DB;
  const since = new Date(nowMs - 7 * 86_400_000).toISOString();
  const { results } = await db.prepare(`SELECT db, COUNT(*) AS runs, SUM(status = 'ok') AS ok, MAX(bytes) AS bytes
    FROM backups WHERE created_at >= ? GROUP BY db ORDER BY db`).bind(since).all();
  const lines = results.map((r) => `• ${r.db}: ${r.ok} of ${r.runs} nights OK, latest size up to ${Math.round((r.bytes || 0) / 1024)} KiB`);
  const allOk = results.every((r) => r.ok === r.runs);
  await dispatch(env, {
    type: 'backup_ok_weekly_digest', kind: 'digest', severity: 'info',
    title: allOk ? 'Weekly backups: all good' : 'Weekly backups: some nights failed',
    detail: lines.join('\n') || 'No backups ran last week.', done: 'Backups run every night at 03:17 UTC and are kept in R2 (yondr-ops-backups).',
    link: `${DASHBOARD_URL}/#backups`,
  }, { settings, nowMs });
}
