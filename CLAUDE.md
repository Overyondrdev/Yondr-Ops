# yondr-ops — instructions for Claude

Monitoring, alerts, nightly backups and the auto-fix log for the `overyondrdev.com` estate: Worker `yondr-ops` on
`ops.overyondrdev.com`. README.md has what is checked, every alert type, people & rules, the APIs, backups and
restore, secrets with exact permissions, first deploy, deploy and rollback. Platform rules (sign-in, hosts, deploy
lessons): `Overyondrdev/overyondr-website-v1` → `docs/PLATFORM.md` and `docs/OPERATIONS.md`. Read them before changing
sign-in, hosts, Access, DNS or deploys.

## Where things live
| Path | What |
| --- | --- |
| `src/checks.js` | What is watched. Adding a site = one line in `GATE` (+ `EXPECTED_INVENTORY`/`BUILDS` if it is a new Worker) |
| `src/evaluate.js`, `src/cloudflare.js` | Pure rules turning answers into check results; Cloudflare API checks |
| `src/state.js`, `src/monitor.js` | State machine (alert on change, reminders, mutes, incidents); the 5-minute run |
| `src/alerts.js`, `src/email.js`, `src/digest.js` | Alert types, routing, message text, delivery and log; digests |
| `src/backups.js` | Nightly D1 → R2 backups, retention |
| `src/triage.js`, `src/classify.js` | Auto-fix triage (owner's rules: only objective bugs), Workers AI classifier, the GitHub issue |
| `src/verify.js` | Auto-fix watch: PR backstop, deploy + site verification, automatic revert (own cron) |
| `src/autofix.js`, `src/github.js` | Auto-fix log and one-click revert |
| `src/budget.js` | Auto-fix spending (owner's rules: monthly budget, warnings, pause at 90 %, owner approval) |
| `src/ingest.js` | Token endpoints (`X-Ops-Token`); `client_errors` events go to `src/errors.js` |
| `src/overview.js`, `src/cfcache.js` | Overview (one call); Cloudflare answers cached 5 minutes in `cf_cache` |
| `src/issues.js` | Issues tracker (automatic issues, `issue_assigned` / `issue_critical`, from feedback) |
| `src/status.js` | Staff status page (`/status`, all signed-in staff) and uptime history |
| `src/errors.js`, `src/deploys.js` | Server/browser errors; deployments, deploy watch, owners-only rollback (`CF_DEPLOY_TOKEN`) |
| `src/drill.js` | Monthly restore drill into `DRILL_DB`: the ONLY file that drops anything |
| `src/keys.js`, `src/review.js`, `src/people.js` | Key-expiry calendar; quarterly access review; directory and roles via the feedback tool's API |
| `src/daily.js` | Daily jobs on the backup cron (drill, keys, access review, retention) |
| `src/api.js`, `src/index.js`, `src/http.js`, `src/auth.js` | Dashboard API, routing and sign-in gate, CSRF, roles |
| `src/readonly.js` | Read-only wrapper for other tools' databases |
| `src/schema.js` | D1 schema of `yondr-ops`, applied automatically; additive only |
| `src/yondr-session.js` | **Unchanged copy** of `overyondr-website-v1/auth/src/session.js` (CI compares) |
| `public/` | Dashboard (`index.html`, `app.js`, `app.css`) and brand files, bundled by `scripts/build-static.mjs` |
| `scripts/check.mjs` | Repo rules: syntax, Wrangler safety, read-only foreign DBs, no personal emails or secrets |
| `test/` | `node --test`; `test/helpers.js` fakes D1 (`node:sqlite`), R2, the email binding and signs sessions |

## Rules
- **Sign-in on everything** except `/brand/*`, `/robots.txt` and the four token endpoints. Pages → 302 to
  `loginUrl(request)`, API → 401 JSON. Admins only (feedback tool's `admins` table; there is ONE admin list — never add
  a second), except the read-only staff **Status** page (`/status`, `GET /api/status/public`): any signed-in staff
  member, no technical detail. No Cloudflare Access fallback. `workers_dev` and `preview_urls` stay `false`.
- **Roles are changed only through the feedback tool's admin API** (`src/people.js`, service binding `FEEDBACK`, the
  person's own `yondr_session`, `X-Yondr-Feedback: 1`, ops `Origin`), audited. Never write `FEEDBACK_DB`. Other tools'
  roles are display-only here (name, email, role, last seen — nothing more).
- **Keep `src/yondr-session.js` byte-identical** to `overyondr-website-v1/auth/src/session.js`. When that file
  changes, update this copy in a PR of its own.
- **CSRF**: every state change needs `X-Yondr-Ops: 1` and the site's own `Origin`. No CORS. The ingest token never
  opens the admin API. Don't loosen these; keep the tests.
- **Other tools' databases are read-only** (`FEEDBACK_DB`, `ADS_DB`, `REQUESTS_DB`, `CARDS_DB`): always through
  `readOnly()`; `npm run check` enforces it. **Never implement deletion of live data.** Only backup files under
  `backups/` in R2 are deleted, by the retention rules.
- **Own data** (D1 `yondr-ops`): schema changes additive and idempotent (`IF NOT EXISTS`, `ADDED_COLUMNS`);
  `autofix_events` and `issue_events` are append-only. Locally use `--local` only; never run commands against remote
  databases without the owner's say-so.
- **Destructive SQL** (`npm run check`): `DROP` only in `src/drill.js` on `DRILL_DB` (scratch database
  `yondr-ops-restore-drill`); personal data is dropped from it straight after each drill. `DELETE FROM` only on ops'
  own bookkeeping tables (allow-list in `scripts/check.mjs`).
- **Rollback** is owners-only, confirmed, audited, with the separate `CF_DEPLOY_TOKEN`; `CF_API_TOKEN` stays read-only.
- **Crons**: keep 3. New daily work goes in `src/daily.js` (backup cron), new 5-minute work in the monitor or auto-fix run.
- **Alerts**: owners can't be unsubscribed from `site_down` / `site_exposed`, `rollback_done`, `restore_drill_failed`,
  `key_expiring`, `issue_critical` or the `autofix_budget_*` alerts; `issue_assigned` only ever goes to the assignee; critical
  alerts and `autofix_budget_*` ignore quiet hours. Auto-fix never spends past the pause level without an owner's approval. Keep
  messages plain (what, which site, since when, what was done, link). New alert types go in `EVENTS` and README.
- **Never commit secrets, webhook URLs or personal email addresses** (this repository is public). Tests and examples
  use the fictional people allowed in `scripts/check.mjs`. `DEV_EMAIL` only in `.dev.vars`. No names or emails in
  revert commits/PRs either.
- **Auto-fix** follows the owner's rules in `docs/OPERATIONS.md` §6.3 (README "Auto-fix"): only type bug, only
  objective (unsure = subjective = a person), kill switch `autofix_enabled` respected everywhere, no personal data in
  GitHub issues. Keep the tests in `test/triage.test.js` and `test/verify.test.js`.
- No runtime dependencies (ask first). `wrangler` is the only dev dependency. Plain JS.
- Dashboard: accessible (keyboard, focus visible, labels), works at 375 px, `prefers-reduced-motion` respected,
  CSP-clean (no inline scripts or `style=` attributes). Brand look follows the feedback admin.
- Keep the Worker bundle well under 3 MB (`npm run deploy:dry` prints it; `public/` is capped at 1 MB).
- **Docs move with code**: checks, alert types, APIs, secrets or backup behaviour change → README in the same PR. A new
  Worker/host/database/bucket → `docs/OPERATIONS.md` §1 in the website repo.

## How to ship a change
1. Branch from `main` (`feature/<name>` or `fix/<thing>`).
2. `npm ci` (first time), `npm run check`, `npm test`, `npm run deploy:dry`. All must pass.
3. Commit, push, open a PR into `main` using `.github/pull_request_template.md`. Never push or force-push `main`.
4. **When the PR is ready, merge it yourself (squash) — don't wait for the owner** (owner's standing instruction,
   OPERATIONS.md §2): ready = the **build** check green, branch up to date with `main`, docs updated, no open review
   questions. Then check the change live and say what you checked. Still ask first for: deleting data or databases,
   DNS or Access changes, new secrets/tokens, and anything the owner asked to approve.
5. Deploy: `npm run deploy` (README "Deploy"), then check https://ops.overyondrdev.com (Overview loads, Sites & checks →
   *Run checks now* works, `/status` loads) and say what you checked. Delete the merged branch.
