// People & permissions (README "People & permissions").
// A directory of everyone ops knows: the ONE admin list (feedback tool's `admins`, read-only), alert subscribers,
// issue assignees, and the people & roles of the ad library and marketing requests (their `users` tables, read-only).
// Only name, email, role and "last seen" are ever shown.
//
// Feedback-tool and Ops roles (owner / admin) are changed THROUGH THE FEEDBACK TOOL'S OWN API, on behalf of the signed-in
// admin: ops calls https://feedback.overyondrdev.com/api/admins (GET / POST { email, role } / DELETE { email }) with that
// person's own yondr_session cookie, X-Yondr-Feedback: 1 and Origin: https://ops.overyondrdev.com, so the feedback
// tool applies its own rules (only owners change owners, nobody removes themselves …). Ops never writes FEEDBACK_DB.
// The call goes over the service binding FEEDBACK (Worker yondr-feedback: no public egress, no same-zone loop); without
// the binding (tests, local) it falls back to a plain fetch of the public host. Every change is audited with the actor.
// Other tools' roles are read-only here, with a "Manage in <tool>" link.
import { cleanEmail } from './issues.js';
import { readOnly } from './readonly.js';
import { TOOLS } from './checks.js';
import { readCookie, SESSION_COOKIE } from './yondr-session.js';

export const FEEDBACK_ADMINS_URL = 'https://feedback.overyondrdev.com/api/admins';
export const OPS_ORIGIN = 'https://ops.overyondrdev.com';
export const STALE_DAYS = 90;
const DAY = 86_400_000;

const safe = async (fn, fallback = []) => { try { return await fn(); } catch { return fallback; } };

/** Remember when someone last used ops (at most one write every 10 minutes per person). */
export async function touchSeen(db, email, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  const tenAgo = new Date(nowMs - 10 * 60_000).toISOString();
  await db.prepare(`INSERT INTO ops_seen (email, last_seen_at) VALUES (?, ?)
    ON CONFLICT(email) DO UPDATE SET last_seen_at = excluded.last_seen_at WHERE ops_seen.last_seen_at < ?`).bind(email, now, tenAgo).run();
}

/** Everyone, merged by email. */
export async function directory(env) {
  const db = env.DB;
  const fb = readOnly(env.FEEDBACK_DB);
  const ads = readOnly(env.ADS_DB);
  const req = readOnly(env.REQUESTS_DB);
  const [admins, fbSeen, adsUsers, reqUsers, { results: subs }, { results: assignees }, { results: opsSeen }] = await Promise.all([
    fb ? safe(async () => (await fb.prepare('SELECT email, role, added_at FROM admins ORDER BY email').all()).results) : [],
    fb ? safe(async () => (await fb.prepare('SELECT actor AS email, MAX(created_at) AS last FROM activity GROUP BY actor').all()).results) : [],
    ads ? safe(async () => (await ads.prepare('SELECT email, role, last_seen_at FROM users ORDER BY email').all()).results, null) : null,
    req ? safe(async () => (await req.prepare('SELECT email, name, role, active, last_seen_at FROM users ORDER BY email').all()).results, null) : null,
    db.prepare('SELECT email, name, active FROM subscribers').all(),
    db.prepare('SELECT DISTINCT assignee_email AS email FROM issues WHERE assignee_email IS NOT NULL').all(),
    db.prepare('SELECT email, last_seen_at FROM ops_seen').all(),
  ]);
  const people = new Map();
  const get = (email) => {
    const e = String(email || '').toLowerCase();
    if (!e || !e.includes('@')) return null;
    if (!people.has(e)) people.set(e, { email: e, name: null, roles: {}, alerts: false, assignee: false, last_seen: {} });
    return people.get(e);
  };
  for (const a of admins) { const p = get(a.email); if (p) p.roles.feedback = a.role; }
  for (const s of fbSeen) { const p = people.get(String(s.email || '').toLowerCase()); if (p) p.last_seen.feedback = s.last; }
  for (const u of adsUsers || []) { const p = get(u.email); if (p) { p.roles.ads = u.role; if (u.last_seen_at) p.last_seen.ads = u.last_seen_at; } }
  for (const u of reqUsers || []) {
    const p = get(u.email);
    if (!p) continue;
    p.roles.requests = u.active === 0 ? `${u.role} (inactive)` : u.role;
    if (u.name && !p.name) p.name = u.name;
    if (u.last_seen_at) p.last_seen.requests = u.last_seen_at;
  }
  for (const s of subs) { const p = get(s.email); if (p) { p.alerts = !!s.active; if (s.name && !p.name) p.name = s.name; } }
  for (const a of assignees) { const p = get(a.email); if (p) p.assignee = true; }
  for (const s of opsSeen) { const p = people.get(s.email); if (p) p.last_seen.ops = s.last_seen_at; }
  const list = [...people.values()].map((p) => ({ ...p, last_seen_any: Object.values(p.last_seen).sort().pop() || null }))
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  return { people: list, tools: TOOLS, sources: { ads: adsUsers !== null, requests: reqUsers !== null } };
}

