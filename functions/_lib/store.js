// What's kept in the LIB_DATA KV namespace:
//   index        { statements: { id: { date, settlement, rows, ch, batch } },
//                  batches: [key, ...], uploads: [...], uploaded_at }
//   batch:<...>  one upload's new statements: { key, ch, daily, adj, names }
//   costs        box costs (functions/api/costs.js)
//
// Each upload is stored as its own batch and never re-read or rewritten by the
// server, so an upload costs the same few milliseconds however much history there
// is (Cloudflare's free plan allows 10 ms of CPU per request). The browser adds the
// batches together (assemble() in site/js/pnl.js).
//
// To undo an upload: delete its batch:<...> key and remove that key from `batches`
// and its statements from `statements` in `index`.

export const emptyIndex = () => ({ statements: {}, batches: [], uploads: [], uploaded_at: null });

// Stores the statements in `incoming` that aren't already stored, as a new batch.
// incoming: { statements, daily, adj, names } as made by site/js/tiktok.js (rows carry `s`).
export async function addBatch(env, who, incoming, file, ch = 'tiktok') {
  const kv = env.LIB_DATA;
  const index = (await kv.get('index', 'json')) || emptyIndex();
  const fresh = new Set(Object.keys(incoming.statements).filter((id) => !(id in index.statements)));
  const already = Object.keys(incoming.statements).length - fresh.size;
  if (!fresh.size) return { added: 0, already };

  const now = new Date().toISOString();
  const key = `batch:${now}:${crypto.randomUUID().slice(0, 8)}`;
  const batch = { key, ch, daily: incoming.daily.filter((r) => fresh.has(r.s)), adj: incoming.adj.filter((r) => fresh.has(r.s)), names: incoming.names || {} };
  await kv.put(key, JSON.stringify(batch));

  let settlement = 0;
  for (const id of fresh) {
    index.statements[id] = { ...incoming.statements[id], ch, batch: key };
    settlement += incoming.statements[id].settlement;
  }
  index.batches.push(key);
  index.uploads = [...index.uploads, { ...file, at: now, by: who.email, added: fresh.size, already, settlement: Math.round(settlement * 100) / 100 }].slice(-500);
  index.uploaded_at = now;
  await kv.put('index', JSON.stringify(index));
  return { added: fresh.size, already };
}
