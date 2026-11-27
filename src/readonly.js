// Other tools' databases (feedback, ad library, marketing requests, Christmas cards) are bound to this Worker for
// the admin list and for backups. A D1 binding can't be made read-only, so every use goes through this wrapper,
// which refuses anything but reads. scripts/check.mjs fails if those bindings are used without it.
const READ = /^\s*(SELECT|WITH)\b/i;
const PRAGMA_READ = /^\s*PRAGMA\s+table_info\s*\(/i;

export function readOnly(db) {
  if (!db) return null;
  return {
    prepare(sql) {
      if (!READ.test(sql) && !PRAGMA_READ.test(sql)) throw new Error('Read-only database: only SELECT queries are allowed.');
      if (/;\s*\S/.test(sql.replace(/'(?:[^']|'')*'/g, "''"))) throw new Error('Read-only database: one statement per query.');
      return db.prepare(sql);
    },
  };
}
