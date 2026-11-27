# yondr-ops

Monitoring, alerts, backups and the auto-fix log for Yondr's `overyondrdev.com` estate. One Cloudflare Worker,
`yondr-ops`, on **https://ops.overyondrdev.com**.

- **Watches** every site every 5 minutes as a signed-out visitor (is it up? does it still ask for the Yondr sign-in?),
  checks that `overyondr.com` is still Squarespace, and reads Cloudflare: failed deploys, the Access Bypass app,
  Workers/D1/KV/R2 that appeared or disappeared, and daily usage against the free-plan limits.
- **Alerts** the right people by email and Slack, only when something changes (plus an hourly reminder while a critical
  problem lasts), with a plain explanation and a link to the dashboard. Admins add people and choose what each gets.
- **Backs up** every D1 database to R2 every night (03:17 UTC), with retention rules and a restore procedure.
- **Logs auto-fixes** (the engine comes later) step by step, with a one-click **Revert** that opens a revert pull request.

Only **admins of the feedback tool** can use it (one admin list for Yondr tools, see "Who can use it").

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
| `src/email.js` | Email transports: Cloudflare Email Service or Resend |
| `src/digest.js` | Daily digest and weekly backup summary |
| `src/backups.js` | Nightly D1 → R2 backups and retention |
| `src/autofix.js`, `src/github.js` | Auto-fix log, ingest, one-click revert via the GitHub API |
| `src/ingest.js` | Server-to-server endpoints with the `X-Ops-Token` header |
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
- **owner**: also changes Settings (kill switches, retention, transport) and downloads Christmas-cards backups.
  Owners always get "site down" and "site exposed" alerts.

Add or remove admins in **feedback.overyondrdev.com/admin → People**. There is no second list here.

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

With the `CF_API_TOKEN` secret (without it these show "not checked" and never alert):

| Check | How often | Alert |
| --- | --- | --- |
| Latest Workers Builds deploy of `main` for `overyondr-website-v1`, `yondr-ad-portal`, `yondr-christmas-cards` (PR preview builds ignored) | 5 min | failed = **deploy failed** (high) |
| Access app **"Yondr sites (Google sign-in)"** lists every gated host (incl. `ops.`) and has a Bypass policy | hourly | missing = configuration changed (warning: costs seats) |
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
| `autofix_merged` | info | An automatic fix merged | opt-in |
| `autofix_failed` | high | Checks failed or the engine gave up | new people |
| `autofix_reverted` | warning | Someone reverted an automatic fix | new people |
| `feedback_critical` | high | Feedback marked critical (sent by the feedback tool via `/api/events`) | new people |
| `daily_digest` | info | Every morning (first check after 08:00 UTC by default): open problems, incidents, backups, auto-fixes | new people |

"New people" = the rules a person gets when an admin adds them (they can be changed straight away).

**When alerts go out** (no spam): when a check starts failing; when it changes (e.g. down → exposed, or another host
goes missing); when it is fixed ("Resolved: …", only if people were told it broke); and every 60 minutes while a
**critical** problem lasts (setting). Events from other systems with the same `dedupe_key` (default: type + site +
title) within 60 minutes are logged but not sent again. Every delivery attempt is logged (Alerts tab →
"Recently sent": alert, channel, recipients, status, error).

Each message says, in plain words: what's wrong, which site, since when, what has been done automatically, and a link
to the dashboard. Subjects look like `Website V2 is open to the public [Critical]` / `Resolved: Ad library is down`.

### Adding a person (admins)

Dashboard → **Alerts** → *Add a person*: their `@overyondr.com` address and name → **Add**. They start with the usual
email alerts (table above); the editor opens so you can change them. In the editor:

- **Send them**: everything / high and critical / critical only.
- **Quiet hours**: from–until in their time zone (wraps past midnight). Only **critical** alerts are sent then.
- **Active**: untick to pause all their alerts (owners still get site down / exposed).
- **Rules**: per alert type, email on/off and a Slack channel (one of the configured webhooks).
- **Send test alert** sends a test to their email and Slack channels; **Remove** takes them off the list.

People don't need to be admins to receive alerts; only admins can open the dashboard.

### Controlling alerts

