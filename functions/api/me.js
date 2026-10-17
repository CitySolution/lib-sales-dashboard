// GET /api/me - who is signed in, plus all the figures and box costs. Everyone who
// can sign in (the two allowed email domains) sees the same dashboard; only admins
// get the upload and cost-editing controls.
//
// The stored figures are passed through as stored text, never parsed here, so this
// stays within Cloudflare's CPU limit however much history builds up. The browser
// adds the batches together (assemble() in site/js/pnl.js).
import { identify, fail } from '../_lib/auth.js';
import { seedPending } from './seed.js';

export async function onRequestGet({ request, env }) {
  try {
    const who = await identify(request, env);
    const kv = env.LIB_DATA;
    const [indexRaw, costsRaw] = await Promise.all([kv.get('index'), kv.get('costs')]);
    const index = indexRaw ? JSON.parse(indexRaw) : null;
    const batches = index ? await Promise.all(index.batches.map((k) => kv.get(k))) : [];
    const head = JSON.stringify({ ...who, seed_pending: who.admin ? seedPending(index) : 0 });
    const body = `${head.slice(0, -1)},"costs":${costsRaw || '{"values":{},"log":[]}'},"index":${indexRaw || 'null'},"batches":[${batches.filter(Boolean).join(',')}]}`;
    return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  } catch (err) {
    return fail(err);
  }
}
