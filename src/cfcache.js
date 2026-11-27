// A small cache for expensive Cloudflare API answers (table cf_cache, own data). The Overview and the Deploys page
// read through it so a busy dashboard doesn't hammer the API: answers are reused for maxAgeMs (default 5 minutes);
// if the API fails, the last good answer is returned with `stale: true` and the error.
export const CACHE_MS = 5 * 60_000;

export async function cached(db, key, fn, { maxAgeMs = CACHE_MS, nowMs = Date.now(), force = false } = {}) {
  const row = await db.prepare('SELECT value, fetched_at FROM cf_cache WHERE key = ?').bind(key).first();
  if (row && !force && nowMs - Date.parse(row.fetched_at) < maxAgeMs) return { value: JSON.parse(row.value), fetched_at: row.fetched_at, cached: true };
  try {
    const value = await fn();
    const at = new Date(nowMs).toISOString();
    await db.prepare(`INSERT INTO cf_cache (key, value, fetched_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`).bind(key, JSON.stringify(value), at).run();
    return { value, fetched_at: at, cached: false };
  } catch (e) {
    if (row) return { value: JSON.parse(row.value), fetched_at: row.fetched_at, cached: true, stale: true, error: e.message };
    throw e;
  }
}
