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
  { worker: 'overyondr-website-v2', branch: 'main' },
  { worker: 'yondr-ad-portal', branch: 'main' },
  { worker: 'yondr-christmas-cards', branch: 'main' },
] };

// What should exist in the account (docs/OPERATIONS.md section 1). New or missing = warning.
export const EXPECTED_INVENTORY = { every: 60,
  workers: ['overyondr-website-v1', 'overyondr-website-v2', 'yondr-feedback', 'yondr-auth', 'yondr-ad-portal', 'yondr-christmas-cards',
    'yondr-marketing-requests', 'yondr-ops'],
  d1: ['yondr-feedback', 'yondr-ad-portal-db', 'yondr-marketing-requests-db', 'yondr-christmas-cards', 'yondr-ops',
    'yondr-ops-restore-drill'],
  kv: ['yondr-feedback-screenshots', 'yondr-directory'],
  r2: ['yondr-ad-portal-assets', 'yondr-marketing-requests-files', 'yondr-brand-public', 'yondr-ops-backups'],
};

export const ACCESS = { every: 60 };

// The people directory (yondr-auth's KV `yondr-directory`, synced 4 times a day; src/directory.js). Read through the
// read-only-by-code DIRECTORY binding. No successful sync for staleHours = warning.
export const DIRECTORY = { every: 60, staleHours: 13 };

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

// ---------------------------------------------------------------------------------------------------------------
// 5. Auto-fix (README "Auto-fix"). Which repository fixes a feedback project, and how a merged fix is verified.
// ---------------------------------------------------------------------------------------------------------------
// Feedback `project` (as the widget sends it) -> repository. A project not listed here always goes to a person.
export const PROJECT_REPOS = {
  v1: 'Overyondrdev/overyondr-website-v1',
  portal: 'Overyondrdev/overyondr-website-v1',
  v2: 'Overyondrdev/overyondr-website-v2',
  ads: 'Overyondrdev/digital-ads-portal',
  requests: 'Overyondrdev/marketing-request-portal',
  cards: 'Overyondrdev/christmass-cards',
  feedback: 'Overyondrdev/yondr-feedback',
  ops: 'Overyondrdev/yondr-ops',
};
// Per repository: does it have the auto-fix workflows (.github/workflows/autofix*.yml)? Only those get issues; the
// others go to a person until the workflows are added there (README "Auto-fix" → "Adding a repository").
// worker: the Workers Builds Worker whose production build of the fix is watched; gates: the GATE checks that must
// stay fine for 15 minutes after it is live, or the fix is reverted automatically.
export const AUTOFIX_TARGETS = {
  'Overyondrdev/overyondr-website-v1': { workflow: true, worker: 'overyondr-website-v1', gates: ['gate:portal', 'gate:www', 'gate:v1'] },
  'Overyondrdev/overyondr-website-v2': { workflow: true, worker: 'overyondr-website-v2', gates: ['gate:v2'] },
  'Overyondrdev/digital-ads-portal': { workflow: false, worker: 'yondr-ad-portal', gates: ['gate:ads'] },
  'Overyondrdev/christmass-cards': { workflow: false, worker: 'yondr-christmas-cards', gates: ['gate:cards'] },
  'Overyondrdev/marketing-request-portal': { workflow: false, worker: null, gates: ['gate:requests'] },
  'Overyondrdev/yondr-feedback': { workflow: false, worker: null, gates: ['gate:feedback-admin', 'gate:feedback-widget', 'gate:feedback-api'] },
  'Overyondrdev/yondr-ops': { workflow: false, worker: null, gates: [] },
};
export const AUTOFIX = {
  verifyMinutes: 15,        // a live fix must stay clean this long before it counts as verified
  buildWaitMinutes: 45,     // no production build of the fix after this long = deploy not confirmed (site checks only)
  engineTimeoutMinutes: 180, // an issue with no pull request after this long = the engine gave up
  hardCapPerHour: 10,       // absolute ceiling on issues per hour, critical ones included
  perRun: 3,                // issues opened per 5-minute run at most (subrequest budget)
  watchPerRun: 6,           // pull requests / builds looked up per run at most
  maxAttempts: 3,           // failed attempts to open an issue before giving up
};

