// Auto-fix triage: what happens to a feedback item the feedback tool reports (POST /api/autofix/feedback).
// The owner's rules (docs/OPERATIONS.md §6.3 in overyondr-website-v1), applied in this order by decide():
//   1. Only feedback of type BUG can be fixed automatically. Anything else → "rejected" (not a bug), logged.
//   2. The project must map to a repository (PROJECT_REPOS). Unknown → "triaged": a person decides.
//   3. Only OBJECTIVE bugs (src/classify.js: Workers AI, or an admin's "Mark objective / subjective").
//      SUBJECTIVE ones, even critical → "triaged": a person decides. Never an issue.
//   4. The repository must have the auto-fix workflows (AUTOFIX_TARGETS[repo].workflow). Otherwise → a person.
//   5. Objective → "queued". If the kill switch `autofix_enabled` is on: CRITICAL ones start now; the others are started
//      by the 5-minute run, at most `autofix_max_per_hour` per hour (and never more than AUTOFIX.hardCapPerHour).
//   6. Spending (src/budget.js): when this month's Claude API spend reached the pause level, or one more fix could take
//      it past the budget, objective bugs stay queued and nothing starts until spend allows or an owner approves more.
// "Starting" = opening a GitHub issue in the target repository, labelled `autofix` (+ `autofix-critical`): that label
// starts the repository's `.github/workflows/autofix.yml` (Claude Code), which opens a pull request. Every step is
// logged in autofix_events. No personal data reaches GitHub (the repositories are public).
import { addEvent, alertFor } from './autofix.js';
import { loadBudget, usd } from './budget.js';
import { AUTOFIX, AUTOFIX_TARGETS, DASHBOARD_URL, PROJECT_REPOS } from './checks.js';
import { classify } from './classify.js';
import { gh } from './github.js';
import { getSettings } from './settings.js';

const TYPES = ['bug', 'design', 'content', 'idea', 'question', 'praise', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'critical'];
// Once a fix is under way (or done), feedback edits don't restart it; people take it from there.
const ENGAGED = new Set(['fixing', 'pr_open', 'checks_failed', 'merged', 'deployed', 'verified', 'failed', 'reverted']);
export const UNKNOWN_REPO = 'unknown';

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// ---- personal-data redaction (keep identical in yondr-feedback src/ops.js and yondr-ops src/triage.js) ----
// Bug reports may end up in PUBLIC GitHub issues (auto-fix). Removed: e-mail addresses; phone numbers (international
// and local formats, 9+ digits, or 7+ after + / 00); street addresses (house number + street word, e.g. "12 High
// Street", "1600 Pennsylvania Ave NW", "5 rue de la Paix") with a town and postcode/ZIP that follow; UK postcodes
// anywhere; secrets: URL parameters whose name contains key/token/secret/password/auth/session/signature/code, Bearer
// and Basic credentials, and well-known token formats.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_PARAM = /([?&;#][\w.-]*?(?:key|token|secret|passw(?:or)?d|pwd|auth|session|signature|sig|code|credential)[\w.-]*=)[^&#\s"'<>]+/gi;
const AUTH_HEADER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|re_[A-Za-z0-9_]{20,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/g;
const STREET = '(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Close|Court|Ct|Place|Pl|Square|Sq|Terrace|Crescent|Cres|Gardens|Grove|Hill|Row|Mews|Walk|Parkway|Pkwy|Highway|Hwy|Strasse|Straße|Weg|Gasse|Plaza)';
const POSTCODE = '(?:[A-Z]{1,2}\\d[A-Z\\d]?\\s*\\d[A-Z]{2}|\\d{5}(?:-\\d{4})?|\\d{4}\\s?[A-Z]{2}|[A-Z]\\d[A-Z]\\s?\\d[A-Z]\\d|\\d{4})';
const TAIL = `(?:,?\\s+(?:N|S|E|W|NE|NW|SE|SW)\\b)?(?:,?\\s+[A-Z][A-Za-z.'-]+\\b){0,3}(?:,?\\s+${POSTCODE}\\b)?`;
const ADDRESS = new RegExp(
  `\\b\\d{1,5}[A-Za-z]?(?:[-–]\\d{1,5})?,?\\s+(?:(?:[A-Z][A-Za-z'.-]*|of|the)\\s+){1,4}(?:${STREET}|${STREET.toLowerCase()})\\b\\.?${TAIL}` +
  `|\\b\\d{1,5}[A-Za-z]?,?\\s+(?:[Rr]ue|[Aa]venue|[Vv]ia|[Cc]alle|[Bb]oulevard|[Pp]lace)\\s+(?:(?:de|du|des|la|le|del|di|della|von)\\s+)*[A-Z][A-Za-z'-]+(?:\\s+[A-Z][A-Za-z'-]+)?${TAIL}`, 'g');
const UK_POSTCODE = /\b(?:[A-Z]{1,2}\d[A-Z\d]?|GIR)\s*\d[ABD-HJLNP-UW-Z]{2}\b/g;
const PHONE = /(?<![\w/=.#-])(?:\+|00)?\(?\d[\d (). -]{5,}\d(?![\w/])/g;

/** Remove personal details and secrets from free text before it can leave for a public place. Pure. */
export function redact(s) {
  return String(s ?? '')
    .replace(SECRET_PARAM, '$1[removed]')
    .replace(AUTH_HEADER, '$1 [removed]')
    .replace(TOKEN, '[token removed]')
    .replace(EMAIL, '[email removed]')
    .replace(ADDRESS, '[address removed]')
    .replace(UK_POSTCODE, '[postcode removed]')
    .replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, '').length;
      // Dates (2026-11-27, 27.11.2026), times and short numbers stay; phone numbers have 9+ digits (7+ after + / 00).
      if (/^\d{4}-\d{2}-\d{2}/.test(m) || /^\d{1,2}[.-]\d{1,2}[.-]\d{2,4}$/.test(m.trim())) return m;
      if (digits > 15 || digits < (/^(\+|00)/.test(m) ? 7 : 9)) return m;
      return '[number removed]';
    });
}
// ---- end of personal-data redaction ----
/** Belt and braces: the feedback tool already redacts, but nothing personal may reach a public issue. */
export const scrub = redact;

