// Monthly restore drill (README "Restore drill"): proves the backups can actually be restored.
// On the 1st of each month, right after the nightly backups (same cron, no extra trigger), and on demand (owners), for
// every database: take its latest good backup from R2, empty the scratch database `yondr-ops-restore-drill` (binding
// DRILL_DB), load the backup into it in batches and compare the tables and row counts with what the backup recorded
// (backups.table_stats). The result goes to restore_drills; a failure sends restore_drill_failed (owners always).
// Christmas cards (personal data): restored, counted, then its tables are dropped again straight away (also when the
// drill fails), so the addresses never sit in the scratch database.
//
// SAFETY: this is the ONLY file that drops tables, and only ever in DRILL_DB (the `drill` handle below).
// scripts/check.mjs fails the build if DROP appears anywhere else or against another binding.
import { dispatch } from './alerts.js';
import { BACKUP_DATABASES } from './backups.js';
import { DASHBOARD_URL } from './checks.js';
import { getSettings } from './settings.js';

export const DRILL_BATCH = 200;

/**
 * Split a backup file into statements. Pure. Understands '…' strings ('' escapes), "…" identifiers, -- comments and
 * CREATE TRIGGER … BEGIN … END; bodies. Returns statements without the trailing semicolon; PRAGMAs are skipped.
 */
export function splitSql(text) {
  const out = [];
  let cur = '';
  let i = 0;
  const n = text.length;
  const push = () => {
    const s = cur.trim();
    cur = '';
    if (s && !/^PRAGMA\b/i.test(s)) out.push(s);
  };
  while (i < n) {
    const c = text[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) { if (text[j] === c) { if (text[j + 1] === c) { j += 2; continue; } break; } j++; }
      cur += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '-' && text[i + 1] === '-') { const j = text.indexOf('\n', i); i = j < 0 ? n : j + 1; cur += '\n'; continue; }
    if (c === ';') {
      if (/^\s*CREATE\s+(TEMP\w*\s+)?TRIGGER\b/i.test(cur) && !/\bEND\s*$/i.test(cur)) { cur += c; i++; continue; }
      push(); i++; continue;
    }
    cur += c; i++;
  }
  push();
  return out;
}

/** Table names created by a list of statements. Pure. */
export function createdTables(statements) {
  const names = [];
  for (const s of statements) {
    const m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|([\w$]+))/i.exec(s);
    if (m) names.push((m[1] && m[1].replace(/""/g, '"')) || m[2] || m[3] || m[4]);
  }
  return names;
}

/**
 * Compare what was restored with what the backup recorded. Pure.
 * @param expected { tables: {name: rows} | null, tableNames: [..], totalTables, totalRows }
 * @param actual   { name: rows }
 */
export function compareRestore(expected, actual) {
  const problems = [];
  const want = expected.tables ? Object.keys(expected.tables) : expected.tableNames;
  const have = Object.keys(actual);
  const missing = want.filter((t) => !(t in actual));
  const extra = have.filter((t) => !want.includes(t));
  if (missing.length) problems.push(`missing tables: ${missing.join(', ')}`);
  if (extra.length) problems.push(`unexpected tables: ${extra.join(', ')}`);
  if (expected.tables) {
    for (const t of want) if (t in actual && actual[t] !== expected.tables[t]) problems.push(`${t}: ${actual[t]} rows restored, backup had ${expected.tables[t]}`);
  }
  const rows = have.reduce((s, t) => s + actual[t], 0);
  if (!expected.tables && expected.totalRows != null && rows !== expected.totalRows) problems.push(`${rows} rows restored, backup had ${expected.totalRows}`);
  return { ok: problems.length === 0, problems, tables: have.length, rows };
}

