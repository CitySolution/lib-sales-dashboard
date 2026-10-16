// GET /api/me - who is signed in, plus all the figures and box costs. Everyone who
// can sign in (the two allowed email domains) sees the same dashboard; only admins
// get the upload and cost-editing controls.
import { identify, json, fail } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  try {
    const who = await identify(request, env);
    const [data, costs] = await Promise.all([env.LIB_DATA.get('data', 'json'), env.LIB_DATA.get('costs', 'json')]);
    return json({ ...who, data, costs: costs || { values: {}, log: [] } });
  } catch (err) {
    return fail(err);
  }
}
