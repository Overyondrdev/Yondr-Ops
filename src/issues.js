// Issues: one tracker for everything that needs a person (README "Issues").
//   issues        the current state of each issue
//   issue_events  its append-only timeline (created, assigned, status, priority, comment, linked, edited). Never
//                 updated or deleted.
// Issues open automatically when an incident opens (one open issue per check: a flapping check adds to the same
// issue), when an auto-fix fails or is reverted, when a deploy fails or makes things worse, and every quarter for the
// access review. When the incident behind an issue is resolved, the issue is resolved too ("auto-resolved: incident
// resolved"); people can reopen it. Admins create issues by hand or from a feedback item, comment, assign, and change
// status and priority.
// Alerts: issue_assigned goes to the assignee only (always; not to people assigning to themselves);
// issue_critical goes to owners (always) and anyone subscribed, except for issues opened for an incident (people were
// just alerted about the incident itself).
import { dispatch, dispatchTo } from './alerts.js';
import { DASHBOARD_URL } from './checks.js';
import { readOnly } from './readonly.js';
import { getSettings } from './settings.js';
import { redact } from './triage.js';

export const ISSUE_SOURCES = ['manual', 'incident', 'feedback', 'autofix', 'deploy', 'security'];
export const PRIORITIES = ['low', 'normal', 'high', 'critical'];
export const ISSUE_STATUSES = ['open', 'in_progress', 'blocked', 'resolved', 'wont_fix'];
export const OPEN_STATUSES = ['open', 'in_progress', 'blocked'];
export const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', blocked: 'Blocked', resolved: 'Resolved', wont_fix: "Won't fix" };
const SEVERITY_PRIORITY = { critical: 'critical', high: 'high', warning: 'normal', info: 'low' };

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isoNow = (nowMs) => new Date(nowMs ?? Date.now()).toISOString();
export const issueLink = (id) => `${DASHBOARD_URL}/#issues/${id}`;

/** A work address in an allowed domain, lower-cased, or null. Pure. */
export function cleanEmail(v, env = {}) {
  const email = String(v || '').trim().toLowerCase();
  const domains = String(env.ALLOWED_EMAIL_DOMAINS || 'overyondr.com').split(',').map((d) => d.trim()).filter(Boolean);
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email) && domains.includes(email.split('@')[1]) ? email : null;
}

/** Validate fields an admin sends. Returns { fields } or { error }. Pure. */
export function validateIssue(b, env, { creating }) {
  if (!b || typeof b !== 'object') return { error: 'Send a JSON object.' };
  const f = {};
  if (creating || b.title !== undefined) { f.title = str(b.title, 200); if (!f.title) return { error: 'Give the issue a title.' }; }
  if (b.description !== undefined) f.description = str(b.description, 8000) || null;
  if (b.priority !== undefined) { if (!PRIORITIES.includes(b.priority)) return { error: `Priority is one of ${PRIORITIES.join(', ')}.` }; f.priority = b.priority; }
  if (b.status !== undefined) { if (!ISSUE_STATUSES.includes(b.status)) return { error: `Status is one of ${ISSUE_STATUSES.join(', ')}.` }; f.status = b.status; }
  if (b.site !== undefined) f.site = str(b.site, 100) || null;
  if (b.assignee_email !== undefined) {
    if (b.assignee_email === null || b.assignee_email === '') f.assignee_email = null;
    else { const e = cleanEmail(b.assignee_email, env); if (!e) return { error: 'Assign to a work address (@overyondr.com).' }; f.assignee_email = e; }
  }
  if (b.due_at !== undefined) {
    if (b.due_at === null || b.due_at === '') f.due_at = null;
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.due_at)) || Number.isNaN(Date.parse(b.due_at))) return { error: 'Due date is a date like 2026-12-31.' };
    else f.due_at = String(b.due_at);
  }
  if (creating && b.source !== undefined) { if (!ISSUE_SOURCES.includes(b.source)) return { error: 'Unknown source.' }; f.source = b.source; }
  return { fields: f };
}

