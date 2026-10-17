// Reads a TikTok Shop "income" export (Seller Center → Finance → Statements → Export)
// and turns its "Order details" sheet into the totals the dashboard stores.
//
// Each row belongs to one settlement statement. Statements are settled and never
// change, so a statement is the unit of "already loaded": a file can overlap earlier
// uploads and only the statements not seen before are added. (Row IDs alone can't be
// used - an order and its refund can share every ID within one statement.)
//
// Runs in the browser (via SheetJS, site/vendor/xlsx.full.min.js) and in the tests.

// Money columns kept, with the short key they're stored under. Every row satisfies
//   Total settlement = Net sales + Shipping + Fees + Adjustment amount
// and each of those is the sum of the columns listed under it, so nothing is lost.
// If TikTok adds a column, that check fails and the upload is refused rather than
// quietly dropping money.
export const SALES = { gs: 'Gross sales', gsr: 'Gross sales refund', sd: 'Seller discount', sdr: 'Seller discount refund' };
export const SHIPPING = {
  tsf: 'TikTok Shop shipping fee', fbt: 'Fulfilled by TikTok Shop shipping fee',
  cps: 'Customer-paid shipping fee', cpsr: 'Customer-paid shipping fee refund',
  tsi: 'TikTok Shop shipping incentive', tsir: 'TikTok Shop shipping incentive refund',
  sfs: 'Shipping fee subsidy', rsf: 'Return shipping fee', sfd: 'Shipping fee discount',
  ffs: 'Fee for FBT free shipping', rsl: 'Return shipping label fee', rsr: 'Return shipping fee reimbursement',
};
export const FEES = {
  com: 'TikTok Shop commission fee', aff: 'Affiliate Commission', afp: 'Affiliate partner commission',
  afa: 'Affiliate Shop Ads commission', cfp: 'Co-funded promotion (seller-funded)', vat: 'VAT',
  ssf: 'Shipping service fee', afd: 'Affiliate commission deposit', afr: 'Affiliate commission refund',
  apa: 'Affiliate Partner shop ads commission', crf: 'Campaign resource fee', spf: 'Smart Promotion fee',
  csf: 'Campaign service fee', msp: 'Managed service plan (Per order fee)', gmv: 'GMV Max ad fee',
  apv: 'Auto-post shoppable video commission fee',
};
export const MONEY = { ...SALES, ...SHIPPING, ...FEES };
export const MONEY_KEYS = Object.keys(MONEY);

// Statement-level items that aren't income or costs: a "bill payment" is LIB topping
// up a negative TikTok balance, i.e. money moving, not a cost.
export const NOT_PNL = new Set(['Bill payment (negative balance)']);
// Items that name the order they're about, so they can go against its box(es).
export const BY_ORDER = new Set(['Logistics reimbursement', 'TikTok Shop reimbursement', 'Chargeback']);
// TikTok's daily storage charge: no order, shared across boxes sold (site/js/pnl.js).
export const WAREHOUSE = 'FBT Warehouse service fee';
// Stored figures made by this version link order items to boxes; see /api/seed.
export const PARSER_VERSION = 2;

const REQUIRED = ['Statement date', 'Statement ID', 'Type', 'SKU ID', 'Quantity', 'Product name',
  'Order created date', 'Total settlement amount', 'Net sales', 'Shipping', 'Fees', 'Adjustment amount', ...Object.values(MONEY)];

const num = (v) => {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(/[£,\s]/g, '');
  if (s === '' || s === '/') return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`"${v}" is not an amount`);
  return n;
};
export const round2 = (n) => Math.round(n * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
// TikTok writes dates as 2026/06/27; an Excel re-save may turn them into real dates.
const day = (v) => {
  if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(String(v ?? '').trim());
  return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
};
const text = (v) => String(v ?? '').trim();

// The "Order details" sheet as { header, rows } of raw cell values, plus the
// statement totals from the "Statements" sheet (used to check the file is complete).
export function readWorkbook(XLSX, buffer) {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true, UTC: true, dense: true });
  const grid = (name) => {
    const ws = wb.Sheets[name];
    if (!ws) return null;
    // TikTok's files declare a sheet size of 6 rows whatever they hold, so work the
    // real size out from the cells that are there.
    const rows = ws['!data'] || [];
    const cols = Math.max(1, ...rows.map((r) => r?.length || 0));
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length - 1), c: cols - 1 } });
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: false, UTC: true });
  };
  const od = grid('Order details');
  if (!od) throw new Error('This file has no "Order details" sheet - is it the TikTok Shop income export (Finance → Statements → Export)?');
  const st = grid('Statements');
  const statements = {};
  if (st?.length) {
    const h = st[0].map(text), id = h.indexOf('Statement ID'), tot = h.indexOf('Total settlement amount');
    if (id >= 0 && tot >= 0) for (const r of st.slice(1)) if (text(r[id])) statements[text(r[id])] = num(r[tot]);
  }
  return { header: od[0].map(text), rows: od.slice(1), statements };
}

