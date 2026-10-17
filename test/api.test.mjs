// Sign-in and permission checks for the API, using a local signing key in place of
// Cloudflare's: only verified @citysolution.co.uk / @latestinbeauty.com emails get
// data, only admins can change anything, and uploads only ever add new statements.
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { XLSX } from './xlsx.mjs';
import { _setJwksForTests, _setUsers } from '../functions/_lib/auth.js';
import { onRequestGet as me } from '../functions/api/me.js';
import { onRequestPost as upload } from '../functions/api/upload.js';
import { onRequestPost as costsPost } from '../functions/api/costs.js';
import { onRequestPost as seedPost } from '../functions/api/seed.js';
import { onRequestPost as dismissPost } from '../functions/api/dismiss.js';
import { onRequestPost as targetsPost } from '../functions/api/targets.js';
import seed from '../functions/_lib/seed.json' with { type: 'json' };
import seedCosts from '../functions/_lib/seed-costs.json' with { type: 'json' };
import { assemble, merge } from '../site/js/pnl.js';
import { readWorkbook, parseOrderDetails, onlyNew } from '../site/js/tiktok.js';
import { workbook, file1, file2, A } from './fixture.mjs';

const TEAM = 'https://example.cloudflareaccess.com', AUD = 'aud-123', ORIGIN = 'https://lib.example.pages.dev';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const other = await generateKeyPair('RS256');
_setJwksForTests(createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] }));
_setUsers({ admins: ['Boss@CitySolution.co.uk'] });