/** Privileged roles that the quarterly access review looks at. */
const PRIVILEGED = { feedback: ['owner', 'admin'], ads: ['admin', 'editor'], requests: ['admin', 'lead', 'marketing'] };

/** Everyone with an admin-type role in any tool, with last seen; not seen in 90 days (or never) = flagged. Pure. */
export function reviewList(people, nowMs = Date.now()) {
  const out = [];
  for (const p of people) {
    const roles = Object.entries(p.roles).filter(([tool, role]) => (PRIVILEGED[tool] || []).includes(String(role).replace(' (inactive)', '')));
    if (!roles.length) continue;
    const last = p.last_seen_any;
    const stale = !last || nowMs - Date.parse(last) > STALE_DAYS * DAY;
    out.push({ email: p.email, name: p.name, roles: Object.fromEntries(roles), last_seen: last, stale });
  }
  return out.sort((a, b) => Number(b.stale) - Number(a.stale) || a.email.localeCompare(b.email));
}

// ------------------------------------------------------------------------------------- feedback/ops admins (proxy)
/** Forward one call to the feedback tool's admin API as the signed-in person. Returns { status, body }. */
export async function feedbackAdmins(env, request, method, payload = null) {
  const headers = { accept: 'application/json', 'x-yondr-feedback': '1', origin: OPS_ORIGIN };
  const token = readCookie(request, SESSION_COOKIE);
  if (token) headers.cookie = `${SESSION_COOKIE}=${token}`; // only the sign-in cookie, nothing else of the browser's
  if (payload) headers['content-type'] = 'application/json';
  const req = new Request(FEEDBACK_ADMINS_URL, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
  let res;
  try { res = env.FEEDBACK ? await env.FEEDBACK.fetch(req) : await fetch(req); }
  catch (e) { return { status: 502, body: { error: `Couldn't reach the feedback tool: ${e.message}` } }; }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { status: 200, body: data };
  const why = res.status === 401 ? 'The feedback tool did not accept your sign-in (this only works on ops.overyondrdev.com with the Yondr sign-in).'
    : data.error || `The feedback tool answered ${res.status}.`;
  return { status: res.status === 401 ? 401 : res.status >= 500 ? 502 : res.status, body: { error: why, from: 'feedback' } };
}

/** POST/DELETE an admin through the feedback tool, audited either way. */
export async function changeFeedbackAdmin(env, request, actor, method, b) {
  const email = cleanEmail(b && b.email, env);
  if (!email) return { status: 422, body: { error: 'Use a work address (@overyondr.com).' } };
  const role = b && b.role === 'owner' ? 'owner' : 'admin';
  const payload = method === 'POST' ? { email, role } : { email };
  const r = await feedbackAdmins(env, request, method, payload);
  await env.DB.prepare('INSERT INTO audit (actor, action, detail, created_at) VALUES (?, ?, ?, ?)').bind(actor,
    method === 'POST' ? 'permission.feedback_admin.set' : 'permission.feedback_admin.remove',
    JSON.stringify({ email, role: method === 'POST' ? role : undefined, result: r.status === 200 ? 'done' : `refused (${r.status}): ${r.body.error}` }), new Date().toISOString()).run();
  return r;
}
