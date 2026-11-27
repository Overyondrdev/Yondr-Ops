// D1 schema for yondr-ops (its OWN database, `yondr-ops`, binding DB). Applied idempotently on the first request or
// cron run of each isolate, so a fresh database needs no manual migration. Every change must be ADDITIVE and
// IDEMPOTENT (`IF NOT EXISTS`; new nullable columns via ADDED_COLUMNS). Never drop, rename or rewrite.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by TEXT,
    updated_at TEXT NOT NULL
  )`,
  // One row per check: its last known status (the state machine in src/state.js).
  `CREATE TABLE IF NOT EXISTS check_state (
    check_id TEXT PRIMARY KEY,
    site TEXT,
    status TEXT NOT NULL,             -- ok | fail | unknown
    event TEXT,                       -- alert type while failing
    severity TEXT,                    -- info | warning | high | critical
    title TEXT,
    detail TEXT,
    fingerprint TEXT,                 -- what exactly is wrong (e.g. which hosts are missing); a change re-alerts
    since TEXT NOT NULL,              -- when the current status started
    last_run TEXT NOT NULL,
    last_alert_at TEXT,
    incident_id INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id TEXT NOT NULL,
    site TEXT,
    event TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    opened_at TEXT NOT NULL,
    resolved_at TEXT,
    duration_s INTEGER,
    alerted INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS incidents_open ON incidents(resolved_at, opened_at)`,
  `CREATE INDEX IF NOT EXISTS incidents_check ON incidents(check_id, opened_at)`,
  `CREATE TABLE IF NOT EXISTS mutes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id TEXT NOT NULL,
    until TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ended_at TEXT,
    ended_by TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS mutes_check ON mutes(check_id, until)`,
  // People who get alerts. min_severity: all | high | critical. Quiet hours HH:MM in their time zone.
  `CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    min_severity TEXT NOT NULL DEFAULT 'all',
    quiet_start TEXT,
    quiet_end TEXT,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // Rules: subscriber x event type x channel. channel email = the person's address; channel slack = the named
  // incoming webhook (webhook = the secret's name, e.g. SLACK_WEBHOOK_OPS; never the URL).
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    channel TEXT NOT NULL,            -- email | slack
    webhook TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (subscriber_id, event_type, channel, webhook)
  )`,
  `CREATE INDEX IF NOT EXISTS subscriptions_event ON subscriptions(event_type)`,
  // Events raised by other systems (POST /api/events) and by ops itself.
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    source TEXT NOT NULL,
    site TEXT,
    title TEXT NOT NULL,
    message TEXT,
    url TEXT,
    dedupe_key TEXT NOT NULL,
    status TEXT NOT NULL,             -- routed | duplicate
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_dedupe ON events(dedupe_key, created_at)`,
  // Every alert delivery attempt (one row per channel/recipient group).
  `CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    kind TEXT NOT NULL,               -- opened | changed | reminder | resolved | event | digest | test
    severity TEXT NOT NULL,
    subject TEXT NOT NULL,
    channel TEXT NOT NULL,            -- email | slack
    recipients TEXT NOT NULL,         -- JSON array: emails, or the webhook name
    status TEXT NOT NULL,             -- sent | failed | skipped
    error TEXT,
    incident_id INTEGER,
    event_id INTEGER,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS alerts_created ON alerts(created_at)`,
  `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,               -- monitor | backup | digest
    started_at TEXT NOT NULL,
    finished_at TEXT,
    ok INTEGER,
    summary TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS runs_kind ON runs(kind, started_at)`,
  `CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    db TEXT NOT NULL,
    day TEXT NOT NULL,                -- YYYY-MM-DD (UTC)
    object_key TEXT,
    status TEXT NOT NULL,             -- ok | failed
    bytes INTEGER,
    tables INTEGER,
    rows INTEGER,
    duration_ms INTEGER,
    error TEXT,
    pii INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS backups_db ON backups(db, day)`,
  `CREATE TABLE IF NOT EXISTS autofixes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feedback_id INTEGER,
    project TEXT,
    repo TEXT NOT NULL,
    title TEXT NOT NULL,
    classification TEXT,              -- objective | subjective
    classification_reason TEXT,
    severity TEXT,
    status TEXT NOT NULL,             -- queued|triaged|fixing|pr_open|checks_failed|merged|deployed|verified|failed|reverted|rejected
    issue_url TEXT,
    pr_url TEXT,
    merge_sha TEXT,
    revert_pr_url TEXT,
    reverted_by TEXT,
    reverted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS autofixes_updated ON autofixes(updated_at)`,
  // Append-only audit log of every auto-fix step. Never UPDATE or DELETE rows here.
  `CREATE TABLE IF NOT EXISTS autofix_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    autofix_id INTEGER NOT NULL,
    actor TEXT NOT NULL,
    status TEXT,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS autofix_events_fix ON autofix_events(autofix_id, id)`,
  // Admin actions in this tool (settings, mutes, people, downloads, reverts).
  `CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
];

// Columns added after the first release: [table, column, type]. All nullable.
export const ADDED_COLUMNS = [];

async function addMissingColumns(db) {
  for (const [table, col, type] of ADDED_COLUMNS) {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
    if (results.some((c) => c.name === col)) continue;
    try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run(); }
    catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
  }
}

export async function applySchema(db) {
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  await addMissingColumns(db);
}

let ready = null;
export function ensureSchema(db) {
  if (!ready) ready = applySchema(db).catch((e) => { ready = null; throw e; });
  return ready;
}
/** For tests: forget that the schema was applied in this isolate. */
export function resetSchemaCache() { ready = null; }
