// Reads Shopify's "Total sales by product variant" report (Analytics → Reports, LiB's
// saved "Copy of…" with a Month or Day column), exported as CSV, and turns it into
// the per-box rows the dashboard stores. Runs in the browser and in the tests.
//
// The report has no statements to tell old from new, so each upload replaces the
// months it contains (functions/api/shopify.js). A box is a product in Shopify's BOXES
// collection, or with a box SKU (LIB_COLL_…: older boxes have left the collection), or
// anything else with sales. The items of a build-your-own box (SKUs BYOB26_…, each sold
// at its own price) count as one box, "BYOB26". The £0 rows are a box's contents, free
// gifts and the like. Rows with no product (gift cards, custom items) are left out.

const NEED = ['Product title', 'Product variant SKU', 'Net items sold', 'Gross sales', 'Discounts', 'Sales reversals', 'Net sales'];
const MONEY = { gs: 'Gross sales', sd: 'Discounts', gsr: 'Sales reversals', net: 'Net sales', tax: 'Taxes', ship: 'Shipping charges' };
const isBox = (sku) => /^LIB_COLL/i.test(sku);
const BYOB = /^(BYOB\d*)_/i;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(v * 100) / 100;
// A date as Shopify exports it (2026-01-01), or as Excel saves it after opening the
// file (01/01/26 or 01/01/2026, day first): YYYY-MM-DD, or null.
export function isoDate(v) {
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[1] < 1 || +m[1] > 31) return null;
  return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// The report's date range, from its file name ("… - 2026-10-01 - 2026-10-31.csv").
export const fileRange = (name) => { const m = /(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})/.exec(name || ''); return m ? { from: m[1], to: m[2] } : {}; };

export function parseShopify(XLSX, buffer, name = '') {
  const wb = XLSX.read(buffer, { type: 'array', raw: true });
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
  const head = (grid[0] || []).map((h) => String(h).trim());
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  const missing = NEED.filter((h) => !(h in col));
  if (missing.length) throw new Error(`This doesn't look like the Shopify "Total sales by product variant" report: it has no ${missing.map((m) => `"${m}"`).join(', ')} column.`);
  const dateCol = 'Day' in col ? 'Day' : 'Month' in col ? 'Month' : null;
  if (!dateCol) throw new Error('The report has no Month or Day column. In Shopify, add Month (or Day) under Dimensions, then export again.');

  const months = {}, skipped = { contents: 0, noProduct: 0, noProductNet: 0 };
  for (const r of grid.slice(1)) {
    const get = (h) => (h in col ? r[col[h]] : '');
    const d = isoDate(get(dateCol));
    if (!d) continue;
    let sku = String(get('Product variant SKU')).trim(), title = String(get('Product title')).replace(/\s+/g, ' ').trim();
    const inBoxes = String(get('Product collection')).trim().toUpperCase() === 'BOXES', byob = BYOB.exec(sku);
    if (byob) { sku = byob[1].toUpperCase(); title = `Build your own box (${sku})`; }
    const row = { d: dateCol === 'Month' ? `${d.slice(0, 7)}-01` : d, sku, title, n: num(get('Net items sold')) };
    for (const [k, h] of Object.entries(MONEY)) row[k] = r2(num(get(h)));
    if (!sku && !title) { skipped.noProduct += row.n; skipped.noProductNet = r2(skipped.noProductNet + row.net); continue; }
    // Shopify's test products (TEST_…) are left out with the contents.
    if ((!inBoxes && !isBox(sku) && !row.gs && !row.net && !row.gsr) || /^TEST[_ ]/i.test(title)) { skipped.contents++; continue; }
    if (!sku) continue;
    const list = (months[row.d.slice(0, 7)] ||= []), same = list.find((x) => x.d === row.d && x.sku === row.sku);
    if (!same) { list.push(row); continue; }
    same.n += row.n; for (const k of Object.keys(MONEY)) same[k] = r2(same[k] + row[k]);
  }
  // Every LiB box has a LIB_COLL SKU: a file without any is from another shop.
  if (!Object.values(months).flat().some((r) => isBox(r.sku))) throw new Error('There are no Latest in Beauty boxes in this file (no SKUs starting LIB_COLL), so it looks like another shop\'s report. In Shopify, check the store name at the bottom left is Latest in Beauty, then export again.');
  const ms = Object.keys(months).sort();
  return { months, monthly: dateCol === 'Month', ...fileRange(name), first: ms[0], last: ms.at(-1), skipped };
}

// Months the upload won't fully cover: the report starts after the 1st, or (for a
// month already over) stops before its end. Each of those replaces the whole month.
export function partialMonths(parsed, today) {
  const out = [];
  if (parsed.from && parsed.from.slice(8) !== '01') out.push({ m: parsed.from.slice(0, 7), from: parsed.from });
  if (parsed.to) {
    const m = parsed.to.slice(0, 7), end = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5), 0)).toISOString().slice(0, 10);
    if (parsed.to < end && m < today.slice(0, 7)) out.push({ m, to: parsed.to });
  }
  return out;
}

