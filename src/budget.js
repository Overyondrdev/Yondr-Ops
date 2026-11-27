// Auto-fix spending: the owner's rules (overyondr-website-v1 docs/OPERATIONS.md §6.3, README "Auto-fix → Spending").
// Auto-fix runs Claude Code with a Claude API key, paid per use. Every workflow run reports what it cost
// (POST /api/autofix/events → cost_usd / cost_unknown), stored in autofix_costs. Per calendar month (UTC):
//   - budget        autofix_monthly_budget_usd (default $50) + what owners approved this month = the effective budget
//   - warnings      autofix_budget_warning at autofix_warn_first_pct / autofix_warn_second_pct (50 % / 70 %) of the
//                   effective budget, once per threshold per month
//   - forecast      spent / days elapsed (at least 3) × days in the month + $2 per fix queued or in progress;
//                   above the effective budget → autofix_budget_projection, at most once a day
//   - pause         spent ≥ budget × autofix_pause_at_pct (90 % = $45) + approved extra → auto-fix is PAUSED:
//                   triage still classifies and queues, nothing starts, GET /api/autofix/config answers
//                   { autofix_enabled: false, reason: "budget" } so a workflow that starts anyway stops at its gate.
//                   autofix_budget_paused tells the owners, who approve more (owners only, ≤ $100 at a time,
//                   current month only) → autofix_budget_approved.
// A run whose cost can't be read counts as BUDGET.unknownRunUsd ($2). All alerts here go to owners always, quiet
// hours or not (src/alerts.js EVENTS).
import { dispatch } from './alerts.js';
import { DASHBOARD_URL } from './checks.js';

export const BUDGET = {
  unknownRunUsd: 2,     // a run that reported no readable cost counts as this much
  estimateUsd: 2,       // forecast and start check: what one fix queued or in progress is expected to cost
  minDaysElapsed: 3,    // the forecast never divides by less than 3 days (no wild forecasts on the 1st)
  defaultApprovalUsd: 25,
  maxApprovalUsd: 100,  // per approval
};
export const SPEND_LINK = `${DASHBOARD_URL}/#autofix/spend`;
const DAY = 86_400_000;

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const usd = (n) => `$${round2(n).toFixed(2)}`;
/** Calendar month (UTC) of a time: "2026-11". */
export const monthOf = (nowMs) => new Date(nowMs).toISOString().slice(0, 7);
export function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
export function daysInMonth(nowMs) {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}
/** Days since the 1st of the month 00:00 UTC (fractional). */
export function daysElapsed(nowMs) {
  const d = new Date(nowMs);
  return (nowMs - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) / DAY;
}
/** What one recorded run counts for: its cost, or the conservative default when the cost is unknown. */
export const countedCost = (row) => (row.unknown || row.cost_usd == null || !Number.isFinite(Number(row.cost_usd)) ? BUDGET.unknownRunUsd : Number(row.cost_usd));

/**
 * The month's budget picture. Pure.
 * @param settings     autofix_monthly_budget_usd, autofix_pause_at_pct, autofix_warn_first_pct, autofix_warn_second_pct
 * @param spent        recorded cost this month (unknown runs already counted at $2)
 * @param approvedExtra  sum of this month's owner approvals
 * @param queued       objective fixes waiting to start
 * @param running      fixes in progress (issue opened, no cost reported yet)
 */