/** Every check id the dashboard should show, with its label (Cloudflare ones appear once they've run). */
export function staticChecks() {
  return [
    ...GATE.map((c) => ({ id: c.id, site: c.site, kind: 'gate', url: c.url })),
    { id: PUBLIC_SITE.id, site: PUBLIC_SITE.site, kind: 'public', url: PUBLIC_SITE.url },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// 6. Workers (Overview, Errors, Deploys, rollback). gates: the GATE checks that show whether the Worker's site works;
//    a deploy that makes one of them fail is a regression (src/deploys.js). Same names as EXPECTED_INVENTORY.workers.
// ---------------------------------------------------------------------------------------------------------------
export const WORKERS = [
  { worker: 'overyondr-website-v1', label: 'Website (portal, V1)', gates: ['gate:portal', 'gate:www', 'gate:v1'] },
  { worker: 'overyondr-website-v2', label: 'Website V2', gates: ['gate:v2'] },
  { worker: 'yondr-feedback', label: 'Feedback tool', gates: ['gate:feedback-admin', 'gate:feedback-widget', 'gate:feedback-api'] },
  { worker: 'yondr-auth', label: 'Sign-in', gates: ['gate:auth'] },
  { worker: 'yondr-ad-portal', label: 'Ad library', gates: ['gate:ads'] },
  { worker: 'yondr-christmas-cards', label: 'Christmas cards', gates: ['gate:cards'] },
  { worker: 'yondr-marketing-requests', label: 'Marketing requests', gates: ['gate:requests'] },
  { worker: 'yondr-ops', label: 'Yondr Ops', gates: [] },
];
export const workerOf = (name) => WORKERS.find((w) => w.worker === name) || null;

// Server errors per Worker (src/errors.js, every 5 minutes with CF_API_TOKEN): over the last `windowMinutes`, with at
// least `minRequests` requests, an error rate above warnPct = warning, above highPct = high.
export const ERRORS = { every: 5, windowMinutes: 15, minRequests: 20, warnPct: 2, highPct: 10, keepDays: 8 };
// Browser errors reported by the feedback widget: more than `client_errors_threshold` (setting, default 20) in this
// many minutes for one project = client_errors_spike (at most one alert per project per hour).
export const CLIENT_ERRORS = { windowMinutes: 15, realertMinutes: 60, maxSamples: 10 };

// Deploy watch (src/deploys.js): every new deployment is compared with the hour before it for 15 minutes.
export const DEPLOY_WATCH = { watchMinutes: 15, baselineMinutes: 60, minRequests: 20, maxNewDeployAgeMinutes: 60,
  // worse = error rate after > max(floorPct, 2 × before + 1 point), with at least minRequests after the deploy
  floorPct: 2 };

// Secrets each Worker needs (names only; Overview "setup gaps", read with GET .../workers/scripts/<name>/settings).
export const EXPECTED_SECRETS = {
  'yondr-ops': ['CF_API_TOKEN', 'CF_DEPLOY_TOKEN', 'GITHUB_TOKEN', 'OPS_INGEST_TOKEN', 'RESEND_API_KEY'],
  'yondr-feedback': ['OPS_INGEST_TOKEN'],
  'yondr-christmas-cards': ['RESEND_API_KEY'],
};

// Cloudflare Access seats (daily): any seat in use means someone signs in through Access instead of the Yondr sign-in.
export const ACCESS_SEATS = { every: 1440 };

// Tools whose people & roles ops shows (People & permissions). Only feedback/ops roles are editable from ops.
export const TOOLS = {
  feedback: { label: 'Feedback tool & Ops', manage: 'https://feedback.overyondrdev.com/admin#people' },
  ads: { label: 'Ad library', manage: 'https://ads.overyondrdev.com/' },
  requests: { label: 'Marketing requests', manage: 'https://requests.overyondrdev.com/' },
  cards: { label: 'Christmas cards', manage: 'https://cards.overyondrdev.com/' },
};
