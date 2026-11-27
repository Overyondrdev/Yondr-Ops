// Alerts: event types, who gets what (routing), the message people read, delivery (email / Slack) and the log.
import { DASHBOARD_URL } from './checks.js';
import { sendEmail } from './email.js';
import { readOnly } from './readonly.js';
import { emailTransport } from './settings.js';

export const SEVERITIES = ['info', 'warning', 'high', 'critical'];
export const RANK = { info: 0, warning: 1, high: 2, critical: 3 };

// ownerForced: owners always get these by email; they can't switch them off (and quiet hours don't apply).
// ignoreQuiet: nobody's quiet hours hold these back (the auto-fix spending alerts, like critical ones).
export const EVENTS = {
  site_down: { label: 'Site down', severity: 'critical', ownerForced: true, help: 'A site or the sign-in page is not answering, or answers with an error.' },
  site_exposed: { label: 'Site exposed', severity: 'critical', ownerForced: true, help: 'A private site showed its content to someone who is not signed in.' },
  deploy_failed: { label: 'Deploy failed', severity: 'high', help: 'The latest Workers Builds deploy of a site failed, so the latest change is not live.' },
  config_drift: { label: 'Configuration changed', severity: 'warning', help: 'Something in Cloudflare is not as expected: a new or missing Worker/database/bucket, a host missing from the sign-in Bypass app, overyondr.com changed.' },
  usage_limit: { label: 'Usage near the free limit', severity: 'warning', help: 'Daily usage of Workers, D1 or Workers AI passed 70 % (warning) or 90 % (high) of the free plan.' },
  backup_failed: { label: 'Backup failed', severity: 'high', help: 'A nightly database backup did not complete.' },
  backup_ok_weekly_digest: { label: 'Weekly backup summary', severity: 'info', help: 'Every Monday: which backups ran last week.' },
  autofix_started: { label: 'Auto-fix started', severity: 'info', help: 'An objective bug was handed to the auto-fix engine (a GitHub issue was opened for it).' },
  autofix_merged: { label: 'Auto-fix merged', severity: 'info', help: 'An automatic fix is live and verified: its deploy succeeded and the site stayed fine for 15 minutes.' },
  autofix_failed: { label: 'Auto-fix failed', severity: 'high', help: 'An automatic fix failed (checks failed or the engine gave up).' },
  autofix_reverted: { label: 'Auto-fix reverted', severity: 'warning', help: 'An automatic fix is being undone: by an admin, or automatically because its deploy or the site failed.' },
  autofix_budget_warning: { label: 'Auto-fix spending warning', severity: 'warning', ownerForced: true, ignoreQuiet: true, help: 'This month\'s auto-fix spend on the Claude API reached 50 % or 70 % of the budget (once each a month).' },
  autofix_budget_projection: { label: 'Auto-fix spending forecast', severity: 'warning', ownerForced: true, ignoreQuiet: true, help: 'At the current pace, auto-fix will spend more than this month\'s budget (at most once a day).' },
  autofix_budget_paused: { label: 'Auto-fix paused (budget)', severity: 'high', ownerForced: true, ignoreQuiet: true, help: 'Auto-fix spend reached the pause level (90 % of the budget): nothing new starts until an owner approves more spend.' },
  autofix_budget_approved: { label: 'Auto-fix spend approved', severity: 'info', ownerForced: true, ignoreQuiet: true, help: 'An owner approved more auto-fix spend for this month.' },
  feedback_critical: { label: 'Critical feedback', severity: 'high', help: 'Someone sent feedback marked critical.' },
  daily_digest: { label: 'Daily digest', severity: 'info', help: 'Every morning: open problems, incidents and backups of the last day.' },
  // v2: catch problems before people notice (README "Errors", "Deploys", "Restore drill", "Keys", "Issues").
  error_rate: { label: 'Server errors', severity: 'warning', help: 'A Worker answered more than 2 % of requests with an error in the last 15 minutes (high above 10 %).' },
  client_errors_spike: { label: 'Browser errors spike', severity: 'warning', help: 'The feedback widget saw more JavaScript errors on one project than usual (over 20 in 15 minutes by default).' },
  deploy_regression: { label: 'Deploy made things worse', severity: 'high', help: 'Within 15 minutes of a new deployment, errors went up or a site check started failing. Owners can roll back in one click (Deploys).' },
  rollback_done: { label: 'Rollback done', severity: 'warning', ownerForced: true, help: 'An owner rolled a Worker back to its previous version.' },
  restore_drill_failed: { label: 'Restore drill failed', severity: 'high', ownerForced: true, help: 'The monthly test restore of a backup did not give back the same tables and rows.' },
  key_expiring: { label: 'Key expiring', severity: 'warning', ownerForced: true, help: 'A key or token in the key calendar expires in 30 or 14 days, or today.' },
  access_seats_used: { label: 'Access seats in use', severity: 'warning', help: 'Someone signed in through Cloudflare Access (costs a seat) instead of the Yondr sign-in.' },
  issue_assigned: { label: 'Issue assigned to you', severity: 'info', personal: true, help: 'An issue in Ops was assigned to you. Always sent to the assignee; nobody else gets it.' },
  issue_critical: { label: 'New critical issue', severity: 'critical', ownerForced: true, help: 'A critical issue was opened in Ops (by a person or automatically).' },
};
export const EVENT_TYPES = Object.keys(EVENTS);
// What a new person is subscribed to by email unless the admin chooses otherwise.
export const DEFAULT_EVENTS = ['site_down', 'site_exposed', 'deploy_failed', 'backup_failed', 'autofix_failed', 'autofix_reverted', 'feedback_critical', 'daily_digest',
  'deploy_regression', 'restore_drill_failed'];