export function computeBudget({ settings, spent = 0, approvedExtra = 0, queued = 0, running = 0, nowMs = Date.now() }) {
  const budget = round2(settings.autofix_monthly_budget_usd);
  const effective = round2(budget + approvedExtra);
  const pauseAt = round2(budget * settings.autofix_pause_at_pct / 100 + approvedExtra);
  const dim = daysInMonth(nowMs);
  const elapsed = Math.min(dim, Math.max(BUDGET.minDaysElapsed, daysElapsed(nowMs)));
  const pending = round2((queued + running) * BUDGET.estimateUsd);
  const forecast = round2(spent / elapsed * dim + pending);
  const paused = spent >= pauseAt;
  const warnings = [settings.autofix_warn_first_pct, settings.autofix_warn_second_pct]
    .filter((p) => Number.isFinite(p)).sort((a, b) => a - b)
    .map((pct) => ({ pct, at: round2(effective * pct / 100), reached: spent >= effective * pct / 100 }));
  // A new fix starts only if, with every fix in progress costing the usual estimate, the month stays within budget.
  const canStart = !paused && spent + (running + 1) * BUDGET.estimateUsd <= effective;
  return {
    month: monthOf(nowMs), budget, approved_extra: round2(approvedExtra), effective, pause_at: pauseAt, pause_pct: settings.autofix_pause_at_pct,
    spent: round2(spent), forecast, pending, queued, running, days_elapsed: Math.round(daysElapsed(nowMs) * 10) / 10, days_in_month: dim,
    over_forecast: forecast > effective, paused, can_start: canStart, warnings,
  };
}

/** Load this month's numbers from D1 and compute the picture. */
export async function loadBudget(db, settings, nowMs = Date.now()) {
  const month = monthOf(nowMs);
  const [costs, approvals, counts] = await Promise.all([
    db.prepare('SELECT SUM(CASE WHEN unknown = 1 OR cost_usd IS NULL THEN ? ELSE cost_usd END) AS spent, COUNT(*) AS runs FROM autofix_costs WHERE month = ?')
      .bind(BUDGET.unknownRunUsd, month).first(),
    db.prepare('SELECT SUM(approved_extra_usd) AS extra FROM autofix_budget_approvals WHERE month = ?').bind(month).first(),
    db.prepare("SELECT SUM(CASE WHEN status = 'fixing' THEN 1 ELSE 0 END) AS running, SUM(CASE WHEN status = 'queued' AND classification = 'objective' THEN 1 ELSE 0 END) AS queued FROM autofixes").first(),
  ]);
  return {
    ...computeBudget({ settings, spent: (costs && costs.spent) || 0, approvedExtra: (approvals && approvals.extra) || 0,
      queued: (counts && counts.queued) || 0, running: (counts && counts.running) || 0, nowMs }),
    runs: (costs && costs.runs) || 0,
  };
}

/** What a workflow run reported. Never rejects: a cost that can't be read counts as unknown ($2). Pure. */
export function parseCost(b) {
  if (!b || (b.cost_usd === undefined && b.cost_unknown === undefined)) return null;
  const n = typeof b.cost_usd === 'number' ? b.cost_usd : typeof b.cost_usd === 'string' && /^\d{1,4}(\.\d{1,8})?$/.test(b.cost_usd) ? Number(b.cost_usd) : NaN;
  const ok = b.cost_unknown !== true && Number.isFinite(n) && n >= 0 && n <= 1000;
  const runKey = typeof b.run_id === 'string' && /^[\w.-]{1,80}$/.test(b.run_id) ? b.run_id : null;
  return { cost_usd: ok ? Math.round(n * 10000) / 10000 : null, unknown: !ok, run_key: runKey };
}

