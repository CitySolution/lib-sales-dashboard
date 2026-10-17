// POST /api/targets { months: { 'YYYY-MM': { rev, n, net } | null } } - admins only.
// Sets the monthly targets for the months sent (see site/js/targets.js); a month sent
// as null, or with no figures, has its targets removed. Every change is logged.
import { adminJson, json, fail, HttpError } from '../_lib/auth.js';
import { METRICS } from '../../site/js/targets.js';

const bad = (msg) => { throw new HttpError(400, msg); };
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;

export function sanitiseMonths(months) {
  if (!months || typeof months !== 'object' || Array.isArray(months) || Object.keys(months).length > 24) bad('Send up to 24 months of targets.');
  const out = {};
  for (const [m, t] of Object.entries(months)) {
    if (!MONTH.test(m)) bad(`"${m}" isn't a month.`);
    if (t !== null && (typeof t !== 'object' || Array.isArray(t))) bad(`${m}: targets must be figures.`);
    const o = {};
    for (const { k, label } of METRICS) {
      const v = t?.[k];
      if (v == null) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e9 || (k !== 'net' && v < 0)) bad(`${m}: ${label} must be ${k === 'net' ? 'an amount' : 'zero or more'}.`);
      o[k] = v;
    }
    out[m] = Object.keys(o).length ? o : null;
  }
  return out;
}

export async function onRequestPost({ request, env }) {
  try {
    const { who, body } = await adminJson(request, env, 20_000);
    const months = sanitiseMonths(body?.months);
    const cur = (await env.LIB_DATA.get('targets', 'json')) || { values: {}, log: [] };
    for (const [m, t] of Object.entries(months)) if (t) cur.values[m] = t; else delete cur.values[m];
    cur.log = [...(cur.log || []), { at: new Date().toISOString(), by: who.email, months }].slice(-500);
    await env.LIB_DATA.put('targets', JSON.stringify(cur));
    return json({ ok: true, targets: cur });
  } catch (err) {
    return fail(err);
  }
}