// Shopify's stored rows as dashboard day rows (see pnl.js), joined to the TikTok
// figures. A Shopify box mapped to a TikTok box (map: { shopifySku: tiktokSku })
// counts as that box; an unmapped one is a box of its own, "shopify:<SKU>".
// Shopify's figures are ex VAT; the dashboard's revenue columns are incl. VAT (as
// TikTok's are), so they're grossed up at 20% - net revenue comes out as Shopify's.
// Monthly figures are dated the 1st of the month (`m` marks them).
export const shopKey = (sku, map) => map?.[sku] || `shopify:${sku}`;
export function withShopify(data, shop, map = {}) {
  const months = Object.values(shop?.months || {});
  if (!months.length) return data;
  const out = { statements: {}, daily: [], adj: [], skus: {}, ...(data || {}) };
  out.daily = [...out.daily]; out.skus = { ...out.skus };
  for (const rows of months) for (const r of rows) {
    const sku = shopKey(r.sku, map), month = r.d.endsWith('-01') && shop.index?.months?.[r.d.slice(0, 7)]?.monthly;
    out.daily.push({
      ch: 'shopify', d: r.d, sku, ...(month ? { m: 1 } : {}),
      u: Math.max(r.n, 0), r: Math.max(-r.n, 0), f: 0,
      gs: r2(r.gs * 1.2), sd: r2(r.sd * 1.2), gsr: r2(r.gsr * 1.2), ...(r.ship ? { cps: r2(r.ship * 1.2) } : {}),
    });
    const cur = out.skus[sku];
    if (!cur) out.skus[sku] = { name: r.title, d: r.d, names: [r.title] };
    else if (!cur.names.includes(r.title)) out.skus[sku] = { ...cur, names: [...cur.names, r.title] };
  }
  out.daily.sort((a, b) => a.d.localeCompare(b.d) || a.sku.localeCompare(b.sku));
  return out;
}

// The TikTok box most likely to be the same as a Shopify one - a suggestion for the
// mapping, which someone then checks and saves. Scored by the share of the Shopify
// name's words found in the TikTok name, plus a little when the two were selling in
// the same months or share an edition number, and less when their years differ (2025's
// advent calendar isn't 2026's); edition numbers (Vol 3, #6, Edition 2) mustn't clash.
// Only boxes that have sold are suggested (not free gifts). Ties go to the most recent.
// shop: { title, sku, first, last } (first/last: YYYY-MM); candidates: [[sku, names, last, first]].
const STOP = new Set(['the', 'and', 'with', 'for', 'box', 'boxes', 'beauty', 'bundle', 'worth', 'over', 'almost', 'edition', 'edit', 'kit', 'lib', 'collection', 'vol', 'volume', 'from', 'tiktok', 'exclusive']);
const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)));
const editions = (s) => new Set([...String(s).toLowerCase().matchAll(/(?:vol(?:ume)?|edition|ed|no|part)\.?\s*#?\s*(\d+)|#\s*(\d+)/g)].map((m) => m[1] || m[2]));
const yearOf = (s) => /\b20(2\d)\b/.exec(String(s))?.[1] || null;
const skuYear = (sku) => /[A-Z_](2[0-9])(?=_|$)/.exec(String(sku).replace(/^LIB_COLL_/, '_'))?.[1] || null;
export function suggest(shop, candidates) {
  const { title, sku = '', first = '', last: shopLast = '' } = typeof shop === 'string' ? { title: shop } : shop;
  const a = words(title), ed = editions(title), year = yearOf(title) || skuYear(sku);
  let best = null;
  for (const [tsku, names, last = '', tfirst = ''] of candidates) {
    if (!last) continue;
    for (const n of names) {
      const ted = editions(n);
      if (ed.size && ted.size && ![...ed].some((x) => ted.has(x))) continue;
      const b = words(n), shared = [...a].filter((w) => b.has(w)).length, base = a.size ? shared / a.size : 0;
      if (base < 0.5) continue;
      const tyear = yearOf(n) || (tfirst ? tfirst.slice(2, 4) : null);
      const overlap = first && tfirst && tfirst.slice(0, 7) <= (shopLast || first) && last.slice(0, 7) >= first;
      const sameEd = ed.size && [...ed].some((x) => ted.has(x));
      const score = base + (overlap ? 0.3 : 0) + (sameEd ? 0.3 : 0) - (year && tyear && year !== tyear ? 0.6 : 0);
      if (score >= 0.5 && (!best || score > best.score || (score === best.score && last > best.last))) best = { sku: tsku, score, last };
    }
  }
  return best?.sku || null;
}
