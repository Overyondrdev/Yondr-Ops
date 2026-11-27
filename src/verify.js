// What happens after the auto-fix workflow opened a pull request (every 5 minutes, src/index.js):
//   fixing   no pull request after AUTOFIX.engineTimeoutMinutes → failed ("the engine gave up").
//   pr_open  backstop for the repository's autofix-report workflow: asks GitHub whether the PR merged (→ merged, with
//            merge_sha) or was closed without merging (→ failed).
//   merged / deployed  verification: the target Worker's next production build of merge_sha (Workers Builds API,
//            CF_API_TOKEN) and the site's signed-out checks (the 5-minute monitoring, GATE). If the build of the fix
//            fails, or one of the repository's site checks starts failing after the merge → automatic revert (the
//            same code as the dashboard's Revert button, actor "auto-revert") and autofix_reverted. If everything stays
//            fine for AUTOFIX.verifyMinutes after the deploy → verified, and autofix_merged says what was checked.
import { addEvent, alertFor, revertAutofix } from './autofix.js';
import { AUTOFIX, AUTOFIX_TARGETS, GATE } from './checks.js';
import { buildForCommit } from './cloudflare.js';
import { gh } from './github.js';
import { ensureSchema } from './schema.js';
import { getSettings } from './settings.js';
import { processQueue } from './triage.js';

const MIN = 60_000;
const siteOf = (id) => (GATE.find((g) => g.id === id) || {}).site || id;

/**
 * The verification verdict for one merged fix. Pure.
 * @param entry    the autofixes row (status merged | deployed, merged_at set)
 * @param build    { checked: false, reason } | { checked: true, build: null | { outcome, created_on } }
 * @param failing  site checks of this repository that started failing (or opened an incident) after the merge:
 *                 [{ id, site, since }]
 * @returns { action: 'revert' | 'deployed' | 'verified' | 'wait', reason?, detail? }
 */
export function verdict(entry, build, failing, { nowMs, monitoring = true }) {
  const merged = Date.parse(entry.merged_at);
  if (failing.length) {
    return { action: 'revert', reason: `${failing.map((f) => f.site).join(', ')} started failing after the fix was merged (${failing.map((f) => f.id).join(', ')}).` };
  }
  if (build.checked && build.build && build.build.outcome === 'failed') {
    return { action: 'revert', reason: `The production build of the fix (${entry.merge_sha.slice(0, 7)}) failed, so it is not live.` };
  }
  const checked = [];
  let liveSince = entry.deployed_at ? Date.parse(entry.deployed_at) : null;
  if (!liveSince) {
    if (build.checked && build.build && build.build.outcome === 'success') {
      return { action: 'deployed', detail: `Production build of ${entry.merge_sha.slice(0, 7)} succeeded.` };
    }
    if (build.checked && (!build.build || build.build.outcome === 'running')) {
      if (nowMs - merged < AUTOFIX.buildWaitMinutes * MIN) return { action: 'wait' };
      checked.push(`no production build of ${entry.merge_sha.slice(0, 7)} was seen within ${AUTOFIX.buildWaitMinutes} minutes (deploy not confirmed)`);
    } else if (!build.checked) {
      checked.push(`deploy not watched (${build.reason})`);
    } else {
      checked.push(`build ended "${build.build.outcome}"`);
    }
    liveSince = merged;
  } else {
    checked.push(`production build of ${entry.merge_sha.slice(0, 7)} succeeded`);
  }
  if (nowMs - liveSince < AUTOFIX.verifyMinutes * MIN) return { action: 'wait' };
  const gates = (AUTOFIX_TARGETS[entry.repo] || {}).gates || [];
  if (gates.length) checked.push(monitoring ? `site checks stayed fine for ${AUTOFIX.verifyMinutes}+ minutes: ${gates.map(siteOf).join(', ')}` : 'site checks NOT run (monitoring is switched off)');
  else checked.push('no site checks for this repository');
  return { action: 'verified', detail: `Checked: ${checked.join('; ')}.` };
}