/** Store one run's cost (once per autofix + run id), then check the budget alerts. */
export async function recordCost(env, autofixId, cost, { settings, nowMs = Date.now() } = {}) {
  const db = env.DB;
  const now = new Date(nowMs).toISOString();
  const key = cost.run_key || `ingest-${nowMs}-${Math.random().toString(36).slice(2, 10)}`;
  const r = await db.prepare('INSERT OR IGNORE INTO autofix_costs (autofix_id, run_key, month, run_at, cost_usd, unknown) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(autofixId, key, monthOf(nowMs), now, cost.unknown ? null : cost.cost_usd, cost.unknown ? 1 : 0).run();
  const stored = !!(r.meta && r.meta.changes);
  if (stored && settings) await checkBudget(env, settings, { nowMs }).catch((e) => console.error('budget check failed', e && e.stack));
  return stored;
}

async function claim(db, key, nowMs) {
  const r = await db.prepare('INSERT OR IGNORE INTO autofix_budget_alerts (key, created_at) VALUES (?, ?)').bind(key, new Date(nowMs).toISOString()).run();
  return !!(r.meta && r.meta.changes);
}

function summaryLines(b) {
  return [
    `Spent so far in ${monthLabel(b.month)}: ${usd(b.spent)} of the ${usd(b.effective)} budget${b.approved_extra ? ` (${usd(b.budget)} plus ${usd(b.approved_extra)} approved by an owner)` : ''}.`,
    `Forecast for the whole month: ${usd(b.forecast)} (at the pace so far${b.pending ? `, plus about ${usd(b.pending)} for ${b.queued + b.running} fix${b.queued + b.running === 1 ? '' : 'es'} waiting or in progress` : ''}).`,
    `Auto-fix pauses itself at ${usd(b.pause_at)} and then waits for an owner to approve more.`,
  ];
}

/**
 * Send the budget alerts that are due (each at most once: per threshold per month, projection per day, pause per
 * pause level). Called after every reported cost and by the 5-minute auto-fix run. Returns the alert types sent.
 */
export async function checkBudget(env, settings, { nowMs = Date.now(), budget } = {}) {
  const db = env.DB;
  const b = budget || await loadBudget(db, settings, nowMs);
  const sent = [];
  const send = async (type, severity, title, extra, done) => {
    await dispatch(env, { type, kind: 'event', severity, title, site: 'Auto-fix (Claude API)', detail: [...summaryLines(b), '', ...extra].join('\n').trim(), done, link: SPEND_LINK }, { settings, nowMs });
    sent.push(type);
  };
  const reached = b.warnings.filter((w) => w.reached);
  if (b.paused && await claim(db, `paused:${b.month}:${b.pause_at}`, nowMs)) {
    // The pause message covers the warnings: don't send those as well.
    for (const w of reached) await claim(db, `warn:${b.month}:${w.pct}`, nowMs);
    await send('autofix_budget_paused', 'high', `Auto-fix paused: ${usd(b.spent)} of this month's ${usd(b.effective)} budget spent`, [
      'What is paused: no new automatic fixes start, and a fix that was about to start stops at its first step. Bug reports are still sorted and queued, and fixes that are already live are not affected.',
      `To carry on this month, an owner approves more spend (up to ${usd(BUDGET.maxApprovalUsd)} at a time): open the link below, then Auto-fixes → Spend → "Approve more spend this month". Without approval it starts again on the 1st of next month.`,
    ], 'Auto-fix paused itself. Nothing else needs doing unless you want it to carry on this month.');
    return sent;
  }
  if (!b.paused && reached.length) {
    const fresh = [];
    for (const w of reached) if (await claim(db, `warn:${b.month}:${w.pct}`, nowMs)) fresh.push(w);
    const top = fresh[fresh.length - 1];
    if (top) {
      await send('autofix_budget_warning', 'warning', `Auto-fix spending at ${top.pct} % of this month's budget (${usd(b.spent)} of ${usd(b.effective)})`, [],
        'Nothing is paused yet: auto-fixes keep running. This is an early warning, sent once per level each month.');
    }
  }
  if (!b.paused && b.over_forecast && await claim(db, `projection:${new Date(nowMs).toISOString().slice(0, 10)}`, nowMs)) {
    await send('autofix_budget_projection', 'warning', `Auto-fix spending is on course for ${usd(b.forecast)} this month, over the ${usd(b.effective)} budget`, [
      'Nothing is paused yet. If spending carries on like this, auto-fix will pause itself when it reaches the pause level, and an owner can then approve more.',
      'To slow it down now: lower "Auto-fixes started per hour" in Settings, or switch the auto-fix engine off.',
    ], 'Nothing yet: this is a forecast. You get at most one of these a day.');
  }
  return sent;
}

/** POST /api/autofix/budget/approve (owners only; CSRF checked in src/index.js). */
export async function approveSpend(env, amount, actor, { settings, nowMs = Date.now() } = {}) {
  const db = env.DB;
  const n = amount === undefined || amount === null || amount === '' ? BUDGET.defaultApprovalUsd : Number(amount);
  if (!Number.isInteger(n) || n < 1 || n > BUDGET.maxApprovalUsd) return { status: 422, body: { error: `Approve a whole number of dollars from 1 to ${BUDGET.maxApprovalUsd}.` } };
  const month = monthOf(nowMs);
  const now = new Date(nowMs).toISOString();
  const before = await loadBudget(db, settings, nowMs);
  await db.prepare('INSERT INTO autofix_budget_approvals (month, approved_extra_usd, approved_by, approved_at) VALUES (?, ?, ?, ?)').bind(month, n, actor, now).run();
  await db.prepare('INSERT INTO audit (actor, action, detail, created_at) VALUES (?, ?, ?, ?)')
    .bind(actor, 'autofix.budget.approve', JSON.stringify({ month, approved_extra_usd: n, spent: before.spent, was_paused: before.paused }), now).run();
  const after = await loadBudget(db, settings, nowMs);
  await dispatch(env, {
    type: 'autofix_budget_approved', kind: 'event', severity: 'info', site: 'Auto-fix (Claude API)', link: SPEND_LINK,
    title: `More auto-fix spend approved for ${monthLabel(month)}: +${usd(n)}`,
    detail: [`${actor} approved ${usd(n)} more for ${monthLabel(month)}. This month's budget is now ${usd(after.effective)}.`, ...summaryLines(after).slice(0, 2),
      `Auto-fix ${before.paused && !after.paused ? 'carries on again' : after.paused ? 'is still paused (spending is still above the new pause level)' : 'keeps running'}; it pauses again at ${usd(after.pause_at)}. The approval is for this month only.`,
      `If approvals take this month past the Claude Console spend limit, raise that limit in Claude Console too (README "Auto-fix → Spending").`].join('\n'),
    done: 'Recorded in the audit log.',
  }, { settings, nowMs }).catch((e) => console.error('approval alert failed', e && e.stack));
  return { status: 200, body: { ok: true, budget: after } };
}

/** GET /api/autofix/spend (admins): the Spend panel. */
export async function spendReport(db, settings, nowMs = Date.now()) {
  const month = monthOf(nowMs);
  const [budget, { results: approvals }, { results: costs }] = await Promise.all([
    loadBudget(db, settings, nowMs),
    db.prepare('SELECT id, month, approved_extra_usd, approved_by, approved_at FROM autofix_budget_approvals WHERE month = ? ORDER BY id').bind(month).all(),
    db.prepare(`SELECT c.autofix_id, c.run_at, c.cost_usd, c.unknown, a.title, a.repo, a.status FROM autofix_costs c LEFT JOIN autofixes a ON a.id = c.autofix_id
      WHERE c.month = ? ORDER BY c.run_at DESC LIMIT 200`).bind(month).all(),
  ]);
  return { budget, approvals, costs: costs.map((c) => ({ ...c, unknown: !!c.unknown, counted_usd: countedCost(c) })),
    limits: { default_approval_usd: BUDGET.defaultApprovalUsd, max_approval_usd: BUDGET.maxApprovalUsd, unknown_run_usd: BUDGET.unknownRunUsd } };
}

/** GET /api/autofix/config: the workflow gate. Off when switched off OR paused for budget. */
export async function autofixConfig(db, settings, nowMs = Date.now()) {
  const budget = await loadBudget(db, settings, nowMs);
  const enabled = settings.autofix_enabled && !budget.paused;
  return { autofix_enabled: enabled, reason: !settings.autofix_enabled ? 'switched_off' : budget.paused ? 'budget' : null, budget };
}

/** One line for the daily digest. */
export function digestLine(b) {
  return `Auto-fix spend in ${monthLabel(b.month)}: ${usd(b.spent)} of ${usd(b.effective)} (forecast ${usd(b.forecast)})${b.paused ? '. PAUSED: waiting for an owner to approve more' : b.over_forecast ? '. Forecast is over budget' : ''}.`;
}