/** Validate what the feedback tool sends. Returns { item } or { error }. Pure. */
export function validateFeedbackEvent(b) {
  if (!b || typeof b !== 'object') return { error: 'Send a JSON object.' };
  if (!Number.isInteger(b.feedback_id) || b.feedback_id < 1) return { error: 'feedback_id must be a positive integer.' };
  if (!TYPES.includes(b.type)) return { error: `type must be one of: ${TYPES.join(', ')}.` };
  const priority = b.priority == null ? 'normal' : b.priority;
  if (!PRIORITIES.includes(priority)) return { error: `priority must be one of: ${PRIORITIES.join(', ')}.` };
  const message = scrub(str(b.message, 4000));
  if (!message) return { error: 'message is required.' };
  const project = str(b.project, 40).toLowerCase();
  const url = str(b.url, 2000);
  const admin = str(b.admin_url, 300);
  return { item: {
    feedback_id: b.feedback_id, type: b.type, priority, message,
    project: /^[a-z0-9][a-z0-9-]{0,39}$/.test(project) ? project : null,
    asset: scrub(str(b.asset, 200)) || null,
    title: scrub(str(b.title, 200)) || null,
    url: /^https:\/\//.test(url) ? scrub(url) : null,
    path: scrub(str(b.path, 1000)) || null,
    page_title: scrub(str(b.page_title, 300)) || null,
    screenshots: (Array.isArray(b.screenshots) ? b.screenshots : []).filter((s) => typeof s === 'string' && /^\/api\/attachments\/[\w-]{1,64}$/.test(s)).slice(0, 6),
    admin_url: admin.startsWith('https://feedback.overyondrdev.com/') ? admin : `https://feedback.overyondrdev.com/admin#item-${b.feedback_id}`,
  } };
}

/**
 * The triage decision. Pure.
 * @returns { status: 'rejected'|'triaged'|'queued', message, start: boolean }
 */
