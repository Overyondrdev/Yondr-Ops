// Server-to-server endpoints (other Workers, GitHub Actions, the future auto-fix engine). They carry no sign-in
// cookie; instead they send the shared secret OPS_INGEST_TOKEN in the X-Ops-Token header.
//   POST /api/events            raise an event (validated, de-duplicated, routed to subscribers)
//   POST /api/autofix/events    create/update an auto-fix log entry (src/autofix.js)
//   GET  /api/autofix/config    the auto-fix kill switch (also readable by signed-in admins)
import { dispatch, EVENTS, SEVERITIES } from './alerts.js';
import { getSettings } from './settings.js';

export const TOKEN_HEADER = 'x-ops-token';
export const TOKEN_ROUTES = new Set(['POST /api/events', 'POST /api/autofix/events', 'GET /api/autofix/config']);

/** Constant-time comparison of the presented token with OPS_INGEST_TOKEN. */
export async function hasIngestToken(request, env) {
  const given = request.headers.get(TOKEN_HEADER) || '';
  const want = env.OPS_INGEST_TOKEN || '';
  if (!want || want.length < 32 || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(want))]);
  const x = new Uint8Array(a); const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Validate an incoming event. Returns { event } or { error }. Pure. */
export function validateEvent(b) {
  if (!b || typeof b !== 'object') return { error: 'Send a JSON object.' };
  const type = str(b.type, 40);
  if (!EVENTS[type]) return { error: `Unknown type. Use one of: ${Object.keys(EVENTS).join(', ')}.` };
  const severity = b.severity == null ? EVENTS[type].severity : str(b.severity, 20);
  if (!SEVERITIES.includes(severity)) return { error: `Unknown severity. Use one of: ${SEVERITIES.join(', ')}.` };
  const title = str(b.title, 200);
  if (!title) return { error: 'title is required.' };
  const url = b.url == null ? null : str(b.url, 500);
  if (url && !/^https:\/\//.test(url)) return { error: 'url must start with https://' };
  const site = str(b.site, 100) || null;
  return { event: {
    type, severity, title, site, url,
    message: str(b.message, 4000) || null,
    source: str(b.source, 60) || 'external',
    dedupe_key: str(b.dedupe_key, 200) || `${type}|${site || ''}|${title}`,
  } };
}

export async function ingestEvent(env, body, nowMs = Date.now()) {
  const db = env.DB;
  const v = validateEvent(body);
  if (v.error) return { status: 422, body: { error: v.error } };
  const e = v.event;
  const settings = await getSettings(db);
  const hourAgo = new Date(nowMs - 3_600_000).toISOString();
  const recent = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE created_at > ?').bind(hourAgo).first();
  if (recent.n >= 300) return { status: 429, body: { error: 'Too many events in the last hour.' } };
  const windowStart = new Date(nowMs - settings.event_dedupe_minutes * 60_000).toISOString();
  const dup = await db.prepare("SELECT id FROM events WHERE dedupe_key = ? AND status = 'routed' AND created_at > ? LIMIT 1").bind(e.dedupe_key, windowStart).first();
  const now = new Date(nowMs).toISOString();
  const row = await db.prepare(`INSERT INTO events (type, severity, source, site, title, message, url, dedupe_key, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(e.type, e.severity, e.source, e.site, e.title, e.message, e.url, e.dedupe_key, dup ? 'duplicate' : 'routed', now).first();
  if (dup) return { status: 200, body: { ok: true, id: row.id, duplicate: true, duplicate_of: dup.id } };
  const sent = await dispatch(env, {
    type: e.type, kind: 'event', severity: e.severity, title: e.title, site: e.site, detail: e.message,
    done: `Reported by ${e.source}.`, link: e.url || undefined, event_id: row.id,
  }, { settings, nowMs });
  return { status: 201, body: { ok: true, id: row.id, duplicate: false, recipients: sent.email.length + sent.slack.length } };
}