const store = new Map();
const kv = { get: async (k, t) => (store.has(k) ? (t === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } };
const env = { TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, LIB_DATA: kv };

const token = (email, { key = privateKey, aud = AUD, iss = TEAM, exp = '1h' } = {}) =>
  new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(key);
const call = async (fn, path, tok, { body, origin = ORIGIN, e = env, type = 'application/json' } = {}) => {
  const headers = { ...(tok ? { 'cf-access-jwt-assertion': tok } : {}), ...(body ? { 'content-type': type, origin } : {}) };
  const r = await fn({ request: new Request(`${ORIGIN}${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined }), env: e });
  return { status: r.status, body: await r.json() };
};
const payload = (rows, loaded = []) => {
  const p = onlyNew(parseOrderDetails(readWorkbook(XLSX, workbook(rows))), loaded);
  return { statements: p.statements, daily: p.daily, adj: p.adj, names: p.names, file: { name: 'income.xlsx', first: p.first, last: p.last }, version: p.version };
};
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

const admin = await token('boss@citysolution.co.uk');
const viewer = await token('someone@latestinbeauty.com');

await test('no login configured -> 503, no data', async () => {
  assert.equal((await call(me, '/api/me', admin, { e: { LIB_DATA: kv } })).status, 503);
});
await test('not signed in, forged, expired, wrong audience or issuer -> 401', async () => {
  assert.equal((await call(me, '/api/me', null)).status, 401);
  assert.equal((await call(me, '/api/me', await token('boss@citysolution.co.uk', { key: other.privateKey }))).status, 401);
  assert.equal((await call(me, '/api/me', await token('boss@citysolution.co.uk', { exp: '-1m' }))).status, 401);
  assert.equal((await call(me, '/api/me', await token('boss@citysolution.co.uk', { aud: 'other' }))).status, 401);
  assert.equal((await call(me, '/api/me', await token('boss@citysolution.co.uk', { iss: 'https://evil.cloudflareaccess.com' }))).status, 401);
});
await test('other email domains -> 403, even with a valid sign-in', async () => {
  for (const e of ['someone@gmail.com', 'x@latestinbeauty.com.evil.com', 'x@evil-citysolution.co.uk', 'x@sub.latestinbeauty.com', 'citysolution.co.uk']) {
    const r = await call(me, '/api/me', await token(e));
    assert.equal(r.status, 403, e);
    assert.ok(!('index' in r.body) && !('batches' in r.body));
  }
});
await test('allowed domains can view; only admins are admins', async () => {
  const v = await call(me, '/api/me', viewer);
  assert.equal(v.status, 200); assert.equal(v.body.admin, false); assert.equal(v.body.index, null); assert.deepEqual(v.body.batches, []);
  assert.equal(v.body.seed_pending, 0, 'viewers are never offered the initial load');
  const a = await call(me, '/api/me', admin);
  assert.equal(a.body.admin, true); assert.equal(a.body.email, 'boss@citysolution.co.uk');
});
await test('viewers cannot upload or change costs', async () => {
  assert.equal((await call(upload, '/api/upload', viewer, { body: payload(file1()) })).status, 403);
  assert.equal((await call(costsPost, '/api/costs', viewer, { body: { sku: A, entries: [] } })).status, 403);
  assert.equal(store.size, 0);
});
await test('admin changes must come from the dashboard, as JSON', async () => {
  assert.equal((await call(upload, '/api/upload', admin, { body: payload(file1()), origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(upload, '/api/upload', admin, { body: payload(file1()), type: 'text/plain' })).status, 415);
});
await test('upload adds statements; overlapping and repeat uploads only add new ones', async () => {
  const r1 = await call(upload, '/api/upload', admin, { body: payload(file1()) });
  assert.deepEqual(r1.body, { ok: true, added: 2, already: 0 });
  const index1 = store.get('index');
  // A browser that didn't filter (or a stale page) can't double-count.
  const r2 = await call(upload, '/api/upload', admin, { body: payload(file2()) });
  assert.deepEqual(r2.body, { ok: true, added: 1, already: 1 });
  assert.notEqual(store.get('index'), index1);
  const r3 = await call(upload, '/api/upload', admin, { body: payload(file2()) });
  assert.deepEqual(r3.body, { ok: true, added: 0, already: 2 });
  const m = (await call(me, '/api/me', viewer)).body;
  const d = assemble(m.index, m.batches);
  assert.equal(m.batches.length, 2, 'one batch per upload that added something');
  // Stored in batches, the figures are the same as adding the files together directly.
  const direct = merge(merge(null, payload(file1())).data, payload(file2())).data;
  assert.deepEqual(d.daily, direct.daily); assert.deepEqual(d.adj, direct.adj); assert.deepEqual(d.skus, direct.skus);
  assert.equal(Object.keys(d.statements).length, 3);
  assert.equal(d.uploads.length, 2);
  assert.equal(d.uploads[1].by, 'boss@citysolution.co.uk');
});
await test('bad upload data is refused', async () => {
  const good = payload(file1());
  const cases = [
    { ...good, statements: {} },
    { ...good, statements: { 'abc': { date: '2026-01-01', settlement: 1, rows: 1 } } },
    { ...good, daily: [{ ...good.daily[0], s: '9999' }] },
    { ...good, daily: [{ ...good.daily[0], gs: 'NaN' }] },
    { ...good, daily: [{ ...good.daily[0], sku: '<script>' }] },
    { ...good, adj: [{ ...good.adj[0], d: '2026-13-45' }] },
  ];
  const before = store.get('index');
  for (const body of cases) assert.equal((await call(upload, '/api/upload', admin, { body })).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal(store.get('index'), before);
});
await test('costs: admins set dated costs; bad values refused; changes logged', async () => {
  const entries = [{ from: '2026-02-01', brand: 3, pallet: 0.35, packaging: 2, labour: 4.5, other: 2, commission: 0.15, marketing: 0 }, { from: '2026-01-01', brand: 2.4 }];
  const r = await call(costsPost, '/api/costs', admin, { body: { sku: A, entries } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.costs.values[A].map((e) => e.from), ['2026-01-01', '2026-02-01']);
  assert.equal(r.body.costs.values[A][0].packaging, 0);
  for (const bad of [[{ from: 'soon', brand: 1 }], [{ from: '2026-01-01', brand: -1 }], [{ from: '2026-01-01', commission: 1.5 }], [{ from: '2026-01-01' }, { from: '2026-01-01' }]]) {
    assert.equal((await call(costsPost, '/api/costs', admin, { body: { sku: A, entries: bad } })).status, 400);
  }
  const c = (await call(me, '/api/me', viewer)).body.costs;
  assert.equal(c.log.length, 1); assert.equal(c.log[0].by, 'boss@citysolution.co.uk');
});
await test('initial load: admins only, each part once, adds up to the statements bundled', async () => {
  store.clear();
  assert.equal((await call(seedPost, '/api/seed', viewer, { body: { part: 0 } })).status, 403);
  assert.equal((await call(seedPost, '/api/seed', admin, { body: { part: 'x' } })).status, 400);
  const before = (await call(me, '/api/me', admin)).body;
  assert.equal(before.seed_pending, seed.length);
  let added = 0;
  for (let part = 0; part < seed.length; part++) added += (await call(seedPost, '/api/seed', admin, { body: { part } })).body.added;
  const want = new Set(seed.flatMap((p) => Object.keys(p.statements)));
  assert.equal(added, want.size);
  for (let part = 0; part < seed.length; part++) assert.equal((await call(seedPost, '/api/seed', admin, { body: { part } })).body.added, 0, 'second load adds nothing');
  const after = (await call(me, '/api/me', admin)).body;
  assert.equal(after.seed_pending, 0);
  const d = assemble(after.index, after.batches);
  if (seed.length) assert.equal(Object.keys(d.statements).length, want.size);
});
await test('cost import: admins only, fills only boxes with no costs, never overwrites', async () => {
  store.clear();
  const skus = Object.keys(seedCosts);
  assert.equal((await call(seedPost, '/api/seed', viewer, { body: { costs: true } })).status, 403);
  // One box already has costs entered by hand: it must be left alone.
  const mine = [{ from: '2026-03-01', brand: 1, pallet: 0, packaging: 0, labour: 0, other: 0, commission: 0, marketing: 0 }];
  if (skus.length) assert.equal((await call(costsPost, '/api/costs', admin, { body: { sku: skus[0], entries: mine } })).status, 200);
  assert.equal((await call(me, '/api/me', admin)).body.seed_costs, Math.max(0, skus.length - 1));
  assert.equal((await call(me, '/api/me', viewer)).body.seed_costs, 0);
  const r = await call(seedPost, '/api/seed', admin, { body: { costs: true } });
  assert.equal(r.body.costs, Math.max(0, skus.length - 1));
  assert.equal((await call(seedPost, '/api/seed', admin, { body: { costs: true } })).body.costs, 0, 'second load adds nothing');
  const c = (await call(me, '/api/me', admin)).body;
  assert.equal(c.seed_costs, 0);
  if (skus.length) {
    assert.deepEqual(c.costs.values[skus[0]], mine);
    for (const sku of skus.slice(1)) assert.deepEqual(c.costs.values[sku], seedCosts[sku]);
  }
});
await test('cost import: a commission stored as £ per box by the earlier version becomes a %', async () => {
  store.clear();
  const skus = Object.keys(seedCosts);
  // As the earlier version stored it, before the button was pressed again.
  const values = Object.fromEntries(skus.map((sku) => [sku, seedCosts[sku]]));
  values['1729000000000000009'] = [{ from: '2025-01-01', brand: 2, pallet: 0, packaging: 0, labour: 0, other: 0, commission: 0, commissionUnit: 5.35, marketing: 0 }];
  store.set('costs', JSON.stringify({ values, log: [] }));
  assert.equal((await call(me, '/api/me', admin)).body.seed_costs, 1);
  assert.equal((await call(seedPost, '/api/seed', admin, { body: { costs: true } })).body.costs, 1);
  const c = (await call(me, '/api/me', admin)).body;
  assert.equal(c.seed_costs, 0);
  const fixed = c.costs.values['1729000000000000009'][0];
  assert.ok(Math.abs(fixed.commission - 0.0535) < 1e-9); assert.ok(!('commissionUnit' in fixed)); assert.equal(fixed.brand, 2);
  for (const sku of skus) assert.deepEqual(c.costs.values[sku], seedCosts[sku], 'others untouched');
});
await test('order items and the reader version survive an upload', async () => {
  store.clear();
  const body = payload(file1());
  body.daily = [...body.daily, { s: '7001', d: '2026-01-08', sku: A, u: 0, r: 0, f: 0, x: { 'Logistics reimbursement': 12.5 } }];
  assert.equal((await call(upload, '/api/upload', admin, { body })).status, 200);
  const m = (await call(me, '/api/me', admin)).body;
  assert.equal(m.index.version, body.version);
  assert.deepEqual(m.batches[0].daily.find((r) => r.x).x, { 'Logistics reimbursement': 12.5 });
  const bad = payload(file1()); bad.daily[0].x = { 'Logistics reimbursement': 'lots' };
  assert.equal((await call(upload, '/api/upload', admin, { body: bad })).status, 400);
});
await test('rebuild: replaces figures read by an older version, only if they are just the original files', async () => {
  if (!seed.length) return;
  store.clear();
  // As stored by the earlier version: the same statements, no version on the batches.
  for (let part = 0; part < seed.length; part++) {
    const { version, ...old } = seed[part];
    assert.equal((await call(upload, '/api/upload', admin, { body: { ...old, daily: old.daily.map(({ x, ...r }) => r) } })).status, 200);
  }
  let m = (await call(me, '/api/me', admin)).body;
  assert.equal(m.index.version, 1); assert.equal(m.seed_rebuild, true); assert.equal(m.seed_pending, 0);
  assert.equal((await call(me, '/api/me', viewer)).body.seed_rebuild, false);
  assert.equal((await call(seedPost, '/api/seed', viewer, { body: { part: 0, rebuild: true } })).status, 403);
  const oldBatches = m.index.batches;
  let added = 0;
  for (let part = 0; part < seed.length; part++) added += (await call(seedPost, '/api/seed', admin, { body: { part, ...(part ? {} : { rebuild: true }) } })).body.added;
  m = (await call(me, '/api/me', admin)).body;
  assert.equal(added, Object.keys(m.index.statements).length);
  assert.equal(m.index.version, 2); assert.equal(m.seed_rebuild, false);
  for (const k of oldBatches) assert.ok(!store.has(k), 'old batches removed');
  assert.ok(m.batches.some((b) => b.daily.some((r) => r.x)), 'order items now on boxes');
  // With anything else uploaded, it refuses and changes nothing.
  store.clear();
  const { version, ...old } = seed[0];
  await call(upload, '/api/upload', admin, { body: { ...old, daily: old.daily.map(({ x, ...r }) => r) } });
  await call(upload, '/api/upload', admin, { body: { ...payload(file1()), version: undefined } });
  const before = store.get('index');
  assert.equal((await call(me, '/api/me', admin)).body.seed_rebuild, false);
  assert.equal((await call(seedPost, '/api/seed', admin, { body: { part: 0, rebuild: true } })).status, 409);
  assert.equal(store.get('index'), before);
});
await test('hiding attention items: admins only, validated, shown again, logged', async () => {
  store.clear();
  assert.equal((await call(dismissPost, '/api/dismiss', viewer, { body: { key: `margin:${A}`, until: null } })).status, 403);
  for (const body of [{ key: '<script>' }, { key: `margin:${A}`, until: 'next week' }, {}]) assert.equal((await call(dismissPost, '/api/dismiss', admin, { body })).status, 400);
  assert.equal((await call(dismissPost, '/api/dismiss', admin, { body: { key: `margin:${A}`, until: '2026-11-01' } })).status, 200);
  assert.equal((await call(dismissPost, '/api/dismiss', admin, { body: { key: 'gap:2026-01-01:2026-01-05', until: null } })).status, 200);
  let d = (await call(me, '/api/me', viewer)).body.dismissed;
  assert.deepEqual(Object.keys(d.values).sort(), ['gap:2026-01-01:2026-01-05', `margin:${A}`]);
  assert.equal(d.values[`margin:${A}`].until, '2026-11-01'); assert.equal(d.values[`margin:${A}`].by, 'boss@citysolution.co.uk');
  await call(dismissPost, '/api/dismiss', admin, { body: { key: `margin:${A}`, show: true } });
  d = (await call(me, '/api/me', viewer)).body.dismissed;
  assert.deepEqual(Object.keys(d.values), ['gap:2026-01-01:2026-01-05']);
  assert.equal(d.log.length, 3);
});
await test('targets: admins only, validated, cleared when empty, logged', async () => {
  store.clear();
  const months = { '2026-10': { rev: 150000, n: 4000, net: 50000 }, '2026-11': { rev: 200000 } };
  assert.equal((await call(targetsPost, '/api/targets', viewer, { body: { months } })).status, 403);
  for (const bad of [{ '2026-13': { rev: 1 } }, { '2026-10': { rev: -5 } }, { '2026-10': { n: 'lots' } }, { '2026-10': [1] }, null]) {
    assert.equal((await call(targetsPost, '/api/targets', admin, { body: { months: bad } })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call(targetsPost, '/api/targets', admin, { body: { months } })).status, 200);
  assert.equal((await call(targetsPost, '/api/targets', admin, { body: { months: { '2026-12': { net: -1000 } } } })).status, 200, 'a loss can be a target');
  let t = (await call(me, '/api/me', viewer)).body.targets;
  assert.deepEqual(t.values, { ...months, '2026-12': { net: -1000 } });
  await call(targetsPost, '/api/targets', admin, { body: { months: { '2026-11': null, '2026-12': {} } } });
  t = (await call(me, '/api/me', viewer)).body.targets;
  assert.deepEqual(Object.keys(t.values), ['2026-10']);
  assert.equal(t.log.length, 3); assert.equal(t.log[0].by, 'boss@citysolution.co.uk');
});
console.log(`${n} API tests passed`);
