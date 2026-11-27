import { readOnly } from './readonly.js';
import { yondrUser } from './yondr-session.js';

// Identity: the Yondr Google sign-in session (yondr_session cookie on .overyondrdev.com, issued by
// auth.overyondrdev.com and verified by ./yondr-session.js). There is no Cloudflare Access fallback.
//
// Local development only: DEV_EMAIL in .dev.vars (git-ignored) signs every request in as that person, and an
// X-Dev-Email header acts as someone else (to test roles). DEV_EMAIL must never be set on the deployed Worker;
// scripts/check.mjs fails if it appears in wrangler.jsonc.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)$/;

export function isLocal(request) {
  return LOCAL_HOST.test(new URL(request.url).hostname);
}

export async function currentUser(request, env) {
  // DEV_EMAIL is honoured only on localhost, so setting it on the deployed Worker by mistake can't skip sign-in.
  if (env.DEV_EMAIL && isLocal(request)) {
    const as = request.headers.get('x-dev-email');
    return { email: String(as || env.DEV_EMAIL).trim().toLowerCase(), name: null };
  }
  return yondrUser(request, env);
}

// ONE list of admins for Yondr tools: the feedback tool's `admins` table (D1 yondr-feedback, bound here as
// FEEDBACK_DB and only ever read). Roles: owner | admin. Manage people in feedback.overyondrdev.com/admin → People.
export async function roleOf(env, email) {
  if (!env.FEEDBACK_DB || !email) return null;
  const row = await readOnly(env.FEEDBACK_DB).prepare('SELECT role FROM admins WHERE email = ?').bind(email).first();
  return row && (row.role === 'owner' || row.role === 'admin') ? row.role : null;
}