export function decide({ item, repo, target, classification, settings, startedLastHour = 0, budget = null }) {
  if (item.type !== 'bug') return { status: 'rejected', start: false, message: `Not a bug (type "${item.type}"): only bugs can be fixed automatically.` };
  if (!repo) return { status: 'triaged', start: false, message: `Unknown project "${item.project || '(none)'}": a person decides.` };
  if (!classification || classification.classification !== 'objective') {
    return { status: 'triaged', start: false, message: `Subjective${item.priority === 'critical' ? ' (marked critical)' : ''}: a person decides. ${classification ? classification.reason : ''}`.trim() };
  }
  if (!target || !target.workflow) return { status: 'triaged', start: false, message: `Objective, but ${repo} doesn't have the auto-fix workflow yet: a person fixes it.` };
  if (!settings.autofix_enabled) return { status: 'queued', start: false, message: 'Objective. Queued, but the auto-fix engine is switched off (Settings): nothing starts until an owner turns it on.' };
  if (budget && budget.paused) {
    return { status: 'queued', start: false, message: `Objective. Queued, but auto-fix is paused: this month's spend (${usd(budget.spent)}) reached the pause level (${usd(budget.pause_at)}). Nothing starts until an owner approves more spend (Auto-fixes → Spend).` };
  }
  if (item.priority === 'critical') {
    if (budget && !budget.can_start) return { status: 'queued', start: false, message: `Objective and critical, but starting it now could take this month's spend past the ${usd(budget.effective)} budget: queued until fixes in progress report their cost.` };
    if (startedLastHour >= AUTOFIX.hardCapPerHour) return { status: 'queued', start: false, message: `Objective and critical, but ${AUTOFIX.hardCapPerHour} fixes already started in the last hour: queued for the next run.` };
    return { status: 'queued', start: true, message: 'Objective and critical: starting now.' };
  }
  return { status: 'queued', start: false, message: `Objective. Queued: the 5-minute run starts up to ${settings.autofix_max_per_hour} fixes an hour.` };
}

async function startedSince(db, sinceIso) {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM autofixes WHERE started_at > ?').bind(sinceIso).first();
  return r.n;
}

function itemOf(entry) {
  if (entry.payload) { try { return JSON.parse(entry.payload); } catch { /* fall through */ } }
  return { feedback_id: entry.feedback_id, type: 'bug', priority: entry.severity || 'normal', project: entry.project, message: entry.title, title: entry.title };
}

function titleOf(item) {
  const t = item.title || item.message.split('\n')[0];
  return t.length > 120 ? t.slice(0, 117) + '…' : t;
}

