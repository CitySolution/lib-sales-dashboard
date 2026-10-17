// The dashboard page. All figures come from /api/me; the maths is in pnl.js.
import { summary, byMonth, assemble, COST_LINES, MARKETING, COST_KEYS, costAt } from './pnl.js';
import { MONEY, readWorkbook, parseOrderDetails, onlyNew } from './tiktok.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const gbp0 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
const gbp2 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('en-GB');
const money = (v, dp = 0) => { const s = (dp ? gbp2 : gbp0).format(Math.abs(v)); return v < -0.004 ? `−${s}` : s; };
const cell = (v, dp = 0) => `<td${v < -0.004 ? ' class="neg"' : ''}>${money(v, dp)}</td>`;
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '–');
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

// ---- Rendering ---------------------------------------------------------------------
const boxName = (sku) => state.data?.skus?.[sku]?.name || `SKU ${sku}`;
const profitPer = (b) => ratio(b.net, b.n);

function render() {
  const [from, to] = range();
  $('custom').hidden = $('period').value !== 'custom';
  $('range').textContent = from || to ? `${dmy(from) || 'start'} – ${dmy(to) || 'latest'} · by order date` : 'All orders loaded · by order date';
  const s = summary(state.data, state.costs.values, from, to);
  renderSummary(s, from, to);
  renderBoxes(s);
  if (selected) renderBox(selected, s, from, to);
  renderCosts();
  renderUploads();
}

function tile(label, value, sub = '', hero = false) {
  return `<div class="card tile${hero ? ' hero-tile' : ''}"><span class="lab">${label}</span><span class="big">${value}</span><span class="sub">${sub}</span></div>`;
}

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
  $('top').innerHTML = head + `<tbody>${rows.slice(0, 10).map(line).join('') || '<tr><td colspan="6" class="muted">No sales in this period.</td></tr>'}</tbody>`;

  const shop = Object.entries(s.shop).sort(([a], [b]) => a.localeCompare(b));
  $('pl').innerHTML = `<tbody>
    <tr><td>Net revenue (ex VAT)</td>${cell(t.rev)}</tr>
    <tr><td>TikTok fees</td>${cell(t.fees)}</tr>
    <tr><td>Cost of goods</td>${cell(t.cogs)}</tr>
    <tr class="sum"><td>Gross profit</td>${cell(t.gross)}</tr>
    <tr><td>Marketing</td>${cell(t.marketing)}</tr>
    <tr class="sum"><td>Net profit from boxes</td>${cell(t.net)}</tr>
    ${shop.map(([k, v]) => `<tr><td>${esc(k)}</td>${cell(v)}</tr>`).join('')}
    <tr class="total"><td>Net profit after all costs</td>${cell(s.overall)}</tr></tbody>`;
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

