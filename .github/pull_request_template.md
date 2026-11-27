## What changed

## Who is affected
<!-- Admins using the dashboard, people who get alerts, other repos (Affects: …), or nobody yet. -->
Affects:

## Checks
- [ ] `npm run check`, `npm test` and `npm run deploy:dry` pass
- [ ] Schema changes are additive and idempotent (`IF NOT EXISTS` / `ADDED_COLUMNS`)
- [ ] Other tools' databases are only read (`readOnly()`); no live data is deleted
- [ ] Sign-in, admin check, CSRF and ingest-token rules unchanged, or the change is explained here
- [ ] Alert types / routing unchanged, or README "Alerts" updated
- [ ] Dashboard checked at desktop width and 375 px, keyboard only
- [ ] README / CLAUDE.md updated
- [ ] No secrets, webhook URLs or personal email addresses
