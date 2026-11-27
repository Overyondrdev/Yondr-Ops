// Cloudflare API checks: Workers Builds outcome, the Access Bypass app, account inventory and daily usage.
// Uses the CF_API_TOKEN secret (a READ-ONLY user API token; permissions in README "Secrets"). Without it every
// Cloudflare check reports "couldn't check" (ok: null) and nothing alerts.
// The evaluate* functions are pure (tested); the rest only fetches.
import { ACCESS_BYPASS_APP, ACCOUNT_ID, BUILDS, EXPECTED_INVENTORY, GATED_HOSTS, USAGE } from './checks.js';

const API = 'https://api.cloudflare.com/client/v4';

/** One Cloudflare API call. opts: { method, body, token } (token defaults to the read-only CF_API_TOKEN). */
export async function cf(env, path, opts = {}) {
  const headers = { authorization: `Bearer ${opts.token || env.CF_API_TOKEN}` };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(API + path, { method: opts.method || 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const msg = (body.errors || []).map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API ${path.split('?')[0]}: ${msg}`);
  }
  return body;
}

export async function cfList(env, path, pick = (b) => b.result) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const body = await cf(env, `${path}${sep}page=${page}&per_page=100`);
    const items = pick(body) || [];
    out.push(...items);
    const info = body.result_info;
    if (!info || !info.total_pages || page >= info.total_pages || items.length === 0) break;
  }
  return out;
}

export async function graphql(env, query, variables) {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body.errors && body.errors.length)) throw new Error(`GraphQL: ${(body.errors || []).map((e) => e.message).join('; ') || res.status}`);
  return body.data;
}

const skipped = (id, site, detail) => ({ id, site, ok: null, detail });

// --------------------------------------------------------------------------------------------- pure evaluations
const FAILED = new Set(['fail', 'failed', 'failure', 'error']);
const IGNORED = new Set(['cancelled', 'canceled', 'skipped']);

/** Latest finished production-branch build of one Worker. */
export function evaluateBuilds(worker, branch, builds) {
  const id = `build:${worker}`;
  const site = `Deploys of ${worker}`;
  const prod = (builds || [])
    .filter((b) => (b.build_trigger_metadata && b.build_trigger_metadata.branch) === branch && b.build_outcome && !IGNORED.has(b.build_outcome))
    .sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)));
  const latest = prod[0];
  if (!latest) return skipped(id, site, `No finished builds of ${branch} in the last 90 days.`);
  const when = String(latest.created_on).slice(0, 16).replace('T', ' ');
  if (FAILED.has(latest.build_outcome)) {
    const commit = latest.build_trigger_metadata.commit_hash ? ` (commit ${latest.build_trigger_metadata.commit_hash.slice(0, 7)})` : '';
    return { id, site, ok: false, event: 'deploy_failed', severity: 'high', fingerprint: latest.build_uuid || null,
      title: `Deploy of ${worker} failed`,
      detail: `The Workers Builds deploy of ${branch}${commit} at ${when} UTC failed, so the latest merged change is not live. The site still serves the previous version. Build logs: Cloudflare dashboard → Workers → ${worker} → Deployments → View build history.` };
  }
  return { id, site, ok: true, detail: `Latest deploy of ${branch} (${when} UTC) succeeded.` };
}

function hostOf(s) {
  return String(s || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
}

/** The Bypass app must list every host that checks the Yondr sign-in itself; otherwise Access charges seats. */
export function evaluateAccess(apps, gatedHosts = GATED_HOSTS, appName = ACCESS_BYPASS_APP) {
  const id = 'cf:access-bypass';
  const site = 'Cloudflare Access';
  const app = (apps || []).find((a) => a.name === appName);
  if (!app) {
    return { id, site, ok: false, event: 'config_drift', severity: 'warning', fingerprint: 'missing-app', title: `Access app "${appName}" not found`,
      detail: `The Cloudflare Access application "${appName}" (Bypass for the sites that check the Yondr sign-in themselves) is missing or renamed. Hosts may fall back to the wildcard Access app, and every sign-in there costs a seat.` };
  }
  const hosts = new Set([app.domain, ...(app.self_hosted_domains || []), ...((app.destinations || []).map((d) => d.uri))].filter(Boolean).map(hostOf));
  const missing = gatedHosts.filter((h) => !hosts.has(h)).sort();
  const policies = app.policies || [];
  const notBypass = policies.length > 0 && !policies.some((p) => p.decision === 'bypass');
  if (!missing.length && !notBypass) return { id, site, ok: true, detail: `All ${gatedHosts.length} sites are in the Bypass app.` };
  const parts = [];
  if (missing.length) parts.push(`Not in the Bypass app: ${missing.join(', ')}. Signed-in visits to these hosts go through Cloudflare Access and cost a seat each.`);
  if (notBypass) parts.push('The app has no Bypass policy any more.');
  return { id, site, ok: false, event: 'config_drift', severity: 'warning', fingerprint: [...missing, notBypass ? 'no-bypass' : ''].join(','),
    title: missing.length ? `${missing.length} site${missing.length > 1 ? 's' : ''} missing from the Access Bypass app` : 'Access Bypass app has no Bypass policy',
    detail: parts.join(' ') };
}

const KIND_LABEL = { workers: 'Workers', d1: 'D1 databases', kv: 'KV namespaces', r2: 'R2 buckets' };
/** What exists vs docs/OPERATIONS.md section 1. */
export function evaluateInventory(kind, actual, expected) {
  const id = `cf:inventory:${kind}`;
  const site = `Cloudflare ${KIND_LABEL[kind]}`;
  const have = new Set(actual);
  const want = new Set(expected);
  const added = [...have].filter((n) => !want.has(n)).sort();
  const missing = [...want].filter((n) => !have.has(n)).sort();
  if (!added.length && !missing.length) return { id, site, ok: true, detail: `${have.size} ${KIND_LABEL[kind]}, as expected.` };
  const parts = [];
  if (added.length) parts.push(`New (not in the expected list): ${added.join(', ')}.`);
  if (missing.length) parts.push(`Missing: ${missing.join(', ')}.`);
  parts.push('If this was intended, add it to EXPECTED_INVENTORY in src/checks.js and to docs/OPERATIONS.md section 1.');
  return { id, site, ok: false, event: 'config_drift', severity: 'warning', fingerprint: `+${added.join(',')}-${missing.join(',')}`,
    title: `${KIND_LABEL[kind]} changed`, detail: parts.join(' ') };
}

export function evaluateUsage(metric, value, cfg = USAGE) {
  const { label, limit } = cfg.limits[metric];
  const id = `cf:usage:${metric}`;
  const site = 'Cloudflare usage';
  const pct = limit ? value / limit : 0;
  const shown = `${Math.round(pct * 100)} % (${value.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} today, UTC)`;
  if (pct >= cfg.highAt) return { id, site, ok: false, event: 'usage_limit', severity: 'high', title: `${label} at ${Math.round(pct * 100)} % of the free daily limit`,
    detail: `${label}: ${shown}. Past 100 % requests start failing until midnight UTC.` };
  if (pct >= cfg.warnAt) return { id, site, ok: false, event: 'usage_limit', severity: 'warning', title: `${label} at ${Math.round(pct * 100)} % of the free daily limit`,
    detail: `${label}: ${shown}.` };
  return { id, site, ok: true, detail: `${label}: ${shown}.` };
}

// --------------------------------------------------------------------------------------------- fetching checks
export async function buildChecks(env) {
  if (!env.CF_API_TOKEN) return BUILDS.workers.map((w) => skipped(`build:${w.worker}`, `Deploys of ${w.worker}`, 'CF_API_TOKEN is not set.'));
  let scripts;
  try { scripts = await cfList(env, `/accounts/${ACCOUNT_ID}/workers/scripts`); }
  catch (e) { return BUILDS.workers.map((w) => skipped(`build:${w.worker}`, `Deploys of ${w.worker}`, e.message)); }
  const tags = new Map(scripts.map((s) => [s.id, s.tag]));
  return Promise.all(BUILDS.workers.map(async (w) => {
    const tag = tags.get(w.worker);
    if (!tag) return skipped(`build:${w.worker}`, `Deploys of ${w.worker}`, 'Worker not found in the account.');
    try {
      const body = await cf(env, `/accounts/${ACCOUNT_ID}/builds/workers/${tag}/builds?per_page=25`);
      return evaluateBuilds(w.worker, w.branch, body.result);
    } catch (e) { return skipped(`build:${w.worker}`, `Deploys of ${w.worker}`, e.message); }
  }));
}

export async function accessCheck(env) {
  if (!env.CF_API_TOKEN) return skipped('cf:access-bypass', 'Cloudflare Access', 'CF_API_TOKEN is not set.');
  try { return evaluateAccess(await cfList(env, `/accounts/${ACCOUNT_ID}/access/apps`)); }
  catch (e) { return skipped('cf:access-bypass', 'Cloudflare Access', e.message); }
}

export async function inventoryChecks(env) {
  const kinds = {
    workers: async () => (await cfList(env, `/accounts/${ACCOUNT_ID}/workers/scripts`)).map((s) => s.id),
    d1: async () => (await cfList(env, `/accounts/${ACCOUNT_ID}/d1/database`)).map((d) => d.name),
    kv: async () => (await cfList(env, `/accounts/${ACCOUNT_ID}/storage/kv/namespaces`)).map((n) => n.title),
    r2: async () => (await cf(env, `/accounts/${ACCOUNT_ID}/r2/buckets?per_page=1000`)).result.buckets.map((b) => b.name),
  };
  return Promise.all(Object.entries(kinds).map(async ([kind, list]) => {
    if (!env.CF_API_TOKEN) return skipped(`cf:inventory:${kind}`, `Cloudflare ${KIND_LABEL[kind]}`, 'CF_API_TOKEN is not set.');
    try { return evaluateInventory(kind, await list(), EXPECTED_INVENTORY[kind]); }
    catch (e) { return skipped(`cf:inventory:${kind}`, `Cloudflare ${KIND_LABEL[kind]}`, e.message); }
  }));
}

/** Today's usage (UTC day so far). Each metric is read separately: one unavailable dataset doesn't hide the rest. */
export async function usageChecks(env, nowMs = Date.now()) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const vars = { a: ACCOUNT_ID, s: `${day}T00:00:00Z`, e: new Date(nowMs).toISOString(), d: day };
  const sum = (rows, f) => (rows || []).reduce((n, r) => n + Number((r.sum || {})[f] || 0), 0);
  const acct = (d) => d.viewer.accounts[0] || {};
  const metrics = {
    workers_requests: async () => sum(acct(await graphql(env, `query($a:string!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
      workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){sum{requests}}}}}`, vars)).workersInvocationsAdaptive, 'requests'),
    d1_rows_read: async () => sum(acct(await graphql(env, `query($a:string!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){
      d1AnalyticsAdaptiveGroups(limit:10000,filter:{date_geq:$d,date_leq:$d}){sum{rowsRead}}}}}`, vars)).d1AnalyticsAdaptiveGroups, 'rowsRead'),
    d1_rows_written: async () => sum(acct(await graphql(env, `query($a:string!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){
      d1AnalyticsAdaptiveGroups(limit:10000,filter:{date_geq:$d,date_leq:$d}){sum{rowsWritten}}}}}`, vars)).d1AnalyticsAdaptiveGroups, 'rowsWritten'),
    // Dataset/field name not confirmed in the docs; if the query fails the check shows "couldn't check" (see README TODO).
    ai_neurons: async () => sum(acct(await graphql(env, `query($a:string!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
      aiInferenceAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$e}){sum{totalNeurons}}}}}`, vars)).aiInferenceAdaptiveGroups, 'totalNeurons'),
  };
  return Promise.all(Object.entries(metrics).map(async ([m, read]) => {
    if (!env.CF_API_TOKEN) return skipped(`cf:usage:${m}`, 'Cloudflare usage', 'CF_API_TOKEN is not set.');
    try { return evaluateUsage(m, await read()); }
    catch (e) { return skipped(`cf:usage:${m}`, 'Cloudflare usage', `Couldn't read usage: ${e.message}`); }
  }));
}

