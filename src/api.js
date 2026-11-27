// The dashboard API (/api/*). Every route here runs for a signed-in ADMIN only (checked in src/index.js; staff who aren't
// admins only reach GET /api/me and GET /api/status/public there);
// owner-only routes say so. State changes carry the CSRF header (src/http.js) and are written to the audit log.
import { availableWebhooks, DEFAULT_EVENTS, dispatch, EVENT_TYPES, EVENTS, MIN_SEVERITY, ownerEmails, validQuietTime, validTimeZone, WEBHOOK_NAME } from './alerts.js';
import { getAutofix, listAutofixes, revertAutofix } from './autofix.js';
import { BACKUP_DATABASES, runBackups } from './backups.js';
import { approveSpend, autofixConfig, spendReport } from './budget.js';
import { staticChecks } from './checks.js';
import { json } from './http.js';
import { runMonitor } from './monitor.js';
import { reclassify } from './triage.js';
import { getSettings, SETTINGS, setSetting, validate } from './settings.js';
import { deploysReport, rollback } from './deploys.js';
import { runDrills } from './drill.js';
import { errorsReport } from './errors.js';
import { commentIssue, createIssue, getIssue, issueFromFeedback, listIssues, updateIssue, validateIssue } from './issues.js';
import { keysReport, validateKey } from './keys.js';
import { overview } from './overview.js';
import { changeFeedbackAdmin, directory, reviewList, STALE_DAYS } from './people.js';
import { maybeQuarterlyReview, nextReviewDate } from './review.js';
import { publicStatus } from './status.js';

const audit = (db, actor, action, detail = {}) =>
  db.prepare('INSERT INTO audit (actor, action, detail, created_at) VALUES (?, ?, ?, ?)').bind(actor, action, JSON.stringify(detail), new Date().toISOString()).run();
const body = (request) => request.json().catch(() => ({}));
const ownerOnly = () => json({ error: 'Only owners can do this.' }, 403);

async function status(env) {
  const db = env.DB;
  const now = new Date().toISOString();
  const [{ results: states }, { results: mutes }, monitorRun, backupRun, open, settings] = await Promise.all([
    db.prepare('SELECT * FROM check_state').all(),
    db.prepare('SELECT * FROM mutes WHERE until > ? AND ended_at IS NULL').bind(now).all(),
    db.prepare("SELECT * FROM runs WHERE kind = 'monitor' ORDER BY id DESC LIMIT 1").first(),
    db.prepare("SELECT * FROM runs WHERE kind = 'backup' ORDER BY id DESC LIMIT 1").first(),
    db.prepare('SELECT COUNT(*) AS n FROM incidents WHERE resolved_at IS NULL').first(),
    getSettings(db),
  ]);
  const byId = new Map(states.map((s) => [s.check_id, s]));
  const muteBy = new Map(mutes.map((m) => [m.check_id, m]));
  const known = staticChecks();
  const ids = new Set(known.map((c) => c.id));
  const kindOf = (id) => (id.startsWith('build:') ? 'deploy' : id.startsWith('cf:usage') ? 'usage' : id.startsWith('errors:') ? 'errors' : id.startsWith('cf:') ? 'cloudflare' : 'gate');
  const checks = [
    ...known,
    ...states.filter((s) => !ids.has(s.check_id)).map((s) => ({ id: s.check_id, site: s.site, kind: kindOf(s.check_id) })),
  ].map((c) => ({ ...c, state: byId.get(c.id) || null, mute: muteBy.get(c.id) || null }));
  return json({
    checks, open_incidents: open.n, last_monitor: monitorRun, last_backup: backupRun,
    switches: { monitoring_enabled: settings.monitoring_enabled, alerts_enabled: settings.alerts_enabled, backups_enabled: settings.backups_enabled, autofix_enabled: settings.autofix_enabled },
    cloudflare_token: !!env.CF_API_TOKEN,
  });
}

