// The TikTok file reader and the P&L maths, on a synthetic export with numbers
// worked out by hand. (test/real.test.mjs checks real exports against the Python reference.)
import assert from 'node:assert/strict';
import { XLSX } from './xlsx.mjs';
import { readWorkbook, parseOrderDetails, onlyNew } from '../site/js/tiktok.js';
import { merge, byBox, summary, byMonth, costAt, saleDates, shopItems } from '../site/js/pnl.js';
import { workbook, row, file1, file2, HEADER, A, B } from './fixture.mjs';
import { attention, count, withoutHidden } from '../site/js/checks.js';
import { book, boxesSheet, periodSheet, plSheet, costHistorySheet, statementsSheet } from '../site/js/export.js';

const close = (a, b, what) => assert.ok(Math.abs(a - b) < 0.005, `${what}: got ${a}, expected ${b}`);
const parse = (rows, st) => parseOrderDetails(readWorkbook(XLSX, workbook(rows, st)));
let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };

test('reads statements, units and shop items', () => {
  const p = parse(file1());
  assert.deepEqual(Object.keys(p.statements).sort(), ['7001', '7002']);
  close(p.statements['7001'].settlement, 84 - 15 + 3.6 - 6.9 - 4.2 - 3.5 + 168 - 30 - 13.8 - 12.5, '7001 settlement');
  const a = p.daily.filter((r) => r.sku === A);
  assert.equal(a.reduce((x, r) => x + r.u, 0), 4);
  assert.equal(a.reduce((x, r) => x + r.r, 0), 1);
  assert.deepEqual(p.adj.map((r) => r.t).sort(), ['Bill payment (negative balance)', 'FBT Warehouse service fee', 'Logistics reimbursement']);
  assert.equal(p.first, '2026-01-08'); assert.equal(p.last, '2026-02-01');
});

test('only new statements are added; re-uploading changes nothing', () => {
  const one = merge(null, parse(file1()));
  assert.deepEqual(one.added.sort(), ['7001', '7002']);
  const p2 = parse(file2());
  const fresh = onlyNew(p2, Object.keys(one.data.statements));
  assert.deepEqual(fresh.already, ['7002']);
  const two = merge(one.data, fresh);
  assert.deepEqual(two.added, ['7003']);
  // The server drops already-stored statements even if the browser sent them.
  assert.deepEqual(merge(one.data, p2).data, two.data);
  const again = merge(two.data, parse(file2()));
  assert.equal(again.added.length, 0);
  assert.deepEqual(again.data, two.data);
});

test('box name follows the latest order; old names kept', () => {
  const { data } = merge(merge(null, parse(file1())).data, parse(file2()));
  assert.equal(data.skus[B].name, 'Box B new name');
  assert.deepEqual(data.skus[B].names, ['Box B (old name)', 'Box B new name']);
});

const costs = {
  [A]: [{ from: '2026-01-01', brand: 2.4, pallet: 0.35, packaging: 2, labour: 4.5, other: 2, commission: 0.15, marketing: 1 }],
  [B]: [{ from: '2026-01-01', brand: 1, pallet: 0, packaging: 0, labour: 0, other: 0, commission: 0, marketing: 0 },
        { from: '2026-02-01', brand: 3, pallet: 0, packaging: 0, labour: 0, other: 0, commission: 0, marketing: 0 }],
};

test('P&L per box matches a hand calculation', () => {
  const { data } = merge(merge(null, parse(file1())).data, parse(file2()));
  const a = byBox(data, costs).get(A);
  // Box A: sold 4 (1+2+1 cancelled), refunded 2 (the cancelled one and a later refund) -> 2 net.
  assert.equal(a.u, 4); assert.equal(a.r, 2); assert.equal(a.n, 2);
  const revInc = 84 - 15 + 3.6 + 168 - 30 + (84 - 84 - 15 + 15) + (-84 + 15);
  close(a.revInc, revInc, 'revenue incl VAT');
  close(a.rev, revInc / 1.2, 'revenue ex VAT');
  close(a.fees, -6.9 - 4.2 - 3.5 - 13.8 + 6.9, 'fees');
  const units = 2 * (2.4 + 0.35 + 2 + 4.5 + 2);
  close(a.cogs, -units - 0.15 * revInc / 1.2, 'COGS');
  // January's warehouse fee (-12.50) shared over January's 5 boxes sold (A 4, B 1).
  close(a.other, -12.5 * 4 / 5, 'warehouse share');
  close(a.otherLines['FBT Warehouse service fee'], -10, 'warehouse line');
  close(a.gross, revInc / 1.2 + a.fees + a.other + a.cogs, 'gross');
  close(a.marketing, -2, 'marketing');
  close(a.net, a.gross - 2, 'net');
  assert.equal(a.uncosted, 0);
});