// --------------------------------------------------------------------------------------------- auto-fix verification
/**
 * The production build of one commit. Pure. → { outcome: 'success' | 'failed' | 'running', created_on, build_uuid } or null
 * (not built yet / not found).
 */
export function evaluateCommitBuild(builds, sha, branch = 'main') {
  const mine = (builds || []).filter((b) => b.build_trigger_metadata && b.build_trigger_metadata.branch === branch &&
    String(b.build_trigger_metadata.commit_hash || '').toLowerCase() === String(sha).toLowerCase())
    .sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)));
  const b = mine[0];
  if (!b) return null;
  const outcome = !b.build_outcome ? 'running' : FAILED.has(b.build_outcome) ? 'failed' : IGNORED.has(b.build_outcome) ? 'cancelled' : 'success';
  return { outcome, created_on: b.created_on || null, build_uuid: b.build_uuid || null };
}

/**
 * The Workers Builds production build of `sha` for `worker`. Returns { checked: false, reason } when it can't be
 * known (no CF_API_TOKEN, Worker not in the account, API error), else { checked: true, build } (build may be null).
 * `cache` (a Map) avoids listing the account's scripts more than once per run.
 */
export async function buildForCommit(env, worker, sha, cache = new Map()) {
  if (!env.CF_API_TOKEN) return { checked: false, reason: 'CF_API_TOKEN is not set, so the deploy could not be watched.' };
  if (!worker) return { checked: false, reason: 'This repository has no Workers Builds deploy to watch.' };
  try {
    if (!cache.has('scripts')) cache.set('scripts', await cfList(env, `/accounts/${ACCOUNT_ID}/workers/scripts`));
    const s = cache.get('scripts').find((x) => x.id === worker);
    if (!s || !s.tag) return { checked: false, reason: `Worker ${worker} is not in the account (not deployed by Workers Builds yet).` };
    const body = await cf(env, `/accounts/${ACCOUNT_ID}/builds/workers/${s.tag}/builds?per_page=25`);
    return { checked: true, build: evaluateCommitBuild(body.result, sha) };
  } catch (e) {
    return { checked: false, reason: `Couldn't read Workers Builds: ${e.message}` };
  }
}