// ---------------------------------------------------------------------------------------------------- people & rules
/** Validate a person's settings. Returns { fields, rules } or { error }. Pure (exported for tests). */
export function validateSubscriber(b, env, { creating }) {
  const f = {};
  if (creating || b.email !== undefined) {
    const email = String(b.email || '').trim().toLowerCase();
    const domains = String(env.ALLOWED_EMAIL_DOMAINS || 'overyondr.com').split(',').map((d) => d.trim()).filter(Boolean);
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email) || !domains.includes(email.split('@')[1])) return { error: `Use a work address ending in @${domains.join(' or @')}.` };
    f.email = email;
  }
  if (b.name !== undefined) f.name = String(b.name || '').trim().slice(0, 80) || null;
  if (b.active !== undefined) f.active = b.active ? 1 : 0;
  if (b.min_severity !== undefined) { if (!MIN_SEVERITY[b.min_severity]) return { error: 'Choose which severities this person gets.' }; f.min_severity = b.min_severity; }
  for (const k of ['quiet_start', 'quiet_end']) {
    if (b[k] !== undefined) { if (!validQuietTime(b[k])) return { error: 'Quiet hours are times like 22:00.' }; f[k] = b[k] || null; }
  }
  if (b.timezone !== undefined) { if (!b.timezone || !validTimeZone(b.timezone)) return { error: 'Unknown time zone.' }; f.timezone = b.timezone; }
  let rules;
  if (b.rules !== undefined || creating) {
    const raw = b.rules === undefined ? DEFAULT_EVENTS.map((e) => ({ event_type: e, channel: 'email' })) : b.rules;
    if (!Array.isArray(raw) || raw.length > 200) return { error: 'rules must be a list.' };
    const hooks = new Set(availableWebhooks(env));
    const seen = new Set();
    rules = [];
    for (const r of raw) {
      if (!r || !EVENTS[r.event_type]) return { error: `Unknown alert type ${r && r.event_type}.` };
      if (r.channel !== 'email' && r.channel !== 'slack') return { error: 'Channel must be email or slack.' };
      const webhook = r.channel === 'slack' ? String(r.webhook || '') : '';
      if (r.channel === 'slack' && (!WEBHOOK_NAME.test(webhook) || !hooks.has(webhook))) return { error: `Slack webhook ${webhook || '(none)'} isn't configured. Add it as a secret first (README "Slack").` };
      const key = `${r.event_type}|${r.channel}|${webhook}`;
      if (!seen.has(key)) { seen.add(key); rules.push({ event_type: r.event_type, channel: r.channel, webhook }); }
    }
  }
  return { fields: f, rules };
}

async function saveRules(db, id, rules) {
  if (!rules) return;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('DELETE FROM subscriptions WHERE subscriber_id = ?').bind(id),
    ...rules.map((r) => db.prepare('INSERT INTO subscriptions (subscriber_id, event_type, channel, webhook, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, r.event_type, r.channel, r.webhook, now)),
  ]);
}

async function people(env) {
  const db = env.DB;
  const [{ results: subscribers }, { results: subs }, owners] = await Promise.all([
    db.prepare('SELECT * FROM subscribers ORDER BY active DESC, COALESCE(name, email)').all(),
    db.prepare('SELECT subscriber_id, event_type, channel, webhook FROM subscriptions').all(),
    ownerEmails(env).catch(() => new Set()),
  ]);
  return json({
    people: subscribers.map((s) => ({ ...s, owner: owners.has(s.email), rules: subs.filter((r) => r.subscriber_id === s.id) })),
    owners_without_entry: [...owners].filter((o) => !subscribers.some((s) => s.email === o)).length,
    events: EVENT_TYPES.map((t) => ({ type: t, ...EVENTS[t] })),
    default_events: DEFAULT_EVENTS, min_severity: MIN_SEVERITY, webhooks: availableWebhooks(env),
  });
}

