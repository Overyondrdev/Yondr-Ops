// Key-expiry calendar (README "Keys"): where every key and token lives, who owns it and when it expires — NEVER the
// key itself. keys_registry is own data, editable by admins and owners (audited). Every day (backup cron) keys that
// expire in 30 days, 14 days or today send key_expiring (owners always, plus the key's owner), once per level.
import { dispatch, dispatchTo } from './alerts.js';
import { DASHBOARD_URL } from './checks.js';
import { cleanEmail } from './issues.js';
import { getInternal, setInternal } from './settings.js';

export const ALERT_DAYS = [30, 14, 0];

// Known keys (no expiry dates: owners fill them in). name + location is unique; seeding is idempotent.
export const SEED_KEYS = [
  { name: 'GITHUB_TOKEN', location: 'yondr-ops Worker secret', rotation_notes: 'Fine-grained PAT of the ops GitHub account. Expires at most 366 days after creation: set the date. README "Secrets".' },
  { name: 'AUTOFIX_PR_TOKEN', location: 'GitHub org secret (Overyondrdev)', rotation_notes: 'Fine-grained PAT of the ops GitHub account (can be the same as GITHUB_TOKEN). Expires at most 366 days after creation.' },
  { name: 'CF_API_TOKEN', location: 'yondr-ops Worker secret', rotation_notes: 'Read-only Cloudflare user API token (README "Secrets"). Set an expiry when creating it.' },
  { name: 'CF_DEPLOY_TOKEN', location: 'yondr-ops Worker secret', rotation_notes: 'Cloudflare user API token, Workers Scripts: Edit, for one-click rollback only.' },
  { name: 'RESEND_API_KEY', location: 'yondr-ops Worker secret', rotation_notes: 'Resend → API Keys, sending access, domain overyondrdev.com.' },
  { name: 'RESEND_API_KEY', location: 'yondr-christmas-cards Worker secret', rotation_notes: 'Resend → API Keys, sending access, domain overyondrdev.com (one key per sending Worker).' },
  { name: 'ANTHROPIC_API_KEY', location: 'GitHub org secret (Overyondrdev)', rotation_notes: 'Claude Console API key for auto-fix; workspace spend limit $60.' },
  { name: 'OPS_INGEST_TOKEN', location: 'yondr-ops + yondr-feedback Worker secrets, GitHub org secret', rotation_notes: 'Random (openssl rand -hex 32). Change it in all three places at once.' },
  { name: 'GOOGLE_CLIENT_SECRET', location: 'yondr-auth Worker secret', rotation_notes: 'Google OAuth client secret (project overyondrdev-sign-in). auth/README.md in overyondr-website-v1.' },
  { name: 'SESSION_PRIVATE_JWK', location: 'yondr-auth Worker secret', rotation_notes: 'Session signing key. Rotating it means a new public key in every site (auth/README.md "key rotation").' },
];

