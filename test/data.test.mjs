// The TikTok file reader and the P&L maths, on a synthetic export with numbers
// worked out by hand. (test/real.test.mjs checks real exports against the Python reference.)
import assert from 'node:assert/strict';
import { XLSX } from './xlsx.mjs';
import { readWorkbook, parseOrderDetails, onlyNew } from '../site/js/tiktok.js';
import { merge, byBox, summary, byMonth, costAt } from '../site/js/pnl.js';
import { workbook, row, file1, file2, HEADER, A, B } from './fixture.mjs';

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
  close(a.gross, revInc / 1.2 + a.fees + a.cogs, 'gross');
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
  assert.deepEqual(s.shop, { 'FBT Warehouse service fee': -12.5, 'Logistics reimbursement': 34 });
  close(s.overall, s.total.net + 21.5, 'overall');
  const stmts = Object.values(data.statements).reduce((x, t) => x + t.settlement, 0);
  close(s.total.settlement + s.shopTotal + 17.81, stmts, 'boxes + items = TikTok settlement');
  const jan = summary(data, costs, '2026-01-01', '2026-01-31');
  assert.equal(jan.boxes.get(A).r, 2, 'later refund lands in the order month');
  const months = byMonth(data, costs);
  assert.deepEqual([...months.keys()], ['2026-01', '2026-02']);
  close([...months.values()].reduce((x, m) => x + m.net + m.shopTotal, 0), s.overall, 'months add up');
});

test('commission per box is charged on net boxes, alongside commission %', () => {
  const { data } = merge(merge(null, parse(file1())).data, parse(file2()));
  const c = { [A]: [{ from: '2026-01-01', commission: 0.1, commissionUnit: 2 }] };
  const a = byBox(data, c).get(A);
  close(a.cogsLines.commissionUnit, -2 * 2, '2 net boxes x £2');
  close(a.cogsLines.commission, -0.1 * a.rev, '10% of net revenue');
  close(a.cogs, -4 - 0.1 * a.rev, 'total');
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
console.log(`${n} data tests passed`);
