/* Cartera — seguimiento de inversiones. Vanilla JS, sin dependencias. */
(() => {
'use strict';

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayISO = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMonths = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MESES_L = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fmtDate = (iso, withYear = true) => { if (!iso) return '—'; const [y, m, d] = iso.slice(0, 10).split('-'); return `${+d} ${MESES[+m - 1]}${withYear ? ' ' + y : ''}`; };
const nf = (dec) => new Intl.NumberFormat('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const eur = (n, dec = 2) => (n == null || isNaN(n)) ? '—' : nf(dec).format(n) + ' €';
const eurS = (n, dec = 2) => (n == null || isNaN(n)) ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + nf(dec).format(Math.abs(n)) + ' €';
const pct = (n, dec = 2, sign = true) => (n == null || isNaN(n)) ? '—' : (sign ? (n > 0 ? '+' : n < 0 ? '−' : '') : '') + nf(dec).format(Math.abs(n)) + ' %';
const num = (n, dec = 2) => (n == null || isNaN(n)) ? '—' : nf(dec).format(n);
const cls = (n) => n > 0.000001 ? 'up' : n < -0.000001 ? 'down' : '';
const sum = (arr, f = (x) => x) => arr.reduce((s, x) => s + (f(x) || 0), 0);
const uid = () => 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const store = {
  get(k, d) { try { const v = localStorage.getItem('cartera.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cartera.' + k, JSON.stringify(v)); } catch (e) { toast('No se pudo guardar en el dispositivo'); } },
  del(k) { try { localStorage.removeItem('cartera.' + k); } catch {} },
};

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const S = {
  instruments: [], buckets: {}, fxCfg: [],
  prices: null, events: null, lookthrough: null, seed: null, status: null,
  txs: [], targets: {}, manualPrices: {}, customInstruments: [],
  ui: store.get('ui', { tab: 'resumen', range: '3M', broker: 'all', sort: 'valor' }),
  loaded: false,
};
const byId = {};

async function fetchJSON(path, { bust = true, optional = false } = {}) {
  try {
    const r = await fetch(path + (bust ? (path.includes('?') ? '&' : '?') + 't=' + Date.now() : ''), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch (e) {
    if (!optional) console.warn('No se pudo cargar', path, e);
    return null;
  }
}

async function loadAll() {
  const [ins, seed, prices, events, lt, status] = await Promise.all([
    fetchJSON('data/instruments.json'), fetchJSON('data/seed.json'), fetchJSON('data/prices.json', { optional: true }),
    fetchJSON('data/events.json', { optional: true }), fetchJSON('data/lookthrough.json'), fetchJSON('data/status.json', { optional: true }),
  ]);
  if (!ins || !seed) { $('#view').innerHTML = '<div class="card"><div class="notice err">No se han podido cargar los datos de la app. Comprueba la conexión y vuelve a abrirla.</div></div>'; return; }
  S.customInstruments = store.get('customInstruments', []);
  S.instruments = [...ins.instruments, ...S.customInstruments];
  S.buckets = ins.buckets; S.fxCfg = ins.fx || [];
  S.instruments.forEach((i) => { byId[i.id] = i; });
  S.seed = seed; S.prices = prices; S.events = events; S.lookthrough = lt; S.status = status;
  S.txs = store.get('txs', null) || JSON.parse(JSON.stringify(seed.transactions));
  S.targets = store.get('targets', seed.targets || {});
  S.manualPrices = store.get('manualPrices', {});
  S.loaded = true;
  resolveValueRefLots();
  recompute();
  updateHeader();
  render();
}

// ---------------------------------------------------------------------------
// Precios
// ---------------------------------------------------------------------------
function bsearchLE(series, date) {
  // series: [[date, value], ...] ordenado. Devuelve el último índice con fecha <= date, o -1.
  let lo = 0, hi = series.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (series[mid][0] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
function fxAt(pair, date) {
  const fx = S.prices?.fx?.[pair];
  if (!fx) return null;
  if (!date) return fx.price;
  const i = bsearchLE(fx.history || [], date);
  return i >= 0 ? fx.history[i][1] : (fx.history?.[0]?.[1] ?? fx.price);
}
function quoteCurrency(id) { return S.prices?.quotes?.[id]?.currency || byId[id]?.currency || 'EUR'; }
function toEUR(amount, ccy, date) {
  if (!amount && amount !== 0) return null;
  if (!ccy || ccy === 'EUR') return amount;
  if (ccy === 'USD') { const r = fxAt('EURUSD', date); return r ? amount / r : null; }
  if (ccy === 'GBp') { const r = fxAt('EURGBP', date); return r ? amount / 100 / r : null; }
  const r = fxAt('EUR' + ccy, date); return r ? amount / r : null;
}
function priceEURAt(id, date) {
  const m = S.manualPrices[id];
  const h = S.prices?.history?.[id];
  if (h && h.length) {
    const i = bsearchLE(h, date);
    if (i >= 0) {
      const p = toEUR(h[i][1], quoteCurrency(id), h[i][0]);
      if (p != null) return p;
    } else if (!m) {
      // fecha anterior al histórico: usa el primer dato
      return toEUR(h[0][1], quoteCurrency(id), h[0][0]);
    }
  }
  if (m && m.date <= date) return m.price;
  return null;
}
function currentPriceEUR(id) {
  const m = S.manualPrices[id];
  const q = S.prices?.quotes?.[id];
  if (q && (!m || (q.lastDate > m.date))) return { price: toEUR(q.price, q.currency, null), prev: toEUR(q.prevClose, q.currency, null), date: q.lastDate, source: 'yahoo' };
  if (m) return { price: m.price, prev: m.prev ?? m.price, date: m.date, source: 'manual' };
  return { price: null, prev: null, date: null, source: null };
}
function hasFeed(id) { return !!S.prices?.quotes?.[id]; }

// Lotes con units=null y value_ref: calcula participaciones = valor / precio del día.
function resolveValueRefLots() {
  let changed = false;
  for (const t of S.txs) {
    if (t.units != null) continue;
    if (t.value_ref) {
      const p = priceEURAt(t.instrument, t.value_ref.date);
      if (p) { t.units = +(t.value_ref.value / p).toFixed(6); t.price = +(t.cost / t.units).toFixed(6); t.resolvedFrom = 'value_ref'; changed = true; }
    } else if (t.amount_based && t.cost > 0) {
      // Compra por importe: participaciones = importe / precio del día de la compra
      const p = priceEURAt(t.instrument, t.date);
      if (p) { t.units = +(t.cost / p).toFixed(6); t.price = +(t.cost / t.units).toFixed(6); t.resolvedFrom = 'amount'; changed = true; }
    }
  }
  if (changed) store.set('txs', S.txs);
}

// ---------------------------------------------------------------------------
// Cálculo de cartera
// ---------------------------------------------------------------------------
const C = { positions: {}, realized: [], dividends: [], series: null, totals: {} };

function txCost(t) { return (t.units != null ? (t.units || 0) * (t.price || 0) : (t.cost || 0)) + (t.fee || 0) + (t.tax || 0); }
function txProceeds(t) { return (t.units || 0) * (t.price || 0) - (t.fee || 0) - (t.tax || 0); }

function recompute() {
  const txs = [...S.txs].filter((t) => t.units != null || t.type === 'dividend').sort((a, b) => a.date.localeCompare(b.date) || (a.id > b.id ? 1 : -1));
  const pos = {}; const realized = []; const dividends = [];
  for (const t of txs) {
    const id = t.instrument; if (!byId[id]) continue;
    const p = pos[id] || (pos[id] = { id, lots: [], units: 0, cost: 0, realized: 0, dividends: 0, dividendsTax: 0, fees: 0, taxes: 0, firstDate: t.date, lastDate: t.date, unitsTimeline: [] });
    p.lastDate = t.date;
    if (t.type === 'buy') {
      const cpu = txCost(t) / t.units;
      p.lots.push({ date: t.date, units: t.units, cpu, price: t.price, txId: t.id, estimated: !!t.estimated });
      p.units += t.units; p.cost += txCost(t); p.fees += t.fee || 0; p.taxes += t.tax || 0;
      p.unitsTimeline.push([t.date, p.units]);
    } else if (t.type === 'sell') {
      let rem = t.units, costOut = 0;
      while (rem > 1e-9 && p.lots.length) {
        const l = p.lots[0]; const take = Math.min(rem, l.units);
        costOut += take * l.cpu; l.units -= take; rem -= take;
        if (l.units <= 1e-9) p.lots.shift();
      }
      const proceeds = txProceeds(t); const gain = proceeds - costOut;
      p.units = Math.max(0, p.units - t.units); p.cost = Math.max(0, p.cost - costOut); p.realized += gain; p.fees += t.fee || 0;
      realized.push({ date: t.date, id, units: t.units, proceeds, cost: costOut, gain, txId: t.id });
      p.unitsTimeline.push([t.date, p.units]);
    } else if (t.type === 'dividend') {
      p.dividends += t.amount || 0; p.dividendsTax += t.tax || 0;
      dividends.push({ date: t.date, id, amount: t.amount || 0, tax: t.tax || 0, note: t.note, txId: t.id });
    }
  }
  // Valoración actual
  let totalValue = 0, totalCost = 0, dayChange = 0, dayBase = 0, feedMissing = [];
  for (const p of Object.values(pos)) {
    const cp = currentPriceEUR(p.id);
    p.price = cp.price; p.prevPrice = cp.prev; p.priceDate = cp.date; p.priceSource = cp.source;
    p.value = p.units > 1e-9 && cp.price != null ? p.units * cp.price : 0;
    p.avgCost = p.units > 1e-9 ? p.cost / p.units : null;
    p.pl = p.value - (p.units > 1e-9 ? p.cost : 0);
    p.plPct = p.units > 1e-9 && p.cost > 0 ? p.pl / p.cost * 100 : null;
    p.dayChange = p.units > 1e-9 && cp.price != null && cp.prev != null ? p.units * (cp.price - cp.prev) : 0;
    p.dayPct = cp.price != null && cp.prev ? (cp.price / cp.prev - 1) * 100 : null;
    if (p.units > 1e-9) {
      totalValue += p.value; totalCost += p.cost; dayChange += p.dayChange; dayBase += p.value - p.dayChange;
      if (cp.price == null) feedMissing.push(p.id);
    }
  }
  for (const p of Object.values(pos)) p.weight = totalValue ? p.value / totalValue * 100 : 0;
  C.positions = pos; C.realized = realized; C.dividends = dividends;
  const totalRealized = sum(realized, (r) => r.gain);
  const totalDiv = sum(dividends, (d) => d.amount), totalDivTax = sum(dividends, (d) => d.tax);
  const interest = sum(S.seed?.interest || [], (i) => i.gross - (i.tax || 0));
  const other = sum(S.seed?.other || [], (o) => o.amount);
  C.totals = { value: totalValue, cost: totalCost, pl: totalValue - totalCost, plPct: totalCost ? (totalValue - totalCost) / totalCost * 100 : 0,
    dayChange, dayPct: dayBase ? dayChange / dayBase * 100 : 0, realized: totalRealized, dividends: totalDiv, dividendsNet: totalDiv - totalDivTax, interest, other,
    fees: sum(Object.values(pos), (p) => p.fees), taxes: sum(Object.values(pos), (p) => p.taxes), feedMissing,
    total: totalValue - totalCost + totalRealized + totalDiv - totalDivTax + interest + other };
  C.series = buildSeries();
}

function unitsAt(p, date) {
  const tl = p.unitsTimeline; let lo = 0, hi = tl.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (tl[mid][0] <= date) { ans = tl[mid][1]; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

// Serie diaria: valor de cartera y aportado neto acumulado.
function buildSeries() {
  const txs = S.txs.filter((t) => (t.units != null || t.cost) && (t.type === 'buy' || t.type === 'sell'));
  if (!txs.length) return { dates: [], value: [], invested: [] };
  const first = txs.reduce((m, t) => t.date < m ? t.date : m, txs[0].date);
  const end = todayISO();
  const dates = []; for (let d = first; d <= end; d = addDays(d, 1)) dates.push(d);
  const flows = {}; // fecha -> aportación neta (compras +, ventas -)
  for (const t of txs) { flows[t.date] = (flows[t.date] || 0) + (t.type === 'buy' ? txCost(t) : -txProceeds(t)); }
  const divFlows = {}; for (const d of C.dividends) divFlows[d.date] = (divFlows[d.date] || 0) + (d.amount - d.tax);
  const posList = Object.values(C.positions);
  const value = [], invested = []; let inv = 0;
  for (const d of dates) {
    inv += flows[d] || 0; invested.push(inv);
    let v = 0;
    for (const p of posList) { const u = unitsAt(p, d); if (u > 1e-9) { const pr = priceEURAt(p.id, d); if (pr != null) v += u * pr; } }
    value.push(v);
  }
  // Hoy: usa el precio actual (puede ser intradía)
  if (value.length) value[value.length - 1] = C.totals.value;
  return { dates, value, invested, flows, divFlows };
}

function rangeStart(range) {
  const t = todayISO();
  switch (range) {
    case '1S': return addDays(t, -7);
    case '1M': return addMonths(t, -1);
    case '3M': return addMonths(t, -3);
    case '6M': return addMonths(t, -6);
    case 'YTD': return t.slice(0, 4) + '-01-01';
    case '1A': return addMonths(t, -12);
    default: return C.series?.dates?.[0] || t;
  }
}

// Rentabilidad Modified Dietz entre start y hoy, con flujos del periodo.
function periodReturn(range) {
  const s = C.series; if (!s || !s.dates.length) return null;
  const start = rangeStart(range);
  const i0 = s.dates.findIndex((d) => d >= start);
  if (i0 < 0) return null;
  const V0 = i0 > 0 ? s.value[i0 - 1] : 0;
  const V1 = s.value[s.value.length - 1];
  const n = s.dates.length - i0;
  let F = 0, W = 0;
  for (let i = i0; i < s.dates.length; i++) {
    const d = s.dates[i]; const f = (s.flows[d] || 0) - (s.divFlows[d] || 0);
    if (f) { F += f; W += f * (n - (i - i0)) / n; }
  }
  const denom = V0 + W; const gain = V1 - V0 - F;
  return { gain, pct: denom > 0 ? gain / denom * 100 : null, V0, V1, F, start: s.dates[i0] };
}

// ---------------------------------------------------------------------------
// Look-through
// ---------------------------------------------------------------------------
function exposure() {
  const lt = S.lookthrough || {}; const total = C.totals.value || 1;
  const acc = { assetClass: {}, sectors: {}, countries: {}, currencies: {}, companies: {} };
  const add = (m, k, v) => { if (v) m[k] = (m[k] || 0) + v; };
  for (const p of Object.values(C.positions)) {
    if (p.units <= 1e-9 || !p.value) continue;
    const ins = byId[p.id]; const key = ins.lookthrough || (ins.type === 'stock' ? 'stock' : null); const comp = lt[key];
    const w = p.value / total * 100;
    if (ins.type === 'stock') {
      add(acc.assetClass, 'Renta variable', w); add(acc.sectors, ins.sector || 'Otros', w); add(acc.countries, ins.country || 'Otros', w);
      add(acc.currencies, ins.currency === 'USD' ? 'USD' : ins.currency || 'EUR', w);
      add(acc.companies, ins.short || ins.name, w);
      continue;
    }
    if (!comp) { add(acc.assetClass, 'Otros', w); continue; }
    for (const [k, v] of Object.entries(comp.assetClass || {})) add(acc.assetClass, k, w * v / 100);
    for (const [k, v] of Object.entries(comp.sectors || {})) add(acc.sectors, k, w * v / 100);
    for (const [k, v] of Object.entries(comp.countries || {})) add(acc.countries, k, w * v / 100);
    for (const [k, v] of Object.entries(comp.currencies || {})) add(acc.currencies, k, w * v / 100);
    for (const h of comp.topHoldings || []) { const name = h.match && byId[h.match] ? (byId[h.match].short || byId[h.match].name) : h.name; add(acc.companies, name, w * h.weight / 100); }
  }
  const sortObj = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
  return { assetClass: sortObj(acc.assetClass), sectors: sortObj(acc.sectors), countries: sortObj(acc.countries), currencies: sortObj(acc.currencies), companies: sortObj(acc.companies) };
}

function bucketTotals() {
  const out = {}; for (const [k, b] of Object.entries(S.buckets)) out[k] = { ...b, key: k, value: 0, cost: 0, day: 0 };
  for (const p of Object.values(C.positions)) { if (p.units <= 1e-9) continue; const b = byId[p.id].bucket; if (!out[b]) out[b] = { label: b, key: b, color: '#999', order: 99, value: 0, cost: 0, day: 0 }; out[b].value += p.value; out[b].cost += p.cost; out[b].day += p.dayChange; }
  return Object.values(out).sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------------------
// Gráficas (SVG propio)
// ---------------------------------------------------------------------------
function niceTicks(min, max, n = 4) {
  if (max - min < 1e-9) { max = min + 1; }
  const span = max - min; const step0 = span / n; const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const steps = [1, 2, 2.5, 5, 10].map((s) => s * mag); const step = steps.find((s) => s >= step0) || steps[steps.length - 1];
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step; const ticks = [];
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(10));
  return { lo, hi, ticks };
}
const fmtAxis = (v) => Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1).replace('.', ',') + 'k' : num(v, Math.abs(v) < 10 ? 2 : 0);

// Gráfica de líneas (valor + aportado) con crosshair táctil.
function lineChart({ dates, series, height = 220, showArea = true, yFormat = fmtAxis, tipFormat }) {
  const W = 360, H = height, padL = 44, padR = 8, padT = 12, padB = 24;
  const n = dates.length; if (!n) return '<div class="empty">Sin datos para este periodo</div>';
  const all = series.flatMap((s) => s.data).filter((v) => v != null && !isNaN(v));
  let min = Math.min(...all), max = Math.max(...all);
  if (!isFinite(min)) return '<div class="empty">Sin datos</div>';
  const padV = (max - min) * 0.08 || Math.abs(max) * 0.05 || 1; min -= padV; max += padV; if (min < 0 && Math.min(...all) >= 0) min = 0;
  const { lo, hi, ticks } = niceTicks(min, max, 4);
  const x = (i) => padL + (n === 1 ? 0 : i / (n - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const id = 'c' + Math.random().toString(36).slice(2, 8);
  let g = ticks.map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="var(--grid)" stroke-width="1"/><text x="${padL - 6}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--ink-3)">${yFormat(t)}</text>`).join('');
  const xi = [0, Math.floor((n - 1) / 3), Math.floor(2 * (n - 1) / 3), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  g += xi.map((i) => `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" font-size="10" fill="var(--ink-3)">${fmtDate(dates[i], n > 200)}</text>`).join('');
  let paths = '';
  series.forEach((s, si) => {
    const pts = s.data.map((v, i) => v == null || isNaN(v) ? null : [x(i), y(v)]);
    let d = '', started = false;
    pts.forEach((p) => { if (!p) { started = false; return; } d += (started ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); started = true; });
    if (showArea && si === 0) {
      const firstI = pts.findIndex(Boolean), lastI = pts.length - 1 - [...pts].reverse().findIndex(Boolean);
      if (firstI >= 0) paths += `<path d="${d} L${x(lastI).toFixed(1)} ${y(lo).toFixed(1)} L${x(firstI).toFixed(1)} ${y(lo).toFixed(1)} Z" fill="url(#g${id})" opacity="0.9"/>`;
    }
    paths += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" ${s.dash ? 'stroke-dasharray="4 4"' : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
  });
  const svg = `<svg viewBox="0 0 ${W} ${H}" data-chart="${id}"><defs><linearGradient id="g${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${series[0].color}" stop-opacity="0.22"/><stop offset="1" stop-color="${series[0].color}" stop-opacity="0"/></linearGradient></defs>${g}${paths}<g class="cross" opacity="0"><line y1="${padT}" y2="${H - padB}" stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="3 3"/>${series.map((s) => `<circle r="4.5" fill="${s.color}" stroke="#fff" stroke-width="2"/>`).join('')}</g></svg><div class="tip"></div>`;
  // interacción tras montar
  queueMicrotask(() => {
    const el = $(`svg[data-chart="${id}"]`); if (!el) return;
    const wrap = el.parentElement; const tip = $('.tip', wrap); const cross = $('.cross', el); const line = $('line', cross); const dots = $$('circle', cross);
    const move = (clientX) => {
      const r = el.getBoundingClientRect(); const px = (clientX - r.left) / r.width * W; const i = clamp(Math.round((px - padL) / (W - padL - padR) * (n - 1)), 0, n - 1);
      const cx = x(i); line.setAttribute('x1', cx); line.setAttribute('x2', cx); cross.setAttribute('opacity', '1');
      series.forEach((s, k) => { const v = s.data[i]; if (v == null) { dots[k].setAttribute('opacity', 0); return; } dots[k].setAttribute('opacity', 1); dots[k].setAttribute('cx', cx); dots[k].setAttribute('cy', y(v)); });
      tip.innerHTML = tipFormat ? tipFormat(i) : `<b>${fmtDate(dates[i])}</b><br>${series.map((s) => `${s.label}: ${eur(s.data[i])}`).join('<br>')}`;
      tip.style.opacity = '1'; const tw = tip.offsetWidth; const left = clamp(cx / W * r.width, tw / 2 + 2, r.width - tw / 2 - 2);
      tip.style.left = left + 'px'; tip.style.top = (padT / H * r.height - 6) + 'px';
    };
    const end = () => { cross.setAttribute('opacity', '0'); tip.style.opacity = '0'; };
    el.addEventListener('touchstart', (e) => { move(e.touches[0].clientX); }, { passive: true });
    el.addEventListener('touchmove', (e) => { move(e.touches[0].clientX); }, { passive: true });
    el.addEventListener('touchend', end); el.addEventListener('mousemove', (e) => move(e.clientX)); el.addEventListener('mouseleave', end);
  });
  return `<div class="chart">${svg}</div>`;
}

function donut(items, { size = 150, centerBig = '', centerSmall = '' }) {
  const total = sum(items, (i) => i.value) || 1; const r = 60, cx = 75, cy = 75, sw = 18;
  let a0 = -Math.PI / 2; let paths = '';
  for (const it of items) {
    const frac = it.value / total; if (frac <= 0) continue;
    const a1 = a0 + frac * 2 * Math.PI; const gap = frac < 0.999 ? 0.025 : 0;
    const s = a0 + gap / 2, e = a1 - gap / 2; const large = e - s > Math.PI ? 1 : 0;
    const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const [x0, y0] = p(s), [x1, y1] = p(e);
    paths += frac >= 0.999 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${it.color}" stroke-width="${sw}"/>` : `<path d="M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}" fill="none" stroke="${it.color}" stroke-width="${sw}" stroke-linecap="butt"/>`;
    a0 = a1;
  }
  return `<svg viewBox="0 0 150 150" width="${size}" height="${size}">${paths}<text x="75" y="72" text-anchor="middle" font-size="18" font-weight="700" fill="var(--ink)">${esc(centerBig)}</text><text x="75" y="88" text-anchor="middle" font-size="10" fill="var(--ink-3)">${esc(centerSmall)}</text></svg>`;
}

function hbars(rows, { max = null, color = 'var(--accent)', fmt = (v) => pct(v, 1, false), targets = null } = {}) {
  const m = max ?? Math.max(...rows.map((r) => Math.max(r.value, targets?.[r.key] || 0)), 0.0001);
  return `<div class="hbars">${rows.map((r) => `<div class="hbar"><div class="lab"><span>${r.color ? `<span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${r.color};margin-right:7px"></span>` : ''}${esc(r.label)}</span><b class="num">${fmt(r.value)}${targets && targets[r.key] != null ? `<span class="muted"> / ${pct(targets[r.key], 0, false)}</span>` : ''}</b></div><div class="track"><div class="fill" style="width:${clamp(r.value / m * 100, 0, 100)}%;background:${r.color || color}"></div>${targets && targets[r.key] != null ? `<div class="target" style="left:${clamp(targets[r.key] / m * 100, 0, 100)}%"></div>` : ''}</div></div>`).join('')}</div>`;
}

function barChart(labels, values, { height = 160, color = 'var(--accent)', fmt = (v) => eur(v) } = {}) {
  const W = 360, H = height, padL = 36, padR = 6, padT = 10, padB = 22; const n = labels.length; if (!n) return '<div class="empty">Sin datos</div>';
  const max = Math.max(...values, 0.01); const { hi, ticks } = niceTicks(0, max, 3);
  const bw = (W - padL - padR) / n; const y = (v) => padT + (1 - v / hi) * (H - padT - padB);
  let g = ticks.map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="var(--grid)"/><text x="${padL - 5}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--ink-3)">${fmtAxis(t)}</text>`).join('');
  const bars = values.map((v, i) => { const x0 = padL + i * bw + bw * 0.2; const w = bw * 0.6; const h = Math.max(0, y(0) - y(v)); return `<rect x="${x0.toFixed(1)}" y="${y(v).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${color}"><title>${esc(labels[i])}: ${fmt(v)}</title></rect>`; }).join('');
  const xl = labels.map((l, i) => (n <= 8 || i % Math.ceil(n / 8) === 0) ? `<text x="${(padL + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--ink-3)">${esc(l)}</text>` : '').join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}">${g}${bars}${xl}</svg></div>`;
}

// ---------------------------------------------------------------------------
// UI: cabecera, tabs, sheets
// ---------------------------------------------------------------------------
const TITLES = { resumen: 'Resumen', posiciones: 'Posiciones', analisis: 'Análisis', calendario: 'Calendario', objetivo: 'Objetivo', operaciones: 'Operaciones' };

function updateHeader() {
  const lab = $('#updated-label');
  if (!S.prices) { lab.textContent = 'Sin precios todavía · toca ↻'; return; }
  const d = new Date(S.prices.updated); const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const rel = mins < 2 ? 'ahora' : mins < 60 ? `hace ${mins} min` : mins < 60 * 36 ? `hace ${Math.round(mins / 60)} h` : fmtDate(S.prices.updated.slice(0, 10));
  const errs = S.status?.errors ? Object.keys(S.status.errors).length : 0;
  lab.textContent = `Precios ${rel}${errs ? ` · ${errs} sin cotización` : ''}`;
}

function setTab(tab) { S.ui.tab = tab; store.set('ui', S.ui); $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab)); $('#page-title').textContent = TITLES[tab]; render(); window.scrollTo(0, 0); }
$('#tabbar').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) setTab(b.dataset.tab); });
$('#btn-refresh').addEventListener('click', async () => {
  const b = $('#btn-refresh'); b.classList.add('spin');
  const [prices, events, status] = await Promise.all([fetchJSON('data/prices.json', { optional: true }), fetchJSON('data/events.json', { optional: true }), fetchJSON('data/status.json', { optional: true })]);
  if (prices) { S.prices = prices; S.events = events || S.events; S.status = status; resolveValueRefLots(); recompute(); updateHeader(); render(); toast('Precios actualizados'); } else toast('No se pudieron descargar los precios');
  b.classList.remove('spin');
});

function openSheet(title, body, onMount) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet"><div class="grab"></div><div class="sheet-head"><h2>${esc(title)}</h2><button class="close-btn" aria-label="Cerrar">✕</button></div><div class="sheet-body">${body}</div></div>`;
  document.body.style.overflow = 'hidden';
  const close = () => { root.innerHTML = ''; document.body.style.overflow = ''; };
  $('.sheet-backdrop', root).addEventListener('click', close); $('.close-btn', root).addEventListener('click', close);
  if (onMount) onMount(root, close);
  return close;
}

function render() {
  if (!S.loaded) return;
  const v = $('#view'); const fab = $('.fab'); if (fab) fab.remove();
  switch (S.ui.tab) {
    case 'resumen': v.innerHTML = viewResumen(); break;
    case 'posiciones': v.innerHTML = viewPosiciones(); break;
    case 'analisis': v.innerHTML = viewAnalisis(); break;
    case 'calendario': v.innerHTML = viewCalendario(); break;
    case 'objetivo': v.innerHTML = viewObjetivo(); mountObjetivo(); break;
    case 'operaciones': v.innerHTML = viewOperaciones(); mountOperaciones(); break;
  }
  bindCommon();
}

function bindCommon() {
  $$('[data-range]').forEach((b) => b.addEventListener('click', () => { S.ui.range = b.dataset.range; store.set('ui', S.ui); render(); }));
  $$('[data-pos]').forEach((el) => el.addEventListener('click', () => openPosition(el.dataset.pos)));
  $$('[data-broker]').forEach((b) => b.addEventListener('click', () => { S.ui.broker = b.dataset.broker; store.set('ui', S.ui); render(); }));
  $$('[data-sort]').forEach((b) => b.addEventListener('click', () => { S.ui.sort = b.dataset.sort; store.set('ui', S.ui); render(); }));
  $$('[data-tx-edit]').forEach((el) => el.addEventListener('click', () => openTxForm(el.dataset.txEdit)));
}

const rangeBar = (ranges = ['1S', '1M', '3M', '6M', 'YTD', '1A', 'Todo']) => `<div class="ranges">${ranges.map((r) => `<button data-range="${r}" class="${S.ui.range === r ? 'active' : ''}">${r}</button>`).join('')}</div>`;
const initials = (s) => { const w = String(s).replace(/[^A-Za-zÁ-ú0-9 ]/g, '').trim().split(/\s+/).filter(Boolean); return (w.length >= 2 ? w[0][0] + w[1][0] : (w[0] || '?').slice(0, 2)).toUpperCase(); };
const avatar = (ins) => `<div class="avatar" style="background:${ins.color || S.buckets[ins.bucket]?.color || '#888'}">${esc(initials(ins.short || ins.name))}</div>`;

// ---------------------------------------------------------------------------
// Vista: Resumen
// ---------------------------------------------------------------------------
function viewResumen() {
  const T = C.totals; const s = C.series; const pr = periodReturn(S.ui.range);
  const start = rangeStart(S.ui.range); const i0 = Math.max(0, s.dates.findIndex((d) => d >= start));
  const dates = s.dates.slice(i0), val = s.value.slice(i0), inv = s.invested.slice(i0);
  const chart = lineChart({ dates, series: [{ label: 'Valor', data: val, color: 'var(--accent)' }, { label: 'Aportado', data: inv, color: '#898781', dash: true, width: 1.5 }], tipFormat: (i) => `<b>${fmtDate(dates[i])}</b><br>Valor: ${eur(val[i])}<br>Aportado: ${eur(inv[i])}<br>Resultado: <b>${eurS(val[i] - inv[i])}</b>` });
  const buckets = bucketTotals().filter((b) => b.value > 0);
  const open = Object.values(C.positions).filter((p) => p.units > 1e-9 && p.dayPct != null).sort((a, b) => b.dayPct - a.dayPct);
  const movers = open.length >= 2 ? [open[0], open[open.length - 1]] : open;
  const missing = T.feedMissing;
  return `
  <section class="card hero">
    <div class="label">Valor de la cartera</div>
    <div class="value num">${eur(T.value)}</div>
    <div class="delta"><span class="pill ${cls(T.dayChange)}">${eurS(T.dayChange)} · ${pct(T.dayPct)}</span><span class="muted small">hoy</span></div>
  </section>
  ${missing.length ? `<div class="notice">Sin cotización para ${missing.map((id) => esc(byId[id].short)).join(', ')}: ${S.prices ? 'introduce el precio a mano desde la posición.' : 'los precios se descargan cuando se publique la app.'}</div>` : ''}
  <div class="stats">
    <div class="stat"><div class="k">Invertido</div><div class="v num">${eur(T.cost, 0)}</div><div class="s muted">${Object.values(C.positions).filter((p) => p.units > 1e-9).length} posiciones</div></div>
    <div class="stat"><div class="k">Ganancia latente</div><div class="v num ${cls(T.pl)}">${eurS(T.pl, 0)}</div><div class="s ${cls(T.pl)}">${pct(T.plPct)}</div></div>
    <div class="stat"><div class="k">Realizado</div><div class="v num ${cls(T.realized)}">${eurS(T.realized, 0)}</div><div class="s muted">${C.realized.length} ventas</div></div>
    <div class="stat"><div class="k">Dividendos e intereses</div><div class="v num">${eur(T.dividendsNet + T.interest + T.other, 0)}</div><div class="s muted">netos</div></div>
  </div>
  <section class="card">
    <div class="row" style="margin-bottom:10px"><h2 style="margin:0">Evolución</h2>${pr ? `<span class="pill ${cls(pr.gain)}">${eurS(pr.gain, 0)} · ${pr.pct != null ? pct(pr.pct) : '—'}</span>` : ''}</div>
    ${rangeBar()}
    <div style="height:10px"></div>
    ${chart}
    <div class="legend"><span><span class="ln" style="border-color:var(--accent)"></span>Valor</span><span><span class="ln dash" style="border-color:#898781"></span>Aportado neto</span></div>
    <div class="small muted" style="margin-top:8px">Rentabilidad del periodo calculada con el método Dietz modificado, que descuenta las aportaciones y retiradas.</div>
  </section>
  <section class="card">
    <h2>Reparto</h2>
    <div style="display:flex;height:12px;border-radius:6px;overflow:hidden;gap:2px">${buckets.map((b) => `<div style="width:${b.value / T.value * 100}%;background:${b.color}"></div>`).join('')}</div>
    <div class="legend">${buckets.map((b) => `<span><span class="dot" style="background:${b.color}"></span>${esc(b.label)} <b>${pct(b.value / T.value * 100, 0, false)}</b></span>`).join('')}</div>
  </section>
  ${movers.length ? `<section class="card"><h2>Hoy</h2><div class="movers">${movers.map((p) => `<div class="mover tap" data-pos="${p.id}"><div class="n">${esc(byId[p.id].short)}</div><div class="p num ${cls(p.dayPct)}">${pct(p.dayPct)}</div><div class="small muted">${eurS(p.dayChange)}</div></div>`).join('')}</div></section>` : ''}
  ${plBars()}
  <section class="card">
    <h2>Resultado total <span class="sub">desde el inicio</span></h2>
    <table class="tbl">
      <tr><td>Ganancia latente</td><td class="r num ${cls(T.pl)}">${eurS(T.pl)}</td></tr>
      <tr><td>Plusvalías realizadas</td><td class="r num ${cls(T.realized)}">${eurS(T.realized)}</td></tr>
      <tr><td>Dividendos netos</td><td class="r num">${eurS(T.dividendsNet)}</td></tr>
      <tr><td>Intereses netos</td><td class="r num">${eurS(T.interest)}</td></tr>
      ${T.other ? `<tr><td>Promociones y otros</td><td class="r num">${eurS(T.other)}</td></tr>` : ''}
      <tr><td><b>Total</b></td><td class="r num ${cls(T.total)}"><b>${eurS(T.total)}</b></td></tr>
    </table>
    <div class="small muted" style="margin-top:8px">Comisiones pagadas: ${eur(T.fees + T.taxes)} (ya descontadas).</div>
  </section>`;
}


function plBars() {
  const rows = Object.values(C.positions).map((p) => ({ label: byId[p.id].short, value: p.pl + p.realized + (p.dividends - p.dividendsTax), color: byId[p.id].color })).filter((r) => Math.abs(r.value) > 0.5).sort((a, b) => b.value - a.value);
  if (!rows.length) return '';
  const m = Math.max(...rows.map((r) => Math.abs(r.value)));
  return `<section class="card"><h2>Resultado por activo <span class="sub">€, total desde el inicio</span></h2><div class="hbars">${rows.map((r) => `<div class="hbar"><div class="lab"><span><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${r.color};margin-right:7px"></span>${esc(r.label)}</span><b class="num ${cls(r.value)}">${eurS(r.value, 0)}</b></div><div class="track" style="background:transparent"><div style="position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:var(--grid)"></div><div class="fill" style="left:${r.value >= 0 ? 50 : 50 - Math.abs(r.value) / m * 50}%;width:${Math.abs(r.value) / m * 50}%;background:${r.value >= 0 ? 'var(--good-fill)' : 'var(--bad-fill)'};opacity:0.85"></div></div></div>`).join('')}</div><div class="small muted" style="margin-top:8px">Incluye ganancia latente, plusvalías realizadas y dividendos netos. Toca Posiciones para ver el detalle.</div></section>`;
}

// ---------------------------------------------------------------------------
// Vista: Posiciones
// ---------------------------------------------------------------------------
function viewPosiciones() {
  let list = Object.values(C.positions).filter((p) => p.units > 1e-9);
  if (S.ui.broker !== 'all') list = list.filter((p) => byId[p.id].broker === S.ui.broker);
  const sorters = { valor: (a, b) => b.value - a.value, dia: (a, b) => (b.dayPct ?? -999) - (a.dayPct ?? -999), rent: (a, b) => (b.plPct ?? -999) - (a.plPct ?? -999), nombre: (a, b) => byId[a.id].short.localeCompare(byId[b.id].short) };
  list.sort(sorters[S.ui.sort] || sorters.valor);
  const total = sum(list, (p) => p.value), day = sum(list, (p) => p.dayChange), pl = sum(list, (p) => p.pl), cost = sum(list, (p) => p.cost);
  const brokers = ['all', ...new Set(S.instruments.map((i) => i.broker))];
  const groups = {}; for (const p of list) { const b = byId[p.id].bucket; (groups[b] = groups[b] || []).push(p); }
  const order = Object.keys(groups).sort((a, b) => (S.buckets[a]?.order ?? 99) - (S.buckets[b]?.order ?? 99));
  const item = (p) => { const ins = byId[p.id]; return `<div class="item tap" data-pos="${p.id}">${avatar(ins)}<div class="main"><div class="t">${esc(ins.short)}${p.lots.some((l) => l.estimated) ? '<span class="tag est">est.</span>' : ''}</div><div class="s">${num(p.units, p.units % 1 ? (p.units >= 10 ? 2 : 4) : 0)} ud · ${p.price != null ? eur(p.price, p.price < 20 ? 3 : 2) : 'sin precio'} · ${pct(p.weight, 1, false)}</div></div><div class="right"><div class="v num">${eur(p.value, 0)}</div><div class="d num"><span class="${cls(p.dayPct)}">${p.dayPct != null ? pct(p.dayPct) : '—'}</span> <span class="muted">·</span> <span class="${cls(p.plPct)}">${p.plPct != null ? pct(p.plPct) : '—'}</span></div></div></div>`; };
  return `
  <div class="seg">${brokers.map((b) => `<button data-broker="${esc(b)}" class="${S.ui.broker === b ? 'active' : ''}">${b === 'all' ? 'Todo' : esc(b)}</button>`).join('')}</div>
  <section class="card tight"><div class="summary3"><div><div class="small muted">Valor</div><div class="num n big">${eur(total, 0)}</div></div><div class="r"><div class="small muted">Hoy</div><div class="num n ${cls(day)}">${eurS(day, 0)}</div><div class="small num ${cls(day)}">${pct(sum(list, (p) => p.value - p.dayChange) ? day / sum(list, (p) => p.value - p.dayChange) * 100 : 0)}</div></div><div class="r"><div class="small muted">Desde compra</div><div class="num n ${cls(pl)}">${eurS(pl, 0)}</div><div class="small num ${cls(pl)}">${cost ? pct(pl / cost * 100) : '—'}</div></div></div></section>
  <div class="sortbar">${[['valor', 'Por valor'], ['dia', 'Por día'], ['rent', 'Por rentabilidad'], ['nombre', 'A–Z']].map(([k, l]) => `<button class="chip ${S.ui.sort === k ? 'active' : ''}" data-sort="${k}">${l}</button>`).join('')}</div>
  ${order.map((b) => `<div class="group-title">${esc(S.buckets[b]?.label || b)} · ${eur(sum(groups[b], (p) => p.value), 0)}</div><section class="card tight"><div class="list">${groups[b].map(item).join('')}</div></section>`).join('')}
  ${!list.length ? '<div class="empty">No hay posiciones abiertas con este filtro.</div>' : ''}
  <div class="small muted" style="text-align:center">Día · desde compra. Toca una posición para ver el detalle.</div>
  ${plTable(S.ui.broker)}`;
}


// Resultado total por activo (latente + realizado + dividendos), incluidas posiciones cerradas.
function plTable(broker) {
  let rows = Object.values(C.positions).filter((p) => broker === 'all' || byId[p.id].broker === broker).map((p) => {
    const invested = p.cost + sum(C.realized.filter((r) => r.id === p.id), (r) => r.cost);
    const total = p.pl + p.realized + (p.dividends - p.dividendsTax);
    return { p, invested, total, pct: invested ? total / invested * 100 : null, open: p.units > 1e-9 };
  }).filter((r) => Math.abs(r.total) > 0.004 || r.open).sort((a, b) => b.total - a.total);
  if (!rows.length) return '';
  const tot = sum(rows, (r) => r.total);
  return `<section class="card"><h2>Resultado por activo <span class="sub">latente + realizado + dividendos</span></h2>
    <table class="tbl compact"><tr><th>Activo</th><th class="r">Latente</th><th class="r">Realizado</th><th class="r">Total</th></tr>
    ${rows.map((r) => `<tr><td><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${byId[r.p.id].color || '#888'};margin-right:6px"></span>${esc(byId[r.p.id].short)}${r.open ? '' : '<span class="tag">cerrada</span>'}</td><td class="r num ${cls(r.p.pl)}">${r.open ? eurS(r.p.pl) : '—'}</td><td class="r num ${cls(r.p.realized + r.p.dividends - r.p.dividendsTax)}">${eurS(r.p.realized + r.p.dividends - r.p.dividendsTax)}</td><td class="r num ${cls(r.total)}"><b>${eurS(r.total)}</b><div class="muted" style="font-size:10px">${r.pct != null ? pct(r.pct) : ''}</div></td></tr>`).join('')}
    <tr><td><b>Total</b></td><td class="r num ${cls(sum(rows, (r) => r.p.pl))}">${eurS(sum(rows, (r) => r.p.pl))}</td><td class="r num">${eurS(sum(rows, (r) => r.p.realized + r.p.dividends - r.p.dividendsTax))}</td><td class="r num ${cls(tot)}"><b>${eurS(tot)}</b></td></tr></table>
    <div class="small muted" style="margin-top:8px">El porcentaje es sobre el total invertido en cada activo a lo largo del tiempo. Realizado incluye dividendos netos.</div></section>`;
}

function openPosition(id) {
  const p = C.positions[id]; const ins = byId[id]; if (!p || !ins) return;
  const ev = S.events?.instruments?.[id] || {}; const h = S.prices?.history?.[id] || [];
  const ccy = quoteCurrency(id); const range = p._range || '6M'; const start = rangeStart(range === 'Todo' ? 'Todo' : range);
  const hs = h.filter(([d]) => range === 'Todo' || d >= start).map(([d, v]) => [d, toEUR(v, ccy, d)]);
  const chart = hs.length > 1 ? lineChart({ dates: hs.map((x) => x[0]), series: [{ label: 'Precio', data: hs.map((x) => x[1]), color: ins.color || 'var(--accent)' }], height: 180, yFormat: (v) => num(v, v < 20 ? 2 : 0), tipFormat: (i) => `<b>${fmtDate(hs[i][0])}</b><br>${eur(hs[i][1], hs[i][1] < 20 ? 3 : 2)}` }) : '<div class="empty">Sin histórico de precios</div>';
  const chg = hs.length > 1 ? (hs[hs.length - 1][1] / hs[0][1] - 1) * 100 : null;
  const divs = C.dividends.filter((d) => d.id === id).sort((a, b) => b.date.localeCompare(a.date));
  const sells = C.realized.filter((r) => r.id === id);
  const q = S.prices?.quotes?.[id];
  const body = `
  <section class="card hero" style="padding:16px">
    <div class="row"><div><div class="label">${esc(ins.name)}</div><div class="value num" style="font-size:30px">${eur(p.value)}</div></div>${avatar(ins)}</div>
    <div class="delta"><span class="pill ${cls(p.dayChange)}">${eurS(p.dayChange)} · ${pct(p.dayPct)} hoy</span><span class="pill ${cls(p.pl)}">${eurS(p.pl)} · ${pct(p.plPct)} total</span></div>
  </section>
  <section class="card">
    <div class="row" style="margin-bottom:8px"><h2 style="margin:0">Precio <span class="sub">${p.price != null ? eur(p.price, p.price < 20 ? 3 : 2) : '—'}${q && q.currency !== 'EUR' ? ` · ${num(q.price)} ${q.currency}` : ''}</span></h2>${chg != null ? `<span class="pill ${cls(chg)}">${pct(chg)}</span>` : ''}</div>
    <div class="ranges" id="pos-ranges">${['1M', '3M', '6M', '1A', 'Todo'].map((r) => `<button data-prange="${r}" class="${range === r ? 'active' : ''}">${r}</button>`).join('')}</div>
    <div style="height:10px"></div>${chart}
    <div class="small muted" style="margin-top:6px">${p.priceSource === 'manual' ? 'Precio introducido a mano' : p.priceDate ? `Último dato: ${fmtDate(p.priceDate)}${ins.type === 'fund' ? ' (valor liquidativo)' : ''}` : 'Sin cotización'}${ins.type === 'fund' || ins.type === 'etc' || !hasFeed(id) ? ` · <span class="link" id="manual-price">${p.priceSource === 'manual' ? 'Cambiar precio' : 'Precio manual'}</span>` : ''}</div>
  </section>
  <section class="card"><h2>Posición</h2><div class="kv">
    <div><div class="k">Títulos</div><div class="v num">${num(p.units, p.units % 1 ? 6 : 0)}</div></div>
    <div><div class="k">Coste medio</div><div class="v num">${eur(p.avgCost, p.avgCost < 20 ? 4 : 2)}</div></div>
    <div><div class="k">Invertido</div><div class="v num">${eur(p.cost)}</div></div>
    <div><div class="k">Peso en cartera</div><div class="v num">${pct(p.weight, 1, false)}</div></div>
    <div><div class="k">Bróker</div><div class="v">${esc(ins.broker)}</div></div>
    <div><div class="k">Tipo</div><div class="v">${{ stock: 'Acción', etc: 'ETC', fund: 'Fondo', etf: 'ETF' }[ins.type] || ins.type}${ins.ter ? ` · TER ${num(ins.ter, 2)} %` : ''}</div></div>
    ${ev.high52 ? `<div><div class="k">Rango 52 semanas</div><div class="v num">${num(ev.low52)} – ${num(ev.high52)} ${q?.currency || ''}</div></div>` : ''}
    ${ev.pe ? `<div><div class="k">PER</div><div class="v num">${num(ev.pe, 1)}${ev.forwardPE ? ` <span class="muted small">(${num(ev.forwardPE, 1)} fwd)</span>` : ''}</div></div>` : ''}
    ${ev.dividendYield ? `<div><div class="k">Rentabilidad por dividendo</div><div class="v num">${pct(ev.dividendYield > 1 ? ev.dividendYield : ev.dividendYield * 100, 2, false)}</div></div>` : ''}
    ${ev.marketCap ? `<div><div class="k">Capitalización</div><div class="v num">${(ev.marketCap / 1e9).toFixed(0)} mil M ${q?.currency || ''}</div></div>` : ''}
    ${ev.beta ? `<div><div class="k">Beta</div><div class="v num">${num(ev.beta, 2)}</div></div>` : ''}
    <div><div class="k">ISIN</div><div class="v" style="font-size:13px">${esc(ins.isin || '—')}</div></div>
  </div></section>
  ${(ev.earnings?.length || ev.exDividend) ? `<section class="card"><h2>Próximos eventos</h2>${ev.earnings?.length ? `<div class="row"><span>Resultados</span><b>${ev.earnings.map((d) => fmtDate(d)).join(' / ')}</b></div>` : ''}${ev.exDividend ? `<div class="row" style="margin-top:6px"><span>Fecha ex-dividendo</span><b>${fmtDate(ev.exDividend)}</b></div>` : ''}${ev.payDate ? `<div class="row" style="margin-top:6px"><span>Pago</span><b>${fmtDate(ev.payDate)}</b></div>` : ''}</section>` : ''}
  <section class="card"><h2>Lotes abiertos (FIFO)</h2><table class="tbl"><tr><th>Fecha</th><th class="r">Títulos</th><th class="r">Coste/ud</th><th class="r">Resultado</th></tr>
    ${p.lots.map((l) => `<tr><td>${fmtDate(l.date)}${l.estimated ? '<span class="tag est">est.</span>' : ''}</td><td class="r num">${num(l.units, l.units % 1 ? 4 : 0)}</td><td class="r num">${eur(l.cpu, l.cpu < 20 ? 3 : 2)}</td><td class="r num ${cls((p.price ?? 0) - l.cpu)}">${p.price != null ? pct((p.price / l.cpu - 1) * 100) : '—'}</td></tr>`).join('')}
  </table></section>
  ${sells.length ? `<section class="card"><h2>Ventas realizadas</h2><table class="tbl"><tr><th>Fecha</th><th class="r">Títulos</th><th class="r">Importe</th><th class="r">Plusvalía</th></tr>${sells.map((r) => `<tr><td>${fmtDate(r.date)}</td><td class="r num">${num(r.units, r.units % 1 ? 4 : 0)}</td><td class="r num">${eur(r.proceeds)}</td><td class="r num ${cls(r.gain)}">${eurS(r.gain)}</td></tr>`).join('')}<tr><td><b>Total</b></td><td></td><td></td><td class="r num ${cls(p.realized)}"><b>${eurS(p.realized)}</b></td></tr></table></section>` : ''}
  ${divs.length ? `<section class="card"><h2>Dividendos cobrados <span class="sub">${eur(p.dividends - p.dividendsTax)} netos</span></h2><table class="tbl"><tr><th>Fecha</th><th class="r">Bruto</th><th class="r">Retención</th><th class="r">Neto</th></tr>${divs.map((d) => `<tr><td>${fmtDate(d.date)}${d.note ? `<div class="small muted">${esc(d.note)}</div>` : ''}</td><td class="r num">${eur(d.amount)}</td><td class="r num">${eur(d.tax)}</td><td class="r num">${eur(d.amount - d.tax)}</td></tr>`).join('')}</table></section>` : ''}
  <div class="btn-row"><button class="btn secondary" id="pos-add-tx">Añadir operación</button></div>`;
  openSheet(ins.short, body, (root, close) => {
    $$('[data-prange]', root).forEach((b) => b.addEventListener('click', () => { p._range = b.dataset.prange; close(); openPosition(id); }));
    $('#pos-add-tx', root).addEventListener('click', () => { close(); openTxForm(null, id); });
    const mp = $('#manual-price', root); if (mp) mp.addEventListener('click', () => { close(); openManualPrice(id); });
  });
}

function openManualPrice(id) {
  const ins = byId[id]; const m = S.manualPrices[id] || {};
  openSheet('Precio manual · ' + ins.short, `<div class="form">
    <div class="notice">Úsalo cuando no haya cotización automática. Introduce el valor liquidativo o precio en euros por título y la fecha a la que corresponde.</div>
    <div class="grid2"><div class="field"><label>Precio (€)</label><input id="mp-price" type="number" step="any" inputmode="decimal" value="${m.price ?? ''}"></div><div class="field"><label>Fecha</label><input id="mp-date" type="date" value="${m.date || todayISO()}"></div></div>
    <div class="field"><label>Precio anterior (€, opcional, para la variación del día)</label><input id="mp-prev" type="number" step="any" inputmode="decimal" value="${m.prev ?? ''}"></div>
    <div class="btn-row"><button class="btn primary" id="mp-save">Guardar</button>${m.price ? '<button class="btn danger" id="mp-del">Quitar</button>' : ''}</div></div>`, (root, close) => {
    $('#mp-save', root).addEventListener('click', () => { const price = parseFloat($('#mp-price', root).value); if (!(price > 0)) return toast('Introduce un precio válido'); const prev = parseFloat($('#mp-prev', root).value); S.manualPrices[id] = { price, date: $('#mp-date', root).value || todayISO(), prev: prev > 0 ? prev : undefined }; store.set('manualPrices', S.manualPrices); resolveValueRefLots(); recompute(); render(); close(); toast('Precio guardado'); });
    const del = $('#mp-del', root); if (del) del.addEventListener('click', () => { delete S.manualPrices[id]; store.set('manualPrices', S.manualPrices); recompute(); render(); close(); });
  });
}

// ---------------------------------------------------------------------------
// Vista: Análisis
// ---------------------------------------------------------------------------
function viewAnalisis() {
  const T = C.totals; const ex = exposure(); const buckets = bucketTotals().filter((b) => b.value > 0);
  const open = Object.values(C.positions).filter((p) => p.units > 1e-9).sort((a, b) => b.value - a.value);
  const top5 = sum(open.slice(0, 5), (p) => p.weight);
  const terW = sum(open, (p) => (byId[p.id].ter || 0) * p.value) / (T.value || 1);
  const brokers = {}; for (const p of open) brokers[byId[p.id].broker] = (brokers[byId[p.id].broker] || 0) + p.value;
  const rows = (arr, n = 8, color) => hbars(arr.slice(0, n).map(([k, v]) => ({ label: k, value: v, color })), { max: Math.max(arr[0]?.[1] || 1, 1) });
  const colorsLT = { 'Renta variable': '#2a78d6', 'Renta fija': '#008300', Oro: '#eda100', Cripto: '#e87ba4', Liquidez: '#898781', Otros: '#898781' };
  return `
  <section class="card"><h2>Reparto por bloque</h2>
    <div class="donut-wrap">${donut(buckets, { centerBig: eur(T.value, 0).replace(',00', ''), centerSmall: 'total' })}<div class="legend">${buckets.map((b) => `<div class="lrow"><span><span class="dot" style="background:${b.color}"></span>${esc(b.label)}</span><b class="num">${pct(b.value / T.value * 100, 1, false)}</b></div>`).join('')}</div></div>
  </section>
  <section class="card"><h2>Clase de activo <span class="sub">mirando dentro de fondos y ETC</span></h2>${hbars(ex.assetClass.map(([k, v]) => ({ label: k, value: v, color: colorsLT[k] || '#898781' })), { max: 100 })}</section>
  <section class="card"><h2>Sectores</h2>${rows(ex.sectors, 10)}<div class="small muted" style="margin-top:8px">Las acciones se cuentan por su sector; los fondos, por la composición aproximada de su índice o cartera.</div></section>
  <section class="card"><h2>Países y regiones</h2>${rows(ex.countries, 10, '#1baf7a')}</section>
  <section class="card"><h2>Divisas</h2>${rows(ex.currencies, 8, '#eb6834')}<div class="small muted" style="margin-top:8px">Exposición económica a cada divisa. Los fondos no cubiertos siguen la divisa de sus activos.</div></section>
  <section class="card"><h2>Mayores empresas <span class="sub">directo + indirecto</span></h2>${rows(ex.companies, 10, '#4a3aa7')}<div class="small muted" style="margin-top:8px">Suma lo que tienes en acciones y lo que pesan dentro de tus fondos. Por ejemplo, NVIDIA cuenta tu acción más su peso en el MSCI World.</div></section>
  <section class="card"><h2>Concentración y costes</h2><div class="kv">
    <div><div class="k">Top 5 posiciones</div><div class="v num">${pct(top5, 1, false)}</div></div>
    <div><div class="k">Mayor posición</div><div class="v">${open[0] ? `${esc(byId[open[0].id].short)} · ${pct(open[0].weight, 1, false)}` : '—'}</div></div>
    <div><div class="k">TER medio ponderado</div><div class="v num">${pct(terW, 2, false)}</div></div>
    <div><div class="k">Coste anual estimado</div><div class="v num">${eur(T.value * terW / 100, 0)}</div></div>
    ${Object.entries(brokers).map(([b, v]) => `<div><div class="k">${esc(b)}</div><div class="v num">${eur(v, 0)} · ${pct(v / T.value * 100, 0, false)}</div></div>`).join('')}
  </div></section>
  <div class="small muted" style="text-align:center">Composición de índices y fondos a ${fmtDate(S.lookthrough?.updated)}. Valores aproximados.</div>`;
}

// ---------------------------------------------------------------------------
// Vista: Calendario
// ---------------------------------------------------------------------------
function viewCalendario() {
  const t = todayISO(); const upcoming = [];
  for (const p of Object.values(C.positions)) {
    if (p.units <= 1e-9) continue; const ev = S.events?.instruments?.[p.id]; if (!ev) continue; const ins = byId[p.id];
    for (const d of ev.earnings || []) if (d.slice(0, 10) >= t) upcoming.push({ date: d.slice(0, 10), type: 'Resultados', ins, sub: 'Publicación de resultados trimestrales' });
    if (ev.exDividend && ev.exDividend >= t) upcoming.push({ date: ev.exDividend, type: 'Ex-dividendo', ins, sub: ev.dividendHistory?.length ? `Último dividendo: ${num(ev.dividendHistory.at(-1)[1], 3)} ${quoteCurrency(p.id)} por acción` : '' });
    if (ev.payDate && ev.payDate >= t) upcoming.push({ date: ev.payDate, type: 'Pago de dividendo', ins, sub: ev.dividendHistory?.length ? `≈ ${eur(toEUR(ev.dividendHistory.at(-1)[1], quoteCurrency(p.id), null) * p.units)} brutos` : '' });
  }
  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  // Dividendos cobrados por mes (últimos 12 meses)
  const months = []; for (let i = 11; i >= 0; i--) months.push(addMonths(t.slice(0, 7) + '-01', -i).slice(0, 7));
  const byMonth = months.map((m) => sum(C.dividends.filter((d) => d.date.startsWith(m)), (d) => d.amount - d.tax));
  const byYear = {}; for (const d of C.dividends) byYear[d.date.slice(0, 4)] = (byYear[d.date.slice(0, 4)] || 0) + d.amount - d.tax;
  // Proyección anual
  let proj = 0; const projRows = [];
  for (const p of Object.values(C.positions)) { if (p.units <= 1e-9) continue; const ev = S.events?.instruments?.[p.id]; if (!ev?.dividendTTM) continue; const a = toEUR(ev.dividendTTM, quoteCurrency(p.id), null) * p.units; if (a > 0) { proj += a; projRows.push({ label: byId[p.id].short, value: a }); } }
  projRows.sort((a, b) => b.value - a.value);
  const recent = [...C.dividends].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
  return `
  <section class="card"><h2>Próximos eventos</h2>${upcoming.length ? upcoming.slice(0, 12).map((e) => `<div class="event"><div class="date"><div class="d">${+e.date.slice(8, 10)}</div><div class="m">${MESES[+e.date.slice(5, 7) - 1]}</div></div><div class="body"><div class="t">${esc(e.ins.short)} · ${e.type}</div><div class="s">${esc(e.sub)}</div></div></div>`).join('') : `<div class="empty">${S.events ? 'No hay eventos próximos conocidos para tus acciones. Las fechas se actualizan con los precios.' : 'Las fechas de resultados y dividendos aparecerán cuando se descarguen los datos.'}</div>`}</section>
  <section class="card"><h2>Dividendos netos cobrados <span class="sub">últimos 12 meses · ${eur(sum(byMonth))}</span></h2>${barChart(months.map((m) => MESES[+m.slice(5, 7) - 1]), byMonth, { height: 150, color: '#1baf7a' })}
    <div class="legend">${Object.entries(byYear).map(([y, v]) => `<span>${y}: <b>${eur(v)}</b></span>`).join('')}</div></section>
  <section class="card"><h2>Dividendos esperados <span class="sub">próximos 12 meses · ≈ ${eur(proj, 0)} brutos</span></h2>${projRows.length ? hbars(projRows, { fmt: (v) => eur(v, 2), color: '#1baf7a' }) : '<div class="empty">Sin estimación todavía.</div>'}<div class="small muted" style="margin-top:8px">Estimación con el dividendo pagado en los últimos 12 meses por cada acción. Los fondos de acumulación no reparten dividendo.</div></section>
  <section class="card"><h2>Últimos cobros</h2>${recent.length ? `<table class="tbl"><tr><th>Fecha</th><th>Activo</th><th class="r">Neto</th></tr>${recent.map((d) => `<tr><td>${fmtDate(d.date)}</td><td>${esc(byId[d.id]?.short || d.id)}${d.note ? `<div class="small muted">${esc(d.note)}</div>` : ''}</td><td class="r num">${eur(d.amount - d.tax)}</td></tr>`).join('')}</table>` : '<div class="empty">Aún no has cobrado dividendos.</div>'}</section>`;
}

// ---------------------------------------------------------------------------
// Vista: Objetivo
// ---------------------------------------------------------------------------
function viewObjetivo() {
  const T = C.totals; const buckets = bucketTotals(); const hasT = Object.values(S.targets).some((v) => v > 0);
  const tsum = sum(Object.values(S.targets));
  const rows = buckets.filter((b) => b.value > 0 || S.targets[b.key] > 0).map((b) => ({ key: b.key, label: b.label, color: b.color, value: T.value ? b.value / T.value * 100 : 0 }));
  return `
  <section class="card"><h2>Real frente a objetivo</h2>${hasT ? hbars(rows, { max: 100, targets: S.targets }) : hbars(rows, { max: 100 })}${hasT ? '<div class="small muted" style="margin-top:8px">La raya negra marca el objetivo de cada bloque.</div>' : '<div class="notice" style="margin-top:10px">Todavía no has definido un objetivo. Rellena los porcentajes abajo y guárdalos.</div>'}</section>
  ${hasT ? `<section class="card"><h2>Desviaciones</h2><table class="tbl"><tr><th>Bloque</th><th class="r">Real</th><th class="r">Objetivo</th><th class="r">Diferencia</th></tr>${buckets.filter((b) => b.value > 0 || S.targets[b.key] > 0).map((b) => { const real = T.value ? b.value / T.value * 100 : 0; const tg = S.targets[b.key] || 0; const diffEur = (tg / 100) * T.value - b.value; return `<tr><td><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${b.color};margin-right:7px"></span>${esc(b.label)}</td><td class="r num">${pct(real, 1, false)}</td><td class="r num">${pct(tg, 0, false)}</td><td class="r num ${cls(diffEur)}">${eurS(diffEur, 0)}</td></tr>`; }).join('')}</table><div class="small muted" style="margin-top:8px">Diferencia: lo que habría que comprar (+) o vender (−) para cuadrar con el valor actual.</div></section>` : ''}
  <section class="card"><h2>¿Qué compro este mes?</h2>
    <div class="field"><label>Importe a aportar (€)</label><input id="contrib" type="number" inputmode="decimal" placeholder="Por ejemplo, 500" value="${S.ui.contrib || ''}"></div>
    <div id="contrib-out" style="margin-top:10px"></div>
    <div class="small muted" style="margin-top:8px">Reparte la aportación entre los bloques que están por debajo de su objetivo, en proporción a lo que les falta. No propone ventas.</div>
  </section>
  <section class="card"><h2>Editar objetivo <span class="sub" id="tsum">${hasT ? `suma ${num(tsum, 0)} %` : ''}</span></h2>
    <div class="form">${buckets.map((b) => `<div class="field"><label><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${b.color};margin-right:7px"></span>${esc(b.label)}</label><input data-target="${b.key}" type="number" inputmode="decimal" min="0" max="100" step="1" placeholder="0" value="${S.targets[b.key] ?? ''}"></div>`).join('')}
    <div class="btn-row"><button class="btn primary" id="save-targets">Guardar objetivo</button></div></div>
  </section>`;
}
function mountObjetivo() {
  const T = C.totals; const buckets = bucketTotals();
  const calc = () => {
    const amt = parseFloat($('#contrib').value); const out = $('#contrib-out'); S.ui.contrib = amt || ''; store.set('ui', S.ui);
    if (!(amt > 0)) { out.innerHTML = ''; return; }
    const hasT = Object.values(S.targets).some((v) => v > 0); if (!hasT) { out.innerHTML = '<div class="notice">Define primero un objetivo.</div>'; return; }
    const newTotal = T.value + amt;
    const gaps = buckets.map((b) => ({ b, gap: Math.max(0, (S.targets[b.key] || 0) / 100 * newTotal - b.value) })).filter((g) => g.gap > 0);
    const gsum = sum(gaps, (g) => g.gap); if (!gsum) { out.innerHTML = '<div class="notice">Todos los bloques están en su objetivo. Reparte según los porcentajes objetivo.</div>'; return; }
    const alloc = gaps.map((g) => ({ ...g, amt: Math.min(g.gap, amt * g.gap / gsum) }));
    // Si sobra (porque algún bloque se capó), reparte el resto proporcionalmente al objetivo
    let rest = amt - sum(alloc, (a) => a.amt); if (rest > 0.5) { const tsum = sum(buckets, (b) => S.targets[b.key] || 0) || 1; for (const b of buckets) { const t = S.targets[b.key] || 0; if (!t) continue; const a = alloc.find((x) => x.b.key === b.key); const add = rest * t / tsum; if (a) a.amt += add; else alloc.push({ b, gap: 0, amt: add }); } }
    alloc.sort((a, b) => b.amt - a.amt);
    out.innerHTML = `<table class="tbl"><tr><th>Bloque</th><th class="r">Compra</th><th class="r">Peso después</th></tr>${alloc.filter((a) => a.amt >= 1).map((a) => `<tr><td><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${a.b.color};margin-right:7px"></span>${esc(a.b.label)}</td><td class="r num"><b>${eur(a.amt, 0)}</b></td><td class="r num">${pct((a.b.value + a.amt) / newTotal * 100, 1, false)} <span class="muted">/ ${pct(S.targets[a.b.key] || 0, 0, false)}</span></td></tr>`).join('')}</table>`;
  };
  $('#contrib').addEventListener('input', calc); calc();
  const inputs = $$('[data-target]');
  const upd = () => { const s = sum(inputs, (i) => parseFloat(i.value) || 0); $('#tsum').textContent = s ? `suma ${num(s, 0)} %` : ''; $('#tsum').style.color = Math.abs(s - 100) < 0.01 || !s ? '' : 'var(--bad)'; };
  inputs.forEach((i) => i.addEventListener('input', upd));
  $('#save-targets').addEventListener('click', () => { const t = {}; let s = 0; for (const i of inputs) { const v = parseFloat(i.value) || 0; if (v > 0) t[i.dataset.target] = v; s += v; } if (s && Math.abs(s - 100) > 0.01) return toast(`Los porcentajes suman ${num(s, 0)} %, deben sumar 100`); S.targets = t; store.set('targets', t); render(); toast('Objetivo guardado'); });
}

// ---------------------------------------------------------------------------
// Vista: Operaciones
// ---------------------------------------------------------------------------
function viewOperaciones() {
  const txs = [...S.txs].sort((a, b) => b.date.localeCompare(a.date) || (a.id < b.id ? 1 : -1));
  const years = [...new Set(txs.map((t) => t.date.slice(0, 4)))].sort().reverse();
  const yearRows = years.map((y) => { const R = C.realized.filter((r) => r.date.startsWith(y)); const D = C.dividends.filter((d) => d.date.startsWith(y)); const F = S.txs.filter((t) => t.date.startsWith(y) && (t.type === 'buy' || t.type === 'sell')); const I = (S.seed?.interest || []).filter((i) => String(i.year) === y); return { y, realized: sum(R, (r) => r.gain), divGross: sum(D, (d) => d.amount), divTax: sum(D, (d) => d.tax), fees: sum(F, (t) => (t.fee || 0) + (t.tax || 0)), interest: sum(I, (i) => i.gross), buys: sum(F.filter((t) => t.type === 'buy'), txCost), sells: sum(F.filter((t) => t.type === 'sell'), txProceeds) }; });
  const groups = {}; for (const t of txs) { const k = t.date.slice(0, 7); (groups[k] = groups[k] || []).push(t); }
  const label = (t) => ({ buy: 'Compra', sell: 'Venta', dividend: 'Dividendo' }[t.type] || t.type);
  const amount = (t) => t.type === 'buy' ? -txCost(t) : t.type === 'sell' ? txProceeds(t) : (t.amount || 0) - (t.tax || 0);
  return `
  <section class="card"><h2>Resumen fiscal por año</h2><table class="tbl compact"><tr><th>Año</th><th class="r">Plusvalías</th><th class="r">Dividendos</th><th class="r">Intereses</th><th class="r">Comis.</th></tr>${yearRows.map((r) => `<tr><td><b>${r.y}</b></td><td class="r num ${cls(r.realized)}">${eurS(r.realized)}</td><td class="r num">${eur(r.divGross)}<div class="muted" style="font-size:10px">ret. ${eur(r.divTax)}</div></td><td class="r num">${eur(r.interest)}</td><td class="r num">${eur(r.fees)}</td></tr>`).join('')}</table>
    <div class="small muted" style="margin-top:8px">Plusvalías con criterio FIFO y comisiones descontadas. Las retenciones de dividendos extranjeros (15 % EE. UU.) se deducen en la renta. Orientativo, no sustituye a la información fiscal del bróker.</div></section>
  <section class="card"><h2>Flujos por año</h2><table class="tbl"><tr><th>Año</th><th class="r">Compras</th><th class="r">Ventas</th><th class="r">Neto aportado</th></tr>${yearRows.map((r) => `<tr><td><b>${r.y}</b></td><td class="r num">${eur(r.buys, 0)}</td><td class="r num">${eur(r.sells, 0)}</td><td class="r num">${eur(r.buys - r.sells, 0)}</td></tr>`).join('')}</table></section>
  ${Object.entries(groups).map(([m, list]) => `<div class="group-title">${MESES_L[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}</div><section class="card tight"><div class="list">${list.map((t) => { const ins = byId[t.instrument]; const a = amount(t); return `<div class="item tap" data-tx-edit="${t.id}">${ins ? avatar(ins) : '<div class="avatar" style="background:#999">?</div>'}<div class="main"><div class="t">${label(t)} · ${esc(ins?.short || t.instrument)}${t.estimated ? '<span class="tag est">est.</span>' : ''}</div><div class="s">${fmtDate(t.date)}${t.units != null ? ` · ${num(t.units, t.units % 1 ? 4 : 0)} × ${eur(t.price, t.price < 20 ? 3 : 2)}` : ''}${t.fee ? ` · com. ${eur(t.fee)}` : ''}${t.note && !t.estimated ? ` · ${esc(t.note)}` : ''}</div></div><div class="right"><div class="v num ${t.type === 'buy' ? '' : cls(a)}">${eurS(a)}</div></div></div>`; }).join('')}</div></section>`).join('')}
  <section class="card"><h2>Datos</h2><div class="btn-row"><button class="btn secondary" id="export-json">Exportar copia</button><button class="btn secondary" id="import-json">Importar</button></div><input type="file" id="import-file" accept="application/json,.json" hidden>
    <div class="btn-row" style="margin-top:10px"><button class="btn secondary" id="reset-seed">Restaurar carga inicial</button><button class="btn secondary" id="add-instrument">Nuevo activo</button></div>
    <div class="small muted" style="margin-top:10px">Tus operaciones se guardan solo en este dispositivo. Exporta una copia de vez en cuando (por ejemplo, a Archivos o iCloud Drive).</div></section>
  <button class="fab" id="fab-add" aria-label="Añadir operación"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>`;
}
function mountOperaciones() {
  $('#fab-add').addEventListener('click', () => openTxForm(null));
  $('#add-instrument').addEventListener('click', () => openInstrumentForm());
  $('#export-json').addEventListener('click', exportData);
  $('#import-json').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { try { const d = JSON.parse(r.result); if (!Array.isArray(d.transactions)) throw new Error(); S.txs = d.transactions; store.set('txs', S.txs); if (d.targets) { S.targets = d.targets; store.set('targets', d.targets); } if (d.manualPrices) { S.manualPrices = d.manualPrices; store.set('manualPrices', d.manualPrices); } if (d.customInstruments) { S.customInstruments = d.customInstruments; store.set('customInstruments', d.customInstruments); loadAll(); return; } resolveValueRefLots(); recompute(); render(); toast('Datos importados'); } catch { toast('El archivo no es una copia válida'); } }; r.readAsText(f); });
  $('#reset-seed').addEventListener('click', () => { if (!confirm('¿Sustituir tus operaciones por la carga inicial? Se perderán los cambios que hayas hecho.')) return; S.txs = JSON.parse(JSON.stringify(S.seed.transactions)); store.set('txs', S.txs); resolveValueRefLots(); recompute(); render(); toast('Carga inicial restaurada'); });
}
function exportData() {
  const data = { exported: new Date().toISOString(), transactions: S.txs, targets: S.targets, manualPrices: S.manualPrices, customInstruments: S.customInstruments };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `cartera-${todayISO()}.json`; document.body.appendChild(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 500);
  if (navigator.share) { try { const file = new File([blob], a.download, { type: 'application/json' }); if (navigator.canShare && navigator.canShare({ files: [file] })) navigator.share({ files: [file], title: 'Copia de la cartera' }).catch(() => {}); } catch {} }
}

function openTxForm(txId, presetInstrument) {
  const t = txId ? S.txs.find((x) => x.id === txId) : null; const isNew = !t;
  const d = t || { date: todayISO(), instrument: presetInstrument || '', type: 'buy', units: '', price: '', fee: 0, tax: 0, amount: '' };
  const insOpts = S.instruments.filter((i) => !i.closed || i.id === d.instrument).sort((a, b) => a.short.localeCompare(b.short)).map((i) => `<option value="${i.id}" ${i.id === d.instrument ? 'selected' : ''}>${esc(i.short)} · ${esc(i.broker)}</option>`).join('');
  const body = `<div class="form">
    ${t?.estimated ? '<div class="notice">Esta operación se cargó con fecha y participaciones estimadas. Corrige los datos con los de tu bróker y guarda.</div>' : ''}
    <div class="seg" id="tx-type">${[['buy', 'Compra'], ['sell', 'Venta'], ['dividend', 'Dividendo']].map(([k, l]) => `<button data-type="${k}" class="${d.type === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div class="grid2"><div class="field"><label>Activo</label><select id="tx-ins">${insOpts}</select></div><div class="field"><label>Fecha</label><input id="tx-date" type="date" value="${d.date}"></div></div>
    <div id="tx-trade" ${d.type === 'dividend' ? 'hidden' : ''}>
      <div class="grid2"><div class="field"><label>Títulos / participaciones</label><input id="tx-units" type="number" step="any" inputmode="decimal" value="${d.units ?? ''}"></div><div class="field"><label>Precio por título (€)</label><input id="tx-price" type="number" step="any" inputmode="decimal" value="${d.price ?? ''}"></div></div>
      <div class="field" style="margin-top:12px"><label>O bien, importe total (€) <span class="muted">calcula los títulos</span></label><input id="tx-amount" type="number" step="any" inputmode="decimal" placeholder="Opcional"></div>
    </div>
    <div id="tx-div" ${d.type !== 'dividend' ? 'hidden' : ''}><div class="field"><label>Importe bruto (€)</label><input id="tx-amt" type="number" step="any" inputmode="decimal" value="${d.amount ?? ''}"></div></div>
    <div class="grid2" style="margin-top:12px"><div class="field"><label>Comisión (€)</label><input id="tx-fee" type="number" step="any" inputmode="decimal" value="${d.fee ?? 0}"></div><div class="field"><label>${d.type === 'dividend' ? 'Retención (€)' : 'Impuestos (€)'}</label><input id="tx-tax" type="number" step="any" inputmode="decimal" value="${d.tax ?? 0}"></div></div>
    <div class="field"><label>Nota (opcional)</label><input id="tx-note" type="text" value="${esc(t?.note && !t?.estimated ? t.note : '')}"></div>
    <div class="btn-row"><button class="btn primary" id="tx-save">${isNew ? 'Añadir' : 'Guardar'}</button>${!isNew ? '<button class="btn danger" id="tx-del">Eliminar</button>' : ''}</div>
    <div class="small muted">Los precios se introducen en euros por título, tal como los muestra el bróker. En una venta, la comisión se resta del importe recibido.</div>
  </div>`;
  openSheet(isNew ? 'Nueva operación' : 'Editar operación', body, (root, close) => {
    let type = d.type;
    $$('#tx-type button', root).forEach((b) => b.addEventListener('click', () => { type = b.dataset.type; $$('#tx-type button', root).forEach((x) => x.classList.toggle('active', x === b)); $('#tx-trade', root).hidden = type === 'dividend'; $('#tx-div', root).hidden = type !== 'dividend'; }));
    const amountIn = $('#tx-amount', root); amountIn.addEventListener('input', () => { const a = parseFloat(amountIn.value), p = parseFloat($('#tx-price', root).value), f = parseFloat($('#tx-fee', root).value) || 0; if (a > 0 && p > 0) $('#tx-units', root).value = ((a - (type === 'buy' ? f : -f)) / p).toFixed(6); });
    $('#tx-save', root).addEventListener('click', () => {
      const tx = { id: t?.id || uid(), date: $('#tx-date', root).value, instrument: $('#tx-ins', root).value, type, fee: parseFloat($('#tx-fee', root).value) || 0, tax: parseFloat($('#tx-tax', root).value) || 0, note: $('#tx-note', root).value || undefined };
      if (!tx.date || !tx.instrument) return toast('Faltan datos');
      if (type === 'dividend') { tx.amount = parseFloat($('#tx-amt', root).value); if (!(tx.amount > 0)) return toast('Introduce el importe'); }
      else { tx.units = parseFloat($('#tx-units', root).value); tx.price = parseFloat($('#tx-price', root).value); if (!(tx.units > 0) || !(tx.price > 0)) return toast('Introduce títulos y precio'); }
      if (t) { const i = S.txs.findIndex((x) => x.id === t.id); S.txs[i] = tx; } else S.txs.push(tx);
      store.set('txs', S.txs); recompute(); render(); close(); toast(isNew ? 'Operación añadida' : 'Operación guardada');
    });
    const del = $('#tx-del', root); if (del) del.addEventListener('click', () => { if (!confirm('¿Eliminar esta operación?')) return; S.txs = S.txs.filter((x) => x.id !== t.id); store.set('txs', S.txs); recompute(); render(); close(); toast('Operación eliminada'); });
  });
}

function openInstrumentForm() {
  const body = `<div class="form">
    <div class="notice">Añade un activo que no esté en la lista. Para que tenga precio automático, indica su símbolo en Yahoo Finance (por ejemplo, <b>AAPL</b>, <b>ITX.MC</b> o <b>IE00B4L5Y983</b>); se activará en la siguiente actualización de precios. Mientras tanto puedes usar un precio manual.</div>
    <div class="field"><label>Nombre</label><input id="in-name" type="text" placeholder="Apple"></div>
    <div class="grid2"><div class="field"><label>Nombre corto</label><input id="in-short" type="text" placeholder="Apple"></div><div class="field"><label>ISIN</label><input id="in-isin" type="text" placeholder="US0378331005"></div></div>
    <div class="grid2"><div class="field"><label>Tipo</label><select id="in-type"><option value="stock">Acción</option><option value="etf">ETF</option><option value="etc">ETC</option><option value="fund">Fondo</option></select></div><div class="field"><label>Bloque</label><select id="in-bucket">${Object.entries(S.buckets).map(([k, b]) => `<option value="${k}">${esc(b.label)}</option>`).join('')}</select></div></div>
    <div class="grid2"><div class="field"><label>Bróker</label><select id="in-broker">${[...new Set(S.instruments.map((i) => i.broker))].map((b) => `<option>${esc(b)}</option>`).join('')}</select></div><div class="field"><label>Divisa de cotización</label><select id="in-ccy"><option>EUR</option><option>USD</option></select></div></div>
    <div class="grid2"><div class="field"><label>Símbolo Yahoo (opcional)</label><input id="in-yahoo" type="text" placeholder="AAPL"></div><div class="field"><label>Sector</label><input id="in-sector" type="text" placeholder="Tecnología"></div></div>
    <div class="field"><label>País</label><input id="in-country" type="text" placeholder="Estados Unidos"></div>
    <div class="btn-row"><button class="btn primary" id="in-save">Crear activo</button></div></div>`;
  openSheet('Nuevo activo', body, (root, close) => {
    $('#in-save', root).addEventListener('click', () => {
      const name = $('#in-name', root).value.trim(); if (!name) return toast('Pon un nombre');
      const id = 'X' + (($('#in-isin', root).value.trim() || name).replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toUpperCase() || uid());
      if (byId[id]) return toast('Ya existe un activo con ese identificador');
      const ins = { id, name, short: $('#in-short', root).value.trim() || name, isin: $('#in-isin', root).value.trim() || null, type: $('#in-type', root).value, bucket: $('#in-bucket', root).value, broker: $('#in-broker', root).value, currency: $('#in-ccy', root).value, yahoo: $('#in-yahoo', root).value.trim() || null, sector: $('#in-sector', root).value.trim() || 'Otros', country: $('#in-country', root).value.trim() || 'Otros', color: '#4a3aa7', custom: true, lookthrough: $('#in-type', root).value === 'stock' ? 'stock' : null };
      S.customInstruments.push(ins); store.set('customInstruments', S.customInstruments); S.instruments.push(ins); byId[id] = ins; close(); toast('Activo creado'); openTxForm(null, id);
    });
  });
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) { window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); }); }
$$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.ui.tab)); $('#page-title').textContent = TITLES[S.ui.tab] || 'Resumen';
loadAll();
})();
