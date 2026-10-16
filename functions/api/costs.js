// POST /api/costs - admins only. Sets one box's cost history: a list of entries, each
// applying from its date (see costAt in site/js/pnl.js). Every change is logged.
import { adminJson, json, fail, HttpError } from '../_lib/auth.js';
import { COST_KEYS } from '../../site/js/pnl.js';

const bad = (msg) => { throw new HttpError(400, msg); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function sanitiseEntries(list) {
  if (!Array.isArray(list) || list.length > 100) bad('Costs must be a list of up to 100 dated entries.');
  const out = list.map((e, i) => {
    if (!e || typeof e !== 'object' || !DATE.test(e.from) || Number.isNaN(Date.parse(e.from))) bad(`Entry ${i + 1} needs a "from" date.`);
    const o = { from: e.from };
    for (const k of COST_KEYS) {
      const v = e[k] ?? 0;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > (k === 'commission' ? 1 : 10000)) bad(`Entry ${i + 1}: ${k} must be ${k === 'commission' ? 'between 0% and 100%' : 'a positive amount'}.`);
      o[k] = v;
    }
    return o;
  }).sort((a, b) => a.from.localeCompare(b.from));
  if (new Set(out.map((e) => e.from)).size !== out.length) bad('Two entries have the same date.');
  return out;
}

export async function onRequestPost({ request, env }) {
  try {
    const { who, body } = await adminJson(request, env, 100_000);
    const sku = /^\d{1,30}$/.test(body?.sku) ? body.sku : bad('Unknown box.');
    const entries = sanitiseEntries(body.entries);
    const cur = (await env.LIB_DATA.get('costs', 'json')) || { values: {}, log: [] };
    if (entries.length) cur.values[sku] = entries; else delete cur.values[sku];
    cur.log = [...(cur.log || []), { at: new Date().toISOString(), by: who.email, sku, entries }].slice(-500);
    await env.LIB_DATA.put('costs', JSON.stringify(cur));
    return json({ ok: true, costs: cur });
  } catch (err) {
    return fail(err);
  }
}
