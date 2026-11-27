// Pure functions that turn one HTTP answer into a check result. No I/O here, so the rules are easy to test.
//
// A result: { id, site, ok, event, severity, title, detail }
//   ok        true = fine, false = problem, null = couldn't check (not counted as up or down)
//   event     alert type (src/alerts.js EVENTS) when not ok
//   severity  info | warning | high | critical
import { AUTH_LOGIN } from './checks.js';

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * @param check  an entry of GATE (src/checks.js)
 * @param r      { status, location, error, ms } — error is set when the request failed or timed out
 */
export function evaluateGate(check, r) {
  const base = { id: check.id, site: check.site };
  if (r.error || !r.status) {
    return { ...base, ok: false, event: 'site_down', severity: 'critical', title: `${check.site} is not responding`,
      detail: `No answer from ${check.url} (${r.error || 'no response'}).` };
  }
  if (r.status >= 500) {
    return { ...base, ok: false, event: 'site_down', severity: 'critical', title: `${check.site} is down`,
      detail: `${check.url} answered with error ${r.status}.` };
  }
  const loc = r.location || '';
  const exp = check.expect;

  if (exp === 'login') {
    if (REDIRECT.has(r.status) && loc.startsWith(AUTH_LOGIN + '?')) return { ...base, ok: true, detail: 'Sends signed-out visitors to the Yondr sign-in.' };
    if (r.status === 200) return exposed(base, check);
    if (REDIRECT.has(r.status) && /\.cloudflareaccess\.com\//.test(loc)) {
      return { ...base, ok: false, event: 'config_drift', severity: 'warning', title: `${check.site} is behind Cloudflare Access`,
        detail: `${check.url} sends visitors to the Cloudflare Access login instead of the Yondr sign-in. Every person who signs in there costs an Access seat.` };
    }
    return unexpected(base, check, r);
  }
  if (exp && exp.redirect) {
    if (REDIRECT.has(r.status) && exp.redirect.test(loc)) return { ...base, ok: true, detail: 'Sends signed-out visitors to its sign-in step.' };
    if (r.status === 200) return exposed(base, check);
    return unexpected(base, check, r);
  }
  if (exp && exp.status) {
    if (r.status === exp.status) return { ...base, ok: true, detail: `Answers ${r.status} as expected.` };
    // A gated endpoint that answers 200 to a signed-out request is giving data away.
    if (!check.public && r.status === 200) return exposed(base, check);
    return unexpected(base, check, r);
  }
  throw new Error(`Check ${check.id}: unknown expectation`);
}

function exposed(base, check) {
  return { ...base, ok: false, event: 'site_exposed', severity: 'critical', title: `${check.site} is open to the public`,
    detail: `${check.url} showed its content to a signed-out visitor instead of asking them to sign in. Anyone on the internet can see it right now.` };
}

function unexpected(base, check, r) {
  return { ...base, ok: false, event: 'site_down', severity: 'high', title: `${check.site} is answering unexpectedly`,
    detail: `${check.url} answered ${r.status}${r.location ? ` (redirect to ${r.location})` : ''} instead of the usual answer.` };
}

/** overyondr.com must stay on Squarespace (301 to www, served by Squarespace) until the cutover. */
export function evaluatePublicSite(cfg, r) {
  const base = { id: cfg.id, site: cfg.site };
  if (r.error || !r.status) return { ...base, ok: false, event: 'site_down', severity: 'high', title: 'overyondr.com is not responding', detail: `No answer from ${cfg.url} (${r.error || 'no response'}).` };
  if (r.status >= 500) return { ...base, ok: false, event: 'site_down', severity: 'high', title: 'overyondr.com is down', detail: `${cfg.url} answered with error ${r.status}.` };
  if (REDIRECT.has(r.status) && cfg.location.test(r.location || '') && cfg.server.test(r.server || '')) {
    return { ...base, ok: true, detail: 'Still served by Squarespace (redirects to www.overyondr.com), as expected before the cutover.' };
  }
  return { ...base, ok: false, event: 'config_drift', severity: 'warning', title: 'overyondr.com has changed',
    detail: `overyondr.com no longer looks like the Squarespace site (answer ${r.status}, server "${r.server || 'unknown'}"` +
      `${r.location ? `, redirect to ${r.location}` : ''}). Nothing should change it before the cutover sign-off.` };
}