test('dated costs: each change applies from its date', () => {
  const { data } = merge(merge(null, parse(file1())).data, parse(file2()));
  const b = byBox(data, costs).get(B);
  close(b.cogsLines.brand, -1 - 3, 'Jan sale at £1, Feb sale at £3');
  assert.equal(costAt(costs[B], '2025-12-01').brand, 1, 'earliest entry covers earlier dates');
  assert.equal(byBox(data, {}).get(B).uncosted, 2, 'no costs -> flagged');
});

test('summary: shop items count, bill payments do not; settlement reconciles', () => {
  const { data } = merge(merge(null, parse(file1())).data, parse(file2()));
  const s = summary(data, costs);
  // The warehouse fee is in the boxes now; the reimbursement names no order, so stays.
  assert.deepEqual(s.shop, { 'Logistics reimbursement': 34 });
  close(s.total.otherLines['FBT Warehouse service fee'], -12.5, 'all of it, across boxes');
  close(s.overall, s.total.net + 34, 'overall');
  const stmts = Object.values(data.statements).reduce((x, t) => x + t.settlement, 0);
  close(s.total.settlement + s.shopTotal + 17.81, stmts, 'boxes + items = TikTok settlement');
  const jan = summary(data, costs, '2026-01-01', '2026-01-31');
  assert.equal(jan.boxes.get(A).r, 2, 'later refund lands in the order month');
  const months = byMonth(data, costs);
  assert.deepEqual([...months.keys()], ['2026-01', '2026-02']);
  close([...months.values()].reduce((x, m) => x + m.net + m.shopTotal, 0), s.overall, 'months add up');
});

test('first and last sale per box ignore refund-only days', () => {
  const { data } = merge(merge(null, parse(file1())).data, parse(file2()));
  const d = saleDates(data);
  assert.deepEqual(d.get(A), { first: '2026-01-08', last: '2026-01-09' }, 'the Feb refund of a Jan order is not a sale');
  assert.deepEqual(d.get(B), { first: '2026-01-30', last: '2026-02-18' });
});

test('attention: overdue upload, missing statements, refunds without sales', () => {
  const { data } = merge(merge(null, parse(file1())).data, parse(file2()));
  // Statements on 10 Jan, 3 Feb and 20 Feb: gaps of 24 and 17 days.
  const a = attention(data, {}, null, null, '2026-03-10');
  assert.deepEqual(a.data.map((d) => d.kind), ['stale', 'gap', 'gap']);
  assert.equal(attention(data, {}, null, null, '2026-02-25').data.filter((d) => d.kind === 'stale').length, 0, '5 days old is fine');
  // A refund of a sale that isn't loaded: only the refund statement.
  const refundOnly = merge(null, parse([file2()[3]])).data;
  const r = attention(refundOnly, {}, null, null, '2026-02-21').data.find((d) => d.kind === 'refunds-only');
  assert.equal(r.sku, A); assert.equal(r.n, -1);
});

test('attention: boxes with no costs, losing money, low margin, high refunds', () => {
  const { data } = merge(merge(null, parse(file1())).data, parse(file2()));
  // Box A: 4 sold, 2 refunded (50%) - but fewer than 20 sold, so not flagged for refunds.
  let a = attention(data, {}, null, null, '2026-02-21');
  assert.deepEqual(a.boxes.costs.map((x) => x.sku).sort(), [A, B].sort(), 'no costs entered');
  assert.equal(a.boxes.refunds.length, 0);
  assert.equal(a.boxes.loss.length + a.boxes.margin.length, 0, 'boxes without costs are only listed as needing costs');
  // Heavy costs on A: a loss. Light costs on B: a healthy margin, so not listed.
  a = attention(data, { [A]: [{ from: '2026-01-01', brand: 200 }], [B]: [{ from: '2026-01-01', brand: 1 }] }, null, null, '2026-02-21');
  assert.deepEqual(a.boxes.loss.map((x) => x.sku), [A]);
  assert.equal(a.boxes.costs.length, 0);
  // Margin just under 10% on B: net revenue 2 x 44/1.2 = 73.33, fees -7.22 -> 66.11 before costs.
  a = attention(data, { [A]: [{ from: '2026-01-01', brand: 1 }], [B]: [{ from: '2026-01-01', brand: 30 }] }, null, null, '2026-02-21');
  assert.deepEqual(a.boxes.margin.map((x) => x.sku), [B]);
  assert.ok(a.boxes.margin[0].margin < 0.1 && a.boxes.margin[0].margin >= 0);
  // A period with only a refund (A in late Feb) is not "losing money".
  a = attention(data, { [A]: [{ from: '2026-01-01', brand: 200 }], [B]: [{ from: '2026-01-01', brand: 1 }] }, '2026-02-19', '2026-02-28', '2026-02-21');
  assert.equal(a.boxes.loss.length, 0);
  // The period limits the box checks: in Feb only B sold.
  a = attention(data, {}, '2026-02-01', '2026-02-28', '2026-02-21');
  assert.deepEqual(a.boxes.costs.map((x) => x.sku), [B]);
  assert.equal(count(a), a.data.length + 1);
});

