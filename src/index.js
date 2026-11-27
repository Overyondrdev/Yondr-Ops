// yondr-ops: monitoring, alerts, backups and the auto-fix log for the overyondrdev.com estate,
// on https://ops.overyondrdev.com.
//   /                   the ops dashboard (sign-in required; only feedback-tool admins/owners get in)
//   /status             the staff status page (any signed-in @overyondr.com person; same app, read-only view)
//   /api/*              the dashboard API (admins; staff only GET /api/me and GET /api/status/public; CSRF in ./http.js)
//   POST /api/events, POST /api/autofix/events, POST /api/autofix/feedback, GET /api/autofix/config
//                       server-to-server, authenticated by the X-Ops-Token header (./ingest.js)
//   /brand/*, /robots.txt  public static files
// Cron: every 5 minutes → monitoring (./monitor.js); 2 minutes later, every 5 minutes → auto-fix queue, watch,
// verification and automatic revert (./verify.js, its own invocation so it has its own subrequest budget);
// 03:17 UTC → backups (./backups.js).
// Static files are bundled into the script (src/static.generated.js, from public/).
import { handleApi } from './api.js';
import { currentUser, roleOf } from './auth.js';
import { ingestAutofix } from './autofix.js';
import { autofixConfig } from './budget.js';
import { runDaily } from './daily.js';
import { COMMON, csrfProblem, json } from './http.js';
import { ingestClientErrors } from './errors.js';
import { hasIngestToken, ingestEvent, TOKEN_ROUTES } from './ingest.js';
import { touchSeen } from './people.js';
import { runMonitor } from './monitor.js';
import { triageFeedback } from './triage.js';
import { runAutofix } from './verify.js';
import { ensureSchema } from './schema.js';
import { getSettings } from './settings.js';
import { publicStatus } from './status.js';
import { FILES } from './static.generated.js';
import { loginUrl } from './yondr-session.js';

// Not exported: the main module may only export handlers.
const BACKUP_CRON = '17 3 * * *';
const AUTOFIX_CRON = '2-59/5 * * * *';
const PUBLIC_FILE = /^\/(robots\.txt|brand\/[\w./-]+)$/;
// auth.overyondrdev.com: the shared people picker (script) and the directory it reads (/api/people, with credentials).
const PEOPLE = 'https://auth.overyondrdev.com';
const CSP = `default-src 'none'; script-src 'self' ${PEOPLE}; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${PEOPLE}; ` +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export function cacheControl(path) {
  if (path.startsWith('/brand/')) return 'public, max-age=2592000';
  if (path === '/index.html') return 'private, no-cache';
  if (path === '/app.js' || path === '/app.css') return 'private, max-age=31536000, immutable'; // refs carry ?v=hash
  return 'public, max-age=86400';
}

const bytesCache = new Map();
function fileBody(path, f) {
  if (f.text != null) return f.text;
  if (!bytesCache.has(path)) bytesCache.set(path, Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)));
  return bytesCache.get(path);
}
function serveFile(request, path) {
  const f = FILES[path];
  if (!f) return notFound();
  const headers = { ...COMMON, 'content-type': f.type, 'cache-control': cacheControl(path), etag: f.etag };
  if (path.endsWith('.html')) { headers['content-security-policy'] = CSP; headers['x-frame-options'] = 'DENY'; }
  if (request.headers.get('if-none-match') === f.etag) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : fileBody(path, f), { headers });
}
function notFound() {
  return new Response('Not found', { status: 404, headers: { ...COMMON, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

async function tokenRoute(request, env, key) {
  await ensureSchema(env.DB);
  if (key === 'GET /api/autofix/config') {
    // The workflows' gate: off when switched off in Settings OR paused because of the monthly budget (src/budget.js).
    const c = await autofixConfig(env.DB, await getSettings(env.DB));
    return json({ autofix_enabled: c.autofix_enabled, reason: c.reason });
  }
  const b = await request.json().catch(() => null);
  // Browser errors from the feedback widget share /api/events (type "client_errors"): src/errors.js.
  const r = key === 'POST /api/events' && b && b.type === 'client_errors' ? await ingestClientErrors(env, b)
    : key === 'POST /api/events' ? await ingestEvent(env, b)
    : key === 'POST /api/autofix/feedback' ? await triageFeedback(env, b)
    : await ingestAutofix(env, b);
  return json(r.body, r.status);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const isApi = path.startsWith('/api/');
    try {
      if ((method === 'GET' || method === 'HEAD') && PUBLIC_FILE.test(path)) return serveFile(request, path);

      // Server-to-server: the shared ingest token. A wrong or missing token on a POST is refused outright.
      const key = `${method} ${path}`;
      if (TOKEN_ROUTES.has(key)) {
        if (await hasIngestToken(request, env)) return await tokenRoute(request, env, key);
        if (method !== 'GET') return json({ error: 'Missing or wrong X-Ops-Token.' }, 401);
      }

      const user = await currentUser(request, env).catch(() => null);
      if (!user) {
        if (!isApi && (method === 'GET' || method === 'HEAD')) return new Response(null, { status: 302, headers: { location: loginUrl(request), 'cache-control': 'no-store' } });
        return json({ error: 'Please sign in with your Yondr Google account.' }, 401);
      }

      if (isApi) {
        const problem = csrfProblem(request, env);
        if (problem) return json({ error: problem }, 403);
        const role = await roleOf(env, user.email);
        const route = path.slice('/api/'.length);
        await ensureSchema(env.DB);
        const seen = touchSeen(env.DB, user.email).catch(() => {});
        if (ctx && ctx.waitUntil) ctx.waitUntil(seen); else await seen;
        if (!role) {
          // Every signed-in @overyondr.com person (staff) may read the status page; everything else is admins only.
          if (method === 'GET' && route === 'me') return json({ email: user.email, name: user.name, role: null, staff: true });
          if (method === 'GET' && route === 'status/public') return json(await publicStatus(env.DB));
          return json({ error: 'Admins only. Ask an owner to add you in the feedback tool (People).' }, 403);
        }
        return await handleApi(request, env, ctx, route, { ...user, role });
      }
      if (method !== 'GET' && method !== 'HEAD') return json({ error: 'Method not allowed' }, 405);
      if (path === '/' || path === '/index.html' || path === '/status') return serveFile(request, '/index.html');
      if (path === '/app.js' || path === '/app.css') return serveFile(request, path);
      return notFound();
    } catch (e) {
      console.error('request failed', method, path, e && e.stack);
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    const nowMs = controller.scheduledTime || Date.now();
    const job = controller.cron === BACKUP_CRON ? runDaily(env, { nowMs })
      : controller.cron === AUTOFIX_CRON ? runAutofix(env, { nowMs })
      : runMonitor(env, { nowMs });
    ctx.waitUntil(job.then((r) => console.log('cron', controller.cron, JSON.stringify(r && r.backups && r.backups.results ? { ...r, backups: { ok: r.backups.ok, failed: r.backups.failed, deleted: r.backups.deleted }, drill: r.drill && (r.drill.results ? { ok: r.drill.ok, failed: r.drill.failed } : r.drill) } : r)))
      .catch((e) => { console.error('cron failed', controller.cron, e && e.stack); throw e; }));
  },
};