export async function seedKeys(db, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  await db.batch(SEED_KEYS.map((k) => db.prepare(`INSERT OR IGNORE INTO keys_registry (name, location, rotation_notes, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'yondr-ops', ?, ?)`).bind(k.name, k.location, k.rotation_notes, now, now)));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** A value that looks like a secret rather than a name: refused (never store key values). */
const LOOKS_SECRET = /(sk-ant-|ghp_|github_pat_|\bre_[A-Za-z0-9]{16,}|-----BEGIN|"d"\s*:|[A-Za-z0-9+/_-]{40,})/;

export function validateKey(b, env, { creating }) {
  if (!b || typeof b !== 'object') return { error: 'Send a JSON object.' };
  const f = {};
  if (creating || b.name !== undefined) { f.name = str(b.name, 80); if (!f.name) return { error: 'Name the key (e.g. GITHUB_TOKEN).' }; }
  if (creating || b.location !== undefined) { f.location = str(b.location, 200); if (!f.location) return { error: 'Say where it lives (e.g. "yondr-ops Worker secret").' }; }
  if (b.rotation_notes !== undefined) f.rotation_notes = str(b.rotation_notes, 1000) || null;
  for (const k of ['expires_on', 'last_rotated']) {
    if (b[k] !== undefined) {
      if (b[k] === null || b[k] === '') f[k] = null;
      else if (!DATE.test(String(b[k])) || Number.isNaN(Date.parse(b[k]))) return { error: 'Dates look like 2027-01-31.' };
      else f[k] = String(b[k]);
    }
  }
  if (b.owner_email !== undefined) {
    if (!b.owner_email) f.owner_email = null;
    else { const e = cleanEmail(b.owner_email, env); if (!e) return { error: 'The owner is a work address (@overyondr.com).' }; f.owner_email = e; }
  }
  for (const k of ['name', 'location', 'rotation_notes']) if (f[k] && LOOKS_SECRET.test(f[k])) return { error: 'That looks like a key value. Never store keys here: only their name, where they live and when they expire.' };
  return { fields: f };
}

const daysBetween = (fromDay, toDay) => Math.round((Date.parse(toDay + 'T00:00:00Z') - Date.parse(fromDay + 'T00:00:00Z')) / 86_400_000);

/**
 * Which alert level is due for one key. Pure.
 * @returns { level: 30 | 14 | 0, days } or null. `sent`: levels already sent for this expiry date.
 */
export function keyAlertDue(expiresOn, today, sent = []) {
  if (!expiresOn) return null;
  const days = daysBetween(today, expiresOn);
  if (days > ALERT_DAYS[0]) return null;
  const level = Math.min(...ALERT_DAYS.filter((l) => days <= l)); // the most urgent level reached
  if (sent.includes(level)) return null;
  return { level, days };
}

/** The daily key check. */
export async function checkKeys(env, { nowMs = Date.now(), settings } = {}) {
  const db = env.DB;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const { results } = await db.prepare('SELECT * FROM keys_registry WHERE expires_on IS NOT NULL').all();
  let sentCount = 0;
  for (const k of results) {
    const stateKey = `key_alert:${k.id}:${k.expires_on}`;
    const sent = (await getInternal(db, stateKey)) || [];
    const due = keyAlertDue(k.expires_on, today, sent);
    if (!due) continue;
    // Mark this level and every larger one as sent (no 30-day alert after the 14-day one).
    await setInternal(db, stateKey, [...new Set([...sent, ...ALERT_DAYS.filter((l) => l >= due.level)])]);
    const when = due.days < 0 ? `expired ${-due.days} day${due.days === -1 ? '' : 's'} ago` : due.days === 0 ? 'expires today' : `expires in ${due.days} days (${k.expires_on})`;
    const a = {
      type: 'key_expiring', kind: 'event', severity: due.days <= 0 ? 'high' : 'warning', site: k.location,
      title: `${k.name} ${when}`,
      detail: [`Key: ${k.name}`, `Where: ${k.location}`, `Expires: ${k.expires_on}`, k.owner_email ? `Owner: ${k.owner_email}` : 'No owner recorded.', k.rotation_notes ? `How to rotate: ${k.rotation_notes}` : null].filter(Boolean).join('\n'),
      done: 'Nothing automatic: rotate the key, then update its expiry date on the Keys page.', link: `${DASHBOARD_URL}/#keys`,
    };
    const out = await dispatch(env, a, { settings, nowMs }).catch((e) => { console.error('key_expiring failed', e && e.stack); return { email: [] }; });
    if (k.owner_email && !out.email.includes(k.owner_email)) await dispatchTo(env, a, [k.owner_email], { settings, nowMs }).catch(() => {});
    sentCount++;
  }
  return { checked: results.length, alerts: sentCount };
}

/** Keys page + Overview: every key with days left. */
export async function keysReport(db, nowMs = Date.now()) {
  await seedKeys(db, nowMs);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const { results } = await db.prepare('SELECT * FROM keys_registry ORDER BY expires_on IS NULL, expires_on, name').all();
  return results.map((k) => ({ ...k, days_left: k.expires_on ? daysBetween(today, k.expires_on) : null }));
}
