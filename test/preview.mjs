// Local preview: serves site/ and runs the real API functions with a test sign-in
// (no Cloudflare needed). Optionally preloads TikTok exports.
// usage: node test/preview.mjs [--viewer] [export.xlsx ...]   then open http://localhost:8788
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { XLSX } from './xlsx.mjs';
import { _setJwksForTests, _setUsers } from '../functions/_lib/auth.js';
import { onRequestGet as me } from '../functions/api/me.js';
import { onRequestPost as upload } from '../functions/api/upload.js';
import { onRequestPost as costs } from '../functions/api/costs.js';
import { onRequestPost as seed } from '../functions/api/seed.js';
import { readWorkbook, parseOrderDetails, onlyNew } from '../site/js/tiktok.js';

const args = process.argv.slice(2);
const viewer = args.includes('--viewer');
const files = args.filter((a) => !a.startsWith('--'));
const TEAM = 'https://preview.cloudflareaccess.com', AUD = 'preview';
const { publicKey, privateKey } = await generateKeyPair('RS256');
_setJwksForTests(createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256' }] }));
const email = viewer ? 'viewer@latestinbeauty.com' : 'admin@citysolution.co.uk';
const jwt = await new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'k' }).setIssuer(TEAM).setAudience(AUD).setIssuedAt().setExpirationTime('12h').sign(privateKey);
const store = new Map();
const env = { TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, LIB_DATA: { get: async (k, t) => (store.has(k) ? (t === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } } };
const ORIGIN = 'http://localhost:8788';
const call = (fn, path, body) => fn({ request: new Request(ORIGIN + path, { method: body ? 'POST' : 'GET', headers: { 'cf-access-jwt-assertion': jwt, 'content-type': 'application/json', origin: ORIGIN }, body }), env });

_setUsers({ admins: ['admin@citysolution.co.uk'] });
for (const f of files) {
  const loaded = Object.keys(JSON.parse(store.get('index') || '{}').statements || {});
  const p = onlyNew(parseOrderDetails(readWorkbook(XLSX, readFileSync(f))), loaded);
  const name = f.split('/').pop().replace(/^[0-9a-f]{8}-/, '');
  const r = await (await call(upload, '/api/upload', JSON.stringify({ statements: p.statements, daily: p.daily, adj: p.adj, names: p.names, file: { name, first: p.first, last: p.last }, version: p.version }))).json();
  console.log(name, r);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const routes = { '/api/me': me, '/api/upload': upload, '/api/costs': costs, '/api/seed': seed };
  if (routes[url.pathname]) {
    const body = req.method === 'POST' ? await new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); }) : undefined;
    const r = await call(routes[url.pathname], url.pathname, body);
    res.writeHead(r.status, { 'content-type': 'application/json' });
    return res.end(await r.text());
  }
  const p = join(new URL('../site', import.meta.url).pathname, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
}).listen(8788, () => console.log(`preview on ${ORIGIN} as ${email}`));
