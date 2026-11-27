// Settings and kill switches, stored in the `settings` table (owner-editable in the dashboard's Settings tab).
// Keys starting with "_" are internal bookkeeping (last digest date, last Cloudflare check run) and not editable.
export const SETTINGS = {
  monitoring_enabled: { type: 'bool', default: true, label: 'Monitoring', help: 'Run the 5-minute checks. Off = nothing is checked.' },
  alerts_enabled: { type: 'bool', default: true, label: 'Alerts', help: 'Send alerts. Off = checks still run and incidents are logged, but nobody is emailed or posted to.' },
  backups_enabled: { type: 'bool', default: true, label: 'Nightly backups', help: 'Back up every database to R2 at 03:17 UTC.' },
  autofix_enabled: { type: 'bool', default: false, label: 'Auto-fix engine', help: 'Lets the future auto-fix engine work on feedback (it reads GET /api/autofix/config). Reverts work either way.' },
  email_transport: { type: 'enum', values: ['cloudflare', 'resend', 'off'], default: null, label: 'Email transport',
    help: 'resend = Resend (RESEND_API_KEY secret; the standard for all overyondrdev.com email); off = no email; cloudflare = Cloudflare Email Service (needs a send_email binding, not configured). Empty = the EMAIL_TRANSPORT variable (resend).' },
  realert_minutes: { type: 'int', min: 15, max: 1440, default: 60, label: 'Critical reminder (minutes)', help: 'While a critical problem lasts, remind people this often.' },
  event_dedupe_minutes: { type: 'int', min: 1, max: 1440, default: 60, label: 'Duplicate window (minutes)', help: 'The same event from another system within this window is logged but not sent again.' },
  daily_digest_hour_utc: { type: 'int', min: 0, max: 23, default: 8, label: 'Daily digest hour (UTC)', help: 'The daily summary goes out at the first check after this hour.' },
  backup_retention_days: { type: 'int', min: 7, max: 365, default: 30, label: 'Keep daily backups (days)', help: 'Older daily backups are deleted.' },
  backup_monthly_months: { type: 'int', min: 0, max: 36, default: 12, label: 'Keep monthly backups (months)', help: 'The backup of the 1st of each month is kept this long.' },
};

export function parseValue(def, raw) {
  if (raw === null || raw === undefined) return def.default;
  if (def.type === 'bool') return raw === true || raw === 'true' || raw === 1 || raw === '1';
  if (def.type === 'int') return Number.parseInt(raw, 10);
  return raw;
}

/** Validate a value an owner wants to store. Returns { value } or { error }. */
export function validate(key, value) {
  const def = SETTINGS[key];
  if (!def) return { error: `Unknown setting ${key}.` };
  if (def.type === 'bool') {
    if (typeof value !== 'boolean') return { error: `${def.label}: choose on or off.` };
    return { value };
  }
  if (def.type === 'int') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < def.min || n > def.max) return { error: `${def.label}: a whole number from ${def.min} to ${def.max}.` };
    return { value: n };
  }
  if (def.type === 'enum') {
    if (value === null || value === '') return { value: null };
    if (!def.values.includes(value)) return { error: `${def.label}: one of ${def.values.join(', ')}.` };
    return { value };
  }
  return { error: 'Unsupported setting.' };
}

export async function getSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const raw = new Map(results.map((r) => [r.key, JSON.parse(r.value)]));
  const out = {};
  for (const [k, def] of Object.entries(SETTINGS)) out[k] = raw.has(k) ? parseValue(def, raw.get(k)) : def.default;
  return out;
}

export async function setSetting(db, key, value, actor) {
  await db.prepare(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(key, JSON.stringify(value), actor, new Date().toISOString()).run();
}

export async function getInternal(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('_' + key).first();
  return row ? JSON.parse(row.value) : null;
}
export async function setInternal(db, key, value) {
  await setSetting(db, '_' + key, value, 'system');
}

/** Which email transport to use: the setting, else the EMAIL_TRANSPORT variable, else Cloudflare. */
export function emailTransport(settings, env) {
  return settings.email_transport || env.EMAIL_TRANSPORT || 'resend';
}
