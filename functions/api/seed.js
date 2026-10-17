// POST /api/seed { part } or { costs: true } - admins only. One-off loads of what was
// supplied when the dashboard was built:
//   seed.json        the TikTok income exports (1 Jan - 11 Oct 2026, four files), parsed
//                    with site/js/tiktok.js. Each part is one file and goes through the
//                    same "only new statements" storing as an upload.
//   seed-costs.json  box costs from the original Finance Dashboard spreadsheet. Only
//                    boxes with no costs yet are filled in; nothing else is overwritten,
//                    except that a commission stored as £ per box by an earlier version
//                    (`commissionUnit`) becomes the percentage it always was (5.35 -> 5.35%).
// Loading twice changes nothing. Once loaded, set both files to [] / {}.
//
// { part: 0, rebuild: true } first replaces stored figures read by an older version of
// the file reader (index.version below PARSER_VERSION) with these - but only when every
// stored statement is one of these files', so nothing uploaded since can be lost.
// Box costs are kept. The remaining parts are then loaded as usual.
import { adminJson, json, fail, HttpError } from '../_lib/auth.js';
import { addBatch } from '../_lib/store.js';
import { PARSER_VERSION } from '../../site/js/tiktok.js';
import seed from '../_lib/seed.json' with { type: 'json' };
import seedCosts from '../_lib/seed-costs.json' with { type: 'json' };
import { sanitiseEntries } from './costs.js';

const seedIds = new Set(seed.flatMap((p) => Object.keys(p.statements)));
export const seedRebuild = (index) => !!seed.length && !!index?.batches?.length && (index.version || 1) < PARSER_VERSION
  && Object.keys(index.statements).every((id) => seedIds.has(id));
export const seedPending = (index) => seed.filter((p) => Object.keys(p.statements).some((id) => !index?.statements?.[id])).length;
const perBox = (entries) => entries.some((e) => e.commissionUnit);
export const seedCostsPending = (costs) => Object.keys(seedCosts).filter((sku) => !costs?.values?.[sku]).length
  + Object.values(costs?.values || {}).filter(perBox).length;

async function loadCosts(env, who) {
  const cur = (await env.LIB_DATA.get('costs', 'json')) || { values: {}, log: [] };
  const at = new Date().toISOString();
  let added = 0;
  for (const [sku, entries] of Object.entries(cur.values)) {
    if (!perBox(entries)) continue;
    cur.values[sku] = sanitiseEntries(entries.map(({ commissionUnit, ...e }) => (commissionUnit ? { ...e, commission: commissionUnit / 100 } : e)));
    cur.log = [...(cur.log || []), { at, by: `${who.email} (commission corrected to a %)`, sku, entries: cur.values[sku] }];
    added++;
  }
  for (const [sku, entries] of Object.entries(seedCosts)) {
    if (cur.values[sku]) continue;
    cur.values[sku] = sanitiseEntries(entries);
    cur.log = [...(cur.log || []), { at, by: `${who.email} (from the original spreadsheet)`, sku, entries: cur.values[sku] }];
    added++;
  }
  cur.log = cur.log.slice(-500);
  if (added) await env.LIB_DATA.put('costs', JSON.stringify(cur));
  return added;
}

export async function onRequestPost({ request, env }) {
  try {
    const { who, body } = await adminJson(request, env, 1000);
    if (body?.costs === true) return json({ ok: true, costs: await loadCosts(env, who) });
    const part = seed[body?.part];
    if (!Number.isInteger(body?.part) || !part) throw new HttpError(400, 'No such part.');
    if (body.rebuild === true && body.part === 0) {
      const index = await env.LIB_DATA.get('index', 'json');
      if (!seedRebuild(index)) throw new HttpError(409, 'These figures can\'t be rebuilt automatically: they include uploads other than the original files. Nothing has been changed.');
      for (const key of index.batches) await env.LIB_DATA.delete(key);
      await env.LIB_DATA.delete('index');
    }
    const { file, ...incoming } = part;
    return json({ ok: true, parts: seed.length, ...(await addBatch(env, who, incoming, file)) });
  } catch (err) {
    return fail(err);
  }
}
