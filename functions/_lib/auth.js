// Who is asking, checked on the server for every data request.
//
// Cloudflare Access sits in front of the whole site and signs each request with a
// JWT in the Cf-Access-Jwt-Assertion header. We verify that signature ourselves
// (rather than trusting a plain email header) so a request that somehow reaches
// the site without going through Access - a preview URL, a misconfigured rule -
// gets nothing. The verified email must also be on one of the allowed domains,
// whatever the Access policy says.
import { jwtVerify, createRemoteJWKSet } from 'jose';
import users from './users.json' with { type: 'json' };

export const DOMAINS = ['citysolution.co.uk', 'latestinbeauty.com'];

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let jwks = null, jwksFor = null;
export function _setJwksForTests(set) { jwks = set; jwksFor = 'test'; }

function keySet(teamDomain) {
  if (jwksFor !== teamDomain && jwksFor !== 'test') {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksFor = teamDomain;
  }
  return jwks;
}

export const normEmail = (e) => String(e || '').trim().toLowerCase();
// Owners (users.json) are always admins and can't be removed from the dashboard, so
// nobody can be locked out. Other admins are added and removed on the Access tab
// (functions/api/users.js) and kept in KV under 'users': { admins: { email: { by, at } }, log }.
let owners;
export function _setUsers(u) { owners = new Set((u.admins || []).map(normEmail)); }
_setUsers(users);
export const isOwner = (email) => owners.has(email);
export const ownerList = () => [...owners];
export const allowedEmail = (email) => /^[^@\s]+@([^@\s]+)$/.test(email) && DOMAINS.includes(email.split('@')[1]);

export async function identify(request, env) {
  const teamDomain = (env.TEAM_DOMAIN || '').replace(/\/+$/, '');
  if (!teamDomain || !env.POLICY_AUD) throw new HttpError(503, 'The login has not been configured yet (TEAM_DOMAIN / POLICY_AUD).');
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) throw new HttpError(401, 'Not signed in.');
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keySet(teamDomain), { issuer: teamDomain, audience: env.POLICY_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'email'] }));
  } catch {
    throw new HttpError(401, 'Your sign-in could not be verified. Please sign in again.');
  }
  const email = normEmail(payload.email);
  if (!allowedEmail(email)) throw new HttpError(403, `${email || 'This account'} can't use this dashboard: it's only for ${DOMAINS.map((d) => '@' + d).join(' and ')} email addresses.`);
  const added = owners.has(email) ? null : (await env.LIB_DATA?.get('users', 'json'))?.admins;
  return { email, admin: owners.has(email) || !!added?.[email] };
}

// Admin-only changes must come from the dashboard itself, as JSON.
export async function adminJson(request, env, maxBytes) {
  const who = await identify(request, env);
  if (!who.admin) throw new HttpError(403, 'Only admins can make changes.');
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'Changes must come from the dashboard itself.');
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) throw new HttpError(415, 'Expected JSON.');
  const raw = await request.text();
  if (raw.length > maxBytes) throw new HttpError(413, 'Too large.');
  try { return { who, body: JSON.parse(raw) }; } catch { throw new HttpError(400, 'Not valid JSON.'); }
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

export function fail(err) {
  if (err instanceof HttpError) return json({ error: err.message }, err.status);
  return json({ error: 'Something went wrong on the server.' }, 500);
}
