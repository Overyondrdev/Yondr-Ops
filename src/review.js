// Quarterly access review (README "People & permissions → Access review"). On the first weekday (Mon–Fri, UTC) of
// January, April, July and October, the daily backup run opens the issue "Quarterly access review <year> Q<n>",
// assigned to an owner and announced to every owner: a checklist of everyone with an admin-type role in any tool, with
// when they were last seen; people not seen for 90 days (or never) are flagged. Once per quarter.
import { ownerEmails } from './alerts.js';
import { createIssue } from './issues.js';
import { directory, reviewList, STALE_DAYS } from './people.js';
import { getInternal, setInternal } from './settings.js';

const QUARTER_MONTHS = [0, 3, 6, 9];

/** The first weekday (UTC) of a month, as YYYY-MM-DD. Pure. */
export function firstWeekday(year, month) {
  for (let d = 1; d <= 3; d++) {
    const day = new Date(Date.UTC(year, month, d)).getUTCDay();
    if (day !== 0 && day !== 6) return new Date(Date.UTC(year, month, d)).toISOString().slice(0, 10);
  }
  return null;
}

/** Is today (UTC) the first weekday of a quarter? Pure. */
export function isReviewDay(nowMs) {
  const d = new Date(nowMs);
  return QUARTER_MONTHS.includes(d.getUTCMonth()) && firstWeekday(d.getUTCFullYear(), d.getUTCMonth()) === d.toISOString().slice(0, 10);
}

/** The next review date (today if today is one). Pure. */
export function nextReviewDate(nowMs) {
  const d = new Date(nowMs);
  const today = d.toISOString().slice(0, 10);
  for (let i = 0; i < 6; i++) {
    const y = d.getUTCFullYear() + Math.floor((d.getUTCMonth() + i) / 12);
    const m = (d.getUTCMonth() + i) % 12;
    if (!QUARTER_MONTHS.includes(m)) continue;
    const day = firstWeekday(y, m);
    if (day >= today) return day;
  }
  return null;
}

export const quarterOf = (nowMs) => { const d = new Date(nowMs); return `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`; };

export function reviewChecklist(list) {
  const lines = ['Check every person below still needs their access. Remove what is no longer needed in each tool (People & permissions → the person → "Remove from all tools").', ''];
  for (const p of list) {
    const roles = Object.entries(p.roles).map(([t, r]) => `${t}: ${r}`).join(', ');
    lines.push(`[ ] ${p.name ? `${p.name} <${p.email}>` : p.email} — ${roles} — last seen ${p.last_seen ? p.last_seen.slice(0, 10) : 'never'}${p.stale ? ` — NOT SEEN FOR ${STALE_DAYS}+ DAYS` : ''}`);
  }
  if (!list.length) lines.push('(Nobody has an admin-type role.)');
  return lines.join('\n');
}

/** Called every day from the backup cron. Returns the issue id when one was opened. */
export async function maybeQuarterlyReview(env, { nowMs = Date.now(), settings, force = false } = {}) {
  if (!force && !isReviewDay(nowMs)) return null;
  const db = env.DB;
  const key = `access_review:${quarterOf(nowMs)}`;
  if (!force && await getInternal(db, key)) return null;
  await setInternal(db, key, new Date(nowMs).toISOString());
  const list = reviewList((await directory(env)).people, nowMs);
  const owners = [...await ownerEmails(env).catch(() => new Set())].sort();
  const issue = await createIssue(env, {
    title: `Quarterly access review ${quarterOf(nowMs)}`, source: 'security', source_ref: `access-review:${quarterOf(nowMs)}`, priority: 'normal',
    assignee_email: owners[0] || null, due_at: new Date(nowMs + 14 * 86_400_000).toISOString().slice(0, 10),
    description: reviewChecklist(list), created_message: 'Created automatically: first weekday of the quarter.',
  }, 'yondr-ops', { settings, nowMs, notifyAll: owners });
  return issue.id;
}