// ---------------------------------------------------------------------------------------------------- router
export async function handleApi(request, env, ctx, route, user) {
  const db = env.DB;
  const m = request.method;
  const me = user.email;
  const owner = user.role === 'owner';
  let p;

  if (m === 'GET' && route === 'me') return json({ email: me, name: user.name, role: user.role });
  if (m === 'GET' && route === 'status') return status(env);

  if (m === 'POST' && route === 'checks/run') {
    const last = await db.prepare("SELECT started_at FROM runs WHERE kind = 'monitor' ORDER BY id DESC LIMIT 1").first();
    if (last && Date.now() - Date.parse(last.started_at) < 60_000) return json({ error: 'Checks ran less than a minute ago. Try again shortly.' }, 429);
    await audit(db, me, 'checks.run');
    return json({ ok: true, summary: await runMonitor(env, { force: true }) });
  }
  if ((p = route.match(/^checks\/([\w:.-]{1,80})\/mute$/))) {
    const id = p[1];
    if (m === 'POST') {
      const b = await body(request);
      const hours = Number(b.hours);
      const reason = String(b.reason || '').trim().slice(0, 200);
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) return json({ error: 'Mute for 1 to 168 hours.' }, 422);
      if (!reason) return json({ error: 'Say why (it is logged).' }, 422);
      const now = new Date();
      await db.prepare('UPDATE mutes SET ended_at = ?, ended_by = ? WHERE check_id = ? AND ended_at IS NULL').bind(now.toISOString(), me, id).run();
      const until = new Date(now.getTime() + hours * 3_600_000).toISOString();
      await db.prepare('INSERT INTO mutes (check_id, until, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, until, reason, me, now.toISOString()).run();
      await audit(db, me, 'check.mute', { id, hours, reason });
      return json({ ok: true, until });
    }
    if (m === 'DELETE') {
      await db.prepare('UPDATE mutes SET ended_at = ?, ended_by = ? WHERE check_id = ? AND ended_at IS NULL').bind(new Date().toISOString(), me, id).run();
      await audit(db, me, 'check.unmute', { id });
      return json({ ok: true });
    }
  }

  if (m === 'GET' && route === 'incidents') {
    const { results } = await db.prepare('SELECT * FROM incidents ORDER BY resolved_at IS NOT NULL, opened_at DESC LIMIT 200').all();
    const { results: mutes } = await db.prepare('SELECT * FROM mutes ORDER BY id DESC LIMIT 50').all();
    return json({ incidents: results, mutes });
  }
  if (m === 'GET' && route === 'alerts') {
    const { results } = await db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 200').all();
    const { results: events } = await db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all();
    return json({ alerts: results.map((a) => ({ ...a, recipients: JSON.parse(a.recipients) })), events });
  }

  if (m === 'GET' && route === 'people') return people(env);
  if (m === 'POST' && route === 'people') {
    const v = validateSubscriber(await body(request), env, { creating: true });
    if (v.error) return json({ error: v.error }, 422);
    if (await db.prepare('SELECT id FROM subscribers WHERE email = ?').bind(v.fields.email).first()) return json({ error: 'This person is already on the list.' }, 409);
    const now = new Date().toISOString();
    const f = { min_severity: 'all', timezone: 'UTC', active: 1, ...v.fields };
    const row = await db.prepare(`INSERT INTO subscribers (email, name, active, min_severity, quiet_start, quiet_end, timezone, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(f.email, f.name ?? null, f.active, f.min_severity, f.quiet_start ?? null, f.quiet_end ?? null, f.timezone, me, now, now).first();
    await saveRules(db, row.id, v.rules);
    await audit(db, me, 'person.add', { email: f.email, rules: v.rules.length });
    return json({ ok: true, id: row.id }, 201);
  }
  if ((p = route.match(/^people\/(\d+)$/))) {
    const id = Number(p[1]);
    const prev = await db.prepare('SELECT * FROM subscribers WHERE id = ?').bind(id).first();
    if (!prev) return json({ error: 'No such person.' }, 404);
    if (m === 'PATCH') {
      const v = validateSubscriber(await body(request), env, { creating: false });
      if (v.error) return json({ error: v.error }, 422);
      delete v.fields.email; // a different address is a different person
      const keys = Object.keys(v.fields);
      if (keys.length) await db.prepare(`UPDATE subscribers SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).bind(...keys.map((k) => v.fields[k]), new Date().toISOString(), id).run();
      await saveRules(db, id, v.rules);
      await audit(db, me, 'person.update', { email: prev.email, fields: keys, rules: v.rules ? v.rules.length : undefined });
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      await db.batch([db.prepare('DELETE FROM subscriptions WHERE subscriber_id = ?').bind(id), db.prepare('DELETE FROM subscribers WHERE id = ?').bind(id)]);
      await audit(db, me, 'person.remove', { email: prev.email });
      return json({ ok: true });
    }
  }
  if (m === 'POST' && route === 'alerts/test') {
    const b = await body(request);
    const s = await db.prepare('SELECT * FROM subscribers WHERE id = ?').bind(Number(b.id)).first();
    if (!s) return json({ error: 'No such person.' }, 404);
    const { results: rules } = await db.prepare("SELECT DISTINCT webhook FROM subscriptions WHERE subscriber_id = ? AND channel = 'slack'").bind(s.id).all();
    const out = await dispatch(env, {
      type: 'daily_digest', kind: 'test', severity: 'info', title: 'Test alert from Yondr Ops', site: 'Yondr Ops',
      detail: `${me} sent this test from the ops dashboard to check that alerts reach ${s.name || s.email}.`, done: 'Nothing: this is only a test.',
    }, { settings: await getSettings(db), recipients: { email: [s.email], slack: rules.map((r) => r.webhook), skipped: [] } });
    await audit(db, me, 'alerts.test', { to: s.email });
    return json({ ok: out.failed === 0, ...out }, out.failed ? 502 : 200);
  }

  if (m === 'GET' && route === 'backups') {
    const { results } = await db.prepare('SELECT * FROM backups ORDER BY id DESC LIMIT 300').all();
    return json({ backups: results, databases: BACKUP_DATABASES.map((d) => ({ name: d.name, pii: !!d.pii, bound: !!env[d.binding] })), bucket: !!env.BACKUPS });
  }
  if (m === 'POST' && route === 'backups/run') {
    const last = await db.prepare("SELECT started_at FROM runs WHERE kind = 'backup' ORDER BY id DESC LIMIT 1").first();
    if (last && Date.now() - Date.parse(last.started_at) < 10 * 60_000) return json({ error: 'A backup ran less than 10 minutes ago.' }, 429);
    await audit(db, me, 'backups.run');
    const job = runBackups(env, { force: true }).catch((e) => console.error('manual backup failed', e && e.stack));
    if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    return json({ ok: true, started: true }, 202);
  }
  if (m === 'GET' && (p = route.match(/^backups\/(\d+)\/download$/))) {
    const b = await db.prepare('SELECT * FROM backups WHERE id = ?').bind(Number(p[1])).first();
    if (!b || b.status !== 'ok' || b.deleted_at || !b.object_key) return json({ error: 'That backup is not available.' }, 404);
    if (b.pii && !owner) return json({ error: 'This backup holds personal data: only owners can download it.' }, 403);
    const obj = await env.BACKUPS.get(b.object_key);
    if (!obj) return json({ error: 'The backup file is missing from storage.' }, 404);
    await audit(db, me, 'backup.download', { db: b.db, day: b.day, pii: !!b.pii });
    return new Response(obj.body, { headers: {
      'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${b.db}-${b.day}.sql.gz"`,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(obj.size ? { 'content-length': String(obj.size) } : {}),
    } });
  }

  if (m === 'GET' && route === 'autofix') return json({ autofixes: await listAutofixes(db, { status: new URL(request.url).searchParams.get('status') }) });
  if (m === 'GET' && route === 'autofix/config') {
    const s = await getSettings(db);
    const c = await autofixConfig(db, s);
    return json({ autofix_enabled: c.autofix_enabled, switched_on: s.autofix_enabled, reason: c.reason, autofix_max_per_hour: s.autofix_max_per_hour, budget: c.budget });
  }
  if (m === 'GET' && route === 'autofix/spend') return json(await spendReport(db, await getSettings(db)));
  if (m === 'POST' && route === 'autofix/budget/approve') {
    if (!owner) return ownerOnly();
    const b = await body(request);
    const r = await approveSpend(env, b.amount_usd, me, { settings: await getSettings(db) });
    return json(r.body, r.status);
  }
  if (m === 'GET' && (p = route.match(/^autofix\/(\d+)$/))) {
    const a = await getAutofix(db, Number(p[1]));
    return a ? json({ autofix: a }) : json({ error: 'No such auto-fix.' }, 404);
  }
  if (m === 'GET' && (p = route.match(/^autofix\/by-feedback\/(\d+)$/))) {
    const a = await db.prepare('SELECT id FROM autofixes WHERE feedback_id = ? ORDER BY id DESC LIMIT 1').bind(Number(p[1])).first();
    return a ? json({ autofix: await getAutofix(db, a.id) }) : json({ error: 'Ops has nothing for this feedback item yet.' }, 404);
  }
  if (m === 'POST' && (p = route.match(/^autofix\/(\d+)\/classify$/))) {
    const b = await body(request);
    const r = await reclassify(env, Number(p[1]), b.classification, me);
    return json(r.body, r.status);
  }
  if (m === 'POST' && (p = route.match(/^autofix\/(\d+)\/revert$/))) {
    const r = await revertAutofix(env, Number(p[1]), me);
    return json(r.body, r.status);
  }

  if (m === 'GET' && route === 'settings') {
    const { results: auditRows } = await db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all();
    return json({ settings: await getSettings(db), definitions: SETTINGS, audit: auditRows, transport_default: env.EMAIL_TRANSPORT || 'cloudflare',
      secrets: { CF_API_TOKEN: !!env.CF_API_TOKEN, CF_DEPLOY_TOKEN: !!env.CF_DEPLOY_TOKEN, GITHUB_TOKEN: !!env.GITHUB_TOKEN, OPS_INGEST_TOKEN: !!env.OPS_INGEST_TOKEN,
        RESEND_API_KEY: !!env.RESEND_API_KEY, EMAIL_BINDING: !!env.EMAIL, DRILL_DB: !!env.DRILL_DB, FEEDBACK_SERVICE: !!env.FEEDBACK },
      webhooks: availableWebhooks(env) });
  }
  if (m === 'PATCH' && route === 'settings') {
    if (!owner) return ownerOnly();
    const b = await body(request);
    const changes = {};
    for (const [k, v] of Object.entries(b || {})) {
      const r = validate(k, v);
      if (r.error) return json({ error: r.error }, 422);
      changes[k] = r.value;
    }
    for (const [k, v] of Object.entries(changes)) await setSetting(db, k, v, me);
    await audit(db, me, 'settings.update', changes);
    return json({ ok: true, settings: await getSettings(db) });
  }

  // ------------------------------------------------------------------------------------------ v2: admin dashboard
  const q = new URL(request.url).searchParams;
  if (m === 'GET' && route === 'overview') return json(await overview(env));
  if (m === 'GET' && route === 'status/public') return json(await publicStatus(db));

  // Issues (src/issues.js)
  if (m === 'GET' && route === 'issues') {
    const filters = Object.fromEntries(['status', 'priority', 'assignee', 'source', 'site', 'q'].map((k) => [k, q.get(k) || undefined]));
    return json({ issues: await listIssues(db, filters) });
  }
  if (m === 'POST' && route === 'issues') {
    const v = validateIssue(await body(request), env, { creating: true });
    if (v.error) return json({ error: v.error }, 422);
    const row = await createIssue(env, { ...v.fields, source: 'manual' }, me);
    await audit(db, me, 'issue.create', { id: row.id, priority: row.priority });
    return json({ ok: true, issue: await getIssue(db, row.id) }, 201);
  }
  if (m === 'POST' && route === 'issues/from-feedback') {
    const b = await body(request);
    const r = await issueFromFeedback(env, b.feedback_id, me);
    if (r.status === 201) await audit(db, me, 'issue.from_feedback', { id: r.body.issue.id, feedback_id: Number(b.feedback_id) });
    return json(r.body, r.status);
  }
  if ((p = route.match(/^issues\/(\d+)$/))) {
    if (m === 'GET') { const i = await getIssue(db, Number(p[1])); return i ? json({ issue: i }) : json({ error: 'No such issue.' }, 404); }
    if (m === 'PATCH') { const r = await updateIssue(env, Number(p[1]), await body(request), me); return json(r.body, r.status); }
  }
  if (m === 'POST' && (p = route.match(/^issues\/(\d+)\/comments$/))) {
    const r = await commentIssue(env, Number(p[1]), (await body(request)).body, me);
    return json(r.body, r.status);
  }

  // People & permissions (src/people.js)
  if (m === 'GET' && route === 'directory') {
    const d = await directory(env);
    return json({ ...d, review: reviewList(d.people), stale_days: STALE_DAYS, next_review: nextReviewDate(Date.now()), me: { email: me, role: user.role } });
  }
  if (route === 'permissions/feedback-admins' && (m === 'POST' || m === 'DELETE')) {
    const r = await changeFeedbackAdmin(env, request, me, m, await body(request));
    return json(r.body, r.status);
  }
  if (m === 'POST' && route === 'access-review/open') {
    if (!owner) return ownerOnly();
    const id = await maybeQuarterlyReview(env, { force: true });
    await audit(db, me, 'access_review.open', { issue: id });
    return json({ ok: true, issue_id: id }, 201);
  }

  // Errors, deploys, rollback (src/errors.js, src/deploys.js)
  if (m === 'GET' && route === 'errors') return json(await errorsReport(db));
  if (m === 'GET' && route === 'deploys') return json(await deploysReport(env, { force: q.get('refresh') === '1' }));
  if (m === 'POST' && (p = route.match(/^deploys\/([a-z0-9-]{1,63})\/rollback$/))) {
    if (!owner) return ownerOnly();
    const b = await body(request);
    const r = await rollback(env, p[1], me, { expectVersion: b.version_id || null });
    return json(r.body, r.status);
  }

  // Restore drills (src/drill.js)
  if (m === 'GET' && route === 'drills') {
    const { results } = await db.prepare('SELECT * FROM restore_drills ORDER BY id DESC LIMIT 60').all();
    return json({ drills: results, ready: !!env.DRILL_DB && !!env.BACKUPS });
  }
  if (m === 'POST' && route === 'drills/run') {
    if (!owner) return ownerOnly();
    if (!env.DRILL_DB) return json({ error: 'The scratch database binding DRILL_DB is missing (wrangler.jsonc).' }, 412);
    const last = await db.prepare('SELECT started_at FROM restore_drills ORDER BY id DESC LIMIT 1').first();
    if (last && Date.now() - Date.parse(last.started_at) < 15 * 60_000) return json({ error: 'A restore drill ran less than 15 minutes ago.' }, 429);
    await audit(db, me, 'drill.run');
    const job = runDrills(env, { triggeredBy: me }).catch((e) => console.error('manual drill failed', e && e.stack));
    if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    return json({ ok: true, started: true }, 202);
  }

  // Key-expiry calendar (src/keys.js). Never key values.
  if (m === 'GET' && route === 'keys') return json({ keys: await keysReport(db) });
  if (m === 'POST' && route === 'keys') {
    const v = validateKey(await body(request), env, { creating: true });
    if (v.error) return json({ error: v.error }, 422);
    const f = v.fields; const now = new Date().toISOString();
    if (await db.prepare('SELECT id FROM keys_registry WHERE name = ? AND location = ?').bind(f.name, f.location).first()) return json({ error: 'That key is already in the calendar.' }, 409);
    const row = await db.prepare(`INSERT INTO keys_registry (name, location, owner_email, expires_on, rotation_notes, last_rotated, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(f.name, f.location, f.owner_email ?? null, f.expires_on ?? null, f.rotation_notes ?? null, f.last_rotated ?? null, me, now, me, now).first();
    await audit(db, me, 'key.add', { id: row.id, name: f.name, location: f.location, expires_on: f.expires_on ?? null });
    return json({ ok: true, id: row.id }, 201);
  }
  if ((p = route.match(/^keys\/(\d+)$/))) {
    const id = Number(p[1]);
    const prev = await db.prepare('SELECT * FROM keys_registry WHERE id = ?').bind(id).first();
    if (!prev) return json({ error: 'No such key.' }, 404);
    if (m === 'PATCH') {
      const v = validateKey(await body(request), env, { creating: false });
      if (v.error) return json({ error: v.error }, 422);
      const keys = Object.keys(v.fields);
      if (keys.length) await db.prepare(`UPDATE keys_registry SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`).bind(...keys.map((k) => v.fields[k]), me, new Date().toISOString(), id).run();
      await audit(db, me, 'key.update', { id, name: prev.name, fields: keys, expires_on: v.fields.expires_on });
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      if (!owner) return ownerOnly();
      await db.prepare('DELETE FROM keys_registry WHERE id = ?').bind(id).run();
      await audit(db, me, 'key.remove', { id, name: prev.name, location: prev.location });
      return json({ ok: true });
    }
  }

  // Audit log
  if (m === 'GET' && route === 'audit') {
    const where = []; const args = [];
    if (q.get('actor')) { where.push('actor = ?'); args.push(q.get('actor').toLowerCase()); }
    if (q.get('action')) { where.push('action LIKE ?'); args.push(`${q.get('action')}%`); }
    const stmt = db.prepare(`SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`);
    const { results } = await (args.length ? stmt.bind(...args) : stmt).all();
    return json({ audit: results });
  }

  return json({ error: 'Not found' }, 404);
}
