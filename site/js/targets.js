// Monthly targets against what was achieved. Shared with the server and the tests.
// targets: { 'YYYY-MM': { rev, n, net } } - any of the three may be missing.
export const METRICS = [
  { k: 'rev', label: 'Net revenue', money: true },
  { k: 'n', label: 'Boxes sold' },
  { k: 'net', label: 'Net profit after all costs', money: true },
];

// What a month from byMonth() achieved, in the targets' terms.
export const achieved = (t) => ({ rev: t?.rev || 0, n: t?.n || 0, net: (t?.net || 0) + (t?.shopTotal || 0) });

const daysIn = (m) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();

// How much of month `m` the loaded figures cover, 0-1, when the latest order loaded
// is from `dataTo` (YYYY-MM-DD). Pace is judged against this rather than today, so a
// week between uploads doesn't make the month look behind.
export function covered(m, dataTo) {
  if (!dataTo || dataTo < `${m}-01`) return 0;
  if (dataTo.slice(0, 7) > m) return 1;
  return +dataTo.slice(8, 10) / daysIn(m);
}

// One metric of one month: { actual, target, pct (of target), expected (share of the
// month covered), projected (month end at the same pace) }. Null without a target.
export function progress(actual, target, share) {
  if (target == null) return null;
  return { actual, target, pct: target ? actual / target : NaN, expected: share, projected: share ? actual / share : NaN };
}

// Months in [from, to] (YYYY-MM-DD, either may be null) that have a target, oldest
// first: [{ m, rev: progress, n: progress, net: progress }].
export function vsTargets(targets, months, from, to, dataTo) {
  return Object.keys(targets || {}).sort()
    .filter((m) => (!from || m >= from.slice(0, 7)) && (!to || m <= to.slice(0, 7)))
    .map((m) => {
      const a = achieved(months.get(m)), share = covered(m, dataTo);
      return { m, ...Object.fromEntries(METRICS.map(({ k }) => [k, progress(a[k], targets[m][k], share)])) };
    });
}
