// The profit-and-loss maths, shared by the page, the server and the tests.
//
// Sign convention (same as the original spreadsheet): income positive, costs negative.
//
// Per box (TikTok SKU ID - the name changes, the SKU doesn't):
//   Net revenue (ex VAT)  = (gross sales + refunds + seller discounts + their refunds
//                            + customer-paid shipping and its refunds) / 1.2
//   TikTok fees           = every other shipping and fee column, as shown by TikTok
//   Other TikTok items    = reimbursements and chargebacks on the box's orders, and its
//                           share of the FBT warehouse fee: each month's fee split across
//                           the boxes sold that month, by number sold
//   COGS                  = net units x £ per unit for each cost line, plus
//                           commission = net revenue x commission %
//   Gross profit          = net revenue + TikTok fees + other TikTok items + COGS
//   Marketing             = net units x £ per unit
//   Net profit            = gross profit + marketing
// Net units = units sold - units refunded (cancelled orders are a sale and a refund).
import { MONEY_KEYS, SHIPPING, FEES, NOT_PNL, WAREHOUSE, round2 } from './tiktok.js';

export const VAT_RATE = 0.2;
export const REVENUE_KEYS = ['gs', 'gsr', 'sd', 'sdr', 'cps', 'cpsr'];
export const FEE_KEYS = [...Object.keys(SHIPPING), ...Object.keys(FEES)].filter((k) => !REVENUE_KEYS.includes(k));

// Costs that aren't in TikTok's data, entered per box on the Costs page.
export const COST_LINES = [
  { k: 'brand', label: 'Brand contributions' },
  { k: 'pallet', label: 'Pallet fee / delivery to FBT' },
  { k: 'packaging', label: 'Packaging' },
  { k: 'labour', label: 'Fulfilment labour' },
  { k: 'other', label: 'Other COGS' },
  { k: 'commission', label: 'Commission', pct: true },
];
export const MARKETING = { k: 'marketing', label: 'Marketing spend' };
export const COST_KEYS = [...COST_LINES.map((c) => c.k), MARKETING.k];

// ---- Storing ---------------------------------------------------------------------

// Adds newly uploaded statements into the stored figures. Stored rows are one per
// day and SKU (daily) and one per day and item type (adj); `s` is dropped once merged.
// `channel` is there so Shopify can be added alongside TikTok later.
export function merge(data, incoming, channel = 'tiktok') {
  const out = {
    statements: { ...(data?.statements || {}) },
    daily: (data?.daily || []).map((r) => ({ ...r })),
    adj: (data?.adj || []).map((r) => ({ ...r })),
    skus: { ...(data?.skus || {}) },
  };
  const fresh = new Set(Object.keys(incoming.statements).filter((id) => !(id in out.statements)));
  for (const id of fresh) out.statements[id] = { ...incoming.statements[id], ch: channel };

  const dk = (r) => `${r.ch}|${r.d}|${r.sku}`;
  const daily = new Map(out.daily.map((r) => [dk(r), r]));
  for (const r of incoming.daily) {
    if (!fresh.has(r.s)) continue;
    const { s, ...row } = r;
    row.ch = channel;
    const t = daily.get(dk(row));
    if (!t) { daily.set(dk(row), row); continue; }
    for (const k of ['u', 'r', 'f', ...MONEY_KEYS]) if (row[k]) t[k] = round2((t[k] || 0) + row[k]);
    if (row.x) { t.x = { ...(t.x || {}) }; for (const [k, v] of Object.entries(row.x)) t.x[k] = round2((t.x[k] || 0) + v); }
  }
  const ak = (r) => `${r.ch}|${r.d}|${r.t}`;
  const adj = new Map(out.adj.map((r) => [ak(r), r]));
  for (const r of incoming.adj) {
    if (!fresh.has(r.s)) continue;
    const { s, ...row } = r;
    row.ch = channel;
    const t = adj.get(ak(row));
    if (t) t.a = round2(t.a + row.a); else adj.set(ak(row), row);
  }
  // Box names: keep every name a SKU has had, and the latest one.
  for (const [sku, { name, d }] of Object.entries(incoming.names || {})) {
    const cur = out.skus[sku] || { name, d, names: [] };
    const names = cur.names.includes(name) ? cur.names : [...cur.names, name];
    out.skus[sku] = d >= cur.d ? { name, d, names } : { ...cur, names };
  }
  out.daily = [...daily.values()].sort((a, b) => a.d.localeCompare(b.d) || a.sku.localeCompare(b.sku));
  out.adj = [...adj.values()].sort((a, b) => a.d.localeCompare(b.d) || a.t.localeCompare(b.t));
  return { data: out, added: [...fresh] };
}

