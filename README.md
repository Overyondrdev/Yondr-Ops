# yondr-ops

Monitoring, alerts, backups and the auto-fix log for Yondr's `overyondrdev.com` estate. One Cloudflare Worker,
`yondr-ops`, on **https://ops.overyondrdev.com**.

- **Watches** every site every 5 minutes as a signed-out visitor (is it up? does it still ask for the Yondr sign-in?),
  checks that `overyondr.com` is still Squarespace, and reads Cloudflare: failed deploys, the Access Bypass app,
  Workers/D1/KV/R2 that appeared or disappeared, and daily usage against the free-plan limits.
- **Alerts** the right people by email and Slack, only when something changes (plus an hourly reminder while a critical
  problem lasts), with a plain explanation and a link to the dashboard. Admins add people and choose what each gets.
- **Backs up** every D1 database to R2 every night (03:17 UTC), with retention rules and a restore procedure.
- **Runs the auto-fix engine**: triages every feedback item (only objective bugs are fixed automatically), opens a
  GitHub issue that the repository's Claude Code workflow fixes in a pull request, verifies the deploy and reverts
  automatically if anything breaks. Every step is logged, with a one-click **Revert** (section "Auto-fix").

- **Admin dashboard** (v2): Overview of everything, an **Issues** tracker (opened automatically for incidents, failed
  deploys and auto-fixes), **Errors** (server and browser), **Deploys** with a 15-minute deploy watch and owners-only
  one-click **rollback**, a monthly **restore drill** of every backup, a **key-expiry calendar**, the quarterly **access
  review**, a Cloudflare **Access seat** watch, and **People & permissions** across the tools.
- **Status page** for all staff: `/status` (any signed-in `@overyondr.com` person): is each site working, uptime over 7
  and 30 days, incidents in plain words.

Only **admins of the feedback tool** can use the dashboard (one admin list for Yondr tools, see "Who can use it");
every signed-in Yondr person can read the status page.

Platform rules (sign-in, hosts, deploy lessons) live in `Overyondrdev/overyondr-website-v1` → `docs/PLATFORM.md` and
`docs/OPERATIONS.md`. Read them before changing sign-in, hosts or deploys.

## Where things live

