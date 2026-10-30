// GET /api/me - who is signed in, plus all the figures and box costs. Everyone who
// can sign in (the two allowed email domains) sees the same dashboard; only admins
// get the upload and cost-editing controls.
//
// The stored figures are passed through as stored text, never parsed here, so this
// stays within Cloudflare's CPU limit however much history builds up. The browser
// adds the batches together (assemble() in site/js/pnl.js).
import { identify, fail, ownerList } from '../_lib/auth.js';
import { seedPending, seedCostsPending, seedRebuild } from './seed.js';

export async function onRequestGet({ request, env }) {
  try {
    const who = await identify(request, env);
    const kv = env.LIB_DATA;
    const [indexRaw, costsRaw, dismissedRaw, targetsRaw] = await Promise.all([kv.get('index'), kv.get('costs'), kv.get('dismissed'), kv.get('targets')]);
    const index = indexRaw ? JSON.parse(indexRaw) : null;
    const batches = index ? await Promise.all(index.batches.map((k) => kv.get(k))) : [];
    // Who's an admin, for the Access tab: admins only.
    const access = who.admin ? { owners: ownerList(), users: (await kv.get('users', 'json')) || { admins: {}, log: [] } } : {};
    const seed = who.admin
      ? { seed_pending: seedPending(index), seed_costs: seedCostsPending(costsRaw && JSON.parse(costsRaw)), seed_rebuild: seedRebuild(index) }
      : { seed_pending: 0, seed_costs: 0, seed_rebuild: false };
    const head = JSON.stringify({ ...who, ...seed, ...access });
    const body = `${head.slice(0, -1)},"costs":${costsRaw || '{"values":{},"log":[]}'},"dismissed":${dismissedRaw || '{"values":{},"log":[]}'},"targets":${targetsRaw || '{"values":{},"log":[]}'},"index":${indexRaw || 'null'},"batches":[${batches.filter(Boolean).join(',')}]}`;
    return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  } catch (err) {
    return fail(err);
  }
}