// The figures as the page uses them, from what /api/me sends: the index and the
// stored batches (functions/_lib/store.js), added together in upload order.
export function assemble(index, batches) {
  if (!index?.batches?.length) return null;
  const byKey = new Map(batches.map((b) => [b.key, b]));
  const statementsOf = new Map();
  for (const [id, s] of Object.entries(index.statements)) {
    if (!statementsOf.has(s.batch)) statementsOf.set(s.batch, {});
    statementsOf.get(s.batch)[id] = s;
  }
  let data = null;
  for (const key of index.batches) {
    const b = byKey.get(key);
    if (b) data = merge(data, { statements: statementsOf.get(key) || {}, daily: b.daily, adj: b.adj, names: b.names }, b.ch).data;
  }
  return data && { ...data, uploads: index.uploads, uploaded_at: index.uploaded_at };
}

// ---- Costs -------------------------------------------------------------------------

// costs: { sku: [{ from: 'YYYY-MM-DD', brand, pallet, ..., commission }] }
// Each entry applies from its date until the next one; the earliest also covers
// everything before it, so entering a box's costs once covers its whole history.
export function costAt(entries, d) {
  if (!entries?.length) return null;
  let pick = entries[0];
  for (const e of entries) if (e.from <= d) pick = e;
  return pick;
}

// ---- Totals ------------------------------------------------------------------------

const blank = () => ({ u: 0, r: 0, f: 0, n: 0, gs: 0, sd: 0, sdr: 0, revInc: 0, rev: 0, vat: 0, fees: 0, feeLines: {}, other: 0, otherLines: {}, cogs: 0, cogsLines: {}, gross: 0, marketing: 0, net: 0, settlement: 0, uncosted: 0 });

// The FBT warehouse fee per box sold, per month: { 'YYYY-MM': £ per box } (negative).
// Months with fees but no boxes sold keep their fee at shop level.
export function warehouseRates(data) {
  const fee = {}, units = {};
  for (const r of data?.adj || []) if (r.t === WAREHOUSE) fee[r.d.slice(0, 7)] = (fee[r.d.slice(0, 7)] || 0) + r.a;
  for (const r of data?.daily || []) if (r.u) units[r.d.slice(0, 7)] = (units[r.d.slice(0, 7)] || 0) + r.u;
  return Object.fromEntries(Object.entries(fee).filter(([m]) => units[m]).map(([m, f]) => [m, f / units[m]]));
}

// Adds one stored day row into a running total, costing it at that day's costs.
function add(t, row, costs, rates) {
  const n = (row.u || 0) - (row.r || 0);
  const revInc = REVENUE_KEYS.reduce((a, k) => a + (row[k] || 0), 0);
  const rev = revInc / (1 + VAT_RATE);
  let fees = 0;
  for (const k of FEE_KEYS) if (row[k]) { fees += row[k]; t.feeLines[k] = (t.feeLines[k] || 0) + row[k]; }
  let other = 0;
  for (const [k, v] of Object.entries(row.x || {})) { other += v; t.otherLines[k] = (t.otherLines[k] || 0) + v; }
  const wh = (rates?.[row.d.slice(0, 7)] || 0) * (row.u || 0);
  if (wh) { other += wh; t.otherLines[WAREHOUSE] = (t.otherLines[WAREHOUSE] || 0) + wh; }
  const c = costAt(costs, row.d);
  let cogs = 0, marketing = 0;
  if (c) {
    for (const { k, pct } of COST_LINES) {
      const v = pct ? -rev * (c[k] || 0) : -n * (c[k] || 0);
      t.cogsLines[k] = (t.cogsLines[k] || 0) + v; cogs += v;
    }
    marketing = -n * (c.marketing || 0);
  } else if (n || revInc) t.uncosted += n;
  t.u += row.u || 0; t.r += row.r || 0; t.f += row.f || 0; t.n += n;
  t.gs += row.gs || 0; t.sd += row.sd || 0; t.sdr += row.sdr || 0;
  t.revInc += revInc; t.rev += rev; t.vat += revInc - rev; t.fees += fees; t.other += other; t.settlement += revInc + fees + other;
  t.cogs += cogs; t.gross += rev + fees + other + cogs; t.marketing += marketing; t.net += rev + fees + other + cogs + marketing;
}