const COLS = [
  ['name', 'Box'], ['n', 'Boxes'], ['r', 'Refunded'], ['rev', 'Net revenue'], ['fees', 'TikTok fees'], ['cogs', 'COGS'],
  ['marketing', 'Marketing'], ['net', 'Net profit'], ['margin', 'Margin'], ['per', 'Per box'],
];
function renderBoxes(s) {
  const q = $('q').value.trim().toLowerCase();
  const val = (sku, b, k) => (k === 'name' ? boxName(sku).toLowerCase() : k === 'margin' ? ratio(b.net, b.rev) : k === 'per' ? profitPer(b) : b[k]);
  const rows = [...s.boxes]
    .filter(([sku]) => !q || sku.includes(q) || (state.data.skus[sku]?.names || []).some((n) => n.toLowerCase().includes(q)))
    .sort(([ka, a], [kb, b]) => {
      const x = val(ka, a, sort.key), y = val(kb, b, sort.key);
      if (typeof x === 'string') return x.localeCompare(y) * sort.dir;
      return ((Number.isFinite(x) ? x : -Infinity) - (Number.isFinite(y) ? y : -Infinity)) * sort.dir;
    });
  const head = `<thead><tr>${COLS.map(([k, l]) => `<th data-k="${k}"${sort.key === k ? ` aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${l}</th>`).join('')}</tr></thead>`;
  const body = rows.map(([sku, b]) => `<tr class="click${b.uncosted ? ' missing' : ''}${sku === selected ? ' sel' : ''}" data-sku="${sku}"><td>${esc(boxName(sku))}<span class="sku">${sku}</span></td>
    <td>${int.format(b.n)}</td><td>${int.format(b.r)}</td>${cell(b.rev)}${cell(b.fees)}${cell(b.cogs)}${cell(b.marketing)}${cell(b.net)}<td>${pct(ratio(b.net, b.rev))}</td>${Number.isFinite(profitPer(b)) ? cell(profitPer(b), 2) : '<td>–</td>'}</tr>`).join('');
  $('boxes').innerHTML = head + `<tbody>${body || '<tr><td colspan="10" class="muted">No boxes in this period.</td></tr>'}</tbody>`;
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
  const unit = (k) => (c ? (COST_LINES.find((x) => x.k === k)?.pct ? pct(c[k]) : money(c[k] || 0, 2)) : '');
  const fees = Object.entries(b.feeLines).filter(([, v]) => Math.abs(v) >= 0.005).sort(([, a], [, b2]) => a - b2);
  const row = (label, v, note = '') => `<tr><td>${label}</td>${cell(v, 2)}<td class="muted">${note}</td></tr>`;
  el.innerHTML = `
    <div class="ctrl"><div><p class="eyebrow">SKU ${sku}</p><h2>${esc(boxName(sku))}</h2></div><button class="btn ghost" id="box-close">Close</button></div>
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
        <tr class="head"><td colspan="3">Cost of goods</td></tr>
        ${COST_LINES.map(({ k, label }) => row(label, b.cogsLines[k] || 0, unit(k))).join('')}
        <tr class="sum"><td>Total COGS</td>${cell(b.cogs, 2)}<td></td></tr>
        <tr class="sum"><td>Gross profit</td>${cell(b.gross, 2)}<td></td></tr>
        ${row(MARKETING.label, b.marketing, unit('marketing'))}
        <tr class="total"><td>Net profit</td>${cell(b.net, 2)}<td></td></tr>
      </tbody></table>
      <p class="muted small">Per-unit costs shown are those applying at the end of the period; each sale is costed at the costs applying on its order date.</p></div>
      <div><h3>Month by month</h3><div class="chart" id="box-chart"></div></div>
    </div>`;
  const months = byMonth(state.data, state.costs.values, from, to, sku);
  chart($('box-chart'), [...months].map(([m, v]) => ({ label: monthName(m), a: v.rev, b: v.net, tip: `<b>${monthName(m)}</b>Net revenue ${money(v.rev)}<br>Net profit ${money(v.net)}<br>Boxes ${int.format(v.n)}` })));
  $('box-close').onclick = () => { selected = null; el.hidden = true; render(); };
}

// ---- Costs -------------------------------------------------------------------------
let editing = null;
function renderCosts() {
  const vals = state.costs.values;
  $('costs-help').textContent = state.admin
    ? 'Costs that aren\'t in TikTok\'s data, per box: £ per box sold, and commission as a % of net revenue. When a cost changes, add a new dated entry rather than changing the old one, so past months stay as they were. Click a box to edit.'
    : 'Costs that aren\'t in TikTok\'s data, per box. Only admins can change them.';
  const today = iso(ukToday());
  const skus = Object.keys(state.data?.skus || {}).sort((a, b) => (!!vals[a] - !!vals[b]) || boxName(a).localeCompare(boxName(b)));
  const head = `<thead><tr><th>Box</th>${COST_LINES.map((c) => `<th>${c.label}</th>`).join('')}<th>${MARKETING.label}</th><th>Since</th></tr></thead>`;
  $('costs').innerHTML = head + `<tbody>${skus.map((sku) => {
    const c = costAt(vals[sku], today);
    return `<tr class="${state.admin ? 'click' : ''}${c ? '' : ' missing'}${sku === editing ? ' sel' : ''}" data-sku="${sku}"><td>${esc(boxName(sku))}<span class="sku">${sku}</span></td>
      ${COST_KEYS.map((k) => `<td>${c ? (k === 'commission' ? pct(c[k]) : money(c[k], 2)) : '–'}</td>`).join('')}<td>${c ? dmy(c.from) : ''}</td></tr>`;
  }).join('')}</tbody>`;
  const log = (state.costs.log || []).slice(-15).reverse();
  $('cost-log-card').hidden = !log.length;
  $('cost-log').innerHTML = `<thead><tr><th>Box</th><th>When</th><th>Who</th></tr></thead><tbody>${log.map((l) => `<tr><td>${esc(boxName(l.sku))}</td><td>${new Date(l.at).toLocaleString('en-GB')}</td><td>${esc(l.by)}</td></tr>`).join('')}</tbody>`;
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
  $('seed').hidden = !state.seed_pending;
  const st = Object.values(d?.statements || {});
  const dates = st.map((s) => s.date).sort();
  $('loaded').innerHTML = st.length
    ? `<p>${int.format(st.length)} TikTok statements, settled ${dmy(dates[0])} to ${dmy(dates[dates.length - 1])}, totalling ${money(st.reduce((a, s) => a + s.settlement, 0), 2)} (matches TikTok's statements).</p>`
    : '<p class="muted">Nothing loaded yet.</p>';
  const ups = (d?.uploads || []).slice().reverse();
  $('uploads').innerHTML = ups.length ? `<thead><tr><th>File</th><th>When</th><th>Who</th><th>Orders</th><th>New statements</th><th>Already loaded</th><th>Settlement added</th></tr></thead><tbody>${ups.map((u) => `<tr><td>${esc(u.name)}</td><td>${new Date(u.at).toLocaleString('en-GB')}</td><td>${esc(u.by)}</td><td>${dmy(u.first)} – ${dmy(u.last)}</td><td>${u.added}</td><td>${u.already}</td>${cell(u.settlement, 2)}</tr>`).join('')}</tbody>` : '';
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
      cards.push(`<div class="filecard"><b>${esc(f.name)}</b><br>${int.format(parsed.rows)} rows · orders ${dmy(parsed.first)} – ${dmy(parsed.last)} · ${Object.keys(parsed.statements).length} statements:
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
          names: fresh.names, file: { name, first: fresh.first, last: fresh.last },
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
    for (let part = 0, parts = 1; part < parts; part++) {
      setStatus(`Loading the initial figures… file ${part + 1}`);
      const r = await api('/api/seed', { part });
      parts = r.parts; added += r.added;
    }
    await load();
    setStatus(`Loaded ${added} TikTok statements. Next: enter each box's costs on the Costs tab.`);
  } catch (err) {
    setStatus(err.message, true);
    $('seed-btn').disabled = false;
  }
}