// --------------------------------------------------------------------------------------------- Access seats
/** Seats in use from GET /accounts/<id>/access/users (Zero Trust users; access_seat = uses an Access seat). Pure. */
export function evaluateSeats(users) {
  const id = 'cf:access-seats';
  const site = 'Cloudflare Access seats';
  const seated = (users || []).filter((u) => u.access_seat === true);
  if (!seated.length) return { id, site, ok: true, detail: `0 Access seats in use (${(users || []).length} people known to Zero Trust).` };
  return { id, site, ok: false, event: 'access_seats_used', severity: 'warning', fingerprint: String(seated.length),
    title: `${seated.length} Cloudflare Access seat${seated.length > 1 ? 's' : ''} in use`,
    detail: `${seated.length} ${seated.length > 1 ? 'people use' : 'person uses'} an Access seat, so someone reached a host that is still behind Cloudflare Access instead of the Yondr sign-in. Find it in Zero Trust → Logs → Access and add the host to the Bypass app (docs/PLATFORM.md §3). Seats free up after a month of inactivity, or remove them in Zero Trust → Users.` };
}

export async function accessSeatsCheck(env) {
  if (!env.CF_API_TOKEN) return skipped('cf:access-seats', 'Cloudflare Access seats', 'CF_API_TOKEN is not set.');
  try { return evaluateSeats(await cfList(env, `/accounts/${ACCOUNT_ID}/access/users`)); }
  catch (e) { return skipped('cf:access-seats', 'Cloudflare Access seats', `Couldn't read Zero Trust users (the token needs "Access: Users Read"): ${e.message}`); }
}

// --------------------------------------------------------------------------------------------- setup gaps
/** Secret names (never values) bound to one Worker: GET .../workers/scripts/<name>/settings → bindings of type secret_text. */
export async function workerSecretNames(env, worker) {
  const body = await cf(env, `/accounts/${ACCOUNT_ID}/workers/scripts/${encodeURIComponent(worker)}/settings`);
  return ((body.result && body.result.bindings) || []).filter((b) => b.type === 'secret_text' || b.type === 'secret_key').map((b) => b.name).sort();
}