/** POST /api/autofix/feedback (ingest token): triage one new or changed feedback item. */
export async function triageFeedback(env, body, { nowMs = Date.now(), classifyFn = classify } = {}) {
  const db = env.DB;
  const v = validateFeedbackEvent(body);
  if (v.error) return { status: 422, body: { error: v.error } };
  const item = v.item;
  const settings = await getSettings(db);
  const now = new Date(nowMs).toISOString();
  const existing = await db.prepare('SELECT * FROM autofixes WHERE feedback_id = ? ORDER BY id DESC LIMIT 1').bind(item.feedback_id).first();
  if (existing && ENGAGED.has(existing.status)) {
    await addEvent(db, existing.id, 'yondr-feedback', null, `Feedback changed (now ${item.type}, ${item.priority}). The fix already under way is not changed.`);
    return { status: 200, body: { ok: true, autofix: existing, decision: 'unchanged' } };
  }

  const repo = item.project ? PROJECT_REPOS[item.project] || null : null;
  const target = repo ? AUTOFIX_TARGETS[repo] : null;
  // Only bugs from known projects are worth classifying. An admin's "Mark objective / subjective" sticks.
  let classification = null;
  let classifiedBy = null;
  if (item.type === 'bug' && repo) {
    if (existing && existing.classification && existing.classified_by && existing.classified_by !== 'ai') {
      classification = { classification: existing.classification, reason: existing.classification_reason || 'Marked by an admin.' };
      classifiedBy = existing.classified_by;
    } else {
      classification = await classifyFn(env, item);
      classifiedBy = 'ai';
    }
  }
  const d = decide({ item, repo, target, classification, settings, startedLastHour: await startedSince(db, new Date(nowMs - 3_600_000).toISOString()),
    budget: await loadBudget(db, settings, nowMs) });
  const payload = JSON.stringify({ ...item, expected: classification && classification.expected || null, actual: classification && classification.actual || null });
  const f = {
    project: item.project, repo: repo || UNKNOWN_REPO, title: titleOf(item), severity: item.priority, status: d.status,
    classification: classification ? classification.classification : null,
    classification_reason: classification ? String(classification.reason || '').slice(0, 1000) : null,
    classified_by: classifiedBy, payload,
  };
  let id;
  if (existing) {
    id = existing.id;
    const keys = Object.keys(f);
    await db.prepare(`UPDATE autofixes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).bind(...keys.map((k) => f[k]), now, id).run();
  } else {
    const row = await db.prepare(`INSERT INTO autofixes (feedback_id, project, repo, title, classification, classification_reason, classified_by, severity,
      status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(item.feedback_id, f.project, f.repo, f.title, f.classification, f.classification_reason, f.classified_by, f.severity, f.status, payload, now, now).first();
    id = row.id;
  }
  const how = classification ? ` Classified ${classification.classification}${classifiedBy === 'ai' ? ` by Workers AI${classification.confidence != null ? ` (confidence ${Number(classification.confidence).toFixed(2)})` : ''}` : ' by an admin'}.` : '';
  await addEvent(db, id, 'triage', d.status, `Feedback #${item.feedback_id} ${existing ? 'changed' : 'received'} (${item.type}, ${item.priority}, project ${item.project || 'none'}).${how} ${d.message}`);
  let started = false;
  if (d.start) started = await startFix(env, id, { settings, nowMs });
  const entry = await db.prepare('SELECT * FROM autofixes WHERE id = ?').bind(id).first();
  return { status: existing ? 200 : 201, body: { ok: true, autofix: entry, decision: d.status, started } };
}

// ------------------------------------------------------------------------------------------------- the GitHub issue
const quote = (s) => String(s).split('\n').map((l) => `> ${l}`).join('\n');
/** Markdown-safe user text: no HTML (so no fake markers), no @mentions (nobody gets pinged). */
const safe = (s) => scrub(s).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@(?=[\w-])/g, '@​');

export const GUARDRAILS = [
  'Fix ONLY the bug described here. Make the smallest change that fixes it; no refactors, no unrelated clean-ups.',
  'Follow the repository\'s CLAUDE.md. Visitors must not see any other change.',
  'Never change sign-in (`auth/`, any `*yondr-session.js`, the Worker\'s sign-in check), Wrangler config, `.github/`, migrations, `package.json` / lockfiles (no new dependencies), `_headers`, CLAUDE.md.',
  'At most 200 changed lines in at most 10 files. The `autofix-guard` check enforces these limits and paths.',
  'Run the repository\'s build and checks; they must pass.',
  'If it is not clearly an objective bug with a clear fix, or you are not confident, change nothing and say "needs a human".',
];

/** The issue text. Pure. No personal data: the repositories are public. */
export function issueBody(entry, item) {
  const lines = [
    `<!-- yondr-ops:autofix-id=${entry.id} -->`,
    `**Automatic fix requested by Yondr Ops** for feedback #${item.feedback_id} (project \`${item.project}\`, priority **${item.priority}**). ` +
      'This issue was opened by the ops engine; its `autofix` label starts the auto-fix workflow. Only the label added by the ops account counts.',
    '',
    '## The bug, as reported',
    '',
    item.title ? quote(`**${safe(item.title)}**`) + '\n>' : null,
    quote(safe(item.message)),
    '',
    item.url ? `- **Page:** ${safe(item.url)}` : null,
    item.path && !item.url ? `- **Path:** \`${safe(item.path).replace(/`/g, '')}\`` : null,
    item.page_title ? `- **Page title:** ${safe(item.page_title)}` : null,
    item.asset ? `- **Asset:** \`${safe(item.asset).replace(/`/g, '')}\`` : null,
    item.screenshots && item.screenshots.length ? `- **Screenshots:** ${item.screenshots.length} in the feedback tool (sign-in required; not available to the workflow)` : null,
    '',
    '## Expected vs actual',
    '',
    `- **Expected:** ${item.expected ? safe(item.expected) : 'not stated: work it out from the report, or say "needs a human".'}`,
    `- **Actual:** ${item.actual ? safe(item.actual) : 'see the report above.'}`,
    '',
    '## Classification',
    '',
    `Objective (${entry.classified_by === 'ai' ? 'Workers AI' : 'an admin'}): ${safe(entry.classification_reason || '')}`,
    '',
    '## Rules for the fix',
    '',
    ...GUARDRAILS.map((g) => `- ${g}`),
    '',
    `Log and revert: ${DASHBOARD_URL}/#autofix/${entry.id}`,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