export async function addIssueEvent(db, issueId, actor, kind, message, nowMs) {
  await db.prepare('INSERT INTO issue_events (issue_id, actor, kind, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(issueId, actor, kind, String(message).slice(0, 4000), isoNow(nowMs)).run();
}

async function notifyAssignee(env, issue, actor, settings, nowMs) {
  if (!issue.assignee_email || issue.assignee_email === actor) return null;
  return dispatchTo(env, {
    type: 'issue_assigned', kind: 'event', severity: 'info', title: `Assigned to you: ${issue.title}`, site: issue.site || null,
    detail: [`Priority: ${issue.priority}. Status: ${STATUS_LABEL[issue.status] || issue.status}.`, issue.due_at ? `Due: ${issue.due_at}.` : null,
      `Assigned by ${actor}.`, issue.description ? `\n${issue.description.slice(0, 1500)}` : null].filter(Boolean).join('\n'),
    done: 'Nothing automatic: the issue waits for you in Ops.', link: issueLink(issue.id),
  }, [issue.assignee_email], { settings, nowMs }).catch((e) => console.error('issue_assigned failed', e && e.stack));
}

async function notifyCritical(env, issue, settings, nowMs) {
  return dispatch(env, {
    type: 'issue_critical', kind: 'event', severity: 'critical', title: `Critical issue: ${issue.title}`, site: issue.site || null,
    detail: [`Source: ${issue.source}${issue.source_ref ? ` (${issue.source_ref})` : ''}.`, issue.assignee_email ? `Assigned to ${issue.assignee_email}.` : 'Not assigned yet.',
      issue.description ? `\n${issue.description.slice(0, 1500)}` : null].filter(Boolean).join('\n'),
    done: 'An issue was opened in Ops so it is tracked until someone resolves it.', link: issueLink(issue.id),
  }, { settings, nowMs }).catch((e) => console.error('issue_critical failed', e && e.stack));
}

/**
 * Create an issue (validated fields), its "created" event and the alerts. Returns the row.
 * opts.notifyAll: extra people to tell (issue_assigned), e.g. every owner for the access review.
 */
export async function createIssue(env, f, actor, { settings, nowMs = Date.now(), notifyAll = null, alreadyAlerted = false } = {}) {
  const db = env.DB;
  const now = isoNow(nowMs);
  settings = settings || await getSettings(db);
  const row = await db.prepare(`INSERT INTO issues (title, description, source, source_ref, site, priority, status, assignee_email, created_by, created_at, updated_at, due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).bind(f.title, f.description ?? null, f.source || 'manual', f.source_ref ?? null, f.site ?? null,
    f.priority || 'normal', f.status || 'open', f.assignee_email ?? null, actor, now, now, f.due_at ?? null).first();
  await addIssueEvent(db, row.id, actor, 'created', f.created_message || `Created${f.source && f.source !== 'manual' ? ` automatically (${f.source})` : ''}.`, nowMs);
  if (row.assignee_email) await addIssueEvent(db, row.id, actor, 'assigned', `Assigned to ${row.assignee_email}.`, nowMs);
  if (notifyAll && notifyAll.length) {
    await dispatchTo(env, {
      type: 'issue_assigned', kind: 'event', severity: 'info', title: `Assigned to you: ${row.title}`, detail: row.description ? row.description.slice(0, 2500) : null,
      done: 'An issue was opened in Ops for you.', link: issueLink(row.id),
    }, notifyAll, { settings, nowMs }).catch((e) => console.error('issue_assigned failed', e && e.stack));
  } else await notifyAssignee(env, row, actor, settings, nowMs);
  // An issue opened for an incident: people were just alerted about the incident itself, so no second critical alert.
  if (row.priority === 'critical' && !alreadyAlerted) await notifyCritical(env, row, settings, nowMs);
  return row;
}

/** Apply an admin's change. Returns { status, body }. Every change is a timeline event. */
export async function updateIssue(env, id, b, actor, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const prev = await db.prepare('SELECT * FROM issues WHERE id = ?').bind(id).first();
  if (!prev) return { status: 404, body: { error: 'No such issue.' } };
  const v = validateIssue(b, env, { creating: false });
  if (v.error) return { status: 422, body: { error: v.error } };
  const f = v.fields;
  const keys = Object.keys(f).filter((k) => f[k] !== prev[k]);
  if (!keys.length) return { status: 200, body: { ok: true, issue: await getIssue(db, id) } };
  const now = isoNow(nowMs);
  const sets = keys.map((k) => `${k} = ?`);
  const vals = keys.map((k) => f[k]);
  if (keys.includes('status')) { sets.push('resolved_at = ?'); vals.push(OPEN_STATUSES.includes(f.status) ? null : now); }
  await db.prepare(`UPDATE issues SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...vals, now, id).run();
  for (const k of keys) {
    if (k === 'status') await addIssueEvent(db, id, actor, 'status', `Status: ${STATUS_LABEL[prev.status] || prev.status} → ${STATUS_LABEL[f.status]}.`, nowMs);
    else if (k === 'priority') await addIssueEvent(db, id, actor, 'priority', `Priority: ${prev.priority} → ${f.priority}.`, nowMs);
    else if (k === 'assignee_email') await addIssueEvent(db, id, actor, 'assigned', f.assignee_email ? `Assigned to ${f.assignee_email}.` : 'Unassigned.', nowMs);
    else await addIssueEvent(db, id, actor, 'edited', `Changed ${k.replace('_', ' ')}.`, nowMs);
  }
  const issue = await db.prepare('SELECT * FROM issues WHERE id = ?').bind(id).first();
  const settings = await getSettings(db);
  if (keys.includes('assignee_email')) await notifyAssignee(env, issue, actor, settings, nowMs);
  if (keys.includes('priority') && f.priority === 'critical') await notifyCritical(env, issue, settings, nowMs);
  return { status: 200, body: { ok: true, issue: await getIssue(db, id) } };
}

export async function commentIssue(env, id, text, actor, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const body = str(text, 4000);
  if (!body) return { status: 422, body: { error: 'Write a comment first.' } };
  const prev = await db.prepare('SELECT id FROM issues WHERE id = ?').bind(id).first();
  if (!prev) return { status: 404, body: { error: 'No such issue.' } };
  await addIssueEvent(db, id, actor, 'comment', body, nowMs);
  await db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').bind(isoNow(nowMs), id).run();
  return { status: 201, body: { ok: true, issue: await getIssue(db, id) } };
}

/** Filters: status (one, or 'active' = open/in progress/blocked), priority, assignee (email or 'none'), source, site, q. */
export async function listIssues(db, filters = {}) {
  const where = [];
  const args = [];
  if (filters.status === 'active') where.push(`status IN (${OPEN_STATUSES.map(() => '?').join(',')})`), args.push(...OPEN_STATUSES);
  else if (ISSUE_STATUSES.includes(filters.status)) where.push('status = ?'), args.push(filters.status);
  if (PRIORITIES.includes(filters.priority)) where.push('priority = ?'), args.push(filters.priority);
  if (ISSUE_SOURCES.includes(filters.source)) where.push('source = ?'), args.push(filters.source);
  if (filters.assignee === 'none') where.push('assignee_email IS NULL');
  else if (filters.assignee) where.push('assignee_email = ?'), args.push(String(filters.assignee).toLowerCase());
  if (filters.site) where.push('site = ?'), args.push(String(filters.site));
  if (filters.q) where.push('(title LIKE ? OR description LIKE ?)'), args.push(`%${filters.q}%`, `%${filters.q}%`);
  const sql = `SELECT * FROM issues ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE WHEN status IN ('resolved', 'wont_fix') THEN 1 ELSE 0 END,
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, updated_at DESC LIMIT 300`;
  const stmt = db.prepare(sql);
  return (await (args.length ? stmt.bind(...args) : stmt).all()).results;
}

export async function getIssue(db, id) {
  const issue = await db.prepare('SELECT * FROM issues WHERE id = ?').bind(id).first();
  if (!issue) return null;
  const { results: events } = await db.prepare('SELECT * FROM issue_events WHERE issue_id = ? ORDER BY id').bind(id).all();
  return { ...issue, events };
}

export async function openIssueFor(db, source, ref) {
  return db.prepare(`SELECT * FROM issues WHERE source = ? AND source_ref = ? AND status IN ('open', 'in_progress', 'blocked') ORDER BY id DESC LIMIT 1`).bind(source, ref).first();
}

// ------------------------------------------------------------------------------------------------ automatic issues
/**
 * An incident opened (src/monitor.js). One open issue per check: if the check already has one, the incident is linked
 * to it. Deploy failures are filed as source "deploy". Returns the issue id.
 */
export async function issueForIncident(env, incident, { settings, nowMs = Date.now() } = {}) {
  const db = env.DB;
  const source = incident.event === 'deploy_failed' ? 'deploy' : 'incident';
  const ref = `check:${incident.check_id}`;
  const existing = await openIssueFor(db, source, ref);
  let id;
  if (existing) {
    id = existing.id;
    await addIssueEvent(db, id, 'yondr-ops', 'linked', `Incident #${incident.id} opened again: ${incident.title}.`, nowMs);
    await db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').bind(isoNow(nowMs), id).run();
  } else {
    const row = await createIssue(env, {
      title: incident.title, source, source_ref: ref, site: incident.site || null,
      priority: SEVERITY_PRIORITY[incident.severity] || 'normal',
      description: [incident.detail, `Incident #${incident.id} (check ${incident.check_id}). This issue resolves itself when the check passes again.`].filter(Boolean).join('\n\n'),
      created_message: `Created automatically: incident #${incident.id} opened.`,
    }, 'yondr-ops', { settings, nowMs, alreadyAlerted: true });
    id = row.id;
  }
  await db.prepare('UPDATE incidents SET issue_id = ? WHERE id = ?').bind(id, incident.id).run();
  return id;
}

/** The incident behind an issue resolved: resolve the issue too (if nobody closed it already). */
export async function resolveForIncident(env, incidentId, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const inc = await db.prepare('SELECT id, issue_id FROM incidents WHERE id = ?').bind(incidentId).first();
  if (!inc || !inc.issue_id) return false;
  const issue = await db.prepare('SELECT * FROM issues WHERE id = ?').bind(inc.issue_id).first();
  if (!issue || !OPEN_STATUSES.includes(issue.status)) return false;
  const now = isoNow(nowMs);
  await db.prepare("UPDATE issues SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?").bind(now, now, issue.id).run();
  await addIssueEvent(db, issue.id, 'yondr-ops', 'status', `auto-resolved: incident resolved (incident #${incidentId}). Reopen it if there is more to do.`, nowMs);
  return true;
}

/** An auto-fix failed or was reverted (src/autofix.js alertFor). */
export async function issueForAutofix(env, entry, type, { settings, severity, detail, nowMs = Date.now() } = {}) {
  const db = env.DB;
  const ref = `autofix:${entry.id}`;
  const what = type === 'autofix_reverted' ? 'reverted' : 'failed';
  const existing = await openIssueFor(db, 'autofix', ref);
  if (existing) { await addIssueEvent(db, existing.id, 'yondr-ops', 'linked', `Auto-fix #${entry.id} ${what}.${detail ? ` ${detail}` : ''}`, nowMs); return existing.id; }
  const row = await createIssue(env, {
    title: `Auto-fix ${what}: ${entry.title}`, source: 'autofix', source_ref: ref, site: entry.project || null,
    priority: severity === 'critical' ? 'critical' : 'high',
    description: [`Repository: ${entry.repo}`, entry.feedback_id ? `Feedback item #${entry.feedback_id}` : null, entry.pr_url ? `Pull request: ${entry.pr_url}` : null,
      detail || null, `Auto-fix log: ${DASHBOARD_URL}/#autofix/${entry.id}`].filter(Boolean).join('\n'),
  }, 'yondr-ops', { settings, nowMs });
  return row.id;
}

/** A deploy made things worse (src/deploys.js). */
export async function issueForDeploy(env, { worker, deployment_id, title, detail }, { settings, nowMs = Date.now() } = {}) {
  const ref = `deploy:${worker}:${deployment_id}`;
  const existing = await openIssueFor(env.DB, 'deploy', ref);
  if (existing) return existing.id;
  const row = await createIssue(env, { title, description: detail, source: 'deploy', source_ref: ref, site: worker, priority: 'high' }, 'yondr-ops', { settings, nowMs });
  return row.id;
}

/**
 * "Create issue from feedback item": copies only the item's title and text (redacted again), its project and
 * priority, and links it by id. Never the author or anyone else involved.
 */
export async function issueFromFeedback(env, feedbackId, actor, { nowMs = Date.now() } = {}) {
  if (!env.FEEDBACK_DB) return { status: 503, body: { error: 'The feedback database is not connected.' } };
  const id = Number(feedbackId);
  if (!Number.isInteger(id) || id < 1) return { status: 422, body: { error: 'Give the feedback item number.' } };
  const item = await readOnly(env.FEEDBACK_DB).prepare('SELECT id, title, message, priority, COALESCE(project, site) AS project FROM feedback WHERE id = ?').bind(id).first();
  if (!item) return { status: 404, body: { error: `Feedback item #${id} was not found.` } };
  const ref = `feedback:${id}`;
  const existing = await openIssueFor(env.DB, 'feedback', ref);
  if (existing) return { status: 409, body: { error: `Issue #${existing.id} is already open for feedback #${id}.`, issue: existing } };
  const text = redact(String(item.message || ''));
  const title = redact(String(item.title || '').trim()) || text.replace(/\s+/g, ' ').slice(0, 80) || `Feedback #${id}`;
  const row = await createIssue(env, {
    title: title.slice(0, 200), source: 'feedback', source_ref: ref, site: item.project || null,
    priority: PRIORITIES.includes(item.priority) ? item.priority : 'normal',
    description: `${text.slice(0, 6000)}\n\nFeedback item: https://feedback.overyondrdev.com/admin#item-${id}`,
    created_message: `Created from feedback #${id}.`,
  }, actor, { nowMs });
  return { status: 201, body: { ok: true, issue: await getIssue(env.DB, row.id) } };
}

/** Open issues by priority (Overview). */
export async function issueCounts(db) {
  const { results } = await db.prepare(`SELECT priority, COUNT(*) AS n FROM issues WHERE status IN ('open', 'in_progress', 'blocked') GROUP BY priority`).all();
  const out = { low: 0, normal: 0, high: 0, critical: 0, total: 0 };
  for (const r of results) { out[r.priority] = r.n; out.total += r.n; }
  return out;
}

