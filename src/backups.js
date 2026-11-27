// Nightly D1 backups to R2 (bucket yondr-ops-backups, binding BACKUPS), 03:17 UTC.
// Each database becomes one gzip'd SQL file: backups/<db>/<YYYY-MM-DD>.sql.gz — the schema from sqlite_master and
// every row as INSERT statements, restorable with `wrangler d1 execute <db> --remote --file=<file>.sql` (README "Restore").
// Retention: daily backups for backup_retention_days, the 1st of each month for backup_monthly_months; backups of
// databases with personal data (pii) are deleted after pii_backup_retention_days, monthly ones included.
// This file only ever READS the databases it backs up (readOnly wrapper). It never deletes live data.
import { dispatch } from './alerts.js';
import { weeklyBackupDigest } from './digest.js';
import { readOnly } from './readonly.js';
import { ensureSchema } from './schema.js';
import { getSettings } from './settings.js';

export const BACKUP_DATABASES = [
  { name: 'yondr-feedback', binding: 'FEEDBACK_DB' },
  { name: 'yondr-ad-portal-db', binding: 'ADS_DB' },
  { name: 'yondr-marketing-requests-db', binding: 'REQUESTS_DB' },
  // Client names and postal addresses: personal data. Shorter backup retention (setting), owners-only download.
  { name: 'yondr-christmas-cards', binding: 'CARDS_DB', pii: true },
  { name: 'yondr-ops', binding: 'DB' },
];
export const PII_DATABASES = new Set(BACKUP_DATABASES.filter((d) => d.pii).map((d) => d.name));
export const KEY_RE = /^backups\/([a-z0-9-]+)\/(\d{4}-\d{2}-\d{2})\.sql\.gz$/;
const PAGE = 1000;

// ------------------------------------------------------------------------------------------------ SQL dump
export function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v) || Array.isArray(v)) {
    const bytes = Array.isArray(v) ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return `X'${Array.from(bytes, (b) => (b & 255).toString(16).padStart(2, '0')).join('')}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}
export const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** Yields the dump in pieces so a large table never sits in memory as one string. */
export async function* dumpDatabase(db, stats = { tables: 0, rows: 0 }) {
  const { results: objects } = await db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND tbl_name NOT LIKE '_cf_%'
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name`).all();
  yield `-- Backup by yondr-ops at ${new Date().toISOString()}\n-- Restore into an EMPTY database: wrangler d1 execute <db> --remote --file=<this file, unzipped>\nPRAGMA defer_foreign_keys = true;\n`;
  for (const t of objects.filter((o) => o.type === 'table')) {
    stats.tables++;
    yield `\n${t.sql};\n`;
    let lastRowid = null;
    let offset = 0;
    let useRowid = true;
    for (;;) {
      let rows;
      if (useRowid) {
        try {
          const q = `SELECT rowid AS __ops_rowid, * FROM ${ident(t.name)}${lastRowid === null ? '' : ' WHERE rowid > ?'} ORDER BY rowid LIMIT ${PAGE}`;
          const stmt = db.prepare(q);
          rows = (await (lastRowid === null ? stmt : stmt.bind(lastRowid)).all()).results;
        } catch (e) {
          if (!/rowid/i.test(String(e && e.message))) throw e;
          useRowid = false; // WITHOUT ROWID table
          continue;
        }
      } else {
        rows = (await db.prepare(`SELECT * FROM ${ident(t.name)} LIMIT ${PAGE} OFFSET ${offset}`).all()).results;
        offset += rows.length;
      }
      if (!rows.length) break;
      const lines = [];
      for (const row of rows) {
        if (useRowid) { lastRowid = row.__ops_rowid; delete row.__ops_rowid; }
        const cols = Object.keys(row);
        lines.push(`INSERT INTO ${ident(t.name)} (${cols.map(ident).join(', ')}) VALUES (${cols.map((c) => sqlValue(row[c])).join(', ')});`);
      }
      stats.rows += rows.length;
      yield lines.join('\n') + '\n';
      if (rows.length < PAGE) break;
    }
  }
  for (const o of objects.filter((o) => o.type !== 'table')) yield `\n${o.sql};\n`;
}

export async function gzipParts(parts) {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const reading = new Response(cs.readable).arrayBuffer();
  const enc = new TextEncoder();
  for await (const p of parts) await writer.write(enc.encode(p));
  await writer.close();
  return new Uint8Array(await reading);
}

// ------------------------------------------------------------------------------------------------ retention
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000); }
function monthsBetween(a, b) { return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7))); }

/**
 * Which backup files to delete. Pure.
 * @param keys   R2 keys (backups/<db>/<YYYY-MM-DD>.sql.gz; anything else is left alone)
 * @param today  YYYY-MM-DD (UTC)
 * @param opts   { retentionDays, monthlyMonths, piiDays, pii: Set<db name> }
 */
