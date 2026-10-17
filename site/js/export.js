// Excel downloads: each card's figures as sheets of real numbers and dates (not the
// rounded text on screen), so they can be explored further. Shared with the tests.
import { MONEY } from './tiktok.js';
import { COST_LINES, MARKETING, costAt } from './pnl.js';

const MONEY_Z = '"£"#,##0.00;-"£"#,##0.00';
const serial = (ms) => ms / 864e5 + 25569; // Excel's day number
export const gbp = (v) => ({ t: 'n', v: Math.round((v || 0) * 100) / 100, z: MONEY_Z });
export const pc = (v, z = '0.0%') => (Number.isFinite(v) ? { t: 'n', v, z } : '');
export const day = (d) => (d ? { t: 'n', v: serial(Date.parse(`${d.slice(0, 10)}T00:00:00Z`)), z: 'dd/mm/yyyy' } : '');
const month = (m) => ({ t: 'n', v: serial(Date.parse(`${m}-01T00:00:00Z`)), z: 'mmm yyyy' });
// A timestamp as UK clock time.
const when = (ts) => {
  const s = new Date(ts).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).replace(' ', 'T');
  return { t: 'n', v: serial(Date.parse(`${s}Z`)), z: 'dd/mm/yyyy hh:mm' };
};
const ratio = (a, b) => (b ? a / b : NaN);

// The columns for a set of totals (see `blank` in pnl.js).
const TOTALS = [
  ['Sold', (t) => t.u], ['Refunded', (t) => t.r], ['Net boxes', (t) => t.n], ['Free gift units', (t) => t.f],
  ['Revenue incl VAT', (t) => gbp(t.revInc)], ['VAT', (t) => gbp(-t.vat)], ['Net revenue', (t) => gbp(t.rev)],
  ['TikTok fees', (t) => gbp(t.fees)], ['Other TikTok items', (t) => gbp(t.other)], ['COGS', (t) => gbp(t.cogs)],
  ['Gross profit', (t) => gbp(t.gross)], ['Marketing', (t) => gbp(t.marketing)], ['Net profit', (t) => gbp(t.net)],
  ['Margin', (t) => pc(ratio(t.net, t.rev))], ['Profit per box', (t) => (t.n ? gbp(t.net / t.n) : '')],
];
const totalsHead = TOTALS.map(([h]) => h);
const totals = (t) => TOTALS.map(([, f]) => f(t));

// One row per box. name(sku) gives the box's current name; spans from saleDates().
export function boxesSheet(boxes, name, spans) {
  return [['Box', 'SKU', 'First sale', 'Last sale', ...totalsHead, 'Costs entered'],
    ...[...boxes].sort(([, a], [, b]) => b.net - a.net)
      .map(([sku, b]) => [name(sku), sku, day(spans.get(sku)?.first), day(spans.get(sku)?.last), ...totals(b), b.uncosted ? 'No' : 'Yes'])];
}

// One row per month (or day) from byMonth(); `shop` adds the shop-level items.
export function periodSheet(periods, shop = false) {
  const daily = [...periods.keys()][0]?.length === 10;
  return [[daily ? 'Day' : 'Month', ...totalsHead, ...(shop ? ['Shop-level items', 'Net profit after all costs'] : [])],
    ...[...periods].map(([k, t]) => [daily ? day(k) : month(k), ...totals(t), ...(shop ? [gbp(t.shopTotal), gbp(t.net + t.shopTotal)] : [])])];
}

