// The dashboard page. All figures come from /api/me; the maths is in pnl.js.
import { summary, byMonth, assemble, saleDates, inRange, prices, COST_LINES, MARKETING, COST_KEYS, costAt } from './pnl.js';
import { MONEY, readWorkbook, parseOrderDetails, onlyNew } from './tiktok.js';
import { attention, withoutHidden, count as attCount, LIMITS, GROUPS } from './checks.js';
import { METRICS, achieved, covered, vsTargets } from './targets.js';
import { book, targetsSheet, boxesSheet, periodSheet, plSheet, costsSheet, costHistorySheet, costLogSheet, attDataSheet, attBoxSheet, hiddenSheet, uploadsSheet, statementsSheet, pricePeriodSheet, priceBoxSheet } from './export.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const gbp0 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
const gbp2 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('en-GB');
const money = (v, dp = 0) => { const s = (dp ? gbp2 : gbp0).format(Math.abs(v)); return v < -0.004 ? `−${s}` : s; };
const cell = (v, dp = 0) => `<td${v < -0.004 ? ' class="neg"' : ''}>${money(v, dp)}</td>`;
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '–');
const rate = (v) => (Number.isFinite(v) ? `${+(v * 100).toFixed(2)}%` : '–'); // a cost rate as entered: 15%, 5.35%
const ratio = (a, b) => (b ? a / b : NaN);
const dmy = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const monthName = (m) => new Date(`${m}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });

let state = null; // { email, admin, data, costs }
let pending = [];  // parsed files waiting to be added
let sort = { key: 'net', dir: -1 };
let selected = null;

const api = async (path, body) => {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: `The server answered ${r.status}.` }));
  if (!r.ok) throw new Error(j.error || `The server answered ${r.status}.`);
  return j;
};
const setStatus = (msg, err = false) => { $('status').textContent = msg; $('status').className = `status${err ? ' err' : ''}`; };

// ---- Periods -----------------------------------------------------------------------
const iso = (d) => d.toISOString().slice(0, 10);
const ukToday = () => new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) + 'T00:00:00Z');
function range() {
  const p = $('period').value, t = ukToday(), y = t.getUTCFullYear(), m = t.getUTCMonth();
  const D = (yy, mm, dd) => iso(new Date(Date.UTC(yy, mm, dd)));
  const q = Math.floor(m / 3) * 3;
  switch (p) {
    case 'mtd': return [D(y, m, 1), iso(t)];
    case 'lm': return [D(y, m - 1, 1), D(y, m, 0)];
    case 'qtd': return [D(y, q, 1), iso(t)];
    case 'lq': return [D(y, q - 3, 1), D(y, q, 0)];
    case 'ytd': return [D(y, 0, 1), iso(t)];
    case 'l12': return [D(y, m - 11, 1), iso(t)];
    case 'custom': return [$('from').value || null, $('to').value || null];
    default: return [null, null];
  }
}

// ---- Sorting any list table --------------------------------------------------------
// Tap a heading to sort by that column, again to reverse. Works from what the cells
// show, or a cell's data-v when the text doesn't sort (dates: give an ISO date).
// Empty cells ('–') always go last. `limit` shows only the first n rows after sorting.
const tableSort = {};
function cellValue(td) {
  const v = (td?.dataset.v ?? td?.textContent ?? '').trim();
  if (!v || v === '–') return null;
  const n = v.replace(/[£,%\s]/g, '').replace('−', '-');
  if (/^-?\d+(\.\d+)?$/.test(n)) return +n;
  return v.toLowerCase();
}
function sortTable(id, limit = 0) {
  const t = $(id), s = tableSort[id], body = t.tBodies[0];
  if (!body) return;
  t.classList.add('sortable');
  [...(t.tHead?.rows[0]?.cells || [])].forEach((th, i) => (s?.col === i ? th.setAttribute('aria-sort', s.dir > 0 ? 'ascending' : 'descending') : th.removeAttribute('aria-sort')));
  const rows = [...body.rows];
  if (s && rows.every((r) => r.cells.length > s.col)) {
    rows.sort((a, b) => {
      const x = cellValue(a.cells[s.col]), y = cellValue(b.cells[s.col]);
      if (x == null || y == null) return (x == null) - (y == null);
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * s.dir;
    }).forEach((r) => body.append(r));
  }
  if (limit) rows.forEach((r) => { r.hidden = [...body.rows].indexOf(r) >= limit; });
}
function sortable(id, limit = 0) {
  $(id).addEventListener('click', (e) => {
    const th = e.target.closest('thead th');
    if (!th) return;
    const col = th.cellIndex, cur = tableSort[id];
    const sample = cellValue($(id).tBodies[0]?.rows[0]?.cells[col]);
    tableSort[id] = { col, dir: cur?.col === col ? -cur.dir : typeof sample === 'string' ? 1 : -1 };
    sortTable(id, limit);
  });
}

// ---- Rendering ---------------------------------------------------------------------
const boxName = (sku) => state.data?.skus?.[sku]?.name || `SKU ${sku}`;
const profitPer = (b) => ratio(b.net, b.n);

function render() {
  const [from, to] = range();
  $('custom').hidden = $('period').value !== 'custom';
  $('range').textContent = from || to ? `${dmy(from) || 'start'} – ${dmy(to) || 'latest'} · by order date` : 'All orders loaded · by order date';
  const s = summary(state.data, state.costs.values, from, to);
  renderSummary(s, from, to);
  renderTargets(from, to);
  renderBoxes(s);
  renderPrices(s, from, to);
  if (selected) renderBox(selected, s, from, to);
  renderCosts();
  renderAttention(from, to);
  renderUploads();
  renderAccess();
}

function tile(label, value, sub = '', hero = false) {
  return `<div class="card tile${hero ? ' hero-tile' : ''}"><span class="lab">${label}</span><span class="big">${value}</span><span class="sub">${sub}</span></div>`;
}

// A margin line in a P&L: % of net revenue (ex VAT). `extra` pads the box P&L's third column.
const pctRow = (label, v, extra = '') => `<tr class="pct"><td>${label}</td><td${v < 0 ? ' class="neg"' : ''}>${pct(v)}</td>${extra}</tr>`;
function renderSummary(s, from, to) {
  const t = s.total;
  const missing = [...s.boxes].filter(([, b]) => b.uncosted).map(([sku]) => sku);
  $('uncosted').hidden = !missing.length;
  $('uncosted').innerHTML = missing.length ? `<b>${missing.length} box${missing.length > 1 ? 'es have' : ' has'} no costs entered</b>, so ${missing.length > 1 ? 'their' : 'its'} profit is overstated: ${missing.slice(0, 4).map((k) => esc(boxName(k))).join(', ')}${missing.length > 4 ? '…' : ''}. <a href="#costs">Enter costs</a>.` : '';
  $('tiles').innerHTML = [
    tile('Net profit after all costs', money(s.overall), `${pct(ratio(s.overall, t.rev))} of net revenue`, true),
    tile('Net revenue (ex VAT)', money(t.rev), `${money(t.revInc)} incl. VAT`),
    tile('Boxes sold', int.format(t.n), `${int.format(t.u)} sold − ${int.format(t.r)} refunded/cancelled`),
    tile('Profit per box', Number.isFinite(profitPer(t)) ? money(profitPer(t), 2) : '–', `average revenue ${Number.isFinite(ratio(t.rev, t.n)) ? money(ratio(t.rev, t.n), 2) : '–'} per box`),
    tile('TikTok fees', money(t.fees), `${pct(ratio(-t.fees, t.rev))} of net revenue`),
    tile('Cost of goods', money(t.cogs), `${pct(ratio(-t.cogs, t.rev))} of net revenue`),
    tile('Gross profit', money(t.gross), `${pct(ratio(t.gross, t.rev))} margin`),
    tile('Shop-level items', money(s.shopTotal), 'warehouse fees, reimbursements…'),
  ].join('');

  const months = byMonth(state.data, state.costs.values, from, to);
  $('legend').innerHTML = '<span><i style="background:var(--s1)"></i>Net revenue</span><span><i style="background:var(--s2)"></i>Net profit</span>';
  chart($('chart'), [...months].map(([m, v]) => ({ label: monthName(m), a: v.rev, b: v.net + v.shopTotal, tip: `<b>${monthName(m)}</b>Net revenue ${money(v.rev)}<br>Net profit ${money(v.net + v.shopTotal)}<br>Boxes ${int.format(v.n)}` })));

  const rows = [...s.boxes].filter(([, b]) => b.u || b.r).sort(([, a], [, b]) => b.net - a.net);
  const head = '<thead><tr><th>Box</th><th>Boxes</th><th>Net revenue</th><th>Net profit</th><th>Margin</th><th>Per box</th></tr></thead>';
  const line = ([sku, b]) => `<tr class="click${b.uncosted ? ' missing' : ''}" data-sku="${sku}"><td>${esc(boxName(sku))}</td><td>${int.format(b.n)}</td>${cell(b.rev)}${cell(b.net)}<td>${pct(ratio(b.net, b.rev))}</td>${Number.isFinite(profitPer(b)) ? cell(profitPer(b), 2) : '<td>–</td>'}</tr>`;
  $('top').innerHTML = head + `<tbody>${rows.map(line).join('') || '<tr><td colspan="6" class="muted">No sales in this period.</td></tr>'}</tbody>`;
  sortTable('top', 10);

  const shop = Object.entries(s.shop).sort(([a], [b]) => a.localeCompare(b));
  $('pl').innerHTML = `<tbody>
    <tr><td>Net revenue (ex VAT)</td>${cell(t.rev)}</tr>
    <tr><td>TikTok fees</td>${cell(t.fees)}</tr>
    <tr><td>Other TikTok items</td>${cell(t.other)}</tr>
    <tr><td>Cost of goods</td>${cell(t.cogs)}</tr>
    <tr class="sum"><td>Gross profit</td>${cell(t.gross)}</tr>
    ${pctRow('GP %', ratio(t.gross, t.rev))}
    <tr><td>Marketing</td>${cell(t.marketing)}</tr>
    <tr class="sum"><td>Net profit from boxes</td>${cell(t.net)}</tr>
    ${pctRow('Net profit from boxes %', ratio(t.net, t.rev))}
    ${shop.map(([k, v]) => `<tr><td>${esc(k)}</td>${cell(v)}</tr>`).join('')}
    <tr class="total"><td>Net profit after all costs</td>${cell(s.overall)}</tr>
    ${pctRow('Net profit after all costs %', ratio(s.overall, t.rev))}</tbody>`;
}

// ---- Targets -----------------------------------------------------------------------
// Monthly targets (functions/api/targets.js) against what was achieved. Pace is judged
// up to the latest order loaded, not today.
const fmtMetric = (k, v) => (METRICS.find((x) => x.k === k).money ? money(v) : int.format(Math.round(v)));
const lastOrder = () => state.data?.daily?.at(-1)?.d || null;
const onPace = (p) => p.pct >= p.expected - 0.005;
function renderTargets(from, to) {
  const T = state.targets.values, dataTo = lastOrder();
  $('targets-set').hidden = !state.admin;
  const months = byMonth(state.data, state.costs.values);
  // The bars: the latest month of the period with figures loaded.
  const m = [to, dataTo].filter(Boolean).sort()[0]?.slice(0, 7);
  $('targets-title').textContent = m ? `Targets · ${new Date(`${m}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}` : 'Targets';
  const t = m && T[m], share = m ? covered(m, dataTo) : 0, a = achieved(months.get(m));
  $('target-bars').innerHTML = !t
    ? `<p class="muted">${Object.keys(T).length ? 'No targets set for this month.' : 'No targets set yet.'}${state.admin ? ' Tap <b>Set targets</b> to add them.' : ''}</p>`
    : METRICS.filter(({ k }) => t[k] != null).map(({ k, label }) => {
      const p = { actual: a[k], target: t[k], pct: t[k] ? a[k] / t[k] : NaN, expected: share };
      const w = Math.max(0, Math.min(100, (p.pct || 0) * 100));
      const pace = share < 1 && share > 0 ? `On pace for ${fmtMetric(k, a[k] / share)} (${pct(a[k] / share / t[k])} of target)` : share >= 1 ? (p.pct >= 1 ? 'Target met' : 'Target missed') : 'No figures loaded for this month yet';
      return `<div class="tbar"><div class="tbar-top"><span>${label}</span><span><b>${fmtMetric(k, a[k])}</b> of ${fmtMetric(k, t[k])} · ${pct(p.pct)}</span></div>
        <div class="track" title="The tick is where the month's figures so far should be"><div class="fill${onPace(p) ? '' : ' behind'}" style="width:${w}%"></div>${share > 0 && share < 1 ? `<div class="pace" style="left:${share * 100}%"></div>` : ''}</div>
        <div class="muted small">${pace}</div></div>`;
    }).join('');
  const rows = vsTargets(T, months, from, to, dataTo);
  const tot = Object.fromEntries(METRICS.map(({ k }) => [k, rows.filter((r) => r[k]).reduce((x, r) => ({ actual: x.actual + r[k].actual, target: x.target + r[k].target }), { actual: 0, target: 0 })]));
  // Green or red by pace; the total mixes finished and unfinished months, so isn't coloured.
  const cells = (p, k) => (p ? `<td>${fmtMetric(k, p.actual)}</td><td>${fmtMetric(k, p.target)}</td><td${p.expected == null ? '' : ` class="${onPace(p) ? 'ok' : 'neg'}"`}>${pct(p.pct)}</td>` : '<td>–</td><td>–</td><td>–</td>');
  $('targets').hidden = !rows.length;
  $('targets').innerHTML = `<thead><tr><th>Month</th>${METRICS.map(({ label }) => `<th>${label}</th><th>Target</th><th>%</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr><td data-v="${r.m}">${monthName(r.m)}</td>${METRICS.map(({ k }) => cells(r[k], k)).join('')}</tr>`).join('')}</tbody>
    ${rows.length > 1 ? `<tfoot><tr class="sum"><td>Total</td>${METRICS.map(({ k }) => (tot[k].target ? cells({ ...tot[k], pct: tot[k].actual / tot[k].target }, k) : '<td>–</td><td>–</td><td>–</td>')).join('')}</tr></tfoot>` : ''}`;
  sortTable('targets');
  $('targets-help').textContent = rows.length
    ? `Months in the period with targets. Net profit is after all costs, as in the profit and loss. Figures loaded up to ${dmy(dataTo)}; the tick on each bar is where the month should be by then, and green means on pace.`
    : '';
  if (editingTargets) renderTargetEdit();
}

let editingTargets = null; // the year being edited
function renderTargetEdit() {
  const el = $('target-edit'), y = editingTargets, T = state.targets.values;
  el.hidden = false;
  const ms = Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
  const thisYear = +iso(ukToday()).slice(0, 4);
  el.innerHTML = `<div class="ctrl"><h2>Set targets</h2><button class="btn ghost" id="te-close">Close</button></div>
    <div class="ctrl left"><label>Year <select id="te-year">${[thisYear - 1, thisYear, thisYear + 1].map((v) => `<option${v === y ? ' selected' : ''}>${v}</option>`).join('')}</select></label></div>
    <div class="tablewrap targetform"><table class="t"><thead><tr><th>Month</th>${METRICS.map(({ label, money: m }) => `<th>${label}${m ? ' (£)' : ''}</th>`).join('')}</tr></thead><tbody>
    ${ms.map((m) => `<tr><td>${monthName(m)}</td>${METRICS.map(({ k, label }) => `<td><input type="number" inputmode="decimal" step="any" ${k === 'net' ? '' : 'min="0" '}data-m="${m}" data-k="${k}" value="${T[m]?.[k] ?? ''}" aria-label="${monthName(m)} ${label}"></td>`).join('')}</tr>`).join('')}
    </tbody></table></div>
    <p class="muted small">Leave a box empty for no target. Net revenue is ex VAT; net profit is after all costs, as in the profit and loss.</p>
    <div class="ctrl left"><button class="btn" id="te-save">Save ${y}</button><span id="te-msg" class="muted"></span></div>`;
  $('te-close').onclick = () => { editingTargets = null; el.hidden = true; };
  $('te-year').onchange = () => { editingTargets = +$('te-year').value; renderTargetEdit(); };
  $('te-save').onclick = async () => {
    const months = Object.fromEntries(ms.map((m) => [m, {}]));
    el.querySelectorAll('input[data-m]').forEach((i) => { if (i.value.trim() !== '') months[i.dataset.m][i.dataset.k] = +i.value; });
    for (const m of ms) if (!Object.keys(months[m]).length) months[m] = null;
    $('te-msg').textContent = 'Saving…';
    try {
      state.targets = (await api('/api/targets', { months })).targets;
      editingTargets = null; el.hidden = true; render();
      setStatus(`Targets saved for ${y}.`);
    } catch (err) { $('te-msg').textContent = err.message; }
  };
}

// Grouped bars per month, one axis (£), with a hover tooltip per month.
function chart(el, rows) {
  if (!rows.length) { el.innerHTML = '<p class="muted">No sales in this period.</p>'; return; }
  const W = 900, H = 260, L = 76, R = 8, T = 10, B = 28;
  const vals = rows.flatMap((r) => [r.a, r.b]);
  const max = Math.max(0, ...vals);
  // A few pounds of late refunds shouldn't add a whole band below zero.
  const min = Math.min(0, ...vals) > -0.03 * max ? 0 : Math.min(0, ...vals);
  const step = niceStep((max - min) / 4 || 1);
  const top = Math.ceil(max / step) * step, bot = Math.floor(min / step) * step;
  const y = (v) => T + (top - v) / ((top - bot) || 1) * (H - T - B);
  const bw = (W - L - R) / rows.length, bar = Math.min(28, bw * 0.32);
  let svg = '';
  for (let v = bot; v <= top + 1e-9; v += step) svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${money(v)}</text>`;
  const rect = (x, v, cls) => {
    const y0 = y(0), y1 = Math.min(y(v), H - B), h = Math.max(Math.abs(y1 - y0), v ? 1 : 0), top = Math.min(y0, y1);
    return `<path style="fill:var(${cls});pointer-events:none" d="${roundedBar(x, top, bar, h, v >= 0)}"/>`;
  };
  // Hover areas first, so the highlight sits behind the bars.
  rows.forEach((r, i) => { svg += `<rect class="hit" x="${L + bw * i}" y="${T}" width="${bw}" height="${H - T - B}" data-i="${i}"/>`; });
  rows.forEach((r, i) => {
    const cx = L + bw * i + bw / 2;
    svg += rect(cx - bar - 1, r.a, '--s1') + rect(cx + 1, r.b, '--s2');
    if (rows.length <= 18 || i % 2 === 0) svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(r.label)}</text>`;
  });
  svg += `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Net revenue and net profit by month">${svg}</svg>`;
  el.querySelectorAll('.hit').forEach((h) => {
    h.addEventListener('mousemove', (e) => showTip(rows[h.dataset.i].tip, e));
    h.addEventListener('mouseleave', hideTip);
  });
}
const niceStep = (raw) => { const p = 10 ** Math.floor(Math.log10(raw)), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
// A bar with its data end rounded (4px) and its baseline end square.
function roundedBar(x, y, w, h, up) {
  const r = Math.min(4, w / 2, h);
  return up
    ? `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
    : `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
}
function showTip(html, e) {
  const t = $('tip'); t.innerHTML = html; t.hidden = false;
  const x = Math.min(e.clientX + 14, innerWidth - t.offsetWidth - 8);
  t.style.left = `${x}px`; t.style.top = `${e.clientY + 14}px`;
}
const hideTip = () => { $('tip').hidden = true; };

const saleCells = (sku) => { const t = state.spans.get(sku); return `<td>${t ? dmy(t.first) : '–'}</td><td>${t ? dmy(t.last) : '–'}</td>`; };
const COLS = [
  ['name', 'Box'], ['first', 'First sale'], ['last', 'Last sale'], ['n', 'Boxes'], ['r', 'Refunded'], ['rev', 'Net revenue'], ['fees', 'TikTok fees'], ['other', 'Other TikTok'], ['cogs', 'COGS'],
  ['marketing', 'Marketing'], ['net', 'Net profit'], ['margin', 'Margin'], ['per', 'Per box'],
];
function renderBoxes(s) {
  const q = $('q').value.trim().toLowerCase();
  const val = (sku, b, k) => (k === 'name' ? boxName(sku).toLowerCase() : k === 'first' || k === 'last' ? state.spans.get(sku)?.[k] || '' : k === 'margin' ? ratio(b.net, b.rev) : k === 'per' ? profitPer(b) : b[k]);
  const rows = [...s.boxes]
    .filter(([sku]) => !q || sku.includes(q) || (state.data.skus[sku]?.names || []).some((n) => n.toLowerCase().includes(q)))
    .sort(([ka, a], [kb, b]) => {
      const x = val(ka, a, sort.key), y = val(kb, b, sort.key);
      if (typeof x === 'string') return x.localeCompare(y) * sort.dir;
      return ((Number.isFinite(x) ? x : -Infinity) - (Number.isFinite(y) ? y : -Infinity)) * sort.dir;
    });
  const head = `<thead><tr>${COLS.map(([k, l]) => `<th data-k="${k}"${sort.key === k ? ` aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${l}</th>`).join('')}</tr></thead>`;
  const body = rows.map(([sku, b]) => `<tr class="click${b.uncosted ? ' missing' : ''}${sku === selected ? ' sel' : ''}" data-sku="${sku}"><td>${esc(boxName(sku))}<span class="sku">${sku}</span></td>
    ${saleCells(sku)}<td>${int.format(b.n)}</td><td>${int.format(b.r)}</td>${cell(b.rev)}${cell(b.fees)}${cell(b.other)}${cell(b.cogs)}${cell(b.marketing)}${cell(b.net)}<td>${pct(ratio(b.net, b.rev))}</td>${Number.isFinite(profitPer(b)) ? cell(profitPer(b), 2) : '<td>–</td>'}</tr>`).join('');
  $('boxes').innerHTML = head + `<tbody>${body || '<tr><td colspan="13" class="muted">No boxes in this period.</td></tr>'}</tbody>`;
}

// ---- Prices ------------------------------------------------------------------------
const PRICE_HEAD = ['Sold', 'List price', 'Discount', 'Discount %', 'Price paid', 'Discounts given', 'Profit per box'];
const cell2 = (v) => (Number.isFinite(v) ? cell(v, 2) : '<td>–</td>');
const priceCells = (t) => { const p = prices(t); return `<td>${int.format(t.u)}</td>${cell2(p.list)}${cell2(p.disc)}<td>${pct(p.pct)}</td>${cell2(p.paid)}${cell(p.given)}${cell2(profitPer(t))}`; };
const priceMonths = (months) => `<thead><tr><th>Month</th>${PRICE_HEAD.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${[...months].filter(([, t]) => t.u)
  .map(([m, t]) => `<tr><td data-v="${m}">${monthName(m)}</td>${priceCells(t)}</tr>`).join('') || '<tr><td colspan="8" class="muted">No sales in this period.</td></tr>'}</tbody>`;
function renderPrices(s, from, to) {
  const t = s.total, p = prices(t);
  const m2 = (v) => (Number.isFinite(v) ? money(v, 2) : '–');
  $('price-tiles').innerHTML = [
    tile('Average discount', m2(p.disc), `${pct(p.pct)} off the list price`, true),
    tile('Average list price', m2(p.list), 'incl. VAT, per box sold'),
    tile('Average price paid', m2(p.paid), `${m2(p.paid / 1.2)} ex VAT`),
    tile('Discounts given', money(p.given), 'net of refunds'),
  ].join('');
  $('price-months').innerHTML = priceMonths(byMonth(state.data, state.costs.values, from, to));
  sortTable('price-months');
  const rows = [...s.boxes].filter(([, b]) => b.u).sort(([, a], [, b]) => (prices(b).pct || 0) - (prices(a).pct || 0));
  $('price-boxes').innerHTML = `<thead><tr><th>Box</th>${PRICE_HEAD.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows
    .map(([sku, b]) => `<tr class="click${b.uncosted ? ' missing' : ''}" data-sku="${sku}"><td>${esc(boxName(sku))}<span class="sku">${sku}</span></td>${priceCells(b)}</tr>`).join('') || '<tr><td colspan="8" class="muted">No sales in this period.</td></tr>'}</tbody>`;
  sortTable('price-boxes');
}

const FEE_LABEL = (k) => MONEY[k] || k;
function renderBox(sku, s, from, to) {
  const b = s.boxes.get(sku);
  const el = $('box');
  el.hidden = false;
  const info = state.data.skus[sku] || {};
  const others = (info.names || []).filter((n) => n !== info.name);
  if (!b) { el.innerHTML = `<h2>${esc(boxName(sku))}</h2><p class="muted">No sales of this box in the period chosen.</p>`; return; }
  const c = costAt(state.costs.values[sku], to || '9999-12-31');
  const unit = (k) => (c ? (COST_LINES.find((x) => x.k === k)?.pct ? rate(c[k]) : money(c[k] || 0, 2)) : '');
  const fees = Object.entries(b.feeLines).filter(([, v]) => Math.abs(v) >= 0.005).sort(([, a], [, b2]) => a - b2);
  const row = (label, v, note = '') => `<tr><td>${label}</td>${cell(v, 2)}<td class="muted">${note}</td></tr>`;
  el.innerHTML = `
    <div class="ctrl"><div><p class="eyebrow">SKU ${sku}</p><h2>${esc(boxName(sku))}</h2></div><div><button class="btn ghost xl" data-xlsx="box">Excel</button> <button class="btn ghost" id="box-close">Close</button></div></div>
    ${others.length ? `<p class="muted small">Also sold as:</p><ul class="names muted small">${others.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    ${b.uncosted ? '<div class="warn">No costs entered for this box, so its profit is overstated. <a href="#costs">Enter costs</a>.</div>' : ''}
    <div class="tiles">
      ${tile('Net profit', money(b.net), `${pct(ratio(b.net, b.rev))} margin`, true)}
      ${tile('Boxes sold', int.format(b.n), `${int.format(b.u)} sold − ${int.format(b.r)} refunded`)}
      ${tile('Average price (ex VAT)', Number.isFinite(ratio(b.rev, b.n)) ? money(ratio(b.rev, b.n), 2) : '–', 'net revenue per box')}
      ${tile('Profit per box', Number.isFinite(profitPer(b)) ? money(profitPer(b), 2) : '–', b.f ? `plus ${int.format(b.f)} free gift units` : '')}
    </div>
    <div class="grid2">
      <div class="tablewrap"><table class="t pl"><thead><tr><th>Line</th><th>£</th><th>Per unit</th></tr></thead><tbody>
        <tr class="head"><td colspan="3">Revenue</td></tr>
        ${row('Customer payments incl. VAT', b.revInc)}
        ${row('VAT (÷ 6)', -b.vat)}
        <tr class="sum"><td>Net revenue (ex VAT)</td>${cell(b.rev, 2)}<td></td></tr>
        <tr class="head"><td colspan="3">TikTok fees</td></tr>
        ${fees.map(([k, v]) => row(esc(FEE_LABEL(k)), v)).join('') || '<tr><td class="muted" colspan="3">None</td></tr>'}
        <tr class="sum"><td>Total TikTok fees</td>${cell(b.fees, 2)}<td></td></tr>
        <tr class="head"><td colspan="3">Other TikTok items</td></tr>
        ${Object.entries(b.otherLines).filter(([, v]) => Math.abs(v) >= 0.005).map(([k, v]) => row(esc(k === 'FBT Warehouse service fee' ? 'FBT warehouse fee (share)' : k), v, k === 'FBT Warehouse service fee' && b.u ? `${money(v / b.u, 2)} per box sold` : '')).join('') || '<tr><td class="muted" colspan="3">None</td></tr>'}
        <tr class="sum"><td>Total other TikTok items</td>${cell(b.other, 2)}<td></td></tr>
        <tr class="head"><td colspan="3">Cost of goods</td></tr>
        ${COST_LINES.map(({ k, label }) => row(label, b.cogsLines[k] || 0, unit(k))).join('')}
        <tr class="sum"><td>Total COGS</td>${cell(b.cogs, 2)}<td></td></tr>
        <tr class="sum"><td>Gross profit</td>${cell(b.gross, 2)}<td></td></tr>
        ${pctRow('GP %', ratio(b.gross, b.rev), '<td></td>')}
        ${row(MARKETING.label, b.marketing, unit('marketing'))}
        <tr class="total"><td>Net profit</td>${cell(b.net, 2)}<td></td></tr>
        ${pctRow('Net profit %', ratio(b.net, b.rev), '<td></td>')}
      </tbody></table>
      <p class="muted small">Per-unit costs shown are those applying at the end of the period; each sale is costed at the costs applying on its order date.</p></div>
      <div><h3>Month by month</h3><div class="chart" id="box-chart"></div></div>
    </div>
    <h3>Price and discounts</h3>
    <div class="tablewrap"><table class="t" id="box-prices"></table></div>`;
  $('box-prices').innerHTML = priceMonths(byMonth(state.data, state.costs.values, from, to, sku));
  const months = byMonth(state.data, state.costs.values, from, to, sku);
  chart($('box-chart'), [...months].map(([m, v]) => ({ label: monthName(m), a: v.rev, b: v.net, tip: `<b>${monthName(m)}</b>Net revenue ${money(v.rev)}<br>Net profit ${money(v.net)}<br>Boxes ${int.format(v.n)}` })));
  $('box-close').onclick = () => { selected = null; el.hidden = true; render(); };
}

// ---- Attention -------------------------------------------------------------------
// Admins can hide an item for a week, a month or for good (functions/api/dismiss.js).
const hideMenu = (key) => (state.admin
  ? `<select class="hide" data-key="${esc(key)}" aria-label="Hide this"><option value="">Hide…</option><option value="7">For 1 week</option><option value="30">For 1 month</option><option value="always">Always</option></select>`
  : '');
function renderAttention(from, to) {
  const today = iso(ukToday());
  const a = withoutHidden(attention(state.data, state.costs.values, from, to, today), state.dismissed.values, today);
  const n = attCount(a);
  $('att-badge').hidden = !n; $('att-badge').textContent = n;
  $('att-none').hidden = !!n;
  $('att-hidden-card').hidden = !a.hidden.length;
  $('att-hidden').innerHTML = `<thead><tr><th>Item</th><th>Hidden until</th><th>By</th>${state.admin ? '<th></th>' : ''}</tr></thead><tbody>${a.hidden.map((h) => `<tr><td>${esc(h.title)}${h.sku ? `: ${esc(boxName(h.sku))}` : ''}</td><td data-v="${h.until || '9999'}">${h.until ? dmy(h.until) : 'Always'}</td><td>${esc(h.by)}</td>${state.admin ? `<td><button class="btn ghost" data-show="${esc(h.key)}">Show again</button></td>` : ''}</tr>`).join('')}</tbody>`;
  $('att-data').hidden = !a.data.length;
  $('att-data-list').innerHTML = a.data.map((d) => `<div class="attitem${d.sku ? ' click' : ''}"${d.sku ? ` data-sku="${d.sku}"` : ''}><b>${esc(d.title)}${d.sku ? `: ${esc(boxName(d.sku))}` : ''}</b>${esc(d.detail)}${hideMenu(d.key)}</div>`).join('');
  const table = (id, head, rows, line) => {
    $(`${id}-card`).hidden = !rows.length;
    const hideCol = state.admin ? '<th></th>' : '';
    $(id).innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}${hideCol}</tr></thead><tbody>${rows.map((r) => line(r).replace(/<\/tr>$/, `${state.admin ? `<td>${hideMenu(r.key)}</td>` : ''}</tr>`)).join('')}</tbody>`;
    sortTable(id);
  };
  const name = (sku) => `<td>${esc(boxName(sku))}<span class="sku">${sku}</span></td>`;
  table('att-costs', ['Box', 'Last sale', 'Boxes', 'Net revenue'], a.boxes.costs,
    ({ sku, b, last }) => `<tr class="click" data-sku="${sku}">${name(sku)}<td data-v="${last || ''}">${last ? dmy(last) : '–'}</td><td>${int.format(b.n)}</td>${cell(b.rev)}</tr>`);
  table('att-loss', ['Box', 'Boxes', 'Net revenue', 'Net profit', 'Per box'], a.boxes.loss,
    ({ sku, b }) => `<tr class="click" data-sku="${sku}">${name(sku)}<td>${int.format(b.n)}</td>${cell(b.rev)}${cell(b.net)}${Number.isFinite(profitPer(b)) ? cell(profitPer(b), 2) : '<td>–</td>'}</tr>`);
  $('att-margin-help').textContent = `Net profit under ${LIMITS.lowMargin * 100}% of net revenue in this period.`;
  table('att-margin', ['Box', 'Boxes', 'Net revenue', 'Net profit', 'Margin'], a.boxes.margin,
    ({ sku, b, margin }) => `<tr class="click" data-sku="${sku}">${name(sku)}<td>${int.format(b.n)}</td>${cell(b.rev)}${cell(b.net)}<td>${pct(margin)}</td></tr>`);
  $('att-refunds-help').textContent = `${LIMITS.refundRate * 100}% or more of boxes sold were refunded or cancelled (boxes with at least ${LIMITS.refundMinSold} sold).`;
  table('att-refunds', ['Box', 'Sold', 'Refunded', 'Refund rate'], a.boxes.refunds,
    ({ sku, b, rate }) => `<tr class="click" data-sku="${sku}">${name(sku)}<td>${int.format(b.u)}</td><td>${int.format(b.r)}</td><td>${pct(rate)}</td></tr>`);
}

// ---- Costs -------------------------------------------------------------------------
let editing = null;
// Costs table sort: null = boxes without costs first, then by name.
let costSort = { key: null, dir: 1 };
let costSkus = []; // the boxes on the Costs page, as listed
function renderCosts() {
  const vals = state.costs.values;
  $('costs-help').textContent = state.admin
    ? 'Costs that aren\'t in TikTok\'s data, per box: £ per box sold, and commission as a % of net revenue. When a cost changes, add a new dated entry rather than changing the old one, so past months stay as they were. Click a box to edit.'
    : 'Costs that aren\'t in TikTok\'s data, per box. Only admins can change them.';
  const today = iso(ukToday());
  // Only boxes with a sale in the period chosen (all of them for "All time").
  const [from, to] = range();
  const sold = new Set((state.data?.daily || []).filter((r) => r.u && inRange(r.d, from, to)).map((r) => r.sku));
  const cost = new Map(Object.keys(state.data?.skus || {}).map((sku) => [sku, costAt(vals[sku], today)]));
  const value = (sku, k) => {
    const c = cost.get(sku);
    if (k === 'name') return boxName(sku).toLowerCase();
    if (k === 'first' || k === 'last') return state.spans.get(sku)?.[k] ?? null;
    if (k === 'from') return c?.from ?? null;
    return c ? c[k] ?? 0 : null;
  };
  // Boxes with no value for the column always go last, whichever way it's sorted.
  const byKey = (a, b) => {
    const x = value(a, costSort.key), y = value(b, costSort.key);
    if (x == null || y == null) return (x == null) - (y == null);
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * costSort.dir || boxName(a).localeCompare(boxName(b));
  };
  const skus = Object.keys(state.data?.skus || {}).filter((sku) => (!from && !to) || sold.has(sku))
    .sort(costSort.key ? byKey : (a, b) => (!!vals[a] - !!vals[b]) || boxName(a).localeCompare(boxName(b)));
  costSkus = skus;
  const done = skus.filter((sku) => vals[sku]).length;
  const which = from || to ? 'boxes sold in this period' : 'boxes';
  $('costs-count').innerHTML = skus.length
    ? `<b>${done} of ${skus.length} ${which} have costs.</b> ${costSort.key ? 'Tap a heading to sort by it, again to reverse.' : done < skus.length ? `The ${skus.length - done} without are listed first; tap a heading to sort.` : 'Tap a heading to sort.'}`
    : `No ${which}.`;
  const cols = [['name', 'Box'], ['first', 'First sale'], ['last', 'Last sale'], ...[...COST_LINES, MARKETING].map((c) => [c.k, c.label]), ['from', 'Since']];
  const head = `<thead><tr>${cols.map(([k, l]) => `<th data-k="${k}"${costSort.key === k ? ` aria-sort="${costSort.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${l}</th>`).join('')}</tr></thead>`;
  $('costs').innerHTML = head + `<tbody>${skus.map((sku) => {
    const c = cost.get(sku);
    return `<tr class="${state.admin ? 'click' : ''}${c ? '' : ' missing'}${sku === editing ? ' sel' : ''}" data-sku="${sku}"><td>${esc(boxName(sku))}<span class="sku">${sku}</span></td>${saleCells(sku)}
      ${COST_KEYS.map((k) => `<td>${c ? (k === 'commission' ? rate(c[k]) : money(c[k], 2)) : '–'}</td>`).join('')}<td>${c ? dmy(c.from) : ''}</td></tr>`;
  }).join('')}</tbody>`;
  const log = (state.costs.log || []).slice(-15).reverse();
  $('cost-log-card').hidden = !log.length;
  $('cost-log').innerHTML = `<thead><tr><th>Box</th><th>When</th><th>Who</th></tr></thead><tbody>${log.map((l) => `<tr><td>${esc(boxName(l.sku))}</td><td data-v="${l.at}">${new Date(l.at).toLocaleString('en-GB')}</td><td>${esc(l.by)}</td></tr>`).join('')}</tbody>`;
  sortTable('cost-log');
  if (editing) renderCostEdit(editing);
}

function renderCostEdit(sku) {
  const el = $('cost-edit');
  el.hidden = false;
  const entries = (state.costs.values[sku] || []).map((e) => ({ ...e }));
  if (!entries.length) entries.push({ from: '2025-01-01', ...Object.fromEntries(COST_KEYS.map((k) => [k, 0])) });
  const input = (i, k, v) => (k === 'commission'
    ? `<input type="number" min="0" max="100" step="0.1" data-i="${i}" data-k="${k}" value="${+(v * 100).toFixed(2)}" aria-label="${k} %">`
    : `<input type="number" min="0" step="0.01" data-i="${i}" data-k="${k}" value="${v}" aria-label="${k} £">`);
  const lines = [...COST_LINES, MARKETING];
  const draw = () => {
    el.innerHTML = `<div class="ctrl"><div><p class="eyebrow">SKU ${sku}</p><h2>${esc(boxName(sku))}</h2></div><button class="btn ghost" id="ce-close">Close</button></div>
      <div class="costform"><div class="tablewrap"><table class="t"><thead><tr><th>Applies from</th>${lines.map((c) => `<th>${c.label} ${c.pct ? '(%)' : '(£)'}</th>`).join('')}<th></th></tr></thead><tbody>
      ${entries.map((e, i) => `<tr><td><input type="date" data-i="${i}" data-k="from" value="${e.from}" aria-label="Applies from"></td>${lines.map((c) => `<td>${input(i, c.k, e[c.k] || 0)}</td>`).join('')}<td>${entries.length > 1 ? `<button class="btn ghost" data-del="${i}">Remove</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted small">The earliest entry also covers any sales before its date. Costs are per box sold (net of refunds); commission is a % of net revenue ex VAT.</p>
      <div class="ctrl left"><button class="btn ghost" id="ce-add">Add a cost change</button><button class="btn" id="ce-save">Save</button><span id="ce-msg" class="muted"></span></div></div>`;
    el.querySelectorAll('input').forEach((inp) => inp.addEventListener('change', () => {
      const e = entries[inp.dataset.i], k = inp.dataset.k;
      e[k] = k === 'from' ? inp.value : k === 'commission' ? (+inp.value || 0) / 100 : +inp.value || 0;
    }));
    el.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', () => { entries.splice(+btn.dataset.del, 1); draw(); }));
    $('ce-add').onclick = () => { entries.push({ ...entries[entries.length - 1], from: iso(ukToday()) }); draw(); };
    $('ce-close').onclick = () => { editing = null; el.hidden = true; renderCosts(); };
    $('ce-save').onclick = async () => {
      $('ce-msg').textContent = 'Saving…';
      try {
        const r = await api('/api/costs', { sku, entries });
        state.costs = r.costs; editing = null; el.hidden = true; render();
        setStatus(`Costs saved for ${boxName(sku)}.`);
      } catch (err) { $('ce-msg').textContent = err.message; }
    };
  };
  draw();
}

// ---- Uploads -----------------------------------------------------------------------
function renderUploads() {
  const d = state.data;
  $('upload').hidden = !state.admin;
  $('seed').hidden = !state.seed_pending && !state.seed_costs && !state.seed_rebuild;
  $('seed-title').textContent = state.seed_rebuild ? 'Update the figures' : 'Load the initial figures and box costs';
  $('seed-text').textContent = state.seed_rebuild
    ? 'Re-reads the four TikTok exports supplied at the start, so reimbursements and chargebacks go against the box on their order, and the FBT warehouse fee can be shared across boxes. Your box costs are kept.'
    : 'The four TikTok income exports supplied when the dashboard was built (orders from 1 January to 11 October 2026), and the box costs from the original Finance Dashboard spreadsheet. This only needs doing once: statements already loaded are skipped, and costs already entered are never overwritten.';
  $('seed-btn').textContent = state.seed_rebuild ? 'Update figures' : 'Load initial figures';
  const st = Object.values(d?.statements || {});
  const dates = st.map((s) => s.date).sort();
  $('loaded').innerHTML = st.length
    ? `<p>${int.format(st.length)} TikTok statements, settled ${dmy(dates[0])} to ${dmy(dates[dates.length - 1])}, totalling ${money(st.reduce((a, s) => a + s.settlement, 0), 2)} (matches TikTok's statements).</p>`
    : '<p class="muted">Nothing loaded yet.</p>';
  const ups = (d?.uploads || []).slice().reverse();
  $('uploads').innerHTML = ups.length ? `<thead><tr><th>File</th><th>When</th><th>Who</th><th>Orders</th><th>New statements</th><th>Already loaded</th><th>Settlement added</th></tr></thead><tbody>${ups.map((u) => `<tr><td>${esc(u.name)}</td><td data-v="${u.at}">${new Date(u.at).toLocaleString('en-GB')}</td><td>${esc(u.by)}</td><td data-v="${u.first || ''}">${dmy(u.first)} – ${dmy(u.last)}</td><td>${u.added}</td><td>${u.already}</td>${cell(u.settlement, 2)}</tr>`).join('')}</tbody>` : '';
  sortTable('uploads');
}

let XLSX = null;
const loadXlsx = () => (XLSX ? Promise.resolve(XLSX) : new Promise((ok, no) => {
  const s = document.createElement('script');
  s.src = '/vendor/xlsx.full.min.js';
  s.onload = () => ok((XLSX = window.XLSX));
  s.onerror = () => no(new Error('Could not load the Excel reader.'));
  document.head.append(s);
}));

async function pickFiles() {
  const files = [...$('files').files];
  pending = []; $('publish').disabled = true;
  if (!files.length) { $('preview').innerHTML = ''; return; }
  $('preview').innerHTML = '<p class="muted">Reading…</p>';
  await loadXlsx();
  const loaded = new Set(Object.keys(state.data?.statements || {}));
  const cards = [];
  for (const f of files) {
    try {
      const parsed = parseOrderDetails(readWorkbook(XLSX, await f.arrayBuffer()));
      const fresh = onlyNew(parsed, loaded);
      for (const id of Object.keys(fresh.statements)) loaded.add(id); // two files overlapping each other
      const n = Object.keys(fresh.statements).length;
      if (n) pending.push({ name: f.name, fresh });
      const add = Object.values(fresh.statements).reduce((a, s) => a + s.settlement, 0);
      const sd = Object.values(parsed.statements).map((x) => x.date).sort();
      cards.push(`<div class="filecard"><b>${esc(f.name)}</b><br>${int.format(parsed.rows)} rows · statements ${dmy(sd[0])} – ${dmy(sd.at(-1))} (covering orders from ${dmy(parsed.first)}, as they include refunds of older orders) · ${sd.length} statements:
        <b>${n} new</b> (${money(add, 2)})${fresh.already.length ? `, ${fresh.already.length} already loaded (skipped)` : ''}</div>`);
    } catch (err) {
      cards.push(`<div class="filecard err"><b>${esc(f.name)}</b>: ${esc(err.message)}</div>`);
    }
  }
  $('preview').innerHTML = cards.join('') + (pending.length ? '' : '<p class="muted">Nothing new to add.</p>');
  $('publish').disabled = !pending.length;
}

const CHUNK = 15;
async function publish() {
  $('publish').disabled = true;
  try {
    let added = 0;
    for (const { name, fresh } of pending) {
      // A few statements per request keeps each one within Cloudflare's CPU limit.
      const ids = Object.keys(fresh.statements);
      for (let i = 0; i < ids.length; i += CHUNK) {
        setStatus(`Adding ${name}… ${Math.min(i + CHUNK, ids.length)} of ${ids.length} statements`);
        const part = new Set(ids.slice(i, i + CHUNK));
        const r = await api('/api/upload', {
          statements: Object.fromEntries([...part].map((id) => [id, fresh.statements[id]])),
          daily: fresh.daily.filter((x) => part.has(x.s)), adj: fresh.adj.filter((x) => part.has(x.s)),
          names: fresh.names, file: { name, first: fresh.first, last: fresh.last }, version: fresh.version,
        });
        added += r.added;
      }
    }
    pending = []; $('files').value = ''; $('preview').innerHTML = '';
    await load();
    setStatus(`Added ${added} new statement${added === 1 ? '' : 's'}.`);
  } catch (err) {
    setStatus(err.message, true);
    $('publish').disabled = false;
  }
}

// The TikTok files supplied when the dashboard was built, one file per request.
async function loadSeed() {
  $('seed-btn').disabled = true;
  try {
    let added = 0;
    const rebuild = !!state.seed_rebuild;
    for (let part = 0, parts = state.seed_pending || rebuild ? 1 : 0; part < parts; part++) {
      setStatus(`${rebuild ? 'Updating' : 'Loading'} the figures… file ${part + 1}`);
      const r = await api('/api/seed', { part, ...(rebuild && part === 0 ? { rebuild: true } : {}) });
      parts = r.parts; added += r.added;
    }
    setStatus('Loading box costs from the original spreadsheet…');
    const { costs } = await api('/api/seed', { costs: true });
    await load();
    setStatus(rebuild ? `Figures updated: ${added} TikTok statements re-read.` : `Loaded ${added ? `${added} TikTok statements and ` : ''}costs for ${costs} boxes. Boxes still marked "no costs" need theirs entered on the Costs tab.`);
  } catch (err) {
    setStatus(err.message, true);
    $('seed-btn').disabled = false;
  }
}

// ---- Access ------------------------------------------------------------------------
// Admins (functions/api/users.js). Owners come from the code and can't be removed.
function renderAccess() {
  $('tab-access').hidden = !state.admin;
  if (!state.admin) return;
  const added = Object.entries(state.users.admins || {}).filter(([e]) => !state.owners.includes(e));
  const rows = [...state.owners.map((e) => [e, null]), ...added.sort(([a], [b]) => a.localeCompare(b))];
  $('admins').innerHTML = `<thead><tr><th>Email</th><th>Added by</th><th>When</th><th></th></tr></thead><tbody>${rows.map(([e, a]) => `<tr><td>${esc(e)}${e === state.email ? ' <span class="muted">(you)</span>' : ''}</td>
    <td>${a ? esc(a.by) : '<span class="muted">Permanent</span>'}</td><td>${a ? new Date(a.at).toLocaleDateString('en-GB') : ''}</td>
    <td>${a && e !== state.email ? `<button class="btn ghost xl" data-remove="${esc(e)}">Remove</button>` : ''}</td></tr>`).join('')}</tbody>`;
  const log = (state.users.log || []).slice(-15).reverse();
  $('access-log-card').hidden = !log.length;
  $('access-log').innerHTML = `<thead><tr><th>Change</th><th>When</th><th>By</th></tr></thead><tbody>${log.map((l) => `<tr><td>${esc(l.email)} ${l.admin ? 'made an admin' : 'no longer an admin'}</td><td>${new Date(l.at).toLocaleString('en-GB')}</td><td>${esc(l.by)}</td></tr>`).join('')}</tbody>`;
}
async function setAdmin(email, admin) {
  $('access-msg').textContent = 'Saving…';
  try {
    state.users = (await api('/api/users', { email, admin })).users;
    $('access-msg').textContent = ''; $('new-admin').value = '';
    renderAccess();
    setStatus(admin ? `${email} is now an admin. They may need to refresh the page.` : `${email} is no longer an admin.`);
  } catch (err) { $('access-msg').textContent = err.message; }
}

// ---- Excel downloads ---------------------------------------------------------------
// Each card's figures for the period chosen (site/js/export.js).
async function download(key) {
  const [from, to] = range();
  const D = state.data, C = state.costs.values, today = iso(ukToday());
  const s = summary(D, C, from, to);
  const boxes = () => ['Boxes', boxesSheet(s.boxes, boxName, state.spans)];
  const months = (sku = null) => ['By month', periodSheet(byMonth(D, C, from, to, sku), !sku)];
  const att = () => withoutHidden(attention(D, C, from, to, today), state.dismissed.values, today);
  const group = (g) => [GROUPS[g], [[GROUPS[g], attBoxSheet(att().boxes[g], boxName)]]];
  const sets = {
    pl: () => ['Profit and loss', [['Profit and loss', plSheet(s.total, s)], boxes(), months()]],
    chart: () => ['Month by month', [months()]],
    targets: () => ['Targets', [['Targets', targetsSheet(vsTargets(state.targets.values, byMonth(D, C), from, to, lastOrder()))]]],
    top: () => ['Boxes', [boxes()]],
    boxes: () => ['Boxes', [boxes()]],
    box: () => [boxName(selected), [['Profit and loss', plSheet(s.boxes.get(selected))], months(selected), ['By day', periodSheet(byMonth(D, C, from, to, selected, 10))], ['Prices by month', pricePeriodSheet(byMonth(D, C, from, to, selected))]]],
    'price-months': () => ['Prices by month', [['Prices by month', pricePeriodSheet(byMonth(D, C, from, to))]]],
    'price-boxes': () => ['Prices by box', [['Prices by box', priceBoxSheet(s.boxes, boxName)]]],
    costs: () => ['Costs', [['Costs now', costsSheet(costSkus, boxName, state.spans, C, today)], ['Cost history', costHistorySheet(C, boxName)], ['Changes', costLogSheet(state.costs.log || [], boxName)]], false],
    'cost-log': () => ['Cost changes', [['Changes', costLogSheet(state.costs.log || [], boxName)]], false],
    'att-data': () => ['Data checks', [['Data checks', attDataSheet(att().data, boxName)]], false],
    'att-costs': () => group('costs'),
    'att-loss': () => group('loss'),
    'att-margin': () => group('margin'),
    'att-refunds': () => group('refunds'),
    'att-hidden': () => ['Hidden', [['Hidden', hiddenSheet(att().hidden, boxName)]], false],
    uploads: () => ['Uploads', [['Uploads', uploadsSheet(D?.uploads || [])], ['Statements', statementsSheet(D?.statements || {})]], false],
  };
  const [title, sheets, dated = true] = sets[key]();
  const period = from || to ? `${from || 'start'} to ${to || 'latest'}` : 'all time';
  await loadXlsx();
  // Browsers drop a file name with characters like £ in it, so keep to plain ones.
  const file = `LiB ${title}${dated ? ` ${period}` : ''}`.replace(/[^\x20-\x7e]|[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ');
  XLSX.writeFile(book(XLSX, sheets), `${file}.xlsx`);
}

// ---- Wiring ------------------------------------------------------------------------
function showTab() {
  const tab = (location.hash || '#summary').slice(1);
  const known = ['summary', 'attention', 'boxes', 'prices', 'costs', 'uploads', ...(state?.admin ? ['access'] : [])].includes(tab) ? tab : 'summary';
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `v-${known}`; });
  document.querySelectorAll('#tabs a').forEach((a) => (a.dataset.tab === known ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  $('filters').hidden = !['summary', 'attention', 'boxes', 'prices', 'costs'].includes(known);
}

async function load() {
  state = await api('/api/me');
  state.data = assemble(state.index, state.batches);
  state.spans = saleDates(state.data);
  const st = Object.values(state.data?.statements || {}).map((s) => s.date).sort();
  $('who').textContent = `${state.email}${state.admin ? ' · admin' : ''}`;
  $('coverage').textContent = st.length ? `TikTok statements loaded up to ${dmy(st[st.length - 1])}${state.data.uploaded_at ? ` · last updated ${new Date(state.data.uploaded_at).toLocaleDateString('en-GB')}` : ''}` : '';
  $('tabs').hidden = false;
  showTab();
  render();
}

function onRowClick(table, fn) {
  $(table).addEventListener('click', (e) => {
    if (e.target.closest('select, button')) return;
    const el = e.target.closest('[data-sku]'); if (el) fn(el.dataset.sku);
  });
}

async function start() {
  try {
    await load();
    setStatus(state.data ? '' : (state.admin ? 'No figures yet - add the TikTok income export under Uploads.' : 'No figures have been added yet.'));
    if (!state.data && state.admin) location.hash = '#uploads';
  } catch (err) {
    setStatus(err.message, true);
    return;
  }
  addEventListener('hashchange', showTab);
  for (const id of ['period', 'from', 'to']) $(id).addEventListener('change', render);
  $('q').addEventListener('input', () => renderBoxes(summary(state.data, state.costs.values, ...range())));
  $('costs').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-k]');
    if (th) { costSort = { key: th.dataset.k, dir: costSort.key === th.dataset.k ? -costSort.dir : th.dataset.k === 'name' ? 1 : -1 }; renderCosts(); }
  });
  $('boxes').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-k]');
    if (th) { sort = { key: th.dataset.k, dir: sort.key === th.dataset.k ? -sort.dir : th.dataset.k === 'name' ? 1 : -1 }; render(); }
  });
  const openBox = (sku) => { selected = sku; location.hash = '#boxes'; render(); $('box').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  onRowClick('boxes', openBox);
  onRowClick('top', openBox);
  onRowClick('price-boxes', openBox);
  const openCosts = (sku) => { if (!state.admin) return openBox(sku); editing = sku; location.hash = '#costs'; renderCosts(); $('cost-edit').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  onRowClick('att-costs', openCosts);
  for (const id of ['att-loss', 'att-margin', 'att-refunds', 'att-data-list']) onRowClick(id, openBox);
  for (const id of ['att-costs', 'att-loss', 'att-margin', 'att-refunds', 'att-hidden']) sortable(id);
  const dismiss = async (body) => {
    try { state.dismissed = (await api('/api/dismiss', body)).dismissed; render(); } catch (err) { setStatus(err.message, true); }
  };
  $('v-attention').addEventListener('change', (e) => {
    const sel = e.target.closest('select.hide');
    if (!sel || !sel.value) return;
    const until = sel.value === 'always' ? null : iso(new Date(ukToday().getTime() + Number(sel.value) * 864e5));
    dismiss({ key: sel.dataset.key, until });
  });
  $('v-attention').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-show]');
    if (btn) dismiss({ key: btn.dataset.show, show: true });
  });
  $('targets-set').addEventListener('click', () => { editingTargets = +iso(ukToday()).slice(0, 4); renderTargetEdit(); $('target-edit').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  sortable('targets');
  sortable('top', 10); sortable('uploads'); sortable('cost-log'); sortable('price-months'); sortable('price-boxes');
  onRowClick('costs', (sku) => { if (!state.admin) return; editing = sku; renderCosts(); $('cost-edit').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $('files').addEventListener('change', () => pickFiles().catch((err) => setStatus(err.message, true)));
  $('publish').addEventListener('click', publish);
  $('seed-btn').addEventListener('click', loadSeed);
  $('add-admin').addEventListener('click', () => setAdmin($('new-admin').value.trim().toLowerCase(), true));
  $('new-admin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('add-admin').click(); });
  $('admins').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (b && confirm(`Remove ${b.dataset.remove} as an admin? They'll still be able to view the dashboard.`)) setAdmin(b.dataset.remove, false);
  });
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-xlsx]');
    if (btn) download(btn.dataset.xlsx).catch((err) => setStatus(err.message, true));
  });
}
start();