export const MIN_SEVERITY = { all: 'Everything', high: 'High and critical', critical: 'Critical only' };
export const WEBHOOK_NAME = /^SLACK_WEBHOOK_[A-Z0-9_]{1,40}$/;

export function passesSeverity(minSeverity, severity) {
  if (minSeverity === 'critical') return severity === 'critical';
  if (minSeverity === 'high') return RANK[severity] >= RANK.high;
  return true;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function validQuietTime(t) { return t == null || t === '' || HHMM.test(t); }
export function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}

/** Is it quiet time for this person right now? Start/end are HH:MM in their time zone; may wrap past midnight. */
export function inQuietHours(nowMs, start, end, timeZone = 'UTC') {
  if (!start || !end || start === end) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowMs));
  const hh = parts.find((p) => p.type === 'hour').value;
  const mm = parts.find((p) => p.type === 'minute').value;
  const now = `${hh}:${mm}`;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * Who receives one alert. Pure.
 * @param alert { type, severity }
 * @param ctx   { subscribers, subscriptions, owners: Set<email>, nowMs }
 * @returns { email: string[], slack: string[], skipped: { who, reason }[] }
 */
export function route(alert, { subscribers, subscriptions, owners = new Set(), nowMs = Date.now() }) {
  const email = new Set();
  const slack = new Set();
  const skipped = [];
  const byId = new Map(subscribers.map((s) => [s.id, s]));
  const critical = alert.severity === 'critical';
  for (const sub of subscriptions) {
    if (sub.event_type !== alert.type) continue;
    if (EVENTS[alert.type] && EVENTS[alert.type].personal) continue; // only ever to the person concerned (dispatch with recipients)
    const s = byId.get(sub.subscriber_id);
    if (!s) continue;
    const who = sub.channel === 'slack' ? sub.webhook : s.email;
    if (!s.active) { skipped.push({ who, reason: 'paused' }); continue; }
    if (!passesSeverity(s.min_severity, alert.severity)) { skipped.push({ who, reason: 'below their severity filter' }); continue; }
    if (!critical && !(EVENTS[alert.type] && EVENTS[alert.type].ignoreQuiet) && inQuietHours(nowMs, s.quiet_start, s.quiet_end, s.timezone || 'UTC')) { skipped.push({ who, reason: 'quiet hours' }); continue; }
    if (sub.channel === 'email') email.add(s.email);
    else if (sub.channel === 'slack' && WEBHOOK_NAME.test(sub.webhook)) slack.add(sub.webhook);
  }
  // Owners always hear about sites that are down or exposed, and about auto-fix spending, whatever their settings say.
  if (EVENTS[alert.type] && EVENTS[alert.type].ownerForced) for (const o of owners) email.add(o);
  return { email: [...email].sort(), slack: [...slack].sort(), skipped };
}

