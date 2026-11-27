// The check state machine with de-duplication. Alerts go out only when something CHANGES:
//   ok -> failing          incident opened, alert "opened"
//   failing -> ok          incident resolved, alert "resolved" (only if people were told it opened)
//   failing, different     (another event/severity, or the problem's fingerprint changed) alert "changed"
//   failing, critical      reminder every `realertMinutes` (default 60) while it stays broken
//   failing, muted         nothing is sent; when the mute ends and it is still failing, people are told then
//   ok === null            the check couldn't run (e.g. no API token): state is left as it was
// decide() is pure; applyResult() stores the outcome in D1 (check_state + incidents).

export function decide(prev, r, nowMs, { realertMinutes = 60, muted = false } = {}) {
  const now = new Date(nowMs).toISOString();
  if (r.ok === null || r.ok === undefined) {
    return { state: prev ? { ...prev, last_run: now, detail: r.detail ?? prev.detail } : { status: 'unknown', since: now, last_run: now, detail: r.detail || null }, transition: null, alert: null };
  }
  const wasFailing = prev && prev.status === 'fail';
  if (r.ok) {
    const state = { status: 'ok', event: null, severity: null, fingerprint: null, detail: r.detail || null, title: null,
      since: prev && prev.status === 'ok' ? prev.since : now, last_run: now, last_alert_at: null };
    if (!wasFailing) return { state, transition: null, alert: null };
    // Tell people it is fixed only if they were told it broke.
    return { state, transition: 'resolved', alert: prev.last_alert_at && !muted ? 'resolved' : null };
  }
  const base = { status: 'fail', event: r.event, severity: r.severity, fingerprint: r.fingerprint || null, title: r.title,
    detail: r.detail || null, last_run: now };
  if (!wasFailing) {
    return { state: { ...base, since: now, last_alert_at: muted ? null : now }, transition: 'opened', alert: muted ? null : 'opened' };
  }
  const changed = prev.event !== r.event || prev.severity !== r.severity || (prev.fingerprint || null) !== (r.fingerprint || null);
  const state = { ...base, since: prev.since, last_alert_at: prev.last_alert_at || null };
  if (muted) return { state, transition: changed ? 'changed' : null, alert: null };
  if (!prev.last_alert_at) { state.last_alert_at = now; return { state, transition: changed ? 'changed' : null, alert: 'opened' }; }
  if (changed) { state.last_alert_at = now; return { state, transition: 'changed', alert: 'changed' }; }
  if (r.severity === 'critical' && nowMs - Date.parse(prev.last_alert_at) >= realertMinutes * 60_000) {
    state.last_alert_at = now;
    return { state, transition: null, alert: 'reminder' };
  }
  return { state, transition: null, alert: null };
}

/** A check is muted when it has an unexpired mute. */
export function isMuted(mute, nowMs) {
  return !!(mute && Date.parse(mute.until) > nowMs);
}

export async function loadStates(db) {
  const { results } = await db.prepare('SELECT * FROM check_state').all();
  return new Map(results.map((s) => [s.check_id, s]));
}
export async function loadMutes(db, nowMs) {
  const { results } = await db.prepare('SELECT * FROM mutes WHERE until > ? AND ended_at IS NULL').bind(new Date(nowMs).toISOString()).all();
  return new Map(results.map((m) => [m.check_id, m]));
}

/** Store one decision. Returns the incident row the alert (if any) is about. */
export async function applyResult(db, r, d, prev, nowMs) {
  const s = d.state;
  const now = new Date(nowMs).toISOString();
  let incidentId = prev ? prev.incident_id : null;
  if (d.transition === 'opened') {
    const ins = await db.prepare(`INSERT INTO incidents (check_id, site, event, severity, title, detail, opened_at, alerted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(r.id, r.site || null, r.event, r.severity, r.title, r.detail || null, now, d.alert ? 1 : 0).first();
    incidentId = ins.id;
  } else if (d.transition === 'resolved' && incidentId) {
    await db.prepare(`UPDATE incidents SET resolved_at = ?, duration_s = CAST((julianday(?) - julianday(opened_at)) * 86400 AS INTEGER)
      WHERE id = ? AND resolved_at IS NULL`).bind(now, now, incidentId).run();
  } else if (incidentId && s.status === 'fail') {
    // Keep the open incident's description current (e.g. severity went from high to critical).
    await db.prepare(`UPDATE incidents SET event = ?, severity = ?, title = ?, detail = ?,
      alerted = CASE WHEN ? THEN 1 ELSE alerted END WHERE id = ?`).bind(r.event, r.severity, r.title, r.detail || null, d.alert ? 1 : 0, incidentId).run();
  }
  const keepIncident = s.status === 'fail' ? incidentId : null;
  await db.prepare(`INSERT INTO check_state (check_id, site, status, event, severity, title, detail, fingerprint, since, last_run, last_alert_at, incident_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(check_id) DO UPDATE SET site = excluded.site, status = excluded.status, event = excluded.event, severity = excluded.severity,
      title = excluded.title, detail = excluded.detail, fingerprint = excluded.fingerprint, since = excluded.since,
      last_run = excluded.last_run, last_alert_at = excluded.last_alert_at, incident_id = excluded.incident_id`)
    .bind(r.id, r.site || null, s.status, s.event || null, s.severity || null, s.title || null, s.detail || null, s.fingerprint || null,
      s.since, s.last_run, s.last_alert_at || null, keepIncident).run();
  return incidentId;
}
