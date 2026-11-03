// POST /api/delete - admins only. Takes an upload back out, e.g. a wrong file:
//   { tiktok: [at, ...] }  the TikTok uploads made at those times (an upload's `at` is
//                          also in its batch key, functions/_lib/store.js): their batches
//                          and statements go, so the file can be uploaded again.
//   { shopify: ['YYYY-MM', ...] }  those months of Shopify figures (functions/api/shopify.js).
// Every deletion is logged in the index it was taken from.
import { adminJson, json, fail, HttpError } from '../_lib/auth.js';

const bad = (msg) => { throw new HttpError(400, msg); };
const list = (v, re, what) => (Array.isArray(v) && v.length && v.length <= 100 && v.every((x) => typeof x === 'string' && re.test(x)) ? v : bad(`Choose the ${what} to delete.`));

export async function onRequestPost({ request, env }) {
  try {
    const { who, body } = await adminJson(request, env, 20_000);
    const kv = env.LIB_DATA, at = new Date().toISOString();
    if (body?.tiktok) {
      const ats = list(body.tiktok, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, 'TikTok upload');
      const index = await kv.get('index', 'json');
      const keys = new Set((index?.batches || []).filter((k) => ats.some((a) => k.startsWith(`batch:${a}:`))));
      if (!keys.size) bad('That upload has already gone.');
      const ids = Object.keys(index.statements).filter((id) => keys.has(index.statements[id].batch));
      const settlement = Math.round(ids.reduce((a, id) => a + index.statements[id].settlement, 0) * 100) / 100;
      for (const id of ids) delete index.statements[id];
      index.batches = index.batches.filter((k) => !keys.has(k));
      const gone = index.uploads.filter((u) => ats.includes(u.at));
      index.uploads = index.uploads.filter((u) => !ats.includes(u.at));
      index.deleted = [...(index.deleted || []), { at, by: who.email, files: [...new Set(gone.map((u) => u.name))], statements: ids.length, settlement }].slice(-200);
      await kv.put('index', JSON.stringify(index));
      for (const k of keys) await kv.delete(k);
      return json({ ok: true, statements: ids.length, settlement });
    }
    if (body?.shopify) {
      const months = list(body.shopify, /^20\d\d-(0[1-9]|1[0-2])$/, 'Shopify months');
      const index = await kv.get('shopify', 'json');
      const have = months.filter((m) => index?.months?.[m]);
      if (!have.length) bad('Those months have already gone.');
      const net = Math.round(have.reduce((a, m) => a + index.months[m].net, 0) * 100) / 100;
      const files = [...new Set(have.map((m) => index.months[m].file))];
      for (const m of have) delete index.months[m];
      index.deleted = [...(index.deleted || []), { at, by: who.email, files, months: have, net }].slice(-200);
      await kv.put('shopify', JSON.stringify(index));
      for (const m of have) await kv.delete(`shopify:${m}`);
      return json({ ok: true, months: have, net });
    }
    bad('Say which upload to delete.');
  } catch (err) {
    return fail(err);
  }
}
