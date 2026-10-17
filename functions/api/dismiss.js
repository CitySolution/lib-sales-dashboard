// POST /api/dismiss { key, until } - admins only. Hides an Attention item for everyone,
// until a date (YYYY-MM-DD) or for good (until: null); { key, show: true } brings it
// back. Keys are made in site/js/checks.js (e.g. "margin:<SKU>"). Every change is logged.
import { adminJson, json, fail, HttpError } from '../_lib/auth.js';

const bad = (msg) => { throw new HttpError(400, msg); };

export async function onRequestPost({ request, env }) {
  try {
    const { who, body } = await adminJson(request, env, 2000);
    const key = typeof body?.key === 'string' && /^[a-z-]+(:[\w-]+){0,2}$/.test(body.key) && body.key.length <= 100 ? body.key : bad('Unknown item.');
    const cur = (await env.LIB_DATA.get('dismissed', 'json')) || { values: {}, log: [] };
    const at = new Date().toISOString();
    if (body.show === true) {
      delete cur.values[key];
      cur.log = [...(cur.log || []), { at, by: who.email, key, shown: true }];
    } else {
      const until = body.until ?? null;
      if (until !== null && !(typeof until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(until) && !Number.isNaN(Date.parse(until)))) bad('"until" must be a date or null.');
      cur.values[key] = { until, by: who.email, at };
      cur.log = [...(cur.log || []), { at, by: who.email, key, until }];
    }
    cur.log = cur.log.slice(-500);
    await env.LIB_DATA.put('dismissed', JSON.stringify(cur));
    return json({ ok: true, dismissed: cur });
  } catch (err) {
    return fail(err);
  }
}
