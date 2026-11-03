// POST /api/skumap { map: { shopifySku: tiktokSku | null } } - admins only. Says which
// TikTok box each Shopify box is (they have different names and SKUs), so the two
// channels' sales count as one box; null means someone checked and it's not on TikTok
// (kept, so the page can tell checked boxes from new ones). Every change is logged.
import { adminJson, json, fail, HttpError } from '../_lib/auth.js';

const bad = (msg) => { throw new HttpError(400, msg); };

export async function onRequestPost({ request, env }) {
  try {
    const { who, body } = await adminJson(request, env, 50_000);
    const map = body?.map;
    if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > 500) bad('Send the boxes to match.');
    const cur = (await env.LIB_DATA.get('skumap', 'json')) || { values: {}, log: [] };
    const changed = {};
    for (const [s, t] of Object.entries(map)) {
      if (!/^[\w.-]{1,60}$/.test(s)) bad(`"${s}" isn't a Shopify SKU.`);
      if (t !== null && !(typeof t === 'string' && /^\d{1,30}$/.test(t))) bad(`${s}: that isn't a TikTok box.`);
      if (s in cur.values && cur.values[s] === t) continue;
      cur.values[s] = t;
      changed[s] = t;
    }
    if (Object.keys(changed).length) {
      cur.log = [...(cur.log || []), { at: new Date().toISOString(), by: who.email, map: changed }].slice(-500);
      await env.LIB_DATA.put('skumap', JSON.stringify(cur));
    }
    return json({ ok: true, skumap: cur, changed: Object.keys(changed).length });
  } catch (err) {
    return fail(err);
  }
}