async function lastEventMessage(db, id) {
  const r = await db.prepare('SELECT message FROM autofix_events WHERE autofix_id = ? ORDER BY id DESC LIMIT 1').bind(id).first();
  return r ? r.message : null;
}

/** Open the GitHub issue for one queued objective bug. Returns true when the issue is open and labelled. */
export async function startFix(env, id, { settings, nowMs = Date.now() } = {}) {
  const db = env.DB;
  settings = settings || await getSettings(db);
  const entry = await db.prepare('SELECT * FROM autofixes WHERE id = ?').bind(id).first();
  if (!entry || entry.status !== 'queued' || entry.classification !== 'objective' || !settings.autofix_enabled) return false;
  const target = AUTOFIX_TARGETS[entry.repo];
  if (!target || !target.workflow) return false;
  // Spending (src/budget.js): paused, or one more fix could pass the budget → stays queued.
  const budget = await loadBudget(db, settings, nowMs);
  if (!budget.can_start) {
    const msg = budget.paused
      ? `Can't start: auto-fix is paused because this month's spend (${usd(budget.spent)}) reached the pause level (${usd(budget.pause_at)}). Stays queued until an owner approves more spend.`
      : `Can't start yet: with the fixes in progress, this month's spend could pass the ${usd(budget.effective)} budget. Stays queued.`;
    if (await lastEventMessage(db, id) !== msg) await addEvent(db, id, 'yondr-ops', 'queued', msg);
    return false;
  }
  if (!env.GITHUB_TOKEN) {
    const msg = 'Can\'t start: the GITHUB_TOKEN secret is not set (README "Auto-fix" → setup). Stays queued.';
    if (await lastEventMessage(db, id) !== msg) await addEvent(db, id, 'yondr-ops', 'queued', msg);
    return false;
  }
  const now = new Date(nowMs).toISOString();
  // Claim it, so the cron and a critical start can't both open an issue.
  const claim = await db.prepare("UPDATE autofixes SET status = 'fixing', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'").bind(now, now, id).run();
  if (!claim.meta || !claim.meta.changes) return false;
  const item = itemOf(entry);
  let issue = null;
  try {
    issue = await gh(env, 'POST', `/repos/${entry.repo}/issues`, { title: `Auto-fix: ${entry.title}`.slice(0, 250), body: issueBody(entry, item) });
    // The label is added separately, so the workflow sees exactly one `labeled` event, from the ops account.
    const labels = ['autofix', ...(entry.severity === 'critical' ? ['autofix-critical'] : [])];
    await gh(env, 'POST', `/repos/${entry.repo}/issues/${issue.number}/labels`, { labels });
    await db.prepare('UPDATE autofixes SET issue_url = ?, updated_at = ? WHERE id = ?').bind(issue.html_url, now, id).run();
    await addEvent(db, id, 'yondr-ops', 'fixing', `Opened issue #${issue.number} (${issue.html_url}) with label ${labels.join(' + ')}: the repository's auto-fix workflow starts.`);
    const updated = await db.prepare('SELECT * FROM autofixes WHERE id = ?').bind(id).first();
    await alertFor(env, updated, 'autofix_started', settings, { detail: `Issue: ${issue.html_url}`, done: 'A GitHub issue was opened; Claude Code works on it in a pull request, which merges by itself only if every check passes.' });
    return true;
  } catch (e) {
    const attempts = (entry.attempts || 0) + 1;
    if (issue) {
      // The issue exists but the workflow won't start without its label: hand over to a person.
      await db.prepare("UPDATE autofixes SET status = 'failed', issue_url = ?, attempts = ?, updated_at = ? WHERE id = ?").bind(issue.html_url, attempts, now, id).run();
      await addEvent(db, id, 'yondr-ops', 'failed', `Opened issue #${issue.number} but couldn't label it (${e.message}). Add the autofix label by hand, or fix it yourself.`);
    } else if (attempts >= AUTOFIX.maxAttempts) {
      await db.prepare("UPDATE autofixes SET status = 'failed', started_at = NULL, attempts = ?, updated_at = ? WHERE id = ?").bind(attempts, now, id).run();
      await addEvent(db, id, 'yondr-ops', 'failed', `Couldn't open the GitHub issue (${e.message}); gave up after ${attempts} attempts.`);
    } else {
      await db.prepare("UPDATE autofixes SET status = 'queued', started_at = NULL, attempts = ?, updated_at = ? WHERE id = ?").bind(attempts, now, id).run();
      await addEvent(db, id, 'yondr-ops', 'queued', `Couldn't open the GitHub issue (${e.message}); will try again (attempt ${attempts} of ${AUTOFIX.maxAttempts}).`);
      return false;
    }
    const updated = await db.prepare('SELECT * FROM autofixes WHERE id = ?').bind(id).first();
    await alertFor(env, updated, 'autofix_failed', settings, { detail: `Couldn't start the fix: ${e.message}` });
    return false;
  }
}