test('reimbursements and chargebacks go to the box(es) on their order', () => {
  const rows = [
    // One order, two boxes: A (£84) and B (£42).
    row({ st: '8001', sdate: '2026-03-02', sku: A, qty: 1, name: 'Box A', odate: '2026-03-01', oid: '5001', m: { 'Gross sales': 84 } }),
    row({ st: '8001', sdate: '2026-03-02', sku: B, qty: 1, name: 'Box B', odate: '2026-03-01', oid: '5001', m: { 'Gross sales': 42 } }),
    // Later statement: a reimbursement for that order, and a chargeback for an order not in the file.
    row({ st: '8002', sdate: '2026-03-20', type: 'Logistics reimbursement', odate: '2026-03-01', rel: '5001', adj: 30 }),
    row({ st: '8002', sdate: '2026-03-20', type: 'Chargeback', odate: '2026-02-11', rel: '4999', adj: -10 }),
  ];
  const p = parse(rows);
  const x = Object.fromEntries(p.daily.filter((r) => r.x).map((r) => [r.sku, { s: r.s, d: r.d, x: r.x }]));
  assert.deepEqual(x[A], { s: '8002', d: '2026-03-01', x: { 'Logistics reimbursement': 20 } }, 'two thirds, in the reimbursement statement, at the order date');
  assert.deepEqual(x[B].x, { 'Logistics reimbursement': 10 });
  assert.deepEqual(p.adj.map((r) => [r.t, r.a]), [['Chargeback', -10]], 'unmatched stays shop-level');
  // Statement totals still match.
  close(p.statements['8002'].settlement, 20, '8002');
  // The order's statement already loaded: the reimbursement still finds its boxes.
  const { data } = merge(merge(null, { ...p, statements: { 8001: p.statements['8001'] }, daily: p.daily.filter((r) => r.s === '8001'), adj: [] }).data, onlyNew(p, ['8001']));
  const b = byBox(data, {});
  close(b.get(A).other, 20, 'A'); close(b.get(B).other, 10, 'B');
  close(summary(data, {}).shopTotal, -10, 'only the unmatched chargeback is shop-level');
});

test('warehouse fee: shared by boxes sold in its month; months with no sales stay shop-level', () => {
  const rows = [
    row({ st: '9001', sdate: '2026-04-02', sku: A, qty: 3, odate: '2026-04-01', m: { 'Gross sales': 252 } }),
    row({ st: '9001', sdate: '2026-04-02', sku: B, qty: 1, odate: '2026-04-01', m: { 'Gross sales': 42 } }),
    row({ st: '9001', sdate: '2026-04-02', type: 'FBT Warehouse service fee', odate: '2026-04-01', adj: -8 }),
    row({ st: '9002', sdate: '2026-05-02', type: 'FBT Warehouse service fee', odate: '2026-05-01', adj: -5 }),
  ];
  const { data } = merge(null, parse(rows));
  const b = byBox(data, {});
  close(b.get(A).other, -6, 'A: 3 of 4 boxes'); close(b.get(B).other, -2, 'B: 1 of 4');
  assert.deepEqual(shopItems(data), { 'FBT Warehouse service fee': -5 }, 'May had no sales');
  const m = byMonth(data, {});
  close(m.get('2026-04').other, -8, 'April in the boxes'); close(m.get('2026-05').shopTotal, -5, 'May at shop level');
});

