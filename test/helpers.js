// Test doubles: D1 over node:sqlite (in memory), an R2 bucket, the send_email binding, a signed Yondr session.
import { DatabaseSync } from 'node:sqlite';

export function fakeD1(sqlite = new DatabaseSync(':memory:')) {
  const plain = (r) => (r == null ? null : { ...r });
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...args) { return new Stmt(this.sql, args); }
    async first() { return plain(sqlite.prepare(this.sql).get(...this.args)); }
    async all() { return { results: sqlite.prepare(this.sql).all(...this.args).map(plain), success: true }; }
    async run() { const r = sqlite.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; }
  }
  return {
    sqlite,
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      sqlite.exec('BEGIN');
      try { const out = []; for (const s of stmts) out.push(await s.all()); sqlite.exec('COMMIT'); return out; }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
}

/** The feedback tool's database as far as ops cares: the admins table. */
export function feedbackDb(admins = []) {
  const db = fakeD1();
  db.sqlite.exec(`CREATE TABLE admins (email TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'admin', added_by TEXT, added_at TEXT NOT NULL);
    CREATE TABLE feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL, created_at TEXT NOT NULL, title TEXT, site TEXT, project TEXT,
      priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'new', type TEXT NOT NULL DEFAULT 'bug', author_email TEXT);
    CREATE TABLE activity (id INTEGER PRIMARY KEY AUTOINCREMENT, feedback_id INTEGER, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);`);
  const ins = db.sqlite.prepare("INSERT INTO admins (email, role, added_at) VALUES (?, ?, '2026-11-01')");
  for (const [email, role] of admins) ins.run(email, role);
  return db;
}

export function fakeR2() {
  const m = new Map();
  return {
    map: m,
    async put(key, value, opts = {}) { m.set(key, { bytes: new Uint8Array(value), opts }); },
    async get(key) {
      const o = m.get(key);
      if (!o) return null;
      return { size: o.bytes.byteLength, body: new Response(o.bytes).body, customMetadata: o.opts.customMetadata };
    },
    async list({ prefix = '' } = {}) { return { objects: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false }; },
    async delete(keys) { for (const k of [].concat(keys)) m.delete(k); },
  };
}

export function fakeEmail() {
  const sent = [];
  return { sent, async send(msg) { sent.push(msg); return { messageId: String(sent.length) }; } };
}

export const OWNER = 'ada.owner@overyondr.com';
export const ADMIN = 'ben.admin@overyondr.com';
export const STAFF = 'cy.staff@overyondr.com';
export const NEWBIE = 'dee.new@overyondr.com';
export const TOKEN = 'test-ingest-token-0123456789abcdef0123456789';

// A real ES256 key pair, so the session cookie is verified exactly as in production (src/yondr-session.js).
const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
export const PUBLIC_JWK = JSON.stringify({ ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'test-key' });
const b64u = (b) => Buffer.from(b).toString('base64url');
export async function session(email, { exp = Date.now() / 1000 + 3600 } = {}) {
  const h = b64u(JSON.stringify({ alg: 'ES256', kid: 'test-key', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ typ: 'session', iss: 'https://auth.overyondrdev.com', aud: 'overyondrdev.com', exp, email, name: 'Test' }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}

/** A complete env, as the deployed Worker would see it (minus the secrets a test adds). */
export function makeEnv(extra = {}) {
  return {
    DB: fakeD1(), FEEDBACK_DB: feedbackDb([[OWNER, 'owner'], [ADMIN, 'admin']]), ADS_DB: fakeD1(), REQUESTS_DB: fakeD1(), CARDS_DB: fakeD1(),
    BACKUPS: fakeR2(), EMAIL: fakeEmail(), YONDR_AUTH_PUBLIC_JWK: PUBLIC_JWK, ALLOWED_EMAIL_DOMAINS: 'overyondr.com',
    EMAIL_FROM: 'alerts@overyondrdev.com', EMAIL_TRANSPORT: 'cloudflare', OPS_INGEST_TOKEN: TOKEN, ...extra,
  };
}

/** Replace global fetch for one test; returns the list of calls. handler(url, init) → Response. */
export function mockFetch(t, handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  t.after(() => { globalThis.fetch = orig; });
  return calls;
}

/** One request through the Worker's fetch handler as a signed-in person (CSRF header and Origin on changes). */
export async function callWorker(env, worker, path, { method = 'GET', as = ADMIN, body, csrf = true, headers = {}, base = 'https://ops.overyondrdev.com' } = {}) {
  const h = { ...headers };
  if (as) h.cookie = `other=1; yondr_session=${await session(as)}`;
  if (method !== 'GET') h.origin = base;
  if (method !== 'GET' && csrf) h['x-yondr-ops'] = '1';
  if (body) h['content-type'] = 'application/json';
  const pending = [];
  const res = await worker.fetch(new Request(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  const type = res.headers.get('content-type') || '';
  return { res, status: res.status, data: type.includes('json') ? await res.json() : null, text: type.includes('json') ? null : await res.text() };
}

/** Add an alert subscriber with email rules for these event types. Returns its id. */
export function subscribe(env, email, events) {
  const s = env.DB.sqlite.prepare("INSERT INTO subscribers (email, created_by, created_at, updated_at) VALUES (?, 'x', 'x', 'x') RETURNING id").get(email);
  for (const e of events) env.DB.sqlite.prepare("INSERT INTO subscriptions (subscriber_id, event_type, channel, created_at) VALUES (?, ?, 'email', 'x')").run(s.id, e);
  return s.id;
}

/** Probe answers for a monitoring run: every gate fine, except the overrides { url: response-like }. */
export function probes(overrides = {}) {
  return async (url) => {
    if (overrides[url]) return overrides[url];
    if (url === 'https://cards.overyondrdev.com/') return { status: 302, location: 'https://cards.overyondrdev.com/auth' };
    if (url === 'https://auth.overyondrdev.com/login' || url.endsWith('/widget.js')) return { status: 200 };
    if (url.endsWith('/api/me')) return { status: 401 };
    if (url === 'https://overyondr.com/') return { status: 301, location: 'https://www.overyondr.com/', server: 'Squarespace' };
    return { status: 302, location: 'https://auth.overyondrdev.com/login?return=x' };
  };
}
