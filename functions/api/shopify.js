// POST /api/shopify { month: 'YYYY-MM', rows, file, monthly } - admins only. Stores one
// month of Shopify sales from the "Total sales by product variant" report, as read by
// site/js/shopify.js, replacing whatever was stored for that month: the report has no
// statement IDs, so the latest upload of a month is the one kept. One month per request
// keeps each within Cloudflare's CPU limit.
//
// KV: 'shopify'          { months: { 'YYYY-MM': { rows, net, monthly, at, by, file } }, uploads }
//     'shopify:YYYY-MM'  that month's rows: [{ d, sku, title, n, gs, sd, gsr, net, tax, ship, box? }]
import { adminJson, json, fail, HttpError } from '../_lib/auth.js';

const bad = (msg) => { throw new HttpError(400, msg); };
const MONEY = ['gs', 'sd', 'gsr', 'net', 'tax', 'ship'];
const amount = (v, what) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e8 ? Math.round(v * 100) / 100 : bad(`${what} isn't an amount.`));

export function sanitiseRows(month, rows) {
  if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(month || '')) bad('Unknown month.');
  if (!Array.isArray(rows) || rows.length > 5000) bad('Send up to 5,000 rows for a month.');
  return rows.map((r, i) => {
    if (!r || typeof r.d !== 'string' || !r.d.startsWith(`${month}-`) || !/^\d{4}-\d{2}-\d{2}$/.test(r.d)) bad(`Row ${i + 1}: its date isn't in ${month}.`);
    if (typeof r.sku !== 'string' || !/^[\w.-]{1,60}$/.test(r.sku)) bad(`Row ${i + 1}: unknown SKU.`);
    const o = { d: r.d, sku: r.sku, title: String(r.title ?? '').slice(0, 200), n: amount(r.n, `Row ${i + 1}: items sold`) };
    for (const k of MONEY) o[k] = amount(r[k] ?? 0, `Row ${i + 1}: ${k}`);
    if (r.box === 1) o.box = 1;
    return o;
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const { who, body } = await adminJson(request, env, 1_500_000);
    const rows = sanitiseRows(body?.month, body?.rows);
    const kv = env.LIB_DATA, at = new Date().toISOString();
    const file = { name: String(body.file?.name || '').slice(0, 200), from: body.file?.from || null, to: body.file?.to || null };
    const index = (await kv.get('shopify', 'json')) || { months: {}, uploads: [] };
    const replaced = !!index.months[body.month];
    await kv.put(`shopify:${body.month}`, JSON.stringify(rows));
    const net = Math.round(rows.reduce((a, r) => a + r.net, 0) * 100) / 100;
    index.months[body.month] = { rows: rows.length, net, monthly: body.monthly === true, at, by: who.email, file: file.name };
    index.uploads = [...index.uploads, { at, by: who.email, ...file, month: body.month, rows: rows.length, net, replaced }].slice(-500);
    await kv.put('shopify', JSON.stringify(index));
    return json({ ok: true, replaced });
  } catch (err) {
    return fail(err);
  }
}
