// The auto-fix log: what the auto-fix engine did with each feedback item, and one-click revert.
// Triage and starting fixes: src/triage.js. Post-merge verification and automatic revert: src/verify.js.
// autofixes holds the current state of each fix; autofix_events is the append-only audit log (never updated).
import { dispatch } from './alerts.js';
import { ALLOWED_REPOS, DASHBOARD_URL } from './checks.js';
import { openRevertPr, RevertRefused } from './github.js';
import { getSettings } from './settings.js';

export const STATUSES = ['queued', 'triaged', 'fixing', 'pr_open', 'checks_failed', 'merged', 'deployed', 'verified', 'failed', 'reverted', 'rejected'];
export const CLASSIFICATIONS = ['objective', 'subjective'];
// Status changes that alert, and as which event type. "merged" doesn't alert: the fix is only announced once it is
// live and verified (src/verify.js), or reverted.
export const STATUS_EVENT = { fixing: 'autofix_started', verified: 'autofix_merged', failed: 'autofix_failed', checks_failed: 'autofix_failed' };

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const GH_URL = /^https:\/\/github\.com\/Overyondrdev\/[\w.-]+\/(issues|pull|commit)\/[\w]+/;

/** Validate an ingest payload. Returns { fields, actor, message } or { error }. Pure. */
export function validateAutofix(b, { creating }) {
  if (!b || typeof b !== 'object') return { error: 'Send a JSON object.' };
  const f = {};
  if (b.repo !== undefined) {
    if (!ALLOWED_REPOS.includes(b.repo)) return { error: `repo must be one of: ${ALLOWED_REPOS.join(', ')}.` };
    f.repo = b.repo;
  }
  if (b.title !== undefined) { f.title = str(b.title, 200); if (!f.title) return { error: 'title must not be empty.' }; }
  if (b.status !== undefined) { if (!STATUSES.includes(b.status)) return { error: `status must be one of: ${STATUSES.join(', ')}.` }; f.status = b.status; }
  if (b.classification !== undefined) { if (!CLASSIFICATIONS.includes(b.classification)) return { error: 'classification must be objective or subjective.' }; f.classification = b.classification; }
  if (b.classification_reason !== undefined) f.classification_reason = str(b.classification_reason, 1000) || null;
  if (b.severity !== undefined) { if (!['low', 'normal', 'high', 'critical'].includes(b.severity)) return { error: 'severity must be low, normal, high or critical.' }; f.severity = b.severity; }
  if (b.project !== undefined) f.project = str(b.project, 40) || null;
  if (b.feedback_id !== undefined) { if (!Number.isInteger(b.feedback_id) || b.feedback_id < 1) return { error: 'feedback_id must be a positive integer.' }; f.feedback_id = b.feedback_id; }
  for (const k of ['issue_url', 'pr_url']) {
    if (b[k] !== undefined) { if (b[k] !== null && !GH_URL.test(b[k])) return { error: `${k} must be a github.com/Overyondrdev link.` }; f[k] = b[k]; }
  }
  if (b.merge_sha !== undefined) { if (b.merge_sha !== null && !/^[0-9a-f]{40}$/i.test(b.merge_sha)) return { error: 'merge_sha must be a full 40-character commit SHA.' }; f.merge_sha = b.merge_sha && b.merge_sha.toLowerCase(); }
  if (creating) {
    if (!f.repo) return { error: 'repo is required.' };
    if (!f.title) return { error: 'title is required.' };
    if (!f.status) f.status = 'queued';
  }
  return { fields: f, actor: str(b.actor, 80) || 'autofix-engine', message: str(b.message, 2000) || null };
}