// ------------------------------------------------------------------------------------- the scratch database
function drillHandle(env) {
  if (!env.DRILL_DB) throw new Error('The scratch database binding DRILL_DB (yondr-ops-restore-drill) is missing.');
  return env.DRILL_DB;
}

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** Drop every table, view and trigger in DRILL_DB (and nothing anywhere else). */
export async function wipeDrill(env) {
  const drill = drillHandle(env);
  const { results } = await drill.prepare(`SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view', 'trigger')
    AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all();
  const order = { trigger: 0, view: 1, table: 2 };
  const stmts = results.sort((a, b) => order[a.type] - order[b.type])
    .map((o) => drill.prepare(`DROP ${o.type.toUpperCase()} IF EXISTS ${q(o.name)}`));
  if (!stmts.length) return 0;
  await drill.batch([drill.prepare('PRAGMA foreign_keys = OFF'), ...stmts]);
  return stmts.length;
}

async function countTables(env) {
  const drill = drillHandle(env);
  const { results } = await drill.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all();
  const out = {};
  for (const t of results) out[t.name] = (await drill.prepare(`SELECT COUNT(*) AS n FROM ${q(t.name)}`).first()).n;
  return out;
}

export async function gunzipText(stream) {
  const ds = new DecompressionStream('gzip');
  return new Response(stream.pipeThrough(ds)).text();
}

/** Restore one database's latest backup into DRILL_DB and check it. Returns the restore_drills row. */
export async function drillOne(env, spec, { triggeredBy = 'monthly', nowMs = Date.now() } = {}) {
  const db = env.DB;
  const backup = await db.prepare(`SELECT * FROM backups WHERE db = ? AND status = 'ok' AND deleted_at IS NULL AND object_key IS NOT NULL ORDER BY day DESC, id DESC LIMIT 1`).bind(spec.name).first();
  const started = new Date(nowMs).toISOString();
  const row = await db.prepare(`INSERT INTO restore_drills (db, backup_id, backup_day, status, pii, triggered_by, started_at) VALUES (?, ?, ?, 'running', ?, ?, ?) RETURNING id`)
    .bind(spec.name, backup ? backup.id : null, backup ? backup.day : null, spec.pii ? 1 : 0, triggeredBy, started).first();
  const finish = async (status, f) => {
    await db.prepare(`UPDATE restore_drills SET status = ?, tables_expected = ?, tables_restored = ?, rows_expected = ?, rows_restored = ?, detail = ?, pii_dropped = ?, finished_at = ? WHERE id = ?`)
      .bind(status, f.tables_expected ?? null, f.tables_restored ?? null, f.rows_expected ?? null, f.rows_restored ?? null, f.detail, f.pii_dropped ?? null, new Date().toISOString(), row.id).run();
    return db.prepare('SELECT * FROM restore_drills WHERE id = ?').bind(row.id).first();
  };
  if (!backup) return finish('failed', { detail: 'No good backup of this database to restore.' });
  let result;
  let piiDropped = null;
  try {
    const obj = await env.BACKUPS.get(backup.object_key);
    if (!obj) throw new Error(`The backup file ${backup.object_key} is missing from R2.`);
    const statements = splitSql(await gunzipText(obj.body));
    await wipeDrill(env);
    const drill = drillHandle(env);
    for (let i = 0; i < statements.length; i += DRILL_BATCH) {
      await drill.batch(statements.slice(i, i + DRILL_BATCH).map((s) => drill.prepare(s)));
    }
    const actual = await countTables(env);
    const stats = backup.table_stats ? JSON.parse(backup.table_stats) : null;
    const expected = { tables: stats && Object.keys(stats).length === backup.tables ? stats : null, tableNames: createdTables(statements), totalTables: backup.tables, totalRows: backup.rows };
    const c = compareRestore(expected, actual);
    result = { ok: c.ok, tables_expected: backup.tables, tables_restored: c.tables, rows_expected: backup.rows, rows_restored: c.rows,
      detail: c.ok ? `Restored the backup of ${backup.day}: ${c.tables} tables and ${c.rows} rows, as recorded.` : `Restored the backup of ${backup.day}, but: ${c.problems.join('; ')}.` };
  } catch (e) {
    result = { ok: false, detail: `Restore failed: ${String(e && e.message).slice(0, 500)}` };
  } finally {
    // Personal data must not stay in the scratch database, whatever happened above.
    if (spec.pii) {
      try { await wipeDrill(env); piiDropped = 1; } catch (e) { piiDropped = 0; console.error('drill: could not drop personal data', e && e.stack); }
    }
  }
  if (spec.pii && !piiDropped) { result.ok = false; result.detail += ' Could not drop the restored personal data from the scratch database: drop its tables by hand now.'; }
  return finish(result.ok ? 'ok' : 'failed', { ...result, pii_dropped: piiDropped });
}

/** Every database, one after the other. Alerts on failure. */
export async function runDrills(env, { triggeredBy = 'monthly', nowMs = Date.now(), settings } = {}) {
  const db = env.DB;
  settings = settings || await getSettings(db);
  if (!env.DRILL_DB || !env.BACKUPS) return { skipped: 'DRILL_DB or BACKUPS binding missing' };
  const results = [];
  for (const spec of BACKUP_DATABASES) results.push(await drillOne(env, spec, { triggeredBy, nowMs }));
  const failed = results.filter((r) => r.status !== 'ok');
  if (failed.length) {
    await dispatch(env, {
      type: 'restore_drill_failed', kind: 'event', severity: 'high', site: 'Database backups',
      title: `Restore drill failed for ${failed.map((f) => f.db).join(', ')}`,
      detail: failed.map((f) => `${f.db}: ${f.detail}`).join('\n') + '\nThe backups themselves are still in R2; this means a restore from them may not give everything back.',
      done: 'Nothing automatic. Look at the Backups page (Restore drills) and download the backup to check it.', link: `${DASHBOARD_URL}/#backups`,
    }, { settings, nowMs }).catch((e) => console.error('restore_drill_failed alert failed', e && e.stack));
  }
  return { ok: results.length - failed.length, failed: failed.length, results };
}

export async function lastDrills(db) {
  const { results } = await db.prepare(`SELECT d.* FROM restore_drills d JOIN (SELECT db, MAX(id) AS id FROM restore_drills GROUP BY db) m ON m.id = d.id ORDER BY d.db`).all();
  return results;
}