- **Mute a check** (Status → *Mute*): 1 hour to 7 days, with a reason (logged in Incidents → Mutes). The check keeps
  running and incidents are logged; nobody is alerted. If it is still failing when the mute ends, people are told then.
- **Kill switches** (Settings, owners): Monitoring, Alerts (off = still checked and logged, nothing sent), Nightly
  backups, Auto-fix engine. Also: critical reminder interval, duplicate window, digest hour, backup retention.
- Every change is in the Settings → Audit log.

### Slack

Each Slack channel is an **incoming webhook** stored as a Worker secret named `SLACK_WEBHOOK_<NAME>`, e.g.
`npx wrangler secret put SLACK_WEBHOOK_OPS` (paste the `https://hooks.slack.com/services/…` URL when asked). The
dashboard only ever shows and stores the *name*; webhook URLs never go in the repo or the database. After adding a
secret it appears in the Slack column of every person's rules. A channel gets one post per alert even if several
people route to it.

### Email transports

Chosen by the `email_transport` setting (Settings), else the `EMAIL_TRANSPORT` variable (`cloudflare`):

- **`cloudflare`**: Cloudflare Email Service, `send_email` binding `EMAIL` (as Christmas cards does), from
  `alerts@overyondrdev.com` ("Yondr Ops"). `overyondrdev.com` must be onboarded in **Compute → Email Service → Email
  Sending** (it already is for `cards@`; the `cf-bounce` records exist). Sending to *any* address needs **Workers Paid**;
  on Workers Free only *verified destination addresses* (Email Routing → Destination addresses) receive mail.
- **`resend`**: Resend API with the `RESEND_API_KEY` secret (as marketing requests does; `overyondrdev.com` is verified
  in Resend). Sender is the same `alerts@overyondrdev.com`.
- **`off`**: nothing is emailed (deliveries are logged as failed with the reason). Slack still works.