| Path | What |
| --- | --- |
| `src/checks.js` | **What is watched**: the signed-out gate checks (one line per site), expected Cloudflare inventory, usage limits, allowed repos |
| `src/evaluate.js` | Pure rules: what counts as fine / down / exposed / changed for one HTTP answer |
| `src/cloudflare.js` | Cloudflare API checks (builds, Access, inventory, GraphQL usage) |
| `src/state.js` | State machine: alert on change, resolved alerts, critical reminders, mutes, incident log |
| `src/monitor.js` | The 5-minute run |
| `src/alerts.js` | Alert types, routing (severity, quiet hours, owners), message text, Slack, alert log |
| `src/email.js` | Email transports: Resend (standard) or Cloudflare Email Service |
| `src/digest.js` | Daily digest and weekly backup summary |
| `src/directory.js` | People directory (yondr-auth's KV, **read only**): the `directory:sync` check, the digest line, the Overview line |
| `src/backups.js` | Nightly D1 → R2 backups and retention |
| `src/triage.js`, `src/classify.js` | Auto-fix triage (the owner's rules), Workers AI objective/subjective classifier, the GitHub issue |
| `src/verify.js` | Auto-fix watch: pull-request backstop, deploy + site verification, automatic revert |
| `src/autofix.js`, `src/github.js` | Auto-fix log, ingest, one-click revert via the GitHub API |
| `src/budget.js` | Auto-fix spending: cost per run, monthly budget, forecast, warnings, pause at 90 %, owner approvals |
| `src/ingest.js` | Server-to-server endpoints with the `X-Ops-Token` header |
| `src/overview.js`, `src/cfcache.js` | The Overview (one call), Cloudflare answers cached 5 minutes in `cf_cache` |
| `src/issues.js` | Issues tracker: automatic issues, assignment and critical alerts, from feedback items |
| `src/status.js` | Staff status page and uptime history (`check_history`) |
| `src/errors.js` | Server errors per Worker (`errors:<worker>`), browser errors (`client_errors`) |
| `src/deploys.js` | Deployments per Worker, deploy watch, one-click rollback |
| `src/drill.js` | Monthly restore drill into the scratch database `DRILL_DB` (the only place anything is dropped) |
| `src/keys.js` | Key-expiry calendar and `key_expiring` alerts (never key values) |
| `src/people.js`, `src/review.js` | Directory and roles across tools, feedback/ops role changes via the feedback tool; quarterly access review |
| `src/daily.js` | The daily jobs on the backup cron (drill, keys, access review, retention) |
| `src/api.js` | Dashboard API (admins) |
| `src/index.js` | Routing, sign-in gate, static files, cron dispatch |
| `src/auth.js` | Who is signed in (Yondr session; `DEV_EMAIL` locally) and their role (feedback tool's `admins` table) |
| `src/readonly.js` | Read-only wrapper for other tools' databases |
| `src/schema.js` | D1 schema of `yondr-ops`, applied automatically; additive changes only |
| `src/yondr-session.js` | **Unchanged copy** of `overyondr-website-v1/auth/src/session.js` (CI compares) |
| `public/` | Dashboard (`index.html`, `app.js`, `app.css`) and brand files; bundled into the Worker by `scripts/build-static.mjs` |
| `scripts/check.mjs` | Repo rules: syntax, Wrangler safety, read-only foreign DBs, no personal emails or secrets |
| `test/` | `node --test`; `test/helpers.js` stands in for D1 with `node:sqlite`, R2 and the email binding |

## Who can use it

Every page and API needs the **Yondr Google sign-in** (`yondr_session` cookie, checked on every request; signed-out
pages redirect to `auth.overyondrdev.com/login`, the API answers 401). On top of that, only people in the feedback
tool's admin list get in: ops reads `SELECT role FROM admins WHERE email = ?` from D1 `yondr-feedback` (binding
`FEEDBACK_DB`, only ever read). Roles:

- **admin**: everything in the dashboard except Settings and personal-data backup downloads.
- **owner**: also changes Settings (kill switches, retention, transport, auto-fix budget), approves more auto-fix
  spend, and downloads Christmas-cards backups.
  Owners always get "site down" and "site exposed" alerts.

Add or remove admins in **People & permissions** here or in **feedback.overyondrdev.com/admin → People**: both change
the same list (ops goes through the feedback tool's own API). There is no second list.

- **staff** (any signed-in `@overyondr.com` person who is not an admin): only the **Status** page (`/status`,
  `GET /api/status/public`). Everything else answers 403.
- **Owners only**: Settings, approving auto-fix spend, **Roll back**, **Run restore drill now**, removing keys from the
  calendar, opening an access review by hand, making someone owner (the feedback tool enforces that), PII backup
  downloads.

## What is checked

Every 5 minutes (cron `*/5 * * * *`), as a signed-out visitor, without following redirects:

| Check | Fine when | Otherwise |
| --- | --- | --- |
| `overyondrdev.com`, `www.`, `v1.`, `v2.`, `ads.`, `requests.`, `feedback./admin` | 302 to `https://auth.overyondrdev.com/login?…` | 200 = **site exposed** (critical); 5xx/timeout = **site down** (critical, after one retry); Access login = warning (costs seats); anything else = site down (high) |
| `cards.` | redirect to its own `/auth` | same |
| `auth.overyondrdev.com/login` | 200 | site down |
| `feedback./widget.js` | 200 | site down |
| `feedback./api/me` | 401 | 200 = site exposed |
| `overyondr.com` | 301 to `www.overyondr.com`, served by Squarespace | warning "overyondr.com has changed" (nothing may change it before the cutover) |

Hourly, without a token: **`directory:sync`**, the people directory of the sign-in Worker (KV `yondr-directory`,
synced from the Yondr Team Contact List 4 times a day; overyondr-website-v1 `auth/README.md` "People directory").
Its status endpoint needs a signed-in session, so ops reads the key `directory:meta` through the read-only binding
`DIRECTORY` instead (`src/directory.js`; `npm run check` fails on any write to it).

| State | Result |
| --- | --- |
| Never synced, or the error says "Not set up" | "not checked" (unknown): "Directory not set up yet (service account key missing)." No alert |
| Last sync OK, last successful sync ≤ 13 hours ago | fine: "103 people, last updated …" |
| Last sync failed (`ok: false`) | configuration changed (warning) with the error text |
| Update held back (`guard: true`: it would have removed more than 20 % of people at once) | configuration changed (warning): "People directory update held back" |
| Last successful sync > 13 hours ago | configuration changed (warning): "People directory is out of date" |

With the `CF_API_TOKEN` secret (without it these show "not checked" and never alert):

| Check | How often | Alert |
| --- | --- | --- |
| `errors:<worker>` for every Worker in `WORKERS` (`src/checks.js`): errors ÷ requests in the last 15 minutes (GraphQL `workersInvocationsAdaptive`) | 5 min | > 2 % with ≥ 20 requests = `error_rate` warning, > 10 % = high |
| `cf:access-seats`: Zero Trust users with an Access seat (`GET /accounts/<id>/access/users`) | daily | any seat in use = `access_seats_used` (warning). Without the "Access: Users Read" permission: "not checked" |


| Check | How often | Alert |
| --- | --- | --- |
| Latest Workers Builds deploy of `main` for `overyondr-website-v1`, `overyondr-website-v2`, `yondr-ad-portal`, `yondr-christmas-cards` (PR preview builds ignored) | 5 min | failed = **deploy failed** (high) |
| Access app **"Yondr sites (Google sign-in)"** lists every gated host (incl. `ops.`) and has a Bypass policy; **no** Access app on overyondrdev.com (the `*.overyondrdev.com` catch-all included) has a non-Bypass policy (owner: no Access seats, ever) | hourly | missing host = configuration changed (warning); a seat-costing policy = configuration changed (**high**) |
| Workers, D1, KV, R2 vs `EXPECTED_INVENTORY` (= OPERATIONS.md §1) | hourly | new or missing = configuration changed (warning) |
| Today's usage (UTC): Workers requests (100k), D1 rows read (5M) / written (100k), Workers AI neurons (10k) | hourly | ≥ 70 % warning, ≥ 90 % high |

**Adding a site** is one line in `GATE` in `src/checks.js` (plus its Worker name in `EXPECTED_INVENTORY`, and in
`BUILDS` if it deploys with Workers Builds). Keep each check's `id` stable: history, mutes and incidents hang off it.

## Alerts

### Alert types and default routing

| Type | Usual severity | When | Who gets it by default |
| --- | --- | --- | --- |
| `site_down` | critical | A site or the sign-in page doesn't answer or errors | **Owners always** (can't be switched off) + new people |
| `site_exposed` | critical | A private site shows content to a signed-out visitor | **Owners always** (can't be switched off) + new people |
| `deploy_failed` | high | Latest production deploy failed | new people |
| `config_drift` | warning | Access Bypass app incomplete, inventory changed, overyondr.com changed, host behind Access | opt-in |
| `usage_limit` | warning / high | Daily usage ≥ 70 % / 90 % of the free plan | opt-in |
| `backup_failed` | high | A nightly backup failed | new people |
| `backup_ok_weekly_digest` | info | Mondays: last week's backups | opt-in |
| `autofix_started` | info | The engine started on a feedback item | opt-in |
| `autofix_merged` | info | An automatic fix is live and verified (says what was checked) | opt-in |
| `autofix_failed` | high | Checks failed or the engine gave up | new people |
| `autofix_reverted` | warning | An automatic fix was reverted (by an admin, or automatically after a failed deploy/site check) | new people |
| `autofix_budget_warning` | warning | This month's auto-fix Claude API spend reached 50 % / 70 % of the budget (once each a month) | **Owners always**, quiet hours ignored |
| `autofix_budget_projection` | warning | At the current pace the month will cost more than the budget (at most once a day) | **Owners always**, quiet hours ignored |
| `autofix_budget_paused` | high | Spend reached the pause level (90 %): auto-fix paused until an owner approves more | **Owners always**, quiet hours ignored |
| `autofix_budget_approved` | info | An owner approved more auto-fix spend for this month | **Owners always**, quiet hours ignored |
| `feedback_critical` | high | Feedback marked critical (sent by the feedback tool via `/api/events`) | new people |
| `daily_digest` | info | Every morning (first check after 08:00 UTC by default): open problems, incidents, backups, auto-fixes, auto-fix spend this month and forecast, and a **Directory** line (people count; names of people added to or gone from the directory since the previous digest; names only in this email to admins, never in GitHub issues) | new people |
| `error_rate` | warning / high | A Worker's error rate over 15 minutes is above 2 % / 10 % (≥ 20 requests) | opt-in |
| `client_errors_spike` | warning | More than `client_errors_threshold` (default 20) browser errors in 15 minutes for one project (at most hourly per project) | opt-in |
| `deploy_regression` | high | 15 minutes after a deployment, errors are clearly up or a site check started failing (link to Deploys) | new people |
| `rollback_done` | warning | An owner rolled a Worker back | **Owners always** |
| `restore_drill_failed` | high | The monthly restore drill didn't give back the same tables and rows | **Owners always** + new people |
| `key_expiring` | warning / high | A key in the calendar expires in 30 days, 14 days, or today/already | **Owners always** + the key's owner |
| `access_seats_used` | warning | Someone uses a Cloudflare Access seat | opt-in |
| `issue_assigned` | info | An issue was assigned to you | **Only the assignee, always** (not when you assign yourself; never by subscription) |
| `issue_critical` | critical | A new critical issue (by a person, from feedback, auto-fix or deploy; not for incident issues, whose incident already alerted) | **Owners always** |

"New people" = the rules a person gets when an admin adds them (they can be changed straight away).

**When alerts go out** (no spam): when a check starts failing; when it changes (e.g. down → exposed, or another host
goes missing); when it is fixed ("Resolved: …", only if people were told it broke); and every 60 minutes while a
**critical** problem lasts (setting). Events from other systems with the same `dedupe_key` (default: type + site +
title) within 60 minutes are logged but not sent again. Every delivery attempt is logged (Alerts tab →
"Recently sent": alert, channel, recipients, status, error).

Each message says, in plain words: what's wrong, which site, since when, what has been done automatically, and a link
to the dashboard. Subjects look like `Website V2 is open to the public [Critical]` / `Resolved: Ad library is down`.

### Adding a person (admins)

Dashboard → **Alerts** → *Add a person*: type a name or email and pick them from the Yondr directory (the shared
people picker; it fills the name too), or type the full address → **Add**. **Owners** can also add an
outside address (e.g. a personal inbox while company mail filtering is being set up): it receives alert emails only and
never gets sign-in or any access; the audit log marks it `external`. They start with the usual
email alerts (table above); the editor opens so you can change them. In the editor:

- **Send them**: everything / high and critical / critical only.
- **Quiet hours**: from–until in their time zone (wraps past midnight). Only **critical** alerts and the auto-fix
  spending alerts are sent then.
- **Active**: untick to pause all their alerts (owners still get site down / exposed).
- **Rules**: per alert type, email on/off and a Slack channel (one of the configured webhooks).
- **Send test alert** sends a test to their email and Slack channels; **Remove** takes them off the list.

People don't need to be admins to receive alerts; only admins can open the dashboard.

### Controlling alerts

- **Mute a check** (Status → *Mute*): 1 hour to 7 days, with a reason (logged in Incidents → Mutes). The check keeps
  running and incidents are logged; nobody is alerted. If it is still failing when the mute ends, people are told then.
- **Kill switches** (Settings, owners): Monitoring, Alerts (off = still checked and logged, nothing sent), Nightly
  backups, Auto-fix engine. Also: critical reminder interval, duplicate window, digest hour, backup retention.
- Every change is in the **Audit log** page.

### Slack

Each Slack channel is an **incoming webhook** stored as a Worker secret named `SLACK_WEBHOOK_<NAME>`, e.g.
`npx wrangler secret put SLACK_WEBHOOK_OPS` (paste the `https://hooks.slack.com/services/…` URL when asked). The
dashboard only ever shows and stores the *name*; webhook URLs never go in the repo or the database. After adding a
secret it appears in the Slack column of every person's rules. A channel gets one post per alert even if several
people route to it.

### Email transports

**Resend is the standard for all email on overyondrdev.com (owner decision, 27 Nov 2026).** Chosen by the
`email_transport` setting (Settings), else the `EMAIL_TRANSPORT` variable (`resend`):

- **`resend`** (default): Resend API with the `RESEND_API_KEY` secret (`overyondrdev.com` is verified in Resend), from
  `alerts@overyondrdev.com` ("Yondr Ops").
- **`cloudflare`**: Cloudflare Email Service. Not configured (no `send_email` binding); kept only as a fallback option.
- **`off`**: nothing is emailed (deliveries are logged as failed with the reason). Slack still works.

One email per recipient (nobody sees the others' addresses).

## Dashboard pages

Left navigation (collapses behind **Menu** on phones). Every page is keyboard operable, works at 375 px and has
loading, empty and error states.

**Person fields** (Alerts *Add a person*, issue assignee in *New issue*, the issue drawer and the Issues filter,
*Give someone admin access*, key owner, Audit log *Who*) use the shared Yondr directory picker
(`https://auth.overyondrdev.com/people-picker.js`, `<input data-people>`; overyondr-website-v1 docs/PLATFORM.md §8):
type a letter or two, pick with ↓/↑ and Enter. Only the Alerts field also takes outside addresses
(`data-people-external`; owners only, as before). The fields still accept a typed address, and the server checks
them exactly as before. In a modal dialog the picker's list is moved into the dialog while it is used (`pickerHome` in
`public/app.js`), so it isn't hidden behind the dialog.

| Page | What | Who |
| --- | --- | --- |
| **Overview** (`#overview`) | Every site (status, last deploy and its result, error rate 24 h), open incidents, open issues by priority, auto-fix (on/off, spend and forecast), backups (last good one per database, last drill), alerts sent in 24 h, setup gaps (missing secrets of yondr-ops, yondr-feedback, yondr-christmas-cards: names only, via `GET …/workers/scripts/<name>/settings`), feedback (new this week per project, critical open; read-only from `FEEDBACK_DB`), keys expiring, next access review, Access seats, people directory ("103 people, updated 2 h ago", or the problem), browser errors. Each card links to its page. Cloudflare answers are cached 5 minutes in `cf_cache`; refreshes every minute | admins |
| **Issues** (`#issues`, `#issues/<id>`) | The tracker (below) | admins |
| **Status** (`/status`, `#status`) | Sites up/down, uptime 7 / 30 days (from `check_history`), incidents of the last 7 days in plain words, last checked. Refreshes every minute (pause button); no technical detail | **all staff** |
| **Sites & checks** (`#checks`) | Every check with details, mutes, *Run checks now*; link to **Incidents** (`#incidents`) | admins |
| **Errors** (`#errors`) | Server errors per Worker (1 h, 24 h, per hour) and browser errors per project with recent examples | admins |
| **Deploys** (`#deploys`, `#deploys/<worker>`) | Recent deployments and versions per Worker (who, when, source), deploy-watch results, **Roll back** | admins; rollback owners |
| **Auto-fixes**, **Backups**, **Alerts**, **Settings** | As before; Backups adds **Restore drills** | admins |
| **People & permissions** (`#people`, `#people/review`) | Feedback/Ops owners and admins (change roles here), everyone across tools, remove-from-all-tools checklist, access review | admins |
| **Keys** (`#keys`) | Key-expiry calendar | admins; removing owners |
| **Audit log** (`#audit`) | Every change in ops, filter by who and what | admins |

## Issues

One place for everything that needs a person (`issues` + the append-only timeline `issue_events`).

- **Automatic**: an incident opens one (source `incident`, or `deploy` for a failed Workers Builds deploy); a check that
  breaks again while its issue is open adds to the same issue. When the incident resolves, the issue is set to
  **resolved** with "auto-resolved: incident resolved" (unless people already closed it; they can reopen it). An auto-fix
  that **fails** or is **reverted** opens one (`autofix`), a **deploy regression** opens one (`deploy`), and the
  **quarterly access review** opens one (`security`).
- **By hand** (admins): title, description, priority (low/normal/high/critical), assignee (anyone in the directory),
  due date, site. **From feedback item**: give its number; ops copies only the title and text (redacted again), project
  and priority, and links it (`feedback:<id>`), once per open issue.
- Filters: status, priority, assignee (`none` = unassigned), source, site, text. Comments and every change go to the
  timeline with who and when.
- Alerts: `issue_assigned` to the assignee; `issue_critical` to owners for a new critical issue (or one raised to
  critical).

API (admins, CSRF header on changes): `GET /api/issues?status=active|open|…&priority=&assignee=&source=&site=&q=`,
`POST /api/issues`, `GET|PATCH /api/issues/<id>`, `POST /api/issues/<id>/comments { body }`,
`POST /api/issues/from-feedback { feedback_id }`.

## Errors

**Server errors** (needs `CF_API_TOKEN` with *Account Analytics: Read*): every monitoring run reads the last hour of
`workersInvocationsAdaptive` (`sum { requests errors }` by `scriptName` and `datetimeFiveMinutes`) in one GraphQL
request, stores it in `worker_error_stats` (8 days) and evaluates the last 15 minutes per Worker (check
`errors:<worker>`, alert `error_rate`; thresholds `ERRORS` in `src/checks.js`). "Errors" are invocations that did not
succeed (uncaught exceptions, exceeded CPU/memory, internal errors); a 5xx a Worker returns on purpose is not counted.

**Browser errors**: the feedback widget/tool reports JavaScript errors to `POST /api/events` (ingest token) with
`type: "client_errors"`:

```json
{ "type": "client_errors", "project": "v1", "count": 7, "window_minutes": 5,
  "sample": [{ "message": "TypeError: x is null", "source": "/js/site.js:120", "page_path": "/careers" }] }
```

`project` (letters, digits, `-`, `_`), `count` (whole number), `window_minutes` (1–1440, default 5), `sample` (up to 10
kept; message ≤ 300, source ≤ 200, page path ≤ 200 characters, query strings dropped, personal details redacted).
Answers `201 { ok, project, total_in_window, alerted }` or `422`. More than `client_errors_threshold` (Settings,
default 20) in 15 minutes for one project sends `client_errors_spike`, at most once an hour per project. Kept 8 days.

## Deploys and rollback

- **Deploys page**: `GET /accounts/<id>/workers/scripts/<name>/deployments` and `/versions` per Worker in `WORKERS`
  (cached 4–5 minutes; *Refresh from Cloudflare* skips the cache).
- **Deploy watch** (the auto-fix cron, every 5 minutes, own subrequest budget): a deployment ops hasn't seen, younger
  than an hour, is watched. Baseline: error rate of the hour before and which of the Worker's site checks
  (`WORKERS[].gates`) were already failing. 15 minutes after the deploy: a site check that started failing, or an error
  rate above max(2 %, 2 × before + 1 point) with ≥ 20 requests → `deploy_regression` (link `#deploys/<worker>`) and an
  issue. The first deployment seen for a Worker is only recorded (`baseline`).
- **Roll back** (owners only, confirm dialog, audited, `rollback_done`): needs the separate secret **`CF_DEPLOY_TOKEN`**
  (below); without it the button explains what is needed. Ops reads the deployments with that token and deploys the
  previous version (the newest earlier deployment whose main version differs from the live one) at 100 %:
  `POST /accounts/<id>/workers/scripts/<name>/deployments { "strategy": "percentage", "versions": [{ "version_id":
  "<previous>", "percentage": 100 }] }`. API: `POST /api/deploys/<worker>/rollback { version_id }` (the version the page
  showed; refused if the deployments changed meanwhile).
- **A rollback is undone by the next normal deploy from `main`** (Workers Builds or `npm run deploy`): fix or revert the
  change on `main` before merging anything else. **Database migrations (D1) are not rolled back**: the old code must
  still work with the database as it is.

## Restore drill

Proves the backups restore. On the **1st of each month**, right after the nightly backups (the same 03:17 cron), and on
demand (**Backups → Run restore drill now**, owners): for each database, the latest good backup is loaded from R2 into
the scratch D1 **`yondr-ops-restore-drill`** (binding `DRILL_DB`): every table, view and trigger there is dropped first,
the backup SQL runs in batches of 200 statements, and the restored tables and per-table row counts are compared with what
the backup recorded (`backups.table_stats`; older backups: table list and total rows). Results in `restore_drills`
(Backups page, Overview, weekly backup digest); a failure sends `restore_drill_failed`. **Christmas cards** (personal
data): restored, counted, and its tables are **dropped again straight away**, also when the drill fails (`pii_dropped`).
Setting `restore_drill_enabled` (Settings) turns the monthly run off.

**Safety rule** (`npm run check`): `DROP` appears only in `src/drill.js` and only on the drill handle (`env.DRILL_DB`);
only `src/drill.js` uses `DRILL_DB`; `DELETE FROM` is allowed only on ops' own bookkeeping tables (`subscriptions`,
`subscribers`, `check_history`, `worker_error_stats`, `client_errors`, `cf_cache`, `keys_registry`). Other tools'
databases stay read-only (`readOnly()`).

## Keys (expiry calendar)

`keys_registry`: name, where it lives, owner, expiry date, rotation notes, last rotated — **never the key**. Values that
look like a key are refused. Seeded (no dates; fill them in): `GITHUB_TOKEN`, `AUTOFIX_PR_TOKEN` (PATs, ≤ 366 days),
`CF_API_TOKEN`, `CF_DEPLOY_TOKEN`, `RESEND_API_KEY` (ops and cards), `ANTHROPIC_API_KEY`, `OPS_INGEST_TOKEN`,
`GOOGLE_CLIENT_SECRET` and `SESSION_PRIVATE_JWK` (yondr-auth). Admins add and edit, owners remove; audited. Every day
(backup cron) `key_expiring` goes to owners and the key's owner at **30** and **14** days before expiry and **on the day**
(once per level; a key added late gets the most urgent level reached). API: `GET|POST /api/keys`,
`PATCH|DELETE /api/keys/<id>`.

## People & permissions

- **Directory**: everyone in the feedback tool's `admins` list, alert subscribers, issue assignees, the ad library's
  `users` (email, role, last seen) and marketing requests' `users` (name, email, role, active, last seen), all read-only.
  Nothing beyond name, email, role and last seen is shown. "Last seen" per tool: ops (`ops_seen`, every API call, at
  most one write per 10 minutes), feedback (its `activity`), ad library and requests (`last_seen_at`).
- **Feedback tool & Ops roles** (owner/admin) are changed here **through the feedback tool's own admin API**, as the
  signed-in admin: `GET/POST/DELETE https://feedback.overyondrdev.com/api/admins` (`POST { email, role }`,
  `DELETE { email }`) with that person's own `yondr_session` cookie (nothing else of theirs), `X-Yondr-Feedback: 1` and
  `Origin: https://ops.overyondrdev.com`, so its rules apply (only owners change owners, nobody removes themselves) and
  its 403s are shown as they are. The call goes over the **service binding `FEEDBACK`** (Worker `yondr-feedback`; no
  public egress, no same-zone fetch loop); without the binding it falls back to `fetch` of the public host. Ops never
  writes `FEEDBACK_DB`. Every change, done or refused, is in the audit log (`permission.feedback_admin.*`) with the actor.
  Locally (`DEV_EMAIL`) there is no session cookie, so changes are refused by the feedback tool; that's expected.
- Other tools' roles are read-only with **Manage in <tool>** links; a person's drawer has a **Remove from all tools**
  checklist.
- **Access review**: everyone with an admin-type role (feedback owner/admin, ad library admin/editor, requests
  admin/lead/marketing), with last seen; not seen for 90 days (or never) is flagged. On the **first weekday (UTC) of
  January, April, July and October** the backup cron opens the issue "Quarterly access review <year> Q<n>" with this
  checklist, assigned to an owner and announced to every owner (`issue_assigned`), due in 14 days; once per quarter.
  Owners can open one any time.
- API: `GET /api/directory`, `POST|DELETE /api/permissions/feedback-admins`, `POST /api/access-review/open` (owners).

## Cron usage

Still **3 cron triggers** (Workers Free: 5 per account):

| Cron | Runs |
| --- | --- |
| `*/5 * * * *` | Monitoring: gate checks, Cloudflare checks (builds, Access, inventory, usage, **server errors**, **Access seats** daily), state machine, incidents → issues, uptime history, daily digest |
| `2-59/5 * * * *` | Auto-fix queue, watch and verification, spend checks, **deploy watch** |
| `17 3 * * *` | Backups, then (`src/daily.js`) the **restore drill** on the 1st, **key expiry**, the **quarterly access review**, retention of `check_history` (35 days) and error stats (8 days) |

## APIs for other systems

Server-to-server calls send the shared secret in **`X-Ops-Token: <OPS_INGEST_TOKEN>`** (at least 32 characters; a
shorter or missing token disables these endpoints). No cookie, no CSRF header. The token opens only these four:

### `POST /api/events` — raise an event

```bash
curl -X POST https://ops.overyondrdev.com/api/events \
  -H "X-Ops-Token: $OPS_INGEST_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"feedback_critical","title":"Checkout page broken","site":"v1","source":"yondr-feedback",
       "message":"Feedback #12 marked critical.","url":"https://feedback.overyondrdev.com/admin#item-12"}'
```

| Field | Required | Notes |
| --- | --- | --- |
| `type` | yes | one of the alert types above |
| `title` | yes | ≤ 200 characters |
| `severity` | no | `info` \| `warning` \| `high` \| `critical`; default = the type's usual severity |
| `site`, `source`, `message`, `url` | no | `url` must be `https://` |
| `dedupe_key` | no | default `type|site|title`; repeats within the duplicate window aren't sent again |

Answers `201 { ok, id, duplicate: false, recipients }`, `200 { duplicate: true }`, `401` (token), `422` (invalid),
`429` (over 300 events/hour).

### `POST /api/autofix/events` — the auto-fix engine reports progress

Create (no `id`): `{ repo, title, feedback_id?, project?, classification?: "objective"|"subjective",
classification_reason?, severity?: "low"|"normal"|"high"|"critical", status?, issue_url?, pr_url?, merge_sha?, actor?, message? }`
→ `201 { autofix }`. Update: same fields plus `id` → `200`. Every call appends a line to the entry's timeline
(`actor`, `status`, `message`). `repo` must be in `ALLOWED_REPOS` (`src/checks.js`); URLs must be
`https://github.com/Overyondrdev/…`; `merge_sha` a full 40-character SHA. Statuses: `queued`, `triaged`, `fixing`,
`pr_open`, `checks_failed`, `merged`, `deployed`, `verified`, `failed`, `reverted`, `rejected`. Moving to `fixing`,
`verified`, `failed`/`checks_failed` sends `autofix_started`, `autofix_merged`, `autofix_failed` (`merged` sends nothing:
the fix is announced once verified). `merged` starts the verification clock (`merged_at`).

### `POST /api/autofix/feedback` — the feedback tool reports an item (auto-fix triage)

Sent by `yondr-feedback` for every new item and every change of type or priority (its README "Yondr Ops"):
`{ feedback_id, type, priority, project, asset?, title?, message, url?, path?, page_title?, screenshots?: ["/api/attachments/<id>"],
admin_url?, reason?, status?, created_at? }`. No personal data (no author; e-mail addresses are removed again here).
→ `201`/`200 { autofix, decision: "rejected"|"triaged"|"queued"|"unchanged", started }`, `401`, `422`. Rules: "Auto-fix".

Workflow runs also report their **Claude API cost** here (every outcome: PR opened, needs a human, failure):
`cost_usd` (number, US$, or `null`), `cost_unknown` (`true` when the cost couldn't be read: counted as $2.00) and
`run_id` (`<run id>-<attempt>`; a repeated report of the same run is counted once). A bad cost never rejects the call;
it is counted as unknown. See "Auto-fix → Spending".

### `GET /api/autofix/config`

`{ "autofix_enabled": false, "reason": "switched_off" }`: the gate the repositories' `autofix.yml` workflow reads
before doing anything. `autofix_enabled` is `true` only when the kill switch is on (owners, Settings; default **off**)
**and** auto-fix is not paused for the monthly budget. `reason`: `null` (enabled), `"switched_off"` or `"budget"`.
Also readable by signed-in admins (with `switched_on`, `autofix_max_per_hour` and this month's `budget`).

### Dashboard API for spending (admins; approval owners only)

- `GET /api/autofix/spend`: this month's budget picture (`spent`, `forecast`, `effective`, `pause_at`, `paused`,
  `warnings`…), approvals and the cost of every run.
- `POST /api/autofix/budget/approve` `{ "amount_usd": 25 }` (owners, CSRF header): approve more spend for the current
  month (whole dollars 1–100, default 25). Audited (`autofix.budget.approve`), sends `autofix_budget_approved`.

## Auto-fixes and one-click revert

Dashboard → **Auto-fixes**: every entry with its status, classification, links (feedback item, issue, PR, commit) and
the full timeline. `autofix_events` is append-only: it is the audit log.

**Revert** (admins, confirm dialog) on a `merged` / `deployed` / `verified` fix:

1. Ops checks with GitHub that the fix's squash commit (`merge_sha`, one parent) is still the **latest change to every
   file it touched** on `main`. If a later commit changed one of them, it **refuses** and links to the fix's pull
   request, where GitHub's own **Revert** button merges the changes properly. Also refused: merge commits, more than 30
   files, submodules/symlinks, repos not on the allowed list, a revert already opened.
2. It builds a commit on top of `main` whose tree puts every touched file back exactly as it was before the fix
   (added files deleted, renamed files renamed back) — GitHub has no revert API, so this uses the git data API.
3. Pushes branch `autofix-revert/<id>-<sha7>`, opens PR **"Revert: <title>"** with label `autofix-revert`, and turns
   on auto-merge (squash) if the repository allows it; otherwise the timeline says to merge it by hand.
4. Records who asked and when (`reverted_by`, `reverted_at`, `revert_pr_url`, status `reverted`), logs every step,
   and sends `autofix_reverted`.

Commit messages and PR text contain no names or emails (the repositories are public).

## Auto-fix

Bugs reported in the feedback tool can be fixed automatically by **Claude Code in GitHub Actions**, under the owner's
rules (`overyondr-website-v1` → `docs/OPERATIONS.md` §6.3), which are binding:

- Only feedback of type **bug** can be auto-fixed.
- Only **objective** bugs: verifiable against a clear expected behaviour (JavaScript errors, broken links/404s, a form
  that doesn't submit, broken layout or overflow at 375 px, text differing from its source, sign-in failures, missing
  images). **Subjective** issues (look, wording, tone, colour, layout preference), **even critical**, are **never**
  auto-fixed: they wait for a person.
- Objective **critical** bugs start immediately; other objective bugs are **queued**.
- Everything is logged (Auto-fixes tab, `autofix_events`), humans can revert any fix in one click, and people get
  `autofix_*` alerts. The kill switch **`autofix_enabled`** (Settings, owners) is **off** by default.
- Spending: **$50 a month**, owners warned at 50 % / 70 % and when the forecast is over budget, auto-fix **pauses at
  90 % ($45)** until an owner approves more (see "Spending").

### The flow

```text
feedback tool ─ new item / type or priority changed ─► POST /api/autofix/feedback (X-Ops-Token)      [yondr-feedback]
  (also feedback_critical → /api/events for critical items of any type)
                                │
ops triage (src/triage.js) ─────┤ type ≠ bug ...................................► rejected ("not a bug"), logged
                                │ project not in PROJECT_REPOS ...................► triaged: a person decides
                                │ Workers AI: subjective / unsure / error ........► triaged: a person decides (never an issue)
                                │ repo has no auto-fix workflow ..................► triaged: a person fixes it
                                │ objective ......................................► queued
                                │     kill switch off, or paused for budget: stays queued, nothing starts
                                │     critical: starts now (≤ 10/hour in total)
                                │     others: the 5-minute run starts ≤ autofix_max_per_hour (default 3)
                                ▼
"start" = GitHub issue in the target repo (GITHUB_TOKEN), then label `autofix` (+ `autofix-critical`)  → fixing,
          autofix_started
                                ▼
.github/workflows/autofix.yml (target repo)                                                             [GitHub]
  gate:    label added by an AUTOFIX_ACTORS account on its own issue? ops marker on line 1? kill switch on and
           not paused for budget (GET /api/autofix/config)?
  fix:     Claude Code edits files + runs the build (read-only token, no git/gh/web) → patch + the run's cost
           or "needs_human" → comment on the issue, ops: failed, autofix_failed
  publish: fresh checkout, mechanical guardrails (forbidden paths, ≤ 10 files, ≤ 200 lines, no binaries/symlinks),
           commit, push autofix/ops-<id>, PR "Auto-fix: <title>" labelled autofix (AUTOFIX_PR_TOKEN) → pr_open
.github/workflows/autofix-guard.yml: same guardrails on the PR (every push) → auto-merge (squash) on, or
           checks_failed + auto-merge off. GitHub merges only when the required checks pass.
.github/workflows/autofix-report.yml: merged → ops "merged" + merge_sha; closed → failed; CI failed → checks_failed
                                ▼
ops watch (src/verify.js, every 5 minutes, 2 minutes after monitoring)
  backstop: asks GitHub about open autofix PRs (merged / closed); no PR 3 hours after the issue → failed
  merged:   waits for the Workers Builds production build of merge_sha (CF_API_TOKEN) → deployed
            build failed, or one of the repo's site checks (AUTOFIX_TARGETS gates) starts failing after the merge
            → automatic revert (same code as the Revert button, actor "auto-revert") → reverted, autofix_reverted
            (revert impossible → failed + autofix_failed, critical, "revert in GitHub")
            15 minutes live with everything fine → verified, autofix_merged (says what was checked)
```

Statuses: `rejected` (not a bug) · `triaged` (waits for a person) · `queued` · `fixing` · `pr_open` · `checks_failed` ·
`merged` · `deployed` · `verified` · `failed` · `reverted`.

**Admins** (Auto-fixes tab): open an entry for its timeline and links (feedback item, issue, PR, commit); **Mark
objective / Mark subjective** on entries that are `queued` or `triaged` (logged with your name; it sticks when the
feedback changes later, and the AI is not asked again); **Revert** on merged/deployed/verified fixes. The feedback
admin links each item to `https://ops.overyondrdev.com/#autofix/feedback/<feedback id>`. "Also show items that are not
bugs" shows the `rejected` ones.

**Classifier** (`src/classify.js`): Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (as the feedback tool's
summaries) with the owner's definitions and few-shot examples, temperature 0, strict JSON. An objective verdict needs
confidence ≥ 0.75; anything else (low confidence, unreadable answer, error, no AI) is **subjective**.

**Which repository** (`src/checks.js`): `PROJECT_REPOS` maps the feedback project (v1, portal → website-v1; v2 →
website-v2; ads → digital-ads-portal; requests → marketing-request-portal; cards → christmass-cards; feedback →
yondr-feedback; ops → yondr-ops). `AUTOFIX_TARGETS` says which repos have the workflows (`workflow: true`: website-v1
and website-v2 today), the Worker whose build is watched and the site checks that must stay fine.

**Guardrails** (enforced mechanically twice, in `autofix.yml` → publish and in `autofix-guard.yml`): no changes to
sign-in (`auth/`, the Worker in `src/worker/` or `worker/`, any `*session.js`), Wrangler config, `.github/`,
migrations, `package.json`/lockfiles, `.npmrc`/`.nvmrc`, `scripts/`, `_headers`/`_redirects`, CLAUDE.md, git/tool
config (plus V1's `v2/`, `ad-portal/` and self-hosted Squarespace CSS); at most **10 files** and **200 changed lines**;
no binaries, symlinks or submodules. The issue text has no personal data (see "Security model → Privacy"; the
classification says "an admin", not who), and the report's HTML and @mentions are neutralised.

### Spending (owner's rules: $50 a month, approval before going past it)

Auto-fix runs Claude Code with a **Claude API key**, paid per use. The owner's rules (`docs/OPERATIONS.md` §6.3):
a monthly budget, warnings before reaching it, a warning ahead of time when the month is heading over it, and **no
spending past the limit without the owner's approval**. How it works (`src/budget.js`):

- **Cost per run.** After Claude finishes, `autofix.yml` reads the action's `execution_file` output (a JSON list of the
  run's messages, `$RUNNER_TEMP/claude-execution-output.json`) and takes `total_cost_usd` from the final
  `type: "result"` entry. It reports it with every outcome (PR opened, needs a human, failure). If the cost can't be
  read, it reports `cost_unknown: true` and ops counts **$2.00** for that run. Stored in `autofix_costs`, per calendar
  month (UTC); each entry's timeline says what its run cost.
- **Settings** (owners, audited): `autofix_monthly_budget_usd` (default **50**), `autofix_pause_at_pct` (default
  **90**, i.e. $45), warnings `autofix_warn_first_pct` / `autofix_warn_second_pct` (default **50** / **70**).
- **Effective budget** = monthly budget + whatever owners approved this month. **Pause level** = budget × pause % +
  approved this month ($45, or $70 after approving $25): an approval gives exactly the amount approved.
- **Forecast** = spent so far ÷ days elapsed (at least 3, so the 1st doesn't produce wild numbers) × days in the month,
  plus $2 for every objective fix queued or in progress.
- **Alerts** (owners always, can't be switched off, quiet hours don't apply; plain text: spent so far, forecast, what is
  paused, a link to the Spend panel): `autofix_budget_warning` at 50 % and 70 % of the effective budget (once per
  level per month; a jump past both sends one); `autofix_budget_projection` when the forecast is over the effective
  budget (at most once a day); `autofix_budget_paused` at the pause level; `autofix_budget_approved`. Checked after
  every reported cost and in the 5-minute auto-fix run.
- **Paused** (spend ≥ pause level): triage still classifies and queues; nothing starts (no issue is opened, critical
  ones included); `GET /api/autofix/config` answers `autofix_enabled: false, reason: "budget"`, so a workflow that
  starts anyway stops at its gate. Separately, a new fix only starts if this month stays within the budget with $2 for
  it and for every fix still in progress.
- **Approve more** (owners only): Auto-fixes → **Spend** (also in Settings) → *Approve more spend this month*: an amount
  (default $25, at most $100 per approval), confirm. CSRF-checked, audited, owners get `autofix_budget_approved`. It
  counts for the **current month only**; on the 1st everything starts again from the normal budget.
- **Spend panel** (Auto-fixes tab and Settings): spent this month, forecast, budget, pause level, approvals, cost per fix.
- **Daily digest**: month-to-date spend and forecast.
- **Hard backstop**: set the Claude Console workspace's **monthly spend limit to $60** (Console → the workspace →
  Limits). Ops pauses at $45 first; the Console limit stops the key even if ops or a workflow misbehaves. If owners
  approve more than $10 extra in a month (so spend could pass $60), **raise the Console limit too**, or runs fail with a
  spend-limit error (reported as "needs a human").

### Setup (owner; nothing runs until all of this is done and `autofix_enabled` is on)

1. **An ops GitHub account.** Use a dedicated machine user (e.g. `yondr-ops-bot`) that is a member of `Overyondrdev`
   with **Write** access to the repositories in `ALLOWED_REPOS`. Its login goes into `AUTOFIX_ACTORS`. (A GitHub App
   works too: its bot login, e.g. `yondr-ops[bot]`, goes into `AUTOFIX_ACTORS`; the workflow passes the list as the
   action's `allowed_bots`.)
2. **Tokens of that account** (fine-grained PATs, resource owner Overyondrdev, only the `ALLOWED_REPOS`
   repositories, expiry ≤ 1 year, calendar it):
   - `GITHUB_TOKEN` (**Worker secret** on yondr-ops): Contents RW, Pull requests RW, Issues RW. Opens issues and
     labels, revert PRs, reads PR state.
   - `AUTOFIX_PR_TOKEN` (**GitHub org secret**, Actions, selected repositories: the ones with the workflows):
     Contents RW, Pull requests RW. Pushes `autofix/ops-<id>`, opens the PR and turns on auto-merge. It must not be
     the Actions `GITHUB_TOKEN`: what that token does starts no workflows (no CI on the PR, no report on merge). It can
     be the same PAT as `GITHUB_TOKEN`.
3. **`ANTHROPIC_API_KEY`** (GitHub org secret, selected repositories): a Claude API key created in **Claude Console**
   (platform.claude.com → API keys), in a workspace with a **monthly spend limit of $60** (owner decision 27 Nov: browser
   only, no Terminal step; the $60 backstop is above ops' own $45 pause, see "Spending"). The **Claude GitHub App** (github.com/apps/claude) is *not* needed: the
   workflow deliberately gives Claude the job's read-only `GITHUB_TOKEN` and does every write itself. Installing the
   app is harmless but unused.
4. **`OPS_INGEST_TOKEN`**: one random value (`openssl rand -hex 32`) as a **Worker secret** on `yondr-ops` and on
   `yondr-feedback` (`npx wrangler secret put OPS_INGEST_TOKEN` in each), and as a **GitHub org secret** (selected
   repositories).
5. **Org variable `AUTOFIX_ACTORS`** (Settings → Secrets and variables → Actions → Variables): the ops account's login,
   comma-separated without spaces if more than one. Unset = the workflows never run.
6. **In each repository with the workflows** (website-v1, website-v2):
   - Labels `autofix`, `autofix-critical`, `autofix-revert` (Issues → Labels; GitHub also creates them on first use).
   - Settings → General → **Allow auto-merge**: on (also used by revert PRs).
   - Branch protection / ruleset on `main`: **require the `build` status check** (CI) and, recommended, the
     **`guard`** check (Auto-fix guard), so auto-merge waits for them. Without a required check, auto-merge would merge
     as soon as the PR is mergeable. If CODEOWNERS review is required for all paths, auto-merge waits for it: either
     accept that (a person approves each fix) or limit required code-owner review to the protected paths.
   - Settings → Actions → General → Workflow permissions: "Read repository contents" is enough (every job declares its
     own minimal `permissions:`). "Allow GitHub Actions to create and approve pull requests" stays **off**.
   - Fork pull request workflows: keep "Require approval for all outside collaborators".
7. **Cloudflare**: `CF_API_TOKEN` (see "Secrets") lets ops watch the Workers Builds deploy of the fix; without it
   verification relies on the site checks alone (and says so). The `AI` binding is in `wrangler.jsonc`.
8. Deploy yondr-ops and yondr-feedback (`npm run deploy` in each), merge the workflow files in each target repo.
9. **Turn it on**: Settings → Auto-fix engine → on (and "Auto-fixes started per hour"). Try it with a harmless objective
   bug (e.g. a deliberately broken link on a test page) and watch the Auto-fixes tab.

### Turning it off, reverting

- **Budget pause**: automatic at the pause level (see "Spending"); an owner's approval lifts it for the month.
- **Off**: Settings → Auto-fix engine → off. Nothing new starts (queued items stay queued); a workflow that starts
  afterwards stops at its gate. Faster still: delete the `AUTOFIX_ACTORS` variable (no workflow runs at all) or revoke
  `ANTHROPIC_API_KEY`/`AUTOFIX_PR_TOKEN`.
- **Revert a fix**: Auto-fixes → the entry → **Revert this fix** (opens a revert PR, auto-merge on), or the Revert button
  on the fix's pull request in GitHub. Ops reverts automatically when the build of the fix fails or the site breaks
  within 15 minutes of going live.
- **Stop one fix in progress**: before the PR exists, cancel the workflow run (Actions tab); once it exists, click
  "Disable auto-merge" on it or close it (ops marks a closed PR failed).

### Adding a repository

1. Copy `.github/workflows/autofix.yml`, `autofix-guard.yml` and `autofix-report.yml` from
   `overyondr-website-v2` (or v1). In all three adapt `FORBIDDEN` (identical in autofix.yml and autofix-guard.yml:
   sign-in, Worker config, migrations, CI, dependencies of that repo), in `autofix.yml` the build/test commands in the
   prompt and in `--allowedTools` (e.g. `Bash(npm run check)`, `Bash(npm test)`), the Node setup, and in
   `autofix-report.yml` the CI workflow's `name:` under `workflow_run.workflows`.
2. Do setup step 6 for the repo, and add it to the selected repositories of the org secrets and to the PATs.
3. In ops `src/checks.js`, set `workflow: true` for it in `AUTOFIX_TARGETS` (and its `worker` and `gates`), with tests.

### Security model (public repositories)

- **Who can start a fix**: only an `autofix` label added by an `AUTOFIX_ACTORS` account to an issue that such an
  account opened, with the ops marker on its first line. On public repos strangers can open issues and comment but
  can't add labels; comments never trigger anything; pull requests from forks never get these secrets.
- **What Claude can do**: read and edit files in the checkout and run the build/link check. No `Write`, git commit or
  push, `gh`, `curl` or web tools; strict allow-list (`--permission-mode default`). Its GitHub token is the job's
  read-only token. Its only secret is `ANTHROPIC_API_KEY` (a prompt injection could at worst spend up to the
  Console spend limit or leak that key: revoke and rotate it if ever in doubt).
- **What reaches main**: only a patch that passed the mechanical checks twice, as a PR that merges only after the
  required checks. The PAT is used only in steps that never run Claude or repository code. Ops verifies after deploy
  and reverts automatically.
- **Prompt injection**: the feedback text is written by signed-in Yondr staff; it is quoted in the issue as data, with
  HTML and @mentions neutralised, and the prompt tells Claude to treat it as data. The guardrails hold whatever the
  text says.
- **Privacy** (owner's condition for public issues): the issue and PR are public, so personal details must stay
  private. The feedback tool sends no author, assignee, voter or commenter, and ops keeps only the fields it knows
  (anything else in the payload is dropped). Both redact the text, title, URL, path, page title and asset name
  (`redact()`, identical in both repositories): e-mail addresses; phone numbers (international and local formats);
  street addresses (house number + street word, with the town and postcode/ZIP that follow); UK postcodes anywhere;
  URL parameters whose name contains key/token/secret/password/auth/session/signature/code, Bearer/Basic credentials
  and well-known token formats. Screenshots are never sent: the issue only says how many there are (they stay behind
  the Yondr sign-in). The classification says "an admin", not who. The feedback widget tells people reporting a bug
  that it may be shared publicly and not to include personal or confidential details.

## Backups

Every night at **03:17 UTC** (cron `17 3 * * *`; or **Back up now** in the Backups tab) each database is exported —
schema from `sqlite_master`, then every row as `INSERT` statements, read 1,000 rows at a time — gzip'd and stored in R2
bucket `yondr-ops-backups` at `backups/<db>/<YYYY-MM-DD>.sql.gz`:

| Database | Binding | Notes |
| --- | --- | --- |
| `yondr-feedback` | `FEEDBACK_DB` | also the admin list |
| `yondr-ad-portal-db` | `ADS_DB` | |
| `yondr-marketing-requests-db` | `REQUESTS_DB` | |
| `yondr-christmas-cards` | `CARDS_DB` | **personal data** (client names and addresses) |
| `yondr-ops` | `DB` | this tool |

Other tools' databases are bound here but **only read**: every query goes through `readOnly()` (`src/readonly.js`),
which refuses anything but `SELECT`, and `npm run check` fails if code uses those bindings without it. Ops never
deletes live data.

**Retention** (Settings, owners): daily backups 30 days; the backup of the **1st of each month 12 months**, the same for
every database. **Personal-data** databases (Christmas cards: client addresses, which are kept and curated per rep) are
backed up the same way; only owners can download them. Only files under `backups/` matching the pattern are ever deleted. Each run is logged (size, tables, rows,
duration, error); a failure sends `backup_failed`; Mondays send `backup_ok_weekly_digest`.

**Download**: Backups tab → *Download* (admins; streamed from R2; logged). Christmas-cards backups: **owners only**.

### Restore

Restore into a **new, empty** database first; never over live data without the owner's say-so.

```bash
# 1. Get the file (Backups tab → Download, or from R2):
npx wrangler r2 object get yondr-ops-backups/backups/yondr-feedback/2026-11-27.sql.gz --remote --file=feedback.sql.gz
gunzip feedback.sql.gz                                  # → feedback.sql
# 2. Load it into an empty database and check it:
npx wrangler d1 create yondr-feedback-restore
npx wrangler d1 execute yondr-feedback-restore --remote --file=feedback.sql
npx wrangler d1 execute yondr-feedback-restore --remote --command "SELECT COUNT(*) FROM feedback"
```

3. To put it back in service (owner approval): either point the tool's `wrangler.jsonc` `database_id` at the restored
   database and deploy it, or — to keep the same database — `wrangler d1 export` the live one first, then empty it and
   run the file against it. For "undo the last hour" on the *live* database, D1 **Time Travel** is usually better:
   `npx wrangler d1 time-travel restore <db> --timestamp=<ISO time>` (30 days, no backup needed).

Each file starts with `PRAGMA defer_foreign_keys = true;`, then tables, rows, then indexes, triggers and views.

## Security model

- Yondr sign-in on every request except `/brand/*`, `/robots.txt` and the four token endpoints. Pages → 302 to
  `loginUrl(request)`, API → 401 JSON. No Cloudflare Access fallback. `workers_dev`/`preview_urls` false.
- Admin role from the feedback tool's `admins` table on every API request; signed-in staff who aren't admins only get
  `GET /api/me` and `GET /api/status/public`. Owner-only: Settings, spend approval, rollback, restore drill on demand,
  removing keys, PII downloads.
- Role changes go through the feedback tool's API as the signed-in person (only their `yondr_session` cookie is
  forwarded, over the `FEEDBACK` service binding); ops never writes another tool's database.
- `DROP` only in the scratch database `DRILL_DB` (`npm run check`); Christmas-card data is dropped from it straight after
  each drill.
- **CSRF**: every state change needs `X-Yondr-Ops: 1` and `Origin` = `https://ops.overyondrdev.com`. No CORS at all.
- **Ingest token** compared in constant time; never accepted on the admin API.
- Dashboard CSP `default-src 'none'`, no inline scripts or styles, `frame-ancestors 'none'`, `noindex`. The one outside
  origin is `https://auth.overyondrdev.com` in `script-src` and `connect-src`: the shared people picker and the
  directory it reads (`/api/people`, with the visitor's own session).
- `DEV_EMAIL` is honoured on `localhost` only (`.dev.vars`), never in `wrangler.jsonc` (`npm run check` fails).
- Other tools' databases: read-only wrapper; webhook URLs and tokens only in secrets.

## Secrets

Set each with `npx wrangler secret put NAME` (or dashboard → Workers → yondr-ops → Settings → Variables, type
**Secret**). Settings → "Secrets and connections" shows which are set (never their values).

| Secret | Needed for | How to create, exact permissions |
| --- | --- | --- |
| `CF_API_TOKEN` | Deploy, Access, inventory, usage, server-error and Access-seat checks; Deploys page; setup gaps | **User** API token (My Profile → API Tokens → Create; the Workers Builds API rejects account-owned tokens). Account `3fac6c19…8085` only, all **Read**: *Account · Workers Scripts: Read* (also deployments, versions and secret names), *Account · Workers Builds Configuration: Read*, *Account · Access: Apps and Policies: Read*, *Account · Access: Users: Read* (**new**, Access seats), *Account · D1: Read*, *Account · Workers KV Storage: Read*, *Account · Workers R2 Storage: Read*, *Account · Account Analytics: Read* (usage and server errors). Existing tokens: edit the token and add *Access: Users Read* |
| `CF_DEPLOY_TOKEN` | **Roll back** only | A **separate** user API token, account `3fac6c19…8085` only, *Account · Workers Scripts: Edit*. Only owners can use it (rollback button). Without it rollback is unavailable and the button says so. Set an expiry and put it in the Keys calendar |
| `GITHUB_TOKEN` | One-click and automatic revert; auto-fix issues; pull-request backstop | Fine-grained personal access token of the **ops GitHub account** ("Auto-fix" → Setup; or a GitHub App token), resource owner **Overyondrdev**, *Only select repositories*: the ones in `ALLOWED_REPOS`. Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**, **Issues: Read and write** (labels), Metadata: Read (automatic). For auto-merge, enable *Settings → General → Allow auto-merge* in each repo. Expiry ≤ 1 year: calendar it |
| `OPS_INGEST_TOKEN` | `/api/events`, `/api/autofix/*` | Random, ≥ 32 characters: `openssl rand -hex 32`. The same value goes to the feedback tool (Worker secret) and GitHub Actions (org secret) |
| `RESEND_API_KEY` | `resend` transport only | Resend → API Keys → *Sending access*, domain `overyondrdev.com` |
| `SLACK_WEBHOOK_<NAME>` | Slack alerts | Slack → Apps → Incoming Webhooks → Add to channel → copy URL. One secret per channel, e.g. `SLACK_WEBHOOK_OPS` |

Bindings: `AI` (Workers AI, the auto-fix classifier; about one small request per bug report, against the 10k
neurons/day free allowance); `DRILL_DB` (D1 `yondr-ops-restore-drill`, `456502b9-…`, already created: scratch database
for the restore drill only); `FEEDBACK` (service binding to Worker `yondr-feedback`: role changes in People &
permissions); `DIRECTORY` (KV `yondr-directory`, `5339d657…0536`, owned by the sign-in Worker `yondr-auth`: ops only
reads `directory:meta` and, for the digest's names, `directory:v1`. KV bindings can't be made read-only, so
`npm run check` enforces it: only `src/directory.js` touches it, with `get` only).

Plain variables (in `wrangler.jsonc`, safe to commit): `YONDR_AUTH_PUBLIC_JWK`, `ALLOWED_EMAIL_DOMAINS`,
`EMAIL_FROM`, `EMAIL_FROM_NAME`, `EMAIL_TRANSPORT`. Keep every variable there: `wrangler deploy` replaces dashboard
plain-text variables.

## First deploy (owner approval needed: new Worker, host, database and bucket)

1. **D1**: `npx wrangler d1 create yondr-ops` → copy the `database_id` into `wrangler.jsonc` (replacing
   `TO-BE-CREATED`) in a PR. The schema is created automatically on first use.
2. **R2**: `npx wrangler r2 bucket create yondr-ops-backups` (private; no public access, no custom domain).
3. **Email**: set the `RESEND_API_KEY` secret (Resend → API Keys, sending access, domain `overyondrdev.com`). DMARC is
   `p=reject`, so never send from another domain.
4. **Secrets**: as in the table above (`CF_API_TOKEN`, `OPS_INGEST_TOKEN` at least; `GITHUB_TOKEN` before the first
   revert; Slack webhooks as wanted).
5. **Deploy**: `npm ci && npm run deploy` (creates the Worker, the `ops.overyondrdev.com` custom domain and both crons).
6. **Sign-in**: add `ops.overyondrdev.com` to the Access application **"Yondr sites (Google sign-in)"** (Bypass), and a
   line for it to `SITES` in `overyondr-website-v1/auth/src/pages.js`. The catch-all `*.overyondrdev.com` Access app is
   Bypass too (owner: no Access seats, ever), so the Worker's own sign-in check is the only lock.
7. **Docs**: add the Worker, host, D1 `yondr-ops` and R2 `yondr-ops-backups` to `docs/OPERATIONS.md` §1 and
   `docs/PLATFORM.md` §1 in `overyondr-website-v1` (OPERATIONS.md §2 rule 5).
8. **Check** in Incognito: `/` sends you to the sign-in page and back; a non-admin lands on the Status page (`/status`)
   and gets 403 from everything else; `/api/status` answers 401 signed out. In the dashboard: *Run checks now*, add yourself in Alerts and *Send test alert*,
   *Back up now* and download one backup.
9. Auto-fix: section "Auto-fix" → "Setup" (the feedback tool's `OPS_INGEST_TOKEN` secret turns on its reports).

## Deploy

`npm run deploy` (runs `check` and `test`, then `wrangler deploy`). It works from Claude cloud sessions too: the
dashboard is bundled into the script, so there are no static assets to upload. Bundle: about 513 KiB (205 KiB
gzipped); the free plan allows 3 MB. Never set `DEV_EMAIL` on the deployed Worker.

## Rollback

- Code: Cloudflare dashboard → Workers → yondr-ops → Deployments → pick the previous version → *Rollback*, or
  `npx wrangler rollback`. Data is untouched (schema changes are additive). (Ops' own **Deploys → Roll back** works for
  yondr-ops too, but if the bad version broke the dashboard use the Cloudflare dashboard.)
- Stop everything fast without deploying: Settings → switch off Monitoring / Alerts / Backups, or delete the cron
  triggers in the dashboard (Workers → yondr-ops → Settings → Triggers).
- Ops can't break the sites it watches: it only reads them (HTTP GETs, read-only DB queries, read-only CF token). The
  only write outside its own data is a revert pull request, which still goes through each repo's checks.

## Local development

```bash
npm ci
printf 'DEV_EMAIL="ada.owner@overyondr.com"\nOPS_INGEST_TOKEN="local-test-token-0123456789abcdef0123456789"\n' > .dev.vars
npx wrangler d1 execute yondr-feedback --local --command "CREATE TABLE IF NOT EXISTS admins (email TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'admin', added_by TEXT, added_at TEXT NOT NULL); INSERT OR IGNORE INTO admins (email, role, added_at) VALUES ('ada.owner@overyondr.com', 'owner', 'x')"
npm run dev            # wrangler dev --local --test-scheduled --local-upstream localhost:8787
# http://localhost:8787                       the dashboard, signed in as DEV_EMAIL (X-Dev-Email header = someone else)
# http://localhost:8787/__scheduled?cron=*/5+*+*+*+*    run monitoring once (real signed-out GETs to the sites)
# http://localhost:8787/__scheduled?cron=17+3+*+*+*     run backups once (local D1 and R2)
```

Seed a few people and feedback items in the local `yondr-feedback` / `yondr-ad-portal-db` databases to see the
directory and Overview filled. `X-Dev-Email: cy.staff@overyondr.com` (a browser extension or Playwright's
`extraHTTPHeaders`) shows the staff view: only `/status`. Role changes in People & permissions are refused locally
(no session cookie to forward). The `FEEDBACK` service binding shows "not connected" in `wrangler dev` unless
`yondr-feedback` runs locally too; harmless.

`--local-upstream localhost:8787` matters: otherwise `wrangler dev` rewrites every request's URL to the route
(`ops.overyondrdev.com`) and `DEV_EMAIL` (localhost only) is ignored. Emails are written to `.wrangler/tmp/email/`
by the local `send_email` simulator. Use `--local` only; never run commands against the remote databases without the
owner's say-so.

`npm run check` · `npm test` · `npm run deploy:dry`.

## Known limits and TODO

- **Workers AI usage**: the GraphQL dataset/field (`aiInferenceAdaptiveGroups.sum.totalNeurons`) is not confirmed in
  Cloudflare's docs. If the query fails, that one check shows "not checked" and the others still work. Confirm with
  the GraphQL explorer once the token exists and adjust `src/cloudflare.js`.
- **Workers Free CPU limit** (10 ms per invocation, cron included): monitoring is almost all network wait and fits;
  backups gzip in the Worker, so a large database may exceed it on the free plan (the run then fails and
  `backup_failed` is sent). Fine on Workers Paid (30 s default).
- **Subrequests**: one monitoring run makes ~25 outbound requests plus alerts (free limit 50). The auto-fix run has
  its own cron (own budget): ≤ 3 issues (2 requests each), ≤ 6 pull-request/build lookups, an automatic revert ≤ 45.
  On Workers Free a revert plus other lookups in the same run can exceed 50; the revert then fails and `autofix_failed`
  (critical) asks a person to revert in GitHub. Fine on Workers Paid.
- If the monitoring run itself crashes (e.g. D1 unavailable), no alert can be sent: watch `yondr-ops` errors in
  Workers Observability, and the daily digest stops arriving.
- **Server-error dimension**: `datetimeFiveMinutes` on `workersInvocationsAdaptive` is not confirmed against the live
  schema; if the query fails the `errors:*` checks show "not checked". Confirm with the GraphQL explorer once the token
  exists and adjust `fetchErrorBuckets` in `src/errors.js` (e.g. to `datetimeMinute`, summing per 5 minutes).
- **Access seats**: needs *Access: Users Read*; the response field `access_seat` is read per user. Without the
  permission the check shows "not checked".
- **Restore drill on Workers Free**: D1 allows 50 queries per invocation on the free plan (1,000 on Paid); the drill runs
  one batch per 200 statements plus a count per table, so large databases can exceed it on Free and the drill is then
  recorded as failed (`restore_drill_failed`). Fine on Workers Paid. Decompressing a large backup can also exceed the free
  10 ms CPU limit.
- Cron triggers: Workers Free allows 5 per account; this Worker uses 3 (monitoring, auto-fix, backups). If the
  account has no free slot, `wrangler deploy` fails: drop `2-59/5 * * * *` from `wrangler.jsonc`; the auto-fix queue
  and verification then stop (triage and critical starts still work; revert by hand).
