// Request rules for the dashboard API. The dashboard is same-origin only: there is no CORS (no
// Access-Control-Allow-Origin is ever sent), so other sites can't read anything.
//   CSRF  every state-changing request (anything but GET/HEAD/OPTIONS) must carry X-Yondr-Ops: 1 (a custom header,
//         which a cross-site form can't send) AND an Origin header equal to this site's own origin
//         (http://localhost / 127.0.0.1 also allowed while running locally with DEV_EMAIL).
// Token routes (src/ingest.js) are server-to-server and authenticated by X-Ops-Token instead.
export const CSRF_HEADER = 'x-yondr-ops';
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export function isAllowedOrigin(origin, request, env = {}) {
  if (!origin || typeof origin !== 'string') return false;
  if (origin === new URL(request.url).origin && origin.startsWith('https://')) return true;
  return !!env.DEV_EMAIL && LOCAL_ORIGIN_RE.test(origin);
}

/** null if the request may change state, otherwise the reason it may not. */
export function csrfProblem(request, env) {
  if (SAFE_METHODS.has(request.method)) return null;
  if (request.headers.get(CSRF_HEADER) !== '1') return 'Missing X-Yondr-Ops header.';
  if (!isAllowedOrigin(request.headers.get('origin'), request, env)) return 'Origin not allowed.';
  return null;
}

export const COMMON = {
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...COMMON, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}