One email per recipient (nobody sees the others' addresses).

## APIs for other systems

Server-to-server calls send the shared secret in **`X-Ops-Token: <OPS_INGEST_TOKEN>`** (at least 32 characters; a
shorter or missing token disables these endpoints). No cookie, no CSRF header. The token opens only these three:

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
`merged`, `failed`/`checks_failed` sends `autofix_started`, `autofix_merged`, `autofix_failed`.

### `GET /api/autofix/config`

`{ "autofix_enabled": false }`: the engine's kill switch (owners flip it in Settings). Default **off**. Also readable
by signed-in admins.

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

- Yondr sign-in on every request except `/brand/*`, `/robots.txt` and the three token endpoints. Pages → 302 to
  `loginUrl(request)`, API → 401 JSON. No Cloudflare Access fallback. `workers_dev`/`preview_urls` false.
- Admin role from the feedback tool's `admins` table on every API request; owner-only: Settings, PII downloads.
- **CSRF**: every state change needs `X-Yondr-Ops: 1` and `Origin` = `https://ops.overyondrdev.com`. No CORS at all.
- **Ingest token** compared in constant time; never accepted on the admin API.
- Dashboard CSP `default-src 'none'`, no inline scripts or styles, `frame-ancestors 'none'`, `noindex`.
- `DEV_EMAIL` is honoured on `localhost` only (`.dev.vars`), never in `wrangler.jsonc` (`npm run check` fails).
- Other tools' databases: read-only wrapper; webhook URLs and tokens only in secrets.

## Secrets

Set each with `npx wrangler secret put NAME` (or dashboard → Workers → yondr-ops → Settings → Variables, type
**Secret**). Settings → "Secrets and connections" shows which are set (never their values).

| Secret | Needed for | How to create, exact permissions |
| --- | --- | --- |
| `CF_API_TOKEN` | Deploy, Access, inventory, usage checks | **User** API token (My Profile → API Tokens → Create; the Workers Builds API rejects account-owned tokens). Account `3fac6c19…8085` only, all **Read**: *Account · Workers Scripts: Read*, *Account · Workers Builds Configuration: Read*, *Account · Access: Apps and Policies: Read*, *Account · D1: Read*, *Account · Workers KV Storage: Read*, *Account · Workers R2 Storage: Read*, *Account · Account Analytics: Read* |
| `GITHUB_TOKEN` | One-click revert | Fine-grained personal access token (or a GitHub App token), resource owner **Overyondrdev**, *Only select repositories*: the ones in `ALLOWED_REPOS`. Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**, **Issues: Read and write** (labels), Metadata: Read (automatic). For auto-merge, enable *Settings → General → Allow auto-merge* in each repo. Expiry ≤ 1 year: calendar it |
| `OPS_INGEST_TOKEN` | `/api/events`, `/api/autofix/*` | Random, ≥ 32 characters: `openssl rand -hex 32`. Give the same value to the feedback tool / GitHub Actions (as their secret) |
| `RESEND_API_KEY` | `resend` transport only | Resend → API Keys → *Sending access*, domain `overyondrdev.com` |
| `SLACK_WEBHOOK_<NAME>` | Slack alerts | Slack → Apps → Incoming Webhooks → Add to channel → copy URL. One secret per channel, e.g. `SLACK_WEBHOOK_OPS` |

Plain variables (in `wrangler.jsonc`, safe to commit): `YONDR_AUTH_PUBLIC_JWK`, `ALLOWED_EMAIL_DOMAINS`,
`EMAIL_FROM`, `EMAIL_FROM_NAME`, `EMAIL_TRANSPORT`. Keep every variable there: `wrangler deploy` replaces dashboard
plain-text variables.

## First deploy (owner approval needed: new Worker, host, database and bucket)

1. **D1**: `npx wrangler d1 create yondr-ops` → copy the `database_id` into `wrangler.jsonc` (replacing
   `TO-BE-CREATED`) in a PR. The schema is created automatically on first use.
2. **R2**: `npx wrangler r2 bucket create yondr-ops-backups` (private; no public access, no custom domain).
3. **Email**: confirm `overyondrdev.com` is onboarded in Compute → Email Service → Email Sending (it is, for `cards@`);
   nothing else to verify for `alerts@overyondrdev.com`. On Workers Free, add each recipient as a verified destination
   address, or use `EMAIL_TRANSPORT=resend` with `RESEND_API_KEY`. DMARC is `p=reject`, so don't send from another domain.
4. **Secrets**: as in the table above (`CF_API_TOKEN`, `OPS_INGEST_TOKEN` at least; `GITHUB_TOKEN` before the first
   revert; Slack webhooks as wanted).
5. **Deploy**: `npm ci && npm run deploy` (creates the Worker, the `ops.overyondrdev.com` custom domain and both crons).
6. **Sign-in**: add `ops.overyondrdev.com` to the Access application **"Yondr sites (Google sign-in)"** (Bypass), and a
   line for it to `SITES` in `overyondr-website-v1/auth/src/pages.js`. Until then the wildcard Access app keeps it
   behind Access (safe, but costs seats; ops itself will warn about it).
7. **Docs**: add the Worker, host, D1 `yondr-ops` and R2 `yondr-ops-backups` to `docs/OPERATIONS.md` §1 and
   `docs/PLATFORM.md` §1 in `overyondr-website-v1` (OPERATIONS.md §2 rule 5).
8. **Check** in Incognito: `/` sends you to the sign-in page and back; a non-admin sees "Admins only"; `/api/status`
   answers 401 signed out. In the dashboard: *Run checks now*, add yourself in Alerts and *Send test alert*,
   *Back up now* and download one backup.
9. Later: have the feedback tool `POST /api/events` for critical feedback, and the auto-fix engine use `/api/autofix/*`.

## Deploy

`npm run deploy` (runs `check` and `test`, then `wrangler deploy`). It works from Claude cloud sessions too: the
dashboard is bundled into the script, so there are no static assets to upload. Bundle: about 307 KiB (151 KiB
gzipped); the free plan allows 3 MB. Never set `DEV_EMAIL` on the deployed Worker.

## Rollback

- Code: Cloudflare dashboard → Workers → yondr-ops → Deployments → pick the previous version → *Rollback*, or
  `npx wrangler rollback`. Data is untouched (schema changes are additive).
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
- **Subrequests**: one monitoring run makes ~25 outbound requests plus alerts (free limit 50); a revert ≤ 45.
- If the monitoring run itself crashes (e.g. D1 unavailable), no alert can be sent: watch `yondr-ops` errors in
  Workers Observability, and the daily digest stops arriving.
- Cron triggers: Workers Free allows 5 per account; this Worker uses 2.
