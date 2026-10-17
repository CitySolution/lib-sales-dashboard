// POST /api/seed { part } - admins only. One-off load of the TikTok income exports
// supplied when the dashboard was built (1 Jan - 11 Oct 2026, four files), parsed
// with site/js/tiktok.js and bundled in functions/_lib/seed.json. Each part is one
// file and goes through the same "only new statements" storing as an upload, so
// loading twice changes nothing. Delete seed.json once loaded; this then does nothing.
import { adminJson, json, fail, HttpError } from '../_lib/auth.js';
import { addBatch } from '../_lib/store.js';
import seed from '../_lib/seed.json' with { type: 'json' };

export const seedPending = (index) => seed.filter((p) => Object.keys(p.statements).some((id) => !index?.statements?.[id])).length;

export async function onRequestPost({ request, env }) {
  try {
    const { who, body } = await adminJson(request, env, 1000);
    const part = seed[body?.part];
    if (!Number.isInteger(body?.part) || !part) throw new HttpError(400, 'No such part.');
    const { file, ...incoming } = part;
    return json({ ok: true, parts: seed.length, ...(await addBatch(env, who, incoming, file)) });
  } catch (err) {
    return fail(err);
  }
}
