// POST /api/users { email, admin: true | false } - admins only. Makes someone an admin,
// or takes it away, on the Access tab. They must have an allowed email address. The
// owners in functions/_lib/users.json can't be removed here, and nobody can remove
// themselves, so there's always an admin. Every change is logged.
import { adminJson, json, fail, HttpError, normEmail, allowedEmail, isOwner, DOMAINS } from '../_lib/auth.js';

const bad = (msg) => { throw new HttpError(400, msg); };

export async function onRequestPost({ request, env }) {
  try {
    const { who, body } = await adminJson(request, env, 1000);
    const email = normEmail(body?.email);
    if (!allowedEmail(email) || email.length > 200) bad(`Enter an ${DOMAINS.map((d) => '@' + d).join(' or ')} email address.`);
    if (typeof body.admin !== 'boolean') bad('Say whether they should be an admin.');
    if (!body.admin && isOwner(email)) bad(`${email} is a permanent admin and can't be removed here.`);
    if (!body.admin && email === who.email) bad("You can't remove yourself - ask another admin.");
    const cur = (await env.LIB_DATA.get('users', 'json')) || { admins: {}, log: [] };
    const at = new Date().toISOString();
    if (body.admin) { if (!isOwner(email)) cur.admins[email] = { by: who.email, at }; } else delete cur.admins[email];
    cur.log = [...(cur.log || []), { at, by: who.email, email, admin: body.admin }].slice(-500);
    await env.LIB_DATA.put('users', JSON.stringify(cur));
    return json({ ok: true, users: cur });
  } catch (err) {
    return fail(err);
  }
}
