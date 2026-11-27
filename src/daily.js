// The daily jobs that ride on the nightly backup cron (03:17 UTC, no extra cron trigger; Workers Free allows 5 per
// account and this Worker keeps using 3):
//   1. backups (src/backups.js)
//   2. on the 1st of the month: the restore drill (src/drill.js; setting restore_drill_enabled)
//   3. key-expiry alerts (src/keys.js)
//   4. on the first weekday of Jan/Apr/Jul/Oct: the quarterly access review issue (src/review.js)
//   5. retention of ops' own bookkeeping: check_history (35 days), error stats (8 days)
// Each step is independent: one failing doesn't stop the others.
import { runBackups } from './backups.js';
import { runDrills } from './drill.js';
import { pruneErrors } from './errors.js';
import { checkKeys, seedKeys } from './keys.js';
import { maybeQuarterlyReview } from './review.js';
import { ensureSchema } from './schema.js';
import { getSettings } from './settings.js';
import { pruneHistory } from './status.js';

/** The 1st of the month (UTC). Pure. */
export const isDrillDay = (nowMs) => new Date(nowMs).getUTCDate() === 1;

export async function runDaily(env, { nowMs = Date.now(), backups = runBackups } = {}) {
  await ensureSchema(env.DB);
  const out = {};
  const step = async (name, fn) => { try { out[name] = await fn(); } catch (e) { console.error(`daily: ${name} failed`, e && e.stack); out[name] = { error: String(e && e.message) }; } };
  await step('backups', () => backups(env, { nowMs }));
  const settings = await getSettings(env.DB);
  if (isDrillDay(nowMs) && settings.restore_drill_enabled) await step('drill', () => runDrills(env, { nowMs, settings, triggeredBy: 'monthly' }));
  await step('keys', async () => { await seedKeys(env.DB, nowMs); return checkKeys(env, { nowMs, settings }); });
  await step('review', () => maybeQuarterlyReview(env, { nowMs, settings }));
  await step('retention', async () => { await pruneHistory(env.DB, nowMs); await pruneErrors(env.DB, nowMs); return true; });
  return out;
}
