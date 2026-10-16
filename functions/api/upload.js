// POST /api/upload - admins only. Receives the totals the admin's browser worked out
// from a TikTok income export (the raw file never reaches the server), adds the
// statements not already stored, and keeps the previous version as 'data_prev'.
// Statements already stored are ignored, so uploading overlapping files is safe.
import { adminJson, json, fail, HttpError } from '../_lib/auth.js';
import { MONEY_KEYS } from '../../site/js/tiktok.js';
import { merge } from '../../site/js/pnl.js';

const MAX_BYTES = 20_000_000;
const MAX_ROWS = 200_000;
const bad = (msg) => { throw new HttpError(400, `Upload rejected: ${msg}`); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = (v, what) => (typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v)) ? v : bad(`${what} is not a date`));
const amount = (v, what) => (v == null ? 0 : typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9 ? v : bad(`${what} is not a valid amount`));
const count = (v, what) => (v == null ? 0 : Number.isInteger(v) && v >= 0 && v < 1e7 ? v : bad(`${what} is not a valid count`));
const text = (v, what, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : bad(`${what} is missing or too long`));
const ID = /^\d{1,30}$/;

export function sanitise(body) {
  if (!body || typeof body !== 'object') bad('no data');
  const st = body.statements && typeof body.statements === 'object' ? Object.entries(body.statements) : bad('no statements');
  if (!st.length || st.length > 5000) bad('no statements, or too many');
  const statements = {};
  for (const [id, s] of st) {
    if (!ID.test(id)) bad(`statement ID "${String(id).slice(0, 40)}" is not valid`);
    statements[id] = { date: date(s?.date, `statement ${id} date`), settlement: amount(s?.settlement, `statement ${id} total`), rows: count(s?.rows, `statement ${id} rows`) };
  }
  const list = (v, what) => (Array.isArray(v) && v.length <= MAX_ROWS ? v : bad(`${what} are missing or too many`));
  const owned = (s, what) => (typeof s === 'string' && s in statements ? s : bad(`${what} belongs to a statement not in the upload`));
  const daily = list(body.daily, 'box rows').map((r, i) => {
    const w = `box row ${i + 1}`;
    const o = { s: owned(r?.s, w), d: date(r?.d, w), sku: ID.test(r?.sku) ? r.sku : bad(`${w} SKU`), u: count(r.u, w), r: count(r.r, w), f: count(r.f, w) };
    for (const k of MONEY_KEYS) if (r[k] != null) o[k] = amount(r[k], `${w} ${k}`);
    return o;
  });
  const adj = list(body.adj, 'shop items').map((r, i) => ({ s: owned(r?.s, `item ${i + 1}`), d: date(r?.d, `item ${i + 1}`), t: text(r?.t, `item ${i + 1} type`, 100), a: amount(r?.a, `item ${i + 1}`) }));
  const names = {};
  for (const [sku, n] of Object.entries(body.names && typeof body.names === 'object' ? body.names : {})) {
    if (!ID.test(sku)) bad('box name for a bad SKU');
    names[sku] = { name: text(n?.name, `name of ${sku}`, 300), d: date(n?.d, `name date of ${sku}`) };
  }
  const f = body.file || {};
  const file = { name: typeof f.name === 'string' ? f.name.slice(0, 200) : '', first: f.first == null ? null : date(f.first, 'first order'), last: f.last == null ? null : date(f.last, 'last order') };
  return { statements, daily, adj, names, file };
}

export async function onRequestPost({ request, env }) {
  try {
    const { who, body } = await adminJson(request, env, MAX_BYTES);
    const incoming = sanitise(body);
    const kv = env.LIB_DATA;
    const raw = await kv.get('data');
    const cur = raw ? JSON.parse(raw) : null;
    const { data, added } = merge(cur, incoming, 'tiktok');
    const already = Object.keys(incoming.statements).length - added.length;
    if (!added.length) return json({ ok: true, added: 0, already });
    const now = new Date().toISOString();
    const settlement = added.reduce((a, id) => a + incoming.statements[id].settlement, 0);
    const uploads = [...(cur?.uploads || []), { ...incoming.file, at: now, by: who.email, added: added.length, already, settlement: Math.round(settlement * 100) / 100 }].slice(-500);
    if (raw) await kv.put('data_prev', raw);
    await kv.put('data', JSON.stringify({ version: 1, ...data, uploads, uploaded_at: now }));
    return json({ ok: true, added: added.length, already });
  } catch (err) {
    return fail(err);
  }
}