// The profit and loss, line by line. `s` (from summary()) adds the shop-level items.
export function plSheet(t, s = null) {
  const lines = (o, label = (k) => k) => Object.entries(o).filter(([, v]) => Math.abs(v) >= 0.005)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [`  ${label(k)}`, gbp(v)]);
  return [['Line', '£'],
    ['Customer payments incl. VAT', gbp(t.revInc)], ['VAT', gbp(-t.vat)], ['Net revenue (ex VAT)', gbp(t.rev)],
    ['TikTok fees', ''], ...lines(t.feeLines, (k) => MONEY[k] || k), ['Total TikTok fees', gbp(t.fees)],
    ['Other TikTok items', ''], ...lines(t.otherLines), ['Total other TikTok items', gbp(t.other)],
    ['Cost of goods', ''], ...COST_LINES.map(({ k, label }) => [`  ${label}`, gbp(t.cogsLines[k])]), ['Total COGS', gbp(t.cogs)],
    ['Gross profit', gbp(t.gross)],
    [MARKETING.label, gbp(t.marketing)],
    [s ? 'Net profit from boxes' : 'Net profit', gbp(t.net)],
    ...(s ? [['Shop-level items', ''], ...lines(s.shop), ['Net profit after all costs', gbp(s.overall)]] : []),
    [], ['Boxes sold', t.u], ['Refunded or cancelled', t.r], ['Net boxes', t.n],
  ];
}

const costRow = (c) => [...COST_LINES, MARKETING].map(({ k, pct }) => (c ? (pct ? pc(c[k] || 0, '0.00%') : gbp(c[k])) : ''));
const costHead = [...COST_LINES, MARKETING].map((c) => c.label);

// The costs applying on `d` for each box in `skus`.
export function costsSheet(skus, name, spans, values, d) {
  return [['Box', 'SKU', 'First sale', 'Last sale', ...costHead, 'Since'],
    ...skus.map((sku) => { const c = costAt(values[sku], d); return [name(sku), sku, day(spans.get(sku)?.first), day(spans.get(sku)?.last), ...costRow(c), day(c?.from)]; })];
}
// Every dated cost entry.
export function costHistorySheet(values, name) {
  return [['Box', 'SKU', 'Applies from', ...costHead],
    ...Object.entries(values).sort(([a], [b]) => name(a).localeCompare(name(b))).flatMap(([sku, entries]) => entries.map((e) => [name(sku), sku, day(e.from), ...costRow(e)]))];
}
export const costLogSheet = (log, name) => [['Box', 'SKU', 'When', 'Who'], ...log.slice().reverse().map((l) => [name(l.sku), l.sku, when(l.at), l.by])];

// Attention lists (checks.js).
export const attDataSheet = (items, name) => [['Item', 'Detail', 'Box', 'SKU'], ...items.map((d) => [d.title, d.detail, d.sku ? name(d.sku) : '', d.sku || ''])];
export const attBoxSheet = (items, name) => [['Box', 'SKU', ...totalsHead, 'Refund rate'], ...items.map(({ sku, b }) => [name(sku), sku, ...totals(b), pc(ratio(b.r, b.u))])];
export const hiddenSheet = (hidden, name) => [['Item', 'Box', 'SKU', 'Hidden until', 'By', 'When'],
  ...hidden.map((h) => [h.title, h.sku ? name(h.sku) : '', h.sku || '', h.until ? day(h.until) : 'Always', h.by || '', h.at ? when(h.at) : ''])];

// Uploads and every statement loaded.
export const uploadsSheet = (uploads) => [['File', 'When', 'Who', 'Orders from', 'Orders to', 'New statements', 'Already loaded', 'Settlement added'],
  ...uploads.slice().reverse().map((u) => [u.name, when(u.at), u.by, day(u.first), day(u.last), u.added, u.already, gbp(u.settlement)])];
export const statementsSheet = (statements) => [['Statement ID', 'Statement date', 'Channel', 'Settlement'],
  ...Object.entries(statements).sort(([, a], [, b]) => a.date.localeCompare(b.date)).map(([id, s]) => [id, day(s.date), s.ch === 'tiktok' ? 'TikTok' : s.ch, gbp(s.settlement)])];

// A workbook from [[sheet name, rows], ...], with columns sized to fit.
export function book(XLSX, sheets) {
  const wb = XLSX.utils.book_new();
  for (const [title, rows] of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = (rows[0] || []).map((_, i) => ({ wch: Math.min(60, Math.max(10, ...rows.map((r) => String((r[i]?.v ?? r[i]) ?? '').length + 2))) }));
    XLSX.utils.book_append_sheet(wb, ws, title.slice(0, 31));
  }
  return wb;
}