test('attention: hidden items drop out until their date, per issue and box', () => {
  const { data } = merge(merge(null, parse(file1())).data, parse(file2()));
  const a = attention(data, {}, null, null, '2026-03-10');
  assert.equal(a.boxes.costs.length, 2);
  const hidden = { [`costs:${A}`]: { until: '2026-03-17', by: 'x@citysolution.co.uk' }, stale: { until: null, by: 'x' }, [`loss:${B}`]: { until: null } };
  let v = withoutHidden(a, hidden, '2026-03-10');
  assert.deepEqual(v.boxes.costs.map((x) => x.sku), [B], 'A hidden, B still shown');
  assert.ok(!v.data.some((d) => d.kind === 'stale'), 'hidden for good');
  assert.equal(v.data.filter((d) => d.kind === 'gap').length, 2, 'other data items still shown');
  assert.deepEqual(v.hidden.map((h) => h.key).sort(), [`costs:${A}`, 'stale'], 'only what is currently flagged is listed as hidden');
  assert.equal(count(v), count(a) - 2);
  v = withoutHidden(a, hidden, '2026-03-18');
  assert.equal(v.boxes.costs.length, 2, 'back after the snooze ends');
});

test('refuses an incomplete file', () => {
  assert.throws(() => parse(file1(), { 7001: 999 }), /looks incomplete/);
});

test('refuses a file with an unknown money column', () => {
  const rows = file1();
  rows[0][HEADER.indexOf('Total settlement amount')] = '100'; // parts no longer add up
  assert.throws(() => parse(rows), /TikTok may have added a column/);
});

test('refuses a file that is not the income export', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a']]), 'Orders');
  assert.throws(() => readWorkbook(XLSX, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })), /no "Order details" sheet/);
  const bad = file1().map((r) => r.slice(0, 20));
  assert.throws(() => parseOrderDetails({ header: HEADER.slice(0, 20), rows: bad }), /missing column/);
});

test('reads files whose declared sheet size is wrong (as TikTok\'s are)', () => {
  // Rewrite the sheet's <dimension> tag inside the file, as TikTok's files have it.
  const zip = XLSX.CFB.read(workbook(file1()), { type: 'buffer' });
  const entry = zip.FileIndex[zip.FullPaths.findIndex((p) => p.endsWith('xl/worksheets/sheet1.xml'))];
  const xml = Buffer.from(entry.content).toString('utf8');
  assert.match(xml, /<dimension ref="A1:[A-Z]+8"/);
  entry.content = Buffer.from(xml.replace(/<dimension ref="[^"]+"/, '<dimension ref="A1:DX6"'));
  const p = parseOrderDetails(readWorkbook(XLSX, XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip' })));
  assert.equal(p.rows, 7);
});
test('Excel downloads: real numbers and dates that add up', () => {
  const { data } = merge(merge(null, parse(file1())).data, parse(file2()));
  const s = summary(data, costs), name = (sku) => `Box ${sku}`;
  const wb = book(XLSX, [['Profit and loss', plSheet(s.total, s)], ['Boxes', boxesSheet(s.boxes, name, saleDates(data))],
    ['By day', periodSheet(byMonth(data, costs, null, null, A, 10))], ['Cost history', costHistorySheet(costs, name)], ['Statements', statementsSheet(data.statements)]]);
  const back = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { cellNF: true });
  const rows = (sheet) => XLSX.utils.sheet_to_json(back.Sheets[sheet], { header: 1, raw: true });
  const pl = new Map(rows('Profit and loss').map(([k, v]) => [k, v]));
  close(pl.get('Net profit after all costs'), s.overall, 'P&L total');
  close(pl.get('  Logistics reimbursement'), 34, 'shop item line');
  assert.equal(back.Sheets['Profit and loss'].B2.w, `£${(s.total.revInc).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`, 'shown as £');
  const boxes = rows('Boxes');
  assert.deepEqual(Array.from(boxes[0].slice(0, 4)), ['Box', 'SKU', 'First sale', 'Last sale']);
  const a = boxes.find((r) => r[1] === A);
  assert.equal(back.Sheets.Boxes[`C${boxes.indexOf(a) + 1}`].w, '08/01/2026', 'first sale is a date');
  close(a[boxes[0].indexOf('Net profit')], s.boxes.get(A).net, 'box net profit');
  close(rows('By day').slice(1).reduce((x, r) => x + r[13], 0), s.boxes.get(A).net, 'days add up to the box');
  assert.equal(rows('Cost history').length, 1 + Object.values(costs).flat().length);
  assert.equal(rows('Statements').length, 1 + Object.keys(data.statements).length);
});
console.log(`${n} data tests passed`);