export function planRetention(keys, today, { retentionDays = 30, monthlyMonths = 12, piiDays = 30, pii = PII_DATABASES } = {}) {
  const del = [];
  for (const key of keys) {
    const m = KEY_RE.exec(key);
    if (!m) continue;
    const [, db, day] = m;
    const age = daysBetween(day, today);
    if (age <= 0) continue; // today's (or a clock-skewed future) backup is always kept
    if (pii.has(db)) { if (age >= piiDays) del.push(key); continue; }
    if (age < retentionDays) continue;
    if (day.endsWith('-01') && monthsBetween(day, today) < monthlyMonths) continue;
    del.push(key);
  }
  return del;
}

async function listKeys(bucket) {
  const keys = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: 'backups/', cursor, limit: 1000 });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

// ------------------------------------------------------------------------------------------------ the nightly run
export async function backupOne(env, spec, day) {
  const started = Date.now();
  const raw = env[spec.binding];
  if (!raw) throw new Error(`Binding ${spec.binding} is missing.`);
  const db = readOnly(raw);
  const stats = { tables: 0, rows: 0 };
  const bytes = await gzipParts(dumpDatabase(db, stats));
  const key = `backups/${spec.name}/${day}.sql.gz`;
  await env.BACKUPS.put(key, bytes, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { db: spec.name, tables: String(stats.tables), rows: String(stats.rows), pii: spec.pii ? '1' : '0' },
  });
  return { key, bytes: bytes.byteLength, ...stats, duration_ms: Date.now() - started };
}

export async function runBackups(env, { nowMs = Date.now(), force = false } = {}) {
  const db = env.DB;
  await ensureSchema(db);
  const settings = await getSettings(db);
  if (!settings.backups_enabled && !force) return { skipped: 'backups switched off' };
  if (!env.BACKUPS) throw new Error('R2 binding BACKUPS is missing.');
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const run = await db.prepare("INSERT INTO runs (kind, started_at) VALUES ('backup', ?) RETURNING id").bind(new Date(nowMs).toISOString()).first();
  const results = [];
  for (const spec of BACKUP_DATABASES) {
    const now = new Date().toISOString();
    try {
      const r = await backupOne(env, spec, day);
      await db.prepare(`INSERT INTO backups (db, day, object_key, status, bytes, tables, rows, duration_ms, pii, created_at)
        VALUES (?, ?, ?, 'ok', ?, ?, ?, ?, ?, ?)`).bind(spec.name, day, r.key, r.bytes, r.tables, r.rows, r.duration_ms, spec.pii ? 1 : 0, now).run();
      results.push({ db: spec.name, ok: true, ...r });
    } catch (e) {
      console.error('backup failed', spec.name, e && e.stack);
      await db.prepare(`INSERT INTO backups (db, day, status, error, pii, created_at) VALUES (?, ?, 'failed', ?, ?, ?)`)
        .bind(spec.name, day, String(e && e.message).slice(0, 500), spec.pii ? 1 : 0, now).run();
      results.push({ db: spec.name, ok: false, error: String(e && e.message) });
    }
  }
  // Retention (backup files only; live databases are never touched).
  let deleted = [];
  try {
    deleted = planRetention(await listKeys(env.BACKUPS), day, {
      retentionDays: settings.backup_retention_days, monthlyMonths: settings.backup_monthly_months, piiDays: settings.pii_backup_retention_days,
    });
    for (let i = 0; i < deleted.length; i += 1000) await env.BACKUPS.delete(deleted.slice(i, i + 1000));
    const at = new Date().toISOString();
    for (const key of deleted) await db.prepare('UPDATE backups SET deleted_at = ? WHERE object_key = ? AND deleted_at IS NULL').bind(at, key).run();
  } catch (e) { console.error('retention failed', e && e.stack); results.push({ db: '(retention)', ok: false, error: String(e && e.message) }); }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    await dispatch(env, {
      type: 'backup_failed', kind: 'event', severity: 'high',
      title: `Backup failed for ${failed.map((f) => f.db).join(', ')}`, site: 'Database backups',
      detail: failed.map((f) => `${f.db}: ${f.error}`).join('\n') + '\nThe other databases were backed up. The previous backups are still in R2.',
      done: 'Nothing automatic: backups retry tomorrow night, or an admin can press "Back up now" in the Backups tab.',
      link: 'https://ops.overyondrdev.com/#backups',
    }, { settings, nowMs }).catch((e) => console.error('alert failed', e && e.stack));
  }
  if (new Date(nowMs).getUTCDay() === 1 && !force) await weeklyBackupDigest(env, settings, nowMs).catch((e) => console.error('weekly digest failed', e && e.stack));
  const summary = { ok: results.filter((r) => r.ok).length, failed: failed.length, deleted: deleted.length };
  await db.prepare('UPDATE runs SET finished_at = ?, ok = ?, summary = ? WHERE id = ?').bind(new Date().toISOString(), failed.length ? 0 : 1, JSON.stringify(summary), run.id).run();
  return { ...summary, results };
}