// Turns the sheet into per-statement totals:
//   statements  { id: { date, settlement, rows } }
//   daily       one row per statement, order date and SKU: units sold (u), units
//               refunded (r), free units (f, gifts with purchase) and the money columns
//               and `x`: reimbursements/chargebacks for those orders { type: amount }
//   adj         statement-level items not tied to a box (FBT warehouse fees, and any
//               reimbursement/chargeback whose order isn't in the file), per
//               statement, date and type
// An item that names its order (BY_ORDER) is put against that order's box(es) when the
// order is anywhere in the file - including statements already loaded, so exporting
// with some overlap lets a late reimbursement find its order. An order with several
// boxes is split by their gross sales (or quantity, for free items).
//   names       SKU ID -> { name, d } (product name on the latest order seen)
// Every statement is taken whatever its status: a statement that went negative stays
// "Pending" for good (a bill payment covers it), but its orders and fees are real.
export function parseOrderDetails({ header, rows, statements: sheetTotals = {} }) {
  const col = Object.fromEntries(header.map((h, i) => [h, i]).filter(([h]) => h).reverse());
  const missing = REQUIRED.filter((h) => !(h in col));
  if (missing.length) throw new Error(`The "Order details" sheet is missing column(s): ${missing.join(', ')}. Has TikTok changed the export?`);
  const get = (r, h) => r[col[h]];

  const statements = {}, daily = new Map(), adj = new Map(), names = {};
  const orders = new Map(), pending = []; // order ID -> [{ sku, d, w }]; items waiting for their order
  let first = null, last = null, count = 0;
  rows.forEach((r, i) => {
    const sid = text(get(r, 'Statement ID'));
    if (!sid) return;
    const line = i + 2;
    const sdate = day(get(r, 'Statement date'));
    const odate = day(get(r, 'Order created date')) || sdate;
    if (!sdate) throw new Error(`Row ${line}: statement date "${get(r, 'Statement date')}" isn't a date`);
    const settle = num(get(r, 'Total settlement amount'));
    const m = Object.fromEntries(MONEY_KEYS.map((k) => [k, num(get(r, MONEY[k]))]));
    const part = (keys) => keys.reduce((a, k) => a + m[k], 0);
    const adjAmt = num(get(r, 'Adjustment amount'));
    const checks = [
      ['Net sales', num(get(r, 'Net sales')), part(Object.keys(SALES))],
      ['Shipping', num(get(r, 'Shipping')), part(Object.keys(SHIPPING))],
      ['Fees', num(get(r, 'Fees')), part(Object.keys(FEES))],
      ['Total settlement amount', settle, part(MONEY_KEYS) + adjAmt],
    ];
    for (const [what, given, sum] of checks) {
      if (Math.abs(given - sum) > 0.011) throw new Error(`Row ${line}: ${what} is ${given} but its parts add up to ${round2(sum)}. TikTok may have added a column this dashboard doesn't know yet.`);
    }

    const s = statements[sid] || (statements[sid] = { date: sdate, settlement: 0, rows: 0 });
    s.settlement += settle; s.rows += 1; count += 1;
    if (!first || odate < first) first = odate;
    if (!last || odate > last) last = odate;

    const type = text(get(r, 'Type'));
    if (type === 'Order') {
      const sku = text(get(r, 'SKU ID'));
      if (!/^\d{1,30}$/.test(sku)) throw new Error(`Row ${line}: SKU ID "${sku}" isn't a TikTok SKU ID`);
      const qty = num(get(r, 'Quantity'));
      const key = `${sid}|${odate}|${sku}`;
      const t = daily.get(key) || daily.set(key, { s: sid, d: odate, sku, u: 0, r: 0, f: 0 }).get(key);
      if (m.gs > 0) t.u += qty;
      if (m.gsr < 0) t.r += qty;
      if (m.gs === 0 && m.gsr === 0) t.f += qty;
      for (const k of MONEY_KEYS) if (m[k]) t[k] = (t[k] || 0) + m[k];
      const name = text(get(r, 'Product name'));
      if (name && (!names[sku] || odate >= names[sku].d)) names[sku] = { name, d: odate };
      const oid = text(get(r, 'Order/adjustment ID'));
      if (oid && m.gs >= 0) {
        const lines = orders.get(oid) || orders.set(oid, []).get(oid);
        const l = lines.find((x) => x.sku === sku && x.d === odate);
        if (l) { l.gs += Math.max(m.gs, 0); l.qty += Math.max(qty, 0); } else lines.push({ sku, d: odate, gs: Math.max(m.gs, 0), qty: Math.max(qty, 0) });
      }
    } else {
      // Not tied to a box. Its money is all in "Adjustment amount" (checked above).
      if (Math.abs(part(MONEY_KEYS)) > 0.011) throw new Error(`Row ${line}: a "${type}" line has order amounts - this dashboard doesn't expect that`);
      const rel = 'Related order ID' in col ? text(get(r, 'Related order ID')) : '';
      if (BY_ORDER.has(type) && /^\d+$/.test(rel)) { pending.push({ sid, odate, type, a: adjAmt, rel }); return; }
      const key = `${sid}|${odate}|${type}`;
      const t = adj.get(key) || adj.set(key, { s: sid, d: odate, t: type, a: 0 }).get(key);
      t.a += adjAmt;
    }
  });

  // Order items: against the order's box(es), in the item's statement, at the order's date.
  for (const p of pending) {
    const lines = orders.get(p.rel);
    if (!lines) {
      const key = `${p.sid}|${p.odate}|${p.type}`;
      const t = adj.get(key) || adj.set(key, { s: p.sid, d: p.odate, t: p.type, a: 0 }).get(key);
      t.a += p.a;
      continue;
    }
    const w = (l) => (lines.some((x) => x.gs > 0) ? l.gs : l.qty || 1);
    const total = lines.reduce((a, l) => a + w(l), 0);
    for (const l of lines) {
      const key = `${p.sid}|${l.d}|${l.sku}`;
      const t = daily.get(key) || daily.set(key, { s: p.sid, d: l.d, sku: l.sku, u: 0, r: 0, f: 0 }).get(key);
      t.x = t.x || {};
      t.x[p.type] = (t.x[p.type] || 0) + (p.a * w(l)) / total;
    }
  }

  for (const [id, s] of Object.entries(statements)) {
    s.settlement = round2(s.settlement);
    // The Statements sheet total must match the rows, or the export is incomplete.
    if (id in sheetTotals && Math.abs(sheetTotals[id] - s.settlement) > 0.011) {
      throw new Error(`Statement ${id} (${s.date}): its rows add up to £${s.settlement} but the Statements sheet says £${sheetTotals[id]}. The file looks incomplete - download it again.`);
    }
  }
  const tidy = (o) => {
    for (const k of Object.keys(o)) if (typeof o[k] === 'number') o[k] = round2(o[k]);
    if (o.x) for (const k of Object.keys(o.x)) o.x[k] = round2(o.x[k]);
    return o;
  };
  return {
    version: PARSER_VERSION, statements, names, rows: count, first, last,
    daily: [...daily.values()].map(tidy), adj: [...adj.values()].map(tidy),
  };
}

// Keeps only the statements not already loaded.
export function onlyNew(parsed, loadedIds) {
  const seen = new Set(loadedIds);
  const keep = (x) => !seen.has(x.s);
  const statements = Object.fromEntries(Object.entries(parsed.statements).filter(([id]) => !seen.has(id)));
  return { ...parsed, statements, daily: parsed.daily.filter(keep), adj: parsed.adj.filter(keep), already: Object.keys(parsed.statements).filter((id) => seen.has(id)) };
}