// ---- Wiring ------------------------------------------------------------------------
function showTab() {
  const tab = (location.hash || '#summary').slice(1);
  const known = ['summary', 'boxes', 'costs', 'uploads'].includes(tab) ? tab : 'summary';
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `v-${known}`; });
  document.querySelectorAll('#tabs a').forEach((a) => (a.dataset.tab === known ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  $('filters').hidden = !['summary', 'boxes'].includes(known);
}

async function load() {
  state = await api('/api/me');
  state.data = assemble(state.index, state.batches);
  const st = Object.values(state.data?.statements || {}).map((s) => s.date).sort();
  $('who').textContent = `${state.email}${state.admin ? ' · admin' : ''}`;
  $('coverage').textContent = st.length ? `TikTok statements loaded up to ${dmy(st[st.length - 1])}${state.data.uploaded_at ? ` · last updated ${new Date(state.data.uploaded_at).toLocaleDateString('en-GB')}` : ''}` : '';
  $('tabs').hidden = false;
  showTab();
  render();
}

function onRowClick(table, fn) {
  $(table).addEventListener('click', (e) => { const tr = e.target.closest('tr[data-sku]'); if (tr) fn(tr.dataset.sku); });
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
  $('boxes').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-k]');
    if (th) { sort = { key: th.dataset.k, dir: sort.key === th.dataset.k ? -sort.dir : th.dataset.k === 'name' ? 1 : -1 }; render(); }
  });
  const openBox = (sku) => { selected = sku; location.hash = '#boxes'; render(); $('box').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  onRowClick('boxes', openBox);
  onRowClick('top', openBox);
  onRowClick('costs', (sku) => { if (!state.admin) return; editing = sku; renderCosts(); $('cost-edit').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $('files').addEventListener('change', () => pickFiles().catch((err) => setStatus(err.message, true)));
  $('publish').addEventListener('click', publish);
  $('seed-btn').addEventListener('click', loadSeed);
}
start();