export async function addEvent(db, id, actor, status, message) {
  await db.prepare('INSERT INTO autofix_events (autofix_id, actor, status, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, actor, status || null, message, new Date().toISOString()).run();
}

export async function alertFor(env, entry, type, settings, extra = {}) {
  const verbs = { autofix_started: 'Auto-fix started', autofix_merged: 'Auto-fix live and verified', autofix_failed: 'Auto-fix failed', autofix_reverted: 'Auto-fix revert requested' };
  await dispatch(env, {
    type, kind: 'event', severity: extra.severity || (type === 'autofix_failed' ? 'high' : type === 'autofix_reverted' ? 'warning' : 'info'),
    title: `${verbs[type]}: ${entry.title}`, site: entry.project || entry.repo,
    detail: [`Repository: ${entry.repo}`, entry.feedback_id ? `Feedback item #${entry.feedback_id}` : null, entry.pr_url ? `Pull request: ${entry.pr_url}` : null, extra.detail].filter(Boolean).join('\n'),
    done: extra.done, link: `${DASHBOARD_URL}/#autofix/${entry.id}`,
  }, { settings }).catch((e) => console.error('autofix alert failed', e && e.stack));
}

/** POST /api/autofix/events (ingest token). */
export async function ingestAutofix(env, body) {
  const db = env.DB;
  const creating = body == null || body.id == null;
  const v = validateAutofix(body, { creating });
  if (v.error) return { status: 422, body: { error: v.error } };
  const now = new Date().toISOString();
  let prev = null;
  let id;
  if (creating) {
    const f = v.fields;
    const row = await db.prepare(`INSERT INTO autofixes (feedback_id, project, repo, title, classification, classification_reason, severity, status,
      issue_url, pr_url, merge_sha, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(f.feedback_id ?? null, f.project ?? null, f.repo, f.title, f.classification ?? null, f.classification_reason ?? null, f.severity ?? null,
        f.status, f.issue_url ?? null, f.pr_url ?? null, f.merge_sha ?? null, now, now).first();
    id = row.id;
    await addEvent(db, id, v.actor, f.status, v.message || `Logged: ${f.title}`);
  } else {
    id = Number(body.id);
    prev = await db.prepare('SELECT * FROM autofixes WHERE id = ?').bind(id).first();
    if (!prev) return { status: 404, body: { error: 'No such auto-fix.' } };
    const keys = Object.keys(v.fields);
    if (keys.length) {
      await db.prepare(`UPDATE autofixes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .bind(...keys.map((k) => v.fields[k]), now, id).run();
    }
    const changes = keys.filter((k) => prev[k] !== v.fields[k]).map((k) => (k === 'status' ? `status ${prev.status} → ${v.fields.status}` : k));
    await addEvent(db, id, v.actor, v.fields.status || prev.status, v.message || (changes.length ? `Updated: ${changes.join(', ')}` : 'No change'));
  }
  // Merged: start the verification clock (src/verify.js).
  if (v.fields.status === 'merged') await db.prepare("UPDATE autofixes SET merged_at = COALESCE(merged_at, ?) WHERE id = ?").bind(now, id).run();
  const entry = await db.prepare('SELECT * FROM autofixes WHERE id = ?').bind(id).first();
  if ((!prev || prev.status !== entry.status) && STATUS_EVENT[entry.status]) {
    await alertFor(env, entry, STATUS_EVENT[entry.status], await getSettings(db), { detail: v.message || undefined });
  }
  return { status: creating ? 201 : 200, body: { ok: true, autofix: entry } };
}

/** status: one status, 'active' (everything except rejected, i.e. not a bug), or nothing for all. */
export async function listAutofixes(db, { status } = {}) {
  if (status === 'active') return (await db.prepare("SELECT * FROM autofixes WHERE status != 'rejected' ORDER BY updated_at DESC LIMIT 200").all()).results;
  const where = status && STATUSES.includes(status) ? 'WHERE status = ?' : '';
  const stmt = db.prepare(`SELECT * FROM autofixes ${where} ORDER BY updated_at DESC LIMIT 200`);
  return (await (where ? stmt.bind(status) : stmt).all()).results;
}

export async function getAutofix(db, id) {
  const entry = await db.prepare('SELECT * FROM autofixes WHERE id = ?').bind(id).first();
  if (!entry) return null;
  const { results: events } = await db.prepare('SELECT * FROM autofix_events WHERE autofix_id = ? ORDER BY id').bind(id).all();
  return { ...entry, events };
}

/** POST /api/autofix/:id/revert (signed-in admin, CSRF header). */
export async function revertAutofix(env, id, actor) {
  const db = env.DB;
  const entry = await db.prepare('SELECT * FROM autofixes WHERE id = ?').bind(id).first();
  if (!entry) return { status: 404, body: { error: 'No such auto-fix.' } };
  // Claim the revert so two clicks can't open two pull requests.
  const claim = await db.prepare("UPDATE autofixes SET revert_pr_url = 'pending', updated_at = ? WHERE id = ? AND revert_pr_url IS NULL")
    .bind(new Date().toISOString(), id).run();
  if (!claim.meta || !claim.meta.changes) return { status: 409, body: { error: entry.revert_pr_url === 'pending' ? 'A revert is already being opened.' : `A revert was already opened: ${entry.revert_pr_url}` } };
  await addEvent(db, id, actor, entry.status, 'Revert requested in the ops dashboard.');
  const log = (m) => addEvent(db, id, 'yondr-ops', null, m);
  try {
    const r = await openRevertPr(env, entry, log);
    const now = new Date().toISOString();
    await db.prepare("UPDATE autofixes SET status = 'reverted', revert_pr_url = ?, reverted_by = ?, reverted_at = ?, updated_at = ? WHERE id = ?")
      .bind(r.pr_url, actor, now, now, id).run();
    await addEvent(db, id, 'yondr-ops', 'reverted', `Revert pull request opened: ${r.pr_url}${r.auto_merge ? ' (auto-merge on)' : ''}.`);
    const updated = await db.prepare('SELECT * FROM autofixes WHERE id = ?').bind(id).first();
    await alertFor(env, updated, 'autofix_reverted', await getSettings(db), {
      detail: `Revert pull request: ${r.pr_url}`, done: r.auto_merge ? 'A revert pull request was opened with auto-merge: it merges and deploys once checks pass.' : 'A revert pull request was opened. Someone needs to merge it in GitHub once checks pass.',
    });
    await db.prepare('INSERT INTO audit (actor, action, detail, created_at) VALUES (?, ?, ?, ?)').bind(actor, 'autofix.revert', JSON.stringify({ id, pr: r.pr_url }), now).run();
    return { status: 200, body: { ok: true, ...r, autofix: await getAutofix(db, id) } };
  } catch (e) {
    await db.prepare("UPDATE autofixes SET revert_pr_url = NULL, updated_at = ? WHERE id = ? AND revert_pr_url = 'pending'").bind(new Date().toISOString(), id).run();
    const refused = e instanceof RevertRefused || (e && e.name === 'RevertRefused');
    await addEvent(db, id, 'yondr-ops', null, `${refused ? 'Revert refused' : 'Revert failed'}: ${e.message}`);
    const link = entry.pr_url ? ` Pull request: ${entry.pr_url}` : '';
    return { status: refused ? 409 : 502, body: { error: `${e.message}${refused && link ? link : ''}`, refused, pr_url: entry.pr_url || null } };
  }
}
