// Repository checks (run in CI and before deploy): syntax, Wrangler safety rules, read-only use of other tools'
// databases, no personal email addresses, no secrets, nothing loaded from Squarespace. Exits non-zero with a list.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepo } from './secret-scan.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const problems = [];
const SKIP = new Set(['node_modules', '.git', '.wrangler']);
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    if (SKIP.has(n)) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(ROOT).map((p) => relative(ROOT, p)).filter((p) => p !== 'src/static.generated.js' && p !== 'package-lock.json');

// 1. Syntax
for (const f of files.filter((f) => /\.(m?js)$/.test(f))) {
  try { execFileSync(process.execPath, ['--check', join(ROOT, f)], { stdio: 'pipe' }); }
  catch (e) { problems.push(`${f}: syntax error\n${e.stderr}`); }
}

// 2. Wrangler config
const wr = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
if (!/"workers_dev":\s*false/.test(wr)) problems.push('wrangler.jsonc: workers_dev must be false');
if (!/"preview_urls":\s*false/.test(wr)) problems.push('wrangler.jsonc: preview_urls must be false');
if (/DEV_EMAIL/.test(wr)) problems.push('wrangler.jsonc: DEV_EMAIL must never be configured (local .dev.vars only)');
if (/"pattern":\s*"[^"]*overyondr\.com"/.test(wr)) problems.push('wrangler.jsonc: no overyondr.com routes before cutover');
if (!/"pattern":\s*"ops\.overyondrdev\.com"/.test(wr)) problems.push('wrangler.jsonc: the route must be ops.overyondrdev.com');
if (/hooks\.slack\.com|re_[A-Za-z0-9]{20,}|ghp_|github_pat_/.test(wr)) problems.push('wrangler.jsonc: looks like a secret (webhook URL or token); use `wrangler secret put`');

// 3. Session verifier copy (CI also compares it byte-for-byte with the auth Worker's source of truth)
if (!readFileSync(join(ROOT, 'src/yondr-session.js'), 'utf8').includes('Source of truth: overyondr-website-v1/auth/src/session.js'))
  problems.push('src/yondr-session.js: must be an unchanged copy of overyondr-website-v1/auth/src/session.js');

// 4. Other tools' databases are only ever read: every use must go through readOnly() (src/readonly.js).
const FOREIGN = /env\.(FEEDBACK_DB|ADS_DB|REQUESTS_DB|CARDS_DB)\b/g;
for (const f of files.filter((f) => f.startsWith('src/') && f.endsWith('.js'))) {
  const lines = readFileSync(join(ROOT, f), 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(FOREIGN)) {
      const ok = line.includes(`readOnly(env.${m[1]})`) || /^\s*(if \(!env\.|\/\/)/.test(line) || line.includes(`!env.${m[1]}`);
      if (!ok) problems.push(`${f}:${i + 1}: use readOnly(env.${m[1]}) — other tools' databases are read-only here`);
    }
  });
}

// 4b. Destructive SQL. DROP (tables, views, indexes, triggers) only in src/drill.js and only on the scratch database
//     (the `drill` handle from env.DRILL_DB). DELETE only on ops' own bookkeeping tables listed here, never elsewhere.
const DROP = /\bDROP\s+(\$\{|TABLE|VIEW|INDEX|TRIGGER)/i;
const DELETE_OK = new Set(['subscriptions', 'subscribers', 'check_history', 'worker_error_stats', 'client_errors', 'cf_cache', 'keys_registry']);
for (const f of files.filter((f) => f.startsWith('src/') && f.endsWith('.js') && f !== 'src/static.generated.js')) {
  const lines = readFileSync(join(ROOT, f), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    if (DROP.test(line)) {
      if (f !== 'src/drill.js') problems.push(`${f}:${i + 1}: DROP is only allowed in src/drill.js, on the scratch database DRILL_DB`);
      else if (!/\bdrill\.prepare\(/.test(line) || /env\.(DB|FEEDBACK_DB|ADS_DB|REQUESTS_DB|CARDS_DB)\b/.test(line)) problems.push(`${f}:${i + 1}: DROP must run on the drill handle (env.DRILL_DB) only`);
    }
    for (const m of line.matchAll(/\bDELETE\s+FROM\s+([\w"]+)/gi)) {
      if (!DELETE_OK.has(m[1].replace(/"/g, ''))) problems.push(`${f}:${i + 1}: DELETE FROM ${m[1]} is not allowed (only ops' own bookkeeping tables: ${[...DELETE_OK].join(', ')})`);
    }
  });
}
if (/DRILL_DB/.test(readFileSync(join(ROOT, 'src/drill.js'), 'utf8')) === false) problems.push('src/drill.js: the restore drill must use env.DRILL_DB');
for (const f of files.filter((f) => f.startsWith('src/') && f.endsWith('.js') && f !== 'src/drill.js')) {
  if (/env\.DRILL_DB\b/.test(readFileSync(join(ROOT, f), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/!env\.DRILL_DB|env\.DRILL_DB \?|env\.DRILL_DB\)|env\.DRILL_DB &&/g, ''))) problems.push(`${f}: only src/drill.js may use the scratch database DRILL_DB`);
}

// 5. Text-file content rules. This repository is public: no personal email addresses (tests use fictional people).
const FICTIONAL = new Set(['you@overyondr.com', 'name@overyondr.com', 'ada.owner@overyondr.com', 'ben.admin@overyondr.com',
  'cy.staff@overyondr.com', 'dee.new@overyondr.com']);
const SQUARESPACE = /(squarespace-cdn\.com|static1\.squarespace\.com|assets\.squarespace\.com|sqspcdn\.com)/;
const SECRETS = /(hooks\.slack\.com\/services\/T[A-Z0-9]+\/|\bre_[A-Za-z0-9]{20,}|\bghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/;
for (const f of files.filter((f) => /\.(m?js|json|jsonc|md|html|css|sql|yml|yaml|txt|toml)$|^CODEOWNERS$|\/CODEOWNERS$/.test(f))) {
  const text = readFileSync(join(ROOT, f), 'utf8');
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const e = m[0].toLowerCase();
    if (e.endsWith('@overyondr.com') && !FICTIONAL.has(e)) problems.push(`${f}: personal email address? ${e} (use a fictional one from scripts/check.mjs)`);
  }
  if (SQUARESPACE.test(text) && f !== 'scripts/check.mjs') problems.push(`${f}: references a Squarespace host`);
  if (SECRETS.test(text) && f !== 'scripts/check.mjs') problems.push(`${f}: looks like a secret (Slack webhook URL or API token)`);
}

// 6. Secrets in tracked files (API keys, tokens, webhook URLs, private keys): scripts/secret-scan.mjs, also run alone.
problems.push(...scanRepo(ROOT).problems);

if (problems.length) {
  console.error(problems.map((p) => '✗ ' + p).join('\n'));
  process.exit(1);
}
console.log(`check: ${files.length} files OK`);
