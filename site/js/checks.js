// What looks like it needs attention, for the Attention tab. Shared with the tests.
import { byBox, saleDates } from './pnl.js';

export const LIMITS = {
  staleDays: 7,        // latest TikTok statement older than this -> upload overdue
  gapDays: 3,          // statements this many days apart (2+ days missing) -> missing export?
  lowMargin: 0.10,     // net profit under 10% of net revenue
  refundRate: 0.10,    // 10% or more of boxes sold refunded...
  refundMinSold: 20,   // ...on at least this many sold (fewer is noise)
};

const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// Data checks look at everything loaded; box checks at the period chosen.
// Returns { data: [...], boxes: { costs, loss, margin, refunds } }, each item with
// what's needed to show and act on it.
export function attention(data, costs, from, to, today) {
  const out = { data: [], boxes: { costs: [], loss: [], margin: [], refunds: [] } };
  if (!data) return out;

  const dates = [...new Set(Object.values(data.statements).map((s) => s.date))].sort();
  const last = dates[dates.length - 1];
  if (last && days(last, today) > LIMITS.staleDays) {
    out.data.push({ kind: 'stale', key: 'stale', title: 'Upload overdue', detail: `The latest TikTok statement is from ${last}, ${days(last, today)} days ago. Download the latest income export and add it under Uploads.`, from: last, to: today });
  }
  for (let i = 1; i < dates.length; i++) {
    if (days(dates[i - 1], dates[i]) >= LIMITS.gapDays) {
      out.data.push({ kind: 'gap', key: `gap:${dates[i - 1]}:${dates[i]}`, title: 'Missing statements?', detail: `No TikTok statements between ${dates[i - 1]} and ${dates[i]}. If TikTok issued any, upload an export covering those dates.`, from: dates[i - 1], to: dates[i] });
    }
  }
  // Refunds of sales made before the earliest export loaded show as more refunds than sales.
  for (const [sku, b] of byBox(data, costs)) {
    if (b.n < 0) out.data.push({ kind: 'refunds-only', key: `refunds-only:${sku}`, sku, title: 'Refunds without their sales', detail: `${-b.n} more boxes refunded than sold. The original sales are probably in an older export that hasn't been loaded.`, n: b.n });
  }

  const sold = saleDates(data);
  for (const [sku, b] of byBox(data, costs, from, to)) {
    if (!b.u && !b.r) continue;
    const margin = b.rev ? b.net / b.rev : NaN;
    if (b.uncosted) out.boxes.costs.push({ key: `costs:${sku}`, sku, b, last: sold.get(sku)?.last });
    // Profit checks need boxes actually sold; refund-only periods are in the data checks.
    else if (b.n <= 0) { /* nothing sold net */ }
    else if (b.net < 0) out.boxes.loss.push({ key: `loss:${sku}`, sku, b, margin });
    else if (b.rev > 0 && margin < LIMITS.lowMargin) out.boxes.margin.push({ key: `margin:${sku}`, sku, b, margin });
    if (b.u >= LIMITS.refundMinSold && b.r / b.u >= LIMITS.refundRate) out.boxes.refunds.push({ key: `refunds:${sku}`, sku, b, rate: b.r / b.u });
  }
  out.boxes.costs.sort((x, y) => y.b.rev - x.b.rev);
  out.boxes.loss.sort((x, y) => x.b.net - y.b.net);
  out.boxes.margin.sort((x, y) => x.margin - y.margin);
  out.boxes.refunds.sort((x, y) => y.rate - x.rate);
  return out;
}

export const GROUPS = { costs: 'No costs entered', loss: 'Losing money', margin: 'Low margin', refunds: 'High refunds' };

// Items someone has hidden (dismissed: { key: { until: 'YYYY-MM-DD' | null, by, at } })
// are taken out until `until` (or for good when it's null). Returns the attention list
// without them, and what's hidden: [{ key, title, sku, until, by, at }].
export function withoutHidden(a, dismissed, today) {
  const on = (key) => { const d = dismissed?.[key]; return d && (!d.until || d.until >= today) ? d : null; };
  const hidden = [];
  const keep = (item, title) => { const d = on(item.key); if (d) hidden.push({ key: item.key, title, sku: item.sku, ...d }); return !d; };
  return {
    data: a.data.filter((d) => keep(d, d.title)),
    boxes: Object.fromEntries(Object.entries(a.boxes).map(([g, list]) => [g, list.filter((x) => keep(x, GROUPS[g]))])),
    hidden,
  };
}

export const count = (a) => a.data.length + Object.values(a.boxes).reduce((n, l) => n + l.length, 0);
