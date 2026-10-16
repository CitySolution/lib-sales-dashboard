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
import { readWorkbook, parseOrderDetails, onlyNew } from '../site/js/tiktok.js';
import { workbook, file1, file2, A } from './fixture.mjs';

const TEAM = 'https://example.cloudflareaccess.com', AUD = 'aud-123', ORIGIN = 'https://lib.example.pages.dev';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const other = await generateKeyPair('RS256');
_setJwksForTests(createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] }));
_setUsers({ admins: ['Boss@CitySolution.co.uk'] });

const store = new Map();
const kv = { get: async (k, t) => (store.has(k) ? (t === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => { store.set(k, v); } };
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
  return { statements: p.statements, daily: p.daily, adj: p.adj, names: p.names, file: { name: 'income.xlsx', first: p.first, last: p.last } };
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
    assert.ok(!('data' in r.body));
  }
});
await test('allowed domains can view; only admins are admins', async () => {
  const v = await call(me, '/api/me', viewer);
  assert.equal(v.status, 200); assert.equal(v.body.admin, false); assert.equal(v.body.data, null);
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
  const after1 = store.get('data');
  // A browser that didn't filter (or a stale page) can't double-count.
  const r2 = await call(upload, '/api/upload', admin, { body: payload(file2()) });
  assert.deepEqual(r2.body, { ok: true, added: 1, already: 1 });
  assert.equal(store.get('data_prev'), after1);
  const r3 = await call(upload, '/api/upload', admin, { body: payload(file2()) });
  assert.deepEqual(r3.body, { ok: true, added: 0, already: 2 });
  const d = (await call(me, '/api/me', viewer)).body.data;
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
  const before = store.get('data');
  for (const body of cases) assert.equal((await call(upload, '/api/upload', admin, { body })).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal(store.get('data'), before);
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
console.log(`${n} API tests passed`);