async function failingSince(db, gates, sinceIso) {
  if (!gates.length) return [];
  const marks = gates.map(() => '?').join(',');
  const { results: states } = await db.prepare(`SELECT check_id, site, since FROM check_state WHERE status = 'fail' AND since >= ? AND check_id IN (${marks})`).bind(sinceIso, ...gates).all();
  const { results: incidents } = await db.prepare(`SELECT check_id, site, opened_at FROM incidents WHERE opened_at >= ? AND check_id IN (${marks})`).bind(sinceIso, ...gates).all();
  const seen = new Map();
  for (const s of states) seen.set(s.check_id, { id: s.check_id, site: s.site || siteOf(s.check_id), since: s.since });
  for (const i of incidents) if (!seen.has(i.check_id)) seen.set(i.check_id, { id: i.check_id, site: i.site || siteOf(i.check_id), since: i.opened_at });
  return [...seen.values()];
}

const prNumber = (url) => { const m = /\/pull\/(\d+)/.exec(url || ''); return m ? Number(m[1]) : null; };

/** The 5-minute auto-fix watch. Bounded by AUTOFIX.watchPerRun GitHub/Cloudflare lookups per run. */
export async function watchFixes(env, { nowMs = Date.now(), settings, buildFn = buildForCommit } = {}) {
  const db = env.DB;
  settings = settings || await getSettings(db);
  const now = new Date(nowMs).toISOString();
  const out = { timed_out: 0, merged: 0, closed: 0, deployed: 0, verified: 0, reverted: 0 };
  let lookups = 0;

  // 1. Issues the engine never answered.
  const { results: stale } = await db.prepare("SELECT * FROM autofixes WHERE status = 'fixing' AND pr_url IS NULL AND started_at < ?")
    .bind(new Date(nowMs - AUTOFIX.engineTimeoutMinutes * MIN).toISOString()).all();
  for (const e of stale) {
    await db.prepare("UPDATE autofixes SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'fixing'").bind(now, e.id).run();
    await addEvent(db, e.id, 'yondr-ops', 'failed', `No pull request ${AUTOFIX.engineTimeoutMinutes / 60} hours after the issue was opened: the engine gave up or the workflow didn't run. A person takes over${e.issue_url ? ` (${e.issue_url})` : ''}.`);
    await alertFor(env, { ...e, status: 'failed' }, 'autofix_failed', settings, { detail: 'No pull request was opened in time.' });
    out.timed_out++;
  }

  // 2. Open pull requests: did they merge? (The autofix-report workflow usually says so first.)
  if (env.GITHUB_TOKEN) {
    const { results: open } = await db.prepare("SELECT * FROM autofixes WHERE status IN ('pr_open', 'checks_failed') AND pr_url IS NOT NULL ORDER BY updated_at LIMIT ?")
      .bind(AUTOFIX.watchPerRun).all();
    for (const e of open) {
      const n = prNumber(e.pr_url);
      if (!n || lookups >= AUTOFIX.watchPerRun) continue;
      lookups++;
      let pr;
      try { pr = await gh(env, 'GET', `/repos/${e.repo}/pulls/${n}`); } catch (err) { console.error('autofix pr lookup failed', e.id, err.message); continue; }
      if (pr.merged && pr.merge_commit_sha) {
        await db.prepare("UPDATE autofixes SET status = 'merged', merge_sha = ?, merged_at = COALESCE(merged_at, ?), updated_at = ? WHERE id = ?")
          .bind(pr.merge_commit_sha.toLowerCase(), pr.merged_at || now, now, e.id).run();
        await addEvent(db, e.id, 'yondr-ops', 'merged', `Pull request #${n} merged (${pr.merge_commit_sha.slice(0, 7)}). Watching the deploy and the site for ${AUTOFIX.verifyMinutes} minutes.`);
        out.merged++;
      } else if (pr.state === 'closed') {
        await db.prepare("UPDATE autofixes SET status = 'failed', updated_at = ? WHERE id = ?").bind(now, e.id).run();
        await addEvent(db, e.id, 'yondr-ops', 'failed', `Pull request #${n} was closed without merging. A person takes over.`);
        await alertFor(env, { ...e, status: 'failed' }, 'autofix_failed', settings, { detail: `Pull request #${n} was closed without merging.` });
        out.closed++;
      }
    }
  }

  // 3. Merged fixes: verify, or revert.
  const { results: live } = await db.prepare("SELECT * FROM autofixes WHERE status IN ('merged', 'deployed') AND merge_sha IS NOT NULL AND revert_pr_url IS NULL ORDER BY updated_at LIMIT ?")
    .bind(AUTOFIX.watchPerRun).all();
  const cache = new Map();
  for (const e of live) {
    if (!e.merged_at) {
      await db.prepare('UPDATE autofixes SET merged_at = ? WHERE id = ?').bind(now, e.id).run();
      e.merged_at = now;
    }
    const target = AUTOFIX_TARGETS[e.repo] || { worker: null, gates: [] };
    const build = e.deployed_at ? { checked: true, build: { outcome: 'success' } } : await buildFn(env, target.worker, e.merge_sha, cache);
    const failing = await failingSince(db, target.gates || [], e.merged_at);
    const v = verdict(e, build, failing, { nowMs, monitoring: settings.monitoring_enabled });
    if (v.action === 'deployed') {
      await db.prepare("UPDATE autofixes SET status = 'deployed', deployed_at = ?, updated_at = ? WHERE id = ?").bind(now, now, e.id).run();
      await addEvent(db, e.id, 'yondr-ops', 'deployed', `${v.detail} Live; watching the site for ${AUTOFIX.verifyMinutes} minutes.`);
      out.deployed++;
    } else if (v.action === 'verified') {
      await db.prepare("UPDATE autofixes SET status = 'verified', verified_at = ?, verify_detail = ?, updated_at = ? WHERE id = ?").bind(now, v.detail, now, e.id).run();
      await addEvent(db, e.id, 'yondr-ops', 'verified', `Verified. ${v.detail}`);
      const updated = await db.prepare('SELECT * FROM autofixes WHERE id = ?').bind(e.id).first();
      await alertFor(env, updated, 'autofix_merged', settings, { detail: v.detail, done: 'The fix is live. Any admin can still revert it in one click.' });
      out.verified++;
    } else if (v.action === 'revert') {
      await addEvent(db, e.id, 'auto-revert', e.status, `Reverting automatically: ${v.reason}`);
      const r = await revertAutofix(env, e.id, 'auto-revert');
      if (r.status === 200) { out.reverted++; continue; }
      // Couldn't revert (e.g. someone changed the same files since): stop watching, hand over to a person.
      await db.prepare("UPDATE autofixes SET status = 'failed', verify_detail = ?, updated_at = ? WHERE id = ?").bind(`Automatic revert failed: ${r.body.error}`, now, e.id).run();
      await addEvent(db, e.id, 'auto-revert', 'failed', `Automatic revert not possible: ${r.body.error} Revert it in GitHub${e.pr_url ? ` (${e.pr_url})` : ''}.`);
      const updated = await db.prepare('SELECT * FROM autofixes WHERE id = ?').bind(e.id).first();
      await alertFor(env, updated, 'autofix_failed', settings, { severity: 'critical', detail: `${v.reason}\nAutomatic revert not possible: ${r.body.error}`,
        done: `Nothing could be undone automatically. Use the Revert button on the pull request in GitHub${e.pr_url ? `: ${e.pr_url}` : ''}.` });
    }
  }
  return out;
}

/** The auto-fix part of the 5-minute run (its own cron, so it has its own subrequest budget). */
export async function runAutofix(env, { nowMs = Date.now() } = {}) {
  await ensureSchema(env.DB);
  const settings = await getSettings(env.DB);
  const watch = await watchFixes(env, { nowMs, settings });
  const queue = await processQueue(env, { nowMs, settings });
  return { watch, queue };
}
