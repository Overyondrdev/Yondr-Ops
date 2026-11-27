// The Yondr people directory (sign-in Worker yondr-auth, KV namespace `yondr-directory`, synced from the Yondr Team
// Contact List 4 times a day; overyondr-website-v1 auth/README.md "People directory"). Ops only READS it, through the
// DIRECTORY binding: never put, delete or anything else that writes (scripts/check.mjs enforces it). The status
// endpoint on auth.overyondrdev.com needs a signed-in session, which the monitor doesn't have, so ops reads the KV.
//   directory:meta  { ok, error, guard, last_ok, last_attempt, active, inactive, skipped_rows, history,
//                     last_change: { at, added[], removed[], changed[] } }  (emails only, no names)
//   directory:v1    { updated, people: [{ name, email, title, active }] }  (read only to name people in the digest)
// evaluateDirectory() and directoryDigestLine() are pure (tested); the rest only reads.
import { DIRECTORY } from './checks.js';

export const KV_META = 'directory:meta';
export const KV_DATA = 'directory:v1';
const ID = 'directory:sync';
const SITE = 'People directory';
const HOUR = 3_600_000;

const hoursAgo = (iso, nowMs) => Math.max(0, Math.round((nowMs - Date.parse(iso)) / HOUR));
const utc = (iso) => `${String(iso).slice(0, 16).replace('T', ' ')} UTC`;

/** The sync status as a check result. meta = the parsed directory:meta value (null if missing). */
export function evaluateDirectory(meta, nowMs, cfg = DIRECTORY) {
  const base = { id: ID, site: SITE };
  const error = meta && meta.error ? String(meta.error) : '';
  if (!meta || !meta.last_ok || /not set up/i.test(error)) {
    return { ...base, ok: null, detail: /not set up/i.test(error) || !error ? 'Directory not set up yet (service account key missing).'
      : `Directory not set up yet: it has never synced. Last attempt: ${error}` };
  }
  if (meta.guard) {
    return { ...base, ok: false, event: 'config_drift', severity: 'warning', fingerprint: 'guard',
      title: 'People directory update held back',
      detail: `The latest sync of the Yondr Team Contact List was not applied because too many people would have been removed at once. ${error} The directory still has the list from ${utc(meta.last_ok)}.` };
  }
  if (meta.ok === false) {
    return { ...base, ok: false, event: 'config_drift', severity: 'warning', fingerprint: 'error',
      title: 'People directory sync is failing',
      detail: `The latest sync of the Yondr Team Contact List failed: ${error || 'no reason given'} Last good sync: ${utc(meta.last_ok)}. Name and email autofill still uses that list.` };
  }
  const age = hoursAgo(meta.last_ok, nowMs);
  if (nowMs - Date.parse(meta.last_ok) > cfg.staleHours * HOUR) {
    return { ...base, ok: false, event: 'config_drift', severity: 'warning', fingerprint: 'stale',
      title: 'People directory is out of date',
      detail: `The directory last synced ${age} hours ago (${utc(meta.last_ok)}); it should sync 4 times a day. Check the yondr-auth Worker's cron and logs.` };
  }
  const skipped = (meta.skipped_rows || []).length;
  return { ...base, ok: true, detail: `${meta.active ?? '?'} people, last updated ${utc(meta.last_ok)}${skipped ? ` (${skipped} sheet row${skipped > 1 ? 's' : ''} without a valid work email skipped)` : ''}.` };
}

/** Digest line(s): people count, and who was added/removed since the previous digest. Pure. Names, never in issues. */
export function directoryDigestLine(meta, people, sinceIso) {
  if (!meta || !meta.last_ok) return ['Directory: not set up yet.'];
  const status = meta.guard ? ' Last update held back (too many removals).' : meta.ok === false ? ' Last sync failed.' : '';
  const lines = [`Directory: ${meta.active ?? '?'} people.${status}`];
  const c = meta.last_change;
  if (c && c.at && (!sinceIso || c.at > sinceIso)) {
    const byEmail = new Map((people || []).map((p) => [p.email, p.name]));
    const names = (list) => (list || []).map((e) => byEmail.get(e) || e);
    const short = (list) => (list.length > 10 ? `${list.slice(0, 10).join(', ')} and ${list.length - 10} more` : list.join(', '));
    const added = names(c.added);
    const removed = names(c.removed);
    if (added.length) lines.push(`• Added: ${short(added)}`);
    if (removed.length) lines.push(`• Left: ${short(removed)}`);
  }
  return lines;
}

/** directory:meta, or null (no binding or nothing stored). */
export async function readMeta(env) {
  if (!env.DIRECTORY) return null;
  return env.DIRECTORY.get(KV_META, 'json');
}

/** All people (inactive included, so people who left still have a name). */
export async function readPeople(env) {
  if (!env.DIRECTORY) return [];
  const d = await env.DIRECTORY.get(KV_DATA, 'json');
  return (d && d.people) || [];
}

export async function directoryCheck(env, nowMs = Date.now()) {
  if (!env.DIRECTORY) return { id: ID, site: SITE, ok: null, detail: 'No DIRECTORY binding (wrangler.jsonc).' };
  try {
    return evaluateDirectory(await readMeta(env), nowMs);
  } catch (e) {
    return { id: ID, site: SITE, ok: null, detail: `Couldn't read the directory status: ${e && e.message}` };
  }
}

/** For the Overview: one line. */
export async function directorySummary(env, nowMs = Date.now()) {
  if (!env.DIRECTORY) return { bound: false };
  const meta = await readMeta(env);
  const r = evaluateDirectory(meta, nowMs);
  return { bound: true, status: r.ok === true ? 'ok' : r.ok === false ? 'fail' : 'unknown', title: r.title || null, detail: r.detail,
    active: meta ? meta.active ?? null : null, last_ok: meta ? meta.last_ok || null : null };
}