// Prices and LiB's own discounts, incl. VAT as customers see them, per box sold (cancelled
// and refunded ones included, as their sale was). Discounts TikTok funds itself aren't in
// its export. `given` is the discounts net of those refunded.
const per = (a, b) => (b ? a / b : NaN);
export const prices = (t) => ({
  list: per(t.gs, t.u), disc: per(-t.sd, t.u), pct: per(-t.sd, t.gs), paid: per(t.gs + t.sd, t.u), given: -(t.sd + t.sdr),
});

export const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);

// Each box's first and last sale (order date of a day with units sold, not refunds).
export function saleDates(data) {
  const out = new Map();
  for (const r of data?.daily || []) {
    if (!r.u) continue;
    const t = out.get(r.sku);
    if (!t) out.set(r.sku, { first: r.d, last: r.d });
    else { if (r.d < t.first) t.first = r.d; if (r.d > t.last) t.last = r.d; }
  }
  return out;
}

// Per box for a date range: Map sku -> totals (see `blank`).
export function byBox(data, costs, from, to) {
  const out = new Map(), rates = warehouseRates(data);
  for (const row of data?.daily || []) {
    if (!inRange(row.d, from, to)) continue;
    const t = out.get(row.sku) || out.set(row.sku, blank()).get(row.sku);
    add(t, row, costs?.[row.sku], rates);
  }
  return out;
}

// Statement-level items in a range, by type: those that count towards profit and
// aren't already in the boxes (warehouse fees are, for months when boxes sold).
const shopLevel = (r, rates) => !NOT_PNL.has(r.t) && !(r.t === WAREHOUSE && r.d.slice(0, 7) in rates);
export function shopItems(data, from, to) {
  const out = {}, rates = warehouseRates(data);
  for (const r of data?.adj || []) if (inRange(r.d, from, to) && shopLevel(r, rates)) out[r.t] = (out[r.t] || 0) + r.a;
  return out;
}

// Everything for a range: boxes added up, plus the shop-level items.
export function summary(data, costs, from, to) {
  const boxes = byBox(data, costs, from, to);
  const t = blank();
  for (const b of boxes.values()) {
    for (const k of ['u', 'r', 'f', 'n', 'gs', 'sd', 'sdr', 'revInc', 'rev', 'vat', 'fees', 'other', 'cogs', 'gross', 'marketing', 'net', 'settlement', 'uncosted']) t[k] += b[k];
    for (const [k, v] of Object.entries(b.feeLines)) t.feeLines[k] = (t.feeLines[k] || 0) + v;
    for (const [k, v] of Object.entries(b.otherLines)) t.otherLines[k] = (t.otherLines[k] || 0) + v;
    for (const [k, v] of Object.entries(b.cogsLines)) t.cogsLines[k] = (t.cogsLines[k] || 0) + v;
  }
  const shop = shopItems(data, from, to);
  const shopTotal = Object.values(shop).reduce((a, v) => a + v, 0);
  return { boxes, total: t, shop, shopTotal, overall: t.net + shopTotal };
}

// Per month (YYYY-MM) in a range, for trends: Map month -> summary-like totals.
// `len` 10 gives it per day (YYYY-MM-DD) instead.
export function byMonth(data, costs, from, to, sku = null, len = 7) {
  const out = new Map(), rates = warehouseRates(data);
  for (const row of data?.daily || []) {
    if (!inRange(row.d, from, to) || (sku && row.sku !== sku)) continue;
    const m = row.d.slice(0, len);
    const t = out.get(m) || out.set(m, { ...blank(), shopTotal: 0 }).get(m);
    add(t, row, costs?.[row.sku], rates);
  }
  if (!sku) {
    for (const r of data?.adj || []) {
      if (!inRange(r.d, from, to) || !shopLevel(r, rates)) continue;
      const m = r.d.slice(0, len);
      const t = out.get(m) || out.set(m, { ...blank(), shopTotal: 0 }).get(m);
      t.shopTotal += r.a;
    }
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}
