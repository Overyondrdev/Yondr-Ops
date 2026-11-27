// What yondr-ops watches. Adding a site is ONE line in GATE below (and, if it is a new Worker, one word in
// EXPECTED_INVENTORY). Everything else (state machine, alerts, dashboard) picks it up automatically.
//
// Every check has a stable `id` (used for its history, mutes and incidents: don't rename one casually).

export const ACCOUNT_ID = '3fac6c19097c5692e17198cffa818085';
export const AUTH_LOGIN = 'https://auth.overyondrdev.com/login';
export const DASHBOARD_URL = 'https://ops.overyondrdev.com';

// ---------------------------------------------------------------------------------------------------------------
// 1. Signed-out gate checks (every 5 minutes). Each request is sent WITHOUT cookies and WITHOUT following redirects.
//    expect: 'login'           302 to https://auth.overyondrdev.com/login?...  (a 200 here = "site exposed")
//            { redirect: re }   a redirect whose Location matches re (cards uses its own /auth step)
//            { status: n }      exactly that status (a 200 where 401 is expected = "site exposed")
//    site: the name people see in alerts.
// ---------------------------------------------------------------------------------------------------------------
export const GATE = [
  { id: 'gate:portal', site: 'Portal (overyondrdev.com)', url: 'https://overyondrdev.com/', expect: 'login' },
  { id: 'gate:www', site: 'Portal (www)', url: 'https://www.overyondrdev.com/', expect: 'login' },
  { id: 'gate:v1', site: 'Website V1', url: 'https://v1.overyondrdev.com/', expect: 'login' },
  { id: 'gate:v2', site: 'Website V2', url: 'https://v2.overyondrdev.com/', expect: 'login' },
  { id: 'gate:ads', site: 'Ad library', url: 'https://ads.overyondrdev.com/', expect: 'login' },
  { id: 'gate:requests', site: 'Marketing requests', url: 'https://requests.overyondrdev.com/', expect: 'login' },
  { id: 'gate:feedback-admin', site: 'Feedback admin', url: 'https://feedback.overyondrdev.com/admin', expect: 'login' },
  { id: 'gate:cards', site: 'Christmas cards', url: 'https://cards.overyondrdev.com/',
    expect: { redirect: /^(https:\/\/cards\.overyondrdev\.com)?\/auth(\b|\/|\?|$)/ } },
  { id: 'gate:auth', site: 'Sign-in page', url: 'https://auth.overyondrdev.com/login', expect: { status: 200 }, public: true },
  { id: 'gate:feedback-widget', site: 'Feedback widget', url: 'https://feedback.overyondrdev.com/widget.js', expect: { status: 200 }, public: true },
  { id: 'gate:feedback-api', site: 'Feedback API', url: 'https://feedback.overyondrdev.com/api/me', expect: { status: 401 } },
];

// Hosts that must be listed in the Access Bypass application (they check the Yondr sign-in themselves).
// Derived from GATE plus hosts that aren't fetched above.
export const ACCESS_BYPASS_APP = 'Yondr sites (Google sign-in)';
export const GATED_HOSTS = [...new Set([...GATE.map((c) => new URL(c.url).hostname), 'ops.overyondrdev.com'])];

// ---------------------------------------------------------------------------------------------------------------
// 2. overyondr.com must still be Squarespace until the cutover (owner sign-off). A change = warning.
// ---------------------------------------------------------------------------------------------------------------
export const PUBLIC_SITE = {
  id: 'public:overyondr.com', site: 'overyondr.com (public site)', url: 'https://overyondr.com/',
  location: /^https:\/\/www\.overyondr\.com\/?$/,
};

// ---------------------------------------------------------------------------------------------------------------
// 3. Cloudflare API checks (need the CF_API_TOKEN secret; skipped without it). `every` = minutes between runs.
// ---------------------------------------------------------------------------------------------------------------
// Workers deployed by Workers Builds: the latest build on the production branch must not have failed.
// (Pull-request preview builds are ignored: the website's PR preview build always fails by design.)
export const BUILDS = { every: 5, workers: [
  { worker: 'overyondr-website-v1', branch: 'main' },
  { worker: 'yondr-ad-portal', branch: 'main' },
  { worker: 'yondr-christmas-cards', branch: 'main' },
] };

// What should exist in the account (docs/OPERATIONS.md section 1). New or missing = warning.
export const EXPECTED_INVENTORY = { every: 60,
  workers: ['overyondr-website-v1', 'yondr-feedback', 'yondr-auth', 'yondr-ad-portal', 'yondr-christmas-cards',
    'yondr-marketing-requests', 'yondr-ops'],
  d1: ['yondr-feedback', 'yondr-ad-portal-db', 'yondr-marketing-requests-db', 'yondr-christmas-cards', 'yondr-ops'],
  kv: ['yondr-feedback-screenshots'],
  r2: ['yondr-ad-portal-assets', 'yondr-marketing-requests-files', 'yondr-brand-public', 'yondr-ops-backups'],
};

export const ACCESS = { every: 60 };

// Daily usage against the Workers FREE plan limits (UTC day). Warning at 70 %, high at 90 %.
export const USAGE = { every: 60, warnAt: 0.7, highAt: 0.9, limits: {
  workers_requests: { label: 'Workers requests', limit: 100_000 },
  d1_rows_read: { label: 'D1 rows read', limit: 5_000_000 },
  d1_rows_written: { label: 'D1 rows written', limit: 100_000 },
  ai_neurons: { label: 'Workers AI neurons', limit: 10_000 },
} };

// ---------------------------------------------------------------------------------------------------------------
// 4. Repositories the auto-fix log may refer to, and revert PRs may be opened in.
// ---------------------------------------------------------------------------------------------------------------
export const ALLOWED_REPOS = [
  'Overyondrdev/overyondr-website-v1', 'Overyondrdev/overyondr-website-v2', 'Overyondrdev/yondr-feedback',
  'Overyondrdev/digital-ads-portal', 'Overyondrdev/christmass-cards', 'Overyondrdev/marketing-request-portal',
  'Overyondrdev/yondr-ops',
];

/** Every check id the dashboard should show, with its label (Cloudflare ones appear once they've run). */
export function staticChecks() {
  return [
    ...GATE.map((c) => ({ id: c.id, site: c.site, kind: 'gate', url: c.url })),
    { id: PUBLIC_SITE.id, site: PUBLIC_SITE.site, kind: 'public', url: PUBLIC_SITE.url },
  ];
}
