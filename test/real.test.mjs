// Checks the JS against real TikTok exports and the Python reference.
// usage: node test/real.test.mjs ref.json export1.xlsx [export2.xlsx ...]
// (reference: python3 -I reference/reference.py export1.xlsx ... > ref.json)
// Real exports are never committed; CI runs test/data.test.mjs on a synthetic one.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { XLSX } from './xlsx.mjs';
import { readWorkbook, parseOrderDetails, onlyNew } from '../site/js/tiktok.js';
import { merge, summary, byBox } from '../site/js/pnl.js';

const [refPath, ...files] = process.argv.slice(2);
const ref = JSON.parse(readFileSync(refPath, 'utf8'));
let data = null;
for (const f of files) {
  const t = Date.now();
  const parsed = parseOrderDetails(readWorkbook(XLSX, readFileSync(f)));
  const fresh = onlyNew(parsed, Object.keys(data?.statements || {}));
  const r = merge(data, fresh);
  data = r.data;
  console.log(`${f.split('/').pop()}: ${parsed.rows} rows, ${Object.keys(parsed.statements).length} statements (${r.added.length} new), orders ${parsed.first}..${parsed.last}, ${Date.now() - t} ms`);
}
// Uploading every file again adds nothing.
for (const f of files) {
  const parsed = parseOrderDetails(readWorkbook(XLSX, readFileSync(f)));
  const r = merge(data, onlyNew(parsed, Object.keys(data.statements)));
  assert.equal(r.added.length, 0);
  assert.deepEqual(r.data.daily, data.daily);
}
console.log('re-upload adds nothing: ok');

const close = (a, b, what) => assert.ok(Math.abs(a - b) < 0.05, `${what}: JS ${a} vs Python ${b}`);
assert.equal(Object.keys(data.statements).length, ref.statements);
close(Object.values(data.statements).reduce((a, s) => a + s.settlement, 0), ref.settlement, 'total settlement');
const boxes = byBox(data, {});
for (const [sku, b] of Object.entries(ref.boxes)) {
  const j = boxes.get(sku);
  assert.ok(j, `box ${sku} missing`);
  close(j.u, b.u || 0, `${sku} units`); close(j.r, b.r || 0, `${sku} refunds`);
  close(j.rev, b.rev || 0, `${sku} revenue`); close(j.fees, b.fees || 0, `${sku} fees`);
}
assert.equal(boxes.size, Object.keys(ref.boxes).length);
const adj = {};
for (const r of data.adj) adj[r.t] = (adj[r.t] || 0) + r.a;
for (const r of data.daily) for (const [t, v] of Object.entries(r.x || {})) adj[t] = (adj[t] || 0) + v;
for (const [t, v] of Object.entries(ref.shop)) close(adj[t], v, t);
// Settlement = boxes (revenue incl VAT + fees + order items + warehouse share) + the
// remaining shop-level items + bill payments.
const s = summary(data, {});
close(s.total.settlement + s.shopTotal + (adj['Bill payment (negative balance)'] || 0), ref.settlement, 'settlement identity');
console.log(`matches Python reference: ${boxes.size} boxes, ${ref.statements} statements, settlement £${ref.settlement}`);
console.log(`stored size: ${(JSON.stringify(data).length / 1024).toFixed(0)} KB, ${data.daily.length} day rows`);
console.log('totals', Object.fromEntries(Object.entries(s.total).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, Math.round(v)])), 'shop', s.shop);
