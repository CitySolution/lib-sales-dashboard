// Builds a synthetic TikTok income export (same sheets and columns as the real one)
// in memory, so no real data is ever committed.
import { XLSX } from './xlsx.mjs';
import { MONEY } from '../site/js/tiktok.js';

export const HEADER = ['Statement date', 'Statement ID', 'Payment ID', 'Status', 'Currency', 'Type', 'Order/adjustment ID', 'SKU ID', 'Quantity', 'Product name', 'SKU name',
  'Order created date', 'Order shipment date', 'Order delivery date', 'Total settlement amount', 'Net sales', ...Object.values(MONEY).slice(0, 4),
  'Shipping', ...Object.values(MONEY).slice(4, 16), 'Fees', ...Object.values(MONEY).slice(16), 'Adjustment amount', 'Adjustment reason', 'Related order ID  ', '',
  'Customer payment', 'Customer refund', 'Order content source'];

const S = (keys) => keys.reduce((a, k) => a + (k || 0), 0);
// row: { st, sdate, type='Order', sku, qty, name, odate, m: { 'Gross sales': 84, ... }, adj }
export function row({ st, sdate, type = 'Order', sku = '/', qty = '/', name = '/', odate, m = {}, adj = 0, status = 'Paid', oid = String(Math.random()).slice(2), rel = '/' }) {
  const v = (h) => m[h] || 0;
  const net = S(Object.values(MONEY).slice(0, 4).map(v)), ship = S(Object.values(MONEY).slice(4, 16).map(v)), fees = S(Object.values(MONEY).slice(16).map(v));
  const cells = {
    'Statement date': sdate.replaceAll('-', '/'), 'Statement ID': st, 'Payment ID': '1', Status: status, Currency: 'GBP', Type: type, 'Order/adjustment ID': oid, 'Related order ID  ': rel,
    'SKU ID': sku, Quantity: String(qty), 'Product name': name, 'SKU name': 'Default', 'Order created date': odate.replaceAll('-', '/'), 'Order shipment date': '/', 'Order delivery date': '/',
    'Total settlement amount': String(Math.round((net + ship + fees + adj) * 100) / 100), 'Net sales': String(net), Shipping: String(ship), Fees: String(fees), 'Adjustment amount': String(adj),
  };
  for (const h of Object.values(MONEY)) cells[h] = String(v(h));
  return HEADER.map((h) => cells[h] ?? '');
}

// Returns an .xlsx file (Buffer). `statements` overrides the Statements sheet totals.
export function workbook(rows, statements = null) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER, ...rows]), 'Order details');
  const tot = {};
  for (const r of rows) tot[r[1]] = Math.round(((tot[r[1]] || 0) + Number(r[14])) * 100) / 100;
  Object.assign(tot, statements || {});
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Statement date', 'Statement ID', 'Payment ID', 'Status', 'Total settlement amount'], ...Object.entries(tot).map(([id, t]) => ['', id, '', 'Paid', String(t)])]), 'Statements');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// Two statements; box A is sold, refunded and discounted, box B changes its name.
export const A = '1729000000000000001', B = '1729000000000000002';
export const file1 = () => [
  row({ st: '7001', sdate: '2026-01-10', sku: A, qty: 1, name: 'Box A', odate: '2026-01-08', m: { 'Gross sales': 84, 'Seller discount': -15, 'Customer-paid shipping fee': 3.6, 'TikTok Shop commission fee': -6.9, 'Affiliate Commission': -4.2, 'Fulfilled by TikTok Shop shipping fee': -3.5 } }),
  row({ st: '7001', sdate: '2026-01-10', sku: A, qty: 2, name: 'Box A', odate: '2026-01-08', m: { 'Gross sales': 168, 'Seller discount': -30, 'TikTok Shop commission fee': -13.8 } }),
  // Cancelled before settling: sale and refund in the same statement, settles at 0.
  row({ st: '7001', sdate: '2026-01-10', sku: A, qty: 1, name: 'Box A', odate: '2026-01-09', m: { 'Gross sales': 84, 'Gross sales refund': -84, 'Seller discount': -15, 'Seller discount refund': 15 } }),
  row({ st: '7001', sdate: '2026-01-10', type: 'FBT Warehouse service fee', odate: '2026-01-09', adj: -12.5 }),
  row({ st: '7002', sdate: '2026-02-03', sku: B, qty: 1, name: 'Box B (old name)', odate: '2026-01-30', m: { 'Gross sales': 44, 'TikTok Shop commission fee': -3.61 } }),
  row({ st: '7002', sdate: '2026-02-03', type: 'Logistics reimbursement', odate: '2026-01-31', adj: 34 }),
  row({ st: '7002', sdate: '2026-02-03', type: 'Bill payment (negative balance)', odate: '2026-02-01', adj: 17.81, status: 'Pending' }),
];
// Overlaps file1 (statement 7002 again) and adds 7003: a later refund of a January order.
export const file2 = () => [
  file1()[4], file1()[5], file1()[6],
  row({ st: '7003', sdate: '2026-02-20', sku: A, qty: 1, name: 'Box A', odate: '2026-01-08', m: { 'Gross sales refund': -84, 'Seller discount refund': 15, 'TikTok Shop commission fee': 6.9 } }),
  row({ st: '7003', sdate: '2026-02-20', sku: B, qty: 1, name: 'Box B new name', odate: '2026-02-18', m: { 'Gross sales': 44, 'TikTok Shop commission fee': -3.61 } }),
];