/** The 5-minute run: start queued objective bugs within the hourly limits. */
export async function processQueue(env, { nowMs = Date.now(), settings } = {}) {
  const db = env.DB;
  settings = settings || await getSettings(db);
  if (!settings.autofix_enabled) return { skipped: 'auto-fix switched off' };
  if (!env.GITHUB_TOKEN) return { skipped: 'GITHUB_TOKEN not set' };
  const budget = await loadBudget(db, settings, nowMs);
  if (budget.paused) return { skipped: 'paused: monthly budget' };
  let started = await startedSince(db, new Date(nowMs - 3_600_000).toISOString());
  const { results } = await db.prepare(`SELECT id, severity FROM autofixes WHERE status = 'queued' AND classification = 'objective'
    ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, created_at LIMIT ?`).bind(AUTOFIX.perRun * 3).all();
  const out = { started: 0, waiting: 0 };
  for (const r of results) {
    if (out.started >= AUTOFIX.perRun) { out.waiting++; continue; }
    const limit = r.severity === 'critical' ? AUTOFIX.hardCapPerHour : Math.min(settings.autofix_max_per_hour, AUTOFIX.hardCapPerHour);
    if (started >= limit) { out.waiting++; continue; }
    if (await startFix(env, r.id, { settings, nowMs })) { started++; out.started++; }
  }
  return out;
}

/** POST /api/autofix/:id/classify (admin): "Mark objective / Mark subjective". Logged with the admin as actor. */
export async function reclassify(env, id, classification, actor, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  if (classification !== 'objective' && classification !== 'subjective') return { status: 422, body: { error: 'classification must be objective or subjective.' } };
  const entry = await db.prepare('SELECT * FROM autofixes WHERE id = ?').bind(id).first();
  if (!entry) return { status: 404, body: { error: 'No such auto-fix.' } };
  if (entry.status !== 'queued' && entry.status !== 'triaged') return { status: 409, body: { error: `Only items waiting for a decision can be reclassified (this one is "${entry.status}").` } };
  const item = itemOf(entry);
  if (item.type !== 'bug') return { status: 409, body: { error: 'Only bugs can be fixed automatically. Change the type in the feedback tool first.' } };
  const settings = await getSettings(db);
  const repo = entry.repo !== UNKNOWN_REPO ? entry.repo : null;
  const reason = `Marked ${classification} by an admin.`;
  const d = decide({ item, repo, target: repo ? AUTOFIX_TARGETS[repo] : null, classification: { classification, reason }, settings,
    startedLastHour: await startedSince(db, new Date(nowMs - 3_600_000).toISOString()), budget: await loadBudget(db, settings, nowMs) });
  const now = new Date(nowMs).toISOString();
  await db.prepare('UPDATE autofixes SET classification = ?, classification_reason = ?, classified_by = ?, status = ?, updated_at = ? WHERE id = ?')
    .bind(classification, reason, actor, d.status, now, id).run();
  await addEvent(db, id, actor, d.status, `${reason} ${d.message}`);
  await db.prepare('INSERT INTO audit (actor, action, detail, created_at) VALUES (?, ?, ?, ?)').bind(actor, 'autofix.classify', JSON.stringify({ id, classification }), now).run();
  if (d.start) await startFix(env, id, { settings, nowMs });
  return { status: 200, body: { ok: true, decision: d.status } };
}