// ------------------------------------------------------------------------------------------------ message content
const SEV_LABEL = { info: 'Info', warning: 'Warning', high: 'High', critical: 'Critical' };
const KIND_PREFIX = { resolved: 'Resolved: ', reminder: 'Still broken: ', changed: 'Changed: ', test: 'Test: ' };

function fmtTime(iso) {
  if (!iso) return null;
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
function fmtDuration(fromIso, toMs) {
  const m = Math.max(0, Math.round((toMs - Date.parse(fromIso)) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Plain, readable alert for someone who isn't a developer.
 * @param a { type, kind, severity, title, site, detail, since, done, link, nowMs }
 */
export function renderAlert(a) {
  const nowMs = a.nowMs || Date.now();
  const kind = a.kind || 'event';
  const label = EVENTS[a.type] ? EVENTS[a.type].label : a.type;
  const subject = `${KIND_PREFIX[kind] || ''}${a.title}${kind === 'resolved' ? '' : ` [${SEV_LABEL[a.severity] || a.severity}]`}`;
  const lines = [];
  if (kind === 'resolved') lines.push(`Fixed: ${a.title}.`);
  else lines.push(`What's wrong: ${a.title}.`);
  if (a.site) lines.push(`Which site: ${a.site}`);
  if (a.since) lines.push(kind === 'resolved' ? `It was broken for ${fmtDuration(a.since, nowMs)} (since ${fmtTime(a.since)}).` : `Since: ${fmtTime(a.since)} (${fmtDuration(a.since, nowMs)} ago)`);
  if (a.detail) lines.push('', a.detail);
  lines.push('', `What's been done automatically: ${a.done || (kind === 'resolved' ? 'Nothing was needed; the check passes again.' : 'Nothing yet. This alert was sent and the problem is logged as an incident; checks keep running every 5 minutes.')}`);
  if (kind === 'reminder') lines.push('You get a reminder every hour while a critical problem lasts.');
  const link = a.link || `${DASHBOARD_URL}/#incidents`;
  lines.push('', `Details and history: ${link}`);
  lines.push('', `Type: ${label} · Severity: ${SEV_LABEL[a.severity] || a.severity}`, 'You get this because you are on the Yondr Ops alert list. Change what you receive in the Alerts tab of the ops dashboard.');
  const text = lines.join('\n');
  const html = `<div style="font:15px/1.5 Arial,sans-serif;color:#1e1e1e;max-width:560px">` +
    `<p style="margin:0 0 12px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#4f6b35">Yondr Ops · ${esc(label)}</p>` +
    lines.filter((l) => l !== '').map((l) => l.startsWith('Details and history: ')
      ? `<p><a href="${esc(link)}" style="display:inline-block;background:#1c300b;color:#daff6b;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:bold">Open the ops dashboard</a></p>`
      : `<p style="margin:0 0 10px">${esc(l)}</p>`).join('') + `</div>`;
  const icon = kind === 'resolved' ? ':white_check_mark:' : a.severity === 'critical' ? ':rotating_light:' : a.severity === 'high' ? ':warning:' : ':information_source:';
  const slack = `${icon} *${subject}*\n${lines.slice(1).filter((l) => l && !l.startsWith('You get this') && !l.startsWith('Details and history')).join('\n')}\n<${link}|Open the ops dashboard>`;
  return { subject, text, html, slack };
}

// ------------------------------------------------------------------------------------------------ delivery
export async function postSlack(env, webhook, text) {
  if (!WEBHOOK_NAME.test(webhook)) throw new Error(`Invalid webhook name ${webhook}`);
  const url = env[webhook];
  if (!url) throw new Error(`Secret ${webhook} is not set`);
  if (!/^https:\/\/hooks\.slack\.com\//.test(url)) throw new Error(`${webhook} is not a Slack incoming-webhook URL`);
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(`Slack answered ${res.status}`);
}

/** Names of the Slack webhooks configured as secrets (never their URLs). */
export function availableWebhooks(env) {
  return Object.keys(env).filter((k) => WEBHOOK_NAME.test(k)).sort();
}

export async function ownerEmails(env) {
  if (!env.FEEDBACK_DB) return new Set();
  const { results } = await readOnly(env.FEEDBACK_DB).prepare("SELECT email FROM admins WHERE role = 'owner'").all();
  return new Set(results.map((r) => String(r.email).toLowerCase()));
}

async function logAlert(db, row) {
  await db.prepare(`INSERT INTO alerts (event_type, kind, severity, subject, channel, recipients, status, error, incident_id, event_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(row.event_type, row.kind, row.severity, row.subject, row.channel,
    JSON.stringify(row.recipients), row.status, row.error || null, row.incident_id || null, row.event_id || null, new Date().toISOString()).run();
}

/**
 * Route one alert, send it and log every delivery.
 * @param a  as renderAlert, plus incident_id / event_id
 * @param opts { settings, recipients } — recipients overrides routing (used by "send test alert")
 */
export async function dispatch(env, a, { settings, recipients = null, nowMs = Date.now() } = {}) {
  const db = env.DB;
  const msg = renderAlert({ ...a, nowMs });
  let r = recipients;
  if (!r) {
    const [{ results: subscribers }, { results: subscriptions }, owners] = await Promise.all([
      db.prepare('SELECT * FROM subscribers').all(),
      db.prepare('SELECT * FROM subscriptions WHERE event_type = ?').bind(a.type).all(),
      ownerEmails(env).catch(() => new Set()),
    ]);
    r = route({ type: a.type, severity: a.severity }, { subscribers, subscriptions, owners, nowMs });
  }
  const common = { event_type: a.type, kind: a.kind || 'event', severity: a.severity, subject: msg.subject, incident_id: a.incident_id, event_id: a.event_id };
  const out = { email: r.email, slack: r.slack, sent: 0, failed: 0 };
  if (settings && !settings.alerts_enabled && a.kind !== 'test') {
    if (r.email.length) await logAlert(db, { ...common, channel: 'email', recipients: r.email, status: 'skipped', error: 'Alerts are switched off (Settings).' });
    if (r.slack.length) await logAlert(db, { ...common, channel: 'slack', recipients: r.slack, status: 'skipped', error: 'Alerts are switched off (Settings).' });
    return out;
  }
  if (r.email.length) {
    const transport = emailTransport(settings || {}, env);
    const errors = [];
    // One message per person: recipients don't see each other's addresses.
    for (const to of r.email) {
      try { await sendEmail(env, transport, { to, subject: msg.subject, text: msg.text, html: msg.html }); out.sent++; }
      catch (e) { out.failed++; errors.push(`${to}: ${e.message}`); }
    }
    await logAlert(db, { ...common, channel: 'email', recipients: r.email, status: errors.length === r.email.length ? 'failed' : 'sent', error: errors.join('; ') || null });
  }
  for (const hook of r.slack) {
    try { await postSlack(env, hook, msg.slack); out.sent++; await logAlert(db, { ...common, channel: 'slack', recipients: [hook], status: 'sent' }); }
    catch (e) { out.failed++; await logAlert(db, { ...common, channel: 'slack', recipients: [hook], status: 'failed', error: e.message }); }
  }
  return out;
}

/**
 * Send one alert to named people (e.g. the assignee of an issue), whatever their rules say, plus any Slack channel they
 * route this alert type to. Logged like every other alert; the Alerts kill switch still applies.
 */
export async function dispatchTo(env, a, emails, opts = {}) {
  const to = [...new Set((emails || []).map((e) => String(e).toLowerCase()).filter(Boolean))].sort();
  if (!to.length) return { email: [], slack: [], sent: 0, failed: 0 };
  const marks = to.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT DISTINCT s.webhook FROM subscriptions s JOIN subscribers p ON p.id = s.subscriber_id
    WHERE s.event_type = ? AND s.channel = 'slack' AND p.active = 1 AND p.email IN (${marks})`).bind(a.type, ...to).all();
  const slack = results.map((r) => r.webhook).filter((w) => WEBHOOK_NAME.test(w)).sort();
  return dispatch(env, a, { ...opts, recipients: { email: to, slack, skipped: [] } });
}
