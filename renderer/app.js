'use strict';
/* Card Vault - interface. Vanilla JS, sem dependências. */
const V = window.vault;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;            // só para strings estáticas (ícones)
    else if (k === 'style') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) e.style.setProperty(sk, sv); else e.style[sk] = sv; } }
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

// ------------------------------------------------------------------ formatação
const EUR = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });
const INT = new Intl.NumberFormat('pt-PT');
const PCT = new Intl.NumberFormat('pt-PT', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' });
const eur = (v) => (v == null ? '–' : EUR.format(v));
const eurS = (v) => (v == null ? '–' : (v > 0 ? '+' : '') + EUR.format(v));
const pct = (v) => (v == null || !Number.isFinite(v) ? '–' : PCT.format(v));
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const parseNum = (s) => { const n = parseFloat(String(s ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const todayISO = () => new Date().toLocaleDateString('sv-SE');
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('pt-PT', { day: 'numeric', month: 'short', year: 'numeric' });
const safeDate = (s) => String(s).replace(/[^\d-]/g, '');
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const COND = { 'near mint': 'NM', 'lightly played': 'LP', 'moderately played': 'MP', 'heavily played': 'HP', damaged: 'DMG' };
const abbr = (c) => COND[norm(c)] || c;
const RORDER = { mythic: 0, rare: 1, uncommon: 2, common: 3 };

const ICONS = {
  summary: '<svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg>',
  collection: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="11" height="15" rx="2"/><path d="M9 21h9a2 2 0 0 0 2-2V8"/></svg>',
  movers: '<svg viewBox="0 0 24 24"><path d="M7 17V7M7 7L4 10M7 7l3 3M17 7v10M17 17l-3-3M17 17l3-3"/></svg>',
  top: '<svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  refresh: '<svg class="ico" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  import: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></svg>',
  export: '<svg viewBox="0 0 24 24"><path d="M12 15V3M7 8l5-5 5 5M4 21h16"/></svg>',
};

// ------------------------------------------------------------------ estado
const S = {
  cards: [], byId: new Map(), portfolio: [], settings: {}, priceDate: null, file: '',
  view: 'summary', sort: { col: 'value', desc: true },
  filters: { q: '', set: '', rarity: '', printing: '', cond: '', min: '', max: '', unpriced: false },
  rows: [], selected: null, group: 'Set', period: 7, msort: 'pct', mmin: '0,50', busy: false,
};
const dirty = new Set();
const C = {}; const M = {}; const L = {};

function decorate(c) {
  c._s = norm([c.name, c.set_name, c.number, c.rarity, c.condition, c.printing].join(' '));
  c._foil = /foil/i.test(c.printing || '');
  c._value = c.price != null ? c.quantity * c.price : null;
  c._d7 = c.price != null && c.avg7 ? c.price / c.avg7 - 1 : null;
  return c;
}

// ------------------------------------------------------------------ utilitários de UI
function toast(msg, kind = 'ok', ms = 3500) {
  const t = el('div', { class: 'toast ' + kind }, msg);
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, ms);
}

function modal({ title, body, buttons }) {
  return new Promise((resolve) => {
    const cancelVal = (buttons.find((b) => b.cancel) || {}).value ?? null;
    const close = (v) => { ov.remove(); S.modalClose = null; resolve(v); };
    const ov = el('div', { class: 'overlay', onclick: (e) => { if (e.target === ov) close(cancelVal); } },
      el('div', { class: 'modal' }, el('h2', {}, title), el('p', {}, body),
        el('div', { class: 'btns' }, buttons.map((b) => el('button', { class: 'btn ' + (b.kind || ''), onclick: () => close(b.value) }, b.label)))));
    S.modalClose = () => close(cancelVal);
    $('#modal-root').append(ov);
  });
}

function countUp(node, to, fmt, dur = 1000) {
  const from = node._v ?? 0;
  node._v = to;
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    node.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function segmented(opts, value, onChange) {
  const wrap = el('div', { class: 'seg' });
  opts.forEach(([val, label]) => {
    const b = el('button', { class: val === value ? 'on' : '', onclick: () => {
      [...wrap.children].forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      onChange(val);
    } }, label);
    wrap.append(b);
  });
  return wrap;
}

let uid = 0;
function lineChart(host, pts, { height = 220, fmt = eur, empty = 'Sem dados suficientes.' } = {}) {
  host.replaceChildren();
  host.classList.add('chart');
  host.style.height = height + 'px';
  if (pts.length < 2) { host.append(el('div', { class: 'chart-empty' }, empty)); return; }
  const W = Math.max(host.clientWidth, 220), H = height, pl = 10, pr = 10, pt = 16, pb = 24;
  const vals = pts.map((p) => p[1]);
  const vmax = Math.max(...vals), vmin = Math.min(...vals);
  let lo = vmin, hi = vmax;
  if (hi - lo < 1e-9) { const d = Math.abs(hi) * 0.05 || 1; lo -= d; hi += d; } else { const pad = (hi - lo) * 0.14; lo -= pad; hi += pad; }
  const n = pts.length;
  const X = (i) => pl + ((W - pl - pr) * i) / (n - 1);
  const Y = (v) => pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  const area = `${line}L${X(n - 1).toFixed(1)},${H - pb}L${X(0).toFixed(1)},${H - pb}Z`;
  const gid = 'g' + (++uid);
  const gl = [0, 0.5, 1].map((f) => { const y = pt + (H - pt - pb) * f; return `<line class="grid-line" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/>`; }).join('');
  host.insertAdjacentHTML('afterbegin',
    `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".38"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
      ${gl}<path class="area" d="${area}" fill="url(#${gid})"/><path class="line" pathLength="1" d="${line}"/>
      <text x="${pl}" y="${pt - 4}">${fmt(vmax)}</text><text x="${pl}" y="${H - pb - 5}">${fmt(vmin)}</text>
      <text x="${pl}" y="${H - 6}">${safeDate(pts[0][0])}</text><text x="${W - pr}" y="${H - 6}" text-anchor="end">${safeDate(pts[n - 1][0])}</text>
      <line class="hover-line" y1="${pt}" y2="${H - pb}" x1="0" x2="0" opacity="0"/><circle class="dot" r="5" cx="0" cy="0" opacity="0"/>
    </svg>`);
  const svg = $('svg', host), hl = $('.hover-line', host), dot = $('.dot', host);
  const tip = el('div', { class: 'tip' });
  host.append(tip);
  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left - pl) / (W - pl - pr)) * (n - 1))));
    const x = X(i), y = Y(pts[i][1]);
    hl.setAttribute('x1', x); hl.setAttribute('x2', x); hl.setAttribute('opacity', 1);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('opacity', 1);
    tip.style.left = x + 'px'; tip.style.top = y + 'px'; tip.style.opacity = 1;
    tip.textContent = `${pts[i][0]}  ·  ${fmt(pts[i][1])}`;
  });
  svg.addEventListener('mouseleave', () => { hl.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); tip.style.opacity = 0; });
}

function bars(host, items) {
  host.replaceChildren();
  if (!items.length) { host.append(el('div', { class: 'chart-empty' }, 'Sem dados')); return; }
  const top = Math.max(...items.map((i) => i[1])) || 1;
  const fills = [];
  items.forEach(([k, v], i) => {
    const f = el('div', { class: 'bar-fill', style: { transitionDelay: i * 50 + 'ms' } });
    fills.push([f, v]);
    host.append(el('div', { class: 'bar-row' }, el('div', { class: 'bar-label', title: k || '(vazio)' }, k || '(vazio)'),
      el('div', { class: 'bar-track' }, f), el('div', { class: 'bar-val' }, eur(v))));
  });
  requestAnimationFrame(() => requestAnimationFrame(() => fills.forEach(([f, v]) => { f.style.width = (v / top * 100) + '%'; })));
}

function vlist(host, rowH, rowFn) {
  const spacer = el('div', { class: 'v-spacer' });
  const win = el('div', { class: 'v-window' });
  host.append(spacer, win);
  let rows = [], raf = 0;
  function paint() {
    const top = host.scrollTop, h = host.clientHeight || 600;
    const start = Math.max(0, Math.floor(top / rowH) - 6), end = Math.min(rows.length, Math.ceil((top + h) / rowH) + 6);
    win.style.transform = `translateY(${start * rowH}px)`;
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.append(rowFn(rows[i], i));
    win.replaceChildren(frag);
  }
  host.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(paint); });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(paint).observe(host);
  return { set(r) { rows = r; spacer.style.height = r.length * rowH + 'px'; paint(); }, repaint: paint };
}

// ------------------------------------------------------------------ vistas / navegação
const VIEWS = {
  summary: { title: 'Resumo', render: renderSummary },
  collection: { title: 'Coleção', render: renderCollection },
  movers: { title: 'Variações', render: renderMovers },
  top: { title: 'Mais valiosas', render: renderTop },
  settings: { title: 'Definições', render: () => {} },
};

function renderView(name) { dirty.delete(name); VIEWS[name].render(); }

function placeIndicator() {
  const b = $(`.nav-item[data-view="${S.view}"]`), ind = $('.nav-ind');
  if (!b || !ind) return;
  ind.style.height = b.offsetHeight + 'px';
  ind.style.transform = `translateY(${b.offsetTop}px)`;
}

function showView(name) {
  S.view = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('#viewTitle').textContent = VIEWS[name].title;
  const ta = $('#topActions');
  ta.replaceChildren();
  if (name === 'collection') ta.append(el('button', { class: 'btn small', html: ICONS.export + '<span>Exportar vista</span>', onclick: doExport }));
  placeIndicator();
  if (dirty.has(name)) renderView(name);
}

function setEmpty(on) {
  $$('.view').forEach((v) => { if (v.id !== 'view-settings') v.classList.toggle('is-empty', on); });
}

function emptyState() {
  return el('div', { class: 'empty-state' }, el('div', { class: 'orb' }), el('h2', {}, 'A tua coleção está vazia'),
    el('p', {}, 'Arrasta para aqui um CSV da TCGplayer, ou importa-o, e os preços do Cardmarket são preenchidos automaticamente.'),
    el('button', { class: 'btn primary', html: ICONS.import + '<span>Importar CSV</span>', onclick: doImportPick }));
}

function renderSidebar() {
  $('#priceDate').textContent = S.priceDate ? 'Preços de ' + fmtDate(S.priceDate) : 'Ainda sem preços';
}

// ------------------------------------------------------------------ Resumo
function totals() {
  let value = 0, qty = 0, a7 = 0, p7 = 0, unpriced = 0, best = null;
  for (const c of S.cards) {
    qty += c.quantity;
    if (c.price == null) { unpriced++; continue; }
    value += c._value;
    if (c.avg7 > 0) { a7 += c.quantity * c.avg7; p7 += c._value; }
    if (!best || c.price > best.price) best = c;
  }
  return { value, qty, distinct: S.cards.length, unpriced, move: a7 > 0 ? p7 / a7 - 1 : null, best };
}

function portfolioDeltas() {
  const p = S.portfolio;
  if (!p.length) return [];
  const last = p[p.length - 1], out = [];
  for (const d of [1, 7, 30]) {
    const cut = addDays(last[0], -d);
    let ref = null;
    for (const r of p) if (r[0] <= cut) ref = r;
    if (ref && ref[1]) out.push([d, last[1] / ref[1] - 1]);
  }
  return out;
}

const GROUPS = { Set: (c) => c.set_name, Raridade: (c) => c.rarity, Impressão: (c) => c.printing, Condição: (c) => c.condition };

function groupItems() {
  const acc = GROUPS[S.group], m = new Map();
  for (const c of S.cards) if (c._value != null) m.set(acc(c), (m.get(acc(c)) || 0) + c._value);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
}

function renderSummary() {
  const root = $('#view-summary .content');
  root.replaceChildren();
  if (!S.cards.length) return;
  const t = totals();
  const valueNode = el('div', { class: 'value' }), qtyNode = el('div', { class: 'value' }), distNode = el('div', { class: 'value' });
  countUp(valueNode, t.value, eur); countUp(qtyNode, t.qty, (v) => INT.format(Math.round(v))); countUp(distNode, t.distinct, (v) => INT.format(Math.round(v)));
  const moveNode = el('div', { class: 'value ' + cls(t.move) }, pct(t.move));
  const stat = (i, label, node, sub) => el('div', { class: 'card stat', style: { '--i': i } }, el('div', { class: 'label' }, label), node, sub ? el('div', { class: 'sub' }, sub) : null);
  const stats = el('div', { class: 'grid g4 stagger' },
    stat(0, 'Valor da coleção', valueNode, t.unpriced ? `${t.unpriced} carta(s) sem preço` : 'Preço trend do Cardmarket'),
    stat(1, 'Cartas', qtyNode, 'Total de exemplares'),
    stat(2, 'Cartas distintas', distNode, t.best ? `Mais cara: ${t.best.name}` : ''),
    stat(3, 'Preço vs média 7d', moveNode, 'Só efeito de preços'));

  const deltas = portfolioDeltas();
  const pills = el('div', { class: 'pills stagger' }, el('span', { class: 'pill', style: { '--i': 4 } }, 'Valor total vs histórico:'),
    deltas.length ? deltas.map(([d, v], i) => el('span', { class: 'pill ' + cls(v), style: { '--i': 5 + i } }, `${d}d  ${pct(v)}`))
      : el('span', { class: 'pill', style: { '--i': 5 } }, 'ainda sem histórico suficiente'),
    t.best ? el('span', { class: 'pill', style: { '--i': 8, cursor: 'pointer' }, onclick: () => openDrawer(t.best.id) }, `Mais cara: ${t.best.name} · ${eur(t.best.price)}`) : null);

  const chartHost = el('div');
  const groupHost = el('div');
  const seg = segmented(Object.keys(GROUPS).map((k) => [k, k]), S.group, (g) => { S.group = g; bars(groupHost, groupItems()); });
  const main = el('div', { class: 'grid g-main stagger', style: { flex: '1', minHeight: '300px' } },
    el('div', { class: 'card', style: { '--i': 5 } }, el('h3', {}, 'Valor ao longo do tempo'), chartHost),
    el('div', { class: 'card', style: { '--i': 6, overflow: 'auto' } }, el('h3', {}, 'Valor por…'), seg, el('div', { style: { height: '8px' } }), groupHost));
  root.append(stats, pills, main);
  requestAnimationFrame(() => {
    lineChart(chartHost, S.portfolio.map((r) => [r[0], r[1]]), { height: 270,
      empty: 'O gráfico aparece quando houver preços de pelo menos 2 dias diferentes. Atualiza os preços nos próximos dias.' });
    bars(groupHost, groupItems());
  });
}

// ------------------------------------------------------------------ Coleção
const COLS = [
  { key: 'qty', label: 'Qtd', num: true }, { key: 'name', label: 'Nome' }, { key: 'set', label: 'Set' },
  { key: 'rarity', label: 'Raridade' }, { key: 'version', label: 'Versão' },
  { key: 'price', label: 'Trend', num: true, tip: 'Preço trend do Cardmarket' },
  { key: 'low', label: 'From', num: true, tip: 'Preço mais baixo à venda no Cardmarket ("From")' },
  { key: 'value', label: 'Total', num: true }, { key: 'd7', label: 'vs 7d', num: true, tip: 'Trend vs média dos últimos 7 dias' },
];
const ACC = {
  qty: (c) => c.quantity, name: (c) => norm(c.name), set: (c) => norm(c.set_name), rarity: (c) => RORDER[norm(c.rarity)] ?? 9,
  version: (c) => norm(c.printing + ' ' + c.condition), price: (c) => c.price, low: (c) => c.low, value: (c) => c._value, d7: (c) => c._d7,
};

function buildCollection() {
  const root = $('#view-collection .content');
  const reapply = () => applyFilters();
  const search = el('input', { class: 'input search', placeholder: 'Pesquisar nome, set, raridade…  (⌘K)', oninput: debounce((e) => { S.filters.q = e.target.value; reapply(); }, 120) });
  C.search = search;
  C.sel = {};
  const mkSel = (key, label) => {
    const s = el('select', { class: 'select', onchange: (e) => { S.filters[key] = e.target.value; reapply(); } }, el('option', { value: '' }, label));
    C.sel[key] = { node: s, label };
    return s;
  };
  const minI = el('input', { class: 'input mini', placeholder: 'min €', oninput: debounce((e) => { S.filters.min = e.target.value; reapply(); }, 200) });
  const maxI = el('input', { class: 'input mini', placeholder: 'max €', oninput: debounce((e) => { S.filters.max = e.target.value; reapply(); }, 200) });
  const unp = el('button', { class: 'chip', onclick: () => { S.filters.unpriced = !S.filters.unpriced; unp.classList.toggle('on', S.filters.unpriced); reapply(); } }, 'Sem preço');
  const clear = el('button', { class: 'chip', onclick: () => {
    S.filters = { q: '', set: '', rarity: '', printing: '', cond: '', min: '', max: '', unpriced: false };
    search.value = ''; minI.value = ''; maxI.value = ''; unp.classList.remove('on');
    Object.values(C.sel).forEach((s) => { s.node.value = ''; });
    reapply();
  } }, 'Limpar');
  const toolbar = el('div', { class: 'toolbar' }, search, mkSel('set', 'Todos os sets'), mkSel('rarity', 'Raridade'), mkSel('printing', 'Normal + Foil'),
    mkSel('cond', 'Condição'), minI, maxI, unp, clear);

  const head = el('div', { class: 'thead grid-cols' }, COLS.map((c) => {
    const th = el('div', { class: 'th' + (c.num ? ' num' : ''), title: c.tip || '', onclick: () => sortBy(c.key) }, c.label);
    C['th_' + c.key] = th;
    return th;
  }));
  const host = el('div', { class: 'vhost' });
  C.foot = el('div', { class: 'tfoot' });
  root.append(toolbar, el('div', { class: 'card table-card' }, head, host, C.foot));
  C.vl = vlist(host, 46, rowEl);
}

function rowEl(c) {
  return el('div', { class: 'tr grid-cols' + (S.selected === c.id ? ' sel' : ''), onclick: () => openDrawer(c.id) },
    el('div', { class: 'td num' }, c.quantity),
    el('div', { class: 'td name', title: c.name }, c.name),
    el('div', { class: 'td muted', title: c.set_name }, c.set_name),
    el('div', { class: 'td r-' + norm(c.rarity).replace(/\s+/g, '-') }, c.rarity),
    el('div', { class: 'td' }, el('span', { class: 'tag' + (c._foil ? ' foil' : '') }, (c.printing || 'Normal') + (c.condition ? ' · ' + abbr(c.condition) : ''))),
    el('div', { class: 'td num' }, eur(c.price)),
    el('div', { class: 'td num' }, eur(c.low)),
    el('div', { class: 'td num' }, eur(c._value)),
    el('div', { class: 'td num ' + cls(c._d7) }, pct(c._d7)));
}

function sortBy(key) {
  if (S.sort.col === key) S.sort.desc = !S.sort.desc;
  else S.sort = { col: key, desc: ['qty', 'price', 'low', 'value', 'd7'].includes(key) };
  applyFilters();
}

function updateFilterOptions() {
  const distinct = (fn) => [...new Set(S.cards.map(fn).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
  const sources = { set: distinct((c) => c.set_name), rarity: distinct((c) => c.rarity), printing: ['Normal', 'Foil'], cond: distinct((c) => c.condition) };
  for (const [key, { node, label }] of Object.entries(C.sel)) {
    const cur = node.value;
    node.replaceChildren(el('option', { value: '' }, label), ...sources[key].map((v) => el('option', { value: v }, v)));
    node.value = sources[key].includes(cur) ? cur : '';
    S.filters[key] = node.value;
  }
}

function applyFilters() {
  const f = S.filters, toks = norm(f.q).split(/\s+/).filter(Boolean), min = parseNum(f.min), max = parseNum(f.max);
  const rows = S.cards.filter((c) => {
    if (f.set && c.set_name !== f.set) return false;
    if (f.rarity && c.rarity !== f.rarity) return false;
    if (f.cond && c.condition !== f.cond) return false;
    if (f.printing === 'Foil' && !c._foil) return false;
    if (f.printing === 'Normal' && c._foil) return false;
    if (f.unpriced && c.price != null) return false;
    if (min != null && !(c.price != null && c.price >= min)) return false;
    if (max != null && !(c.price != null && c.price <= max)) return false;
    for (const t of toks) if (!c._s.includes(t)) return false;
    return true;
  });
  const acc = ACC[S.sort.col], desc = S.sort.desc;
  rows.sort((a, b) => {
    const x = acc(a), y = acc(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const r = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return desc ? -r : r;
  });
  S.rows = rows;
  C.vl.set(rows);
  let q = 0, v = 0;
  for (const c of rows) { q += c.quantity; v += c._value || 0; }
  C.foot.replaceChildren(el('span', {}, `${INT.format(rows.length)} linhas`), el('span', {}, `${INT.format(q)} cartas`), el('span', {}, `valor ${eur(v)}`));
  for (const c of COLS) {
    const th = C['th_' + c.key];
    th.classList.toggle('sorted', S.sort.col === c.key);
    th.textContent = c.label + (S.sort.col === c.key ? (S.sort.desc ? ' ▼' : ' ▲') : '');
  }
}

function renderCollection() { updateFilterOptions(); applyFilters(); }

// ------------------------------------------------------------------ gaveta de detalhe
function box(label, value, extra = '') { return el('div', { class: 'd-box ' + extra }, el('div', { class: 'l' }, label), el('div', { class: 'v' }, value)); }

function openDrawer(id) {
  const c = S.byId.get(id);
  if (!c) return;
  S.selected = id;
  const d = $('#drawer');
  d.replaceChildren();

  const wrap = el('div', { class: 'cardimg loading' });
  const img = el('img', { alt: c.name });
  wrap.append(img, el('div', { class: 'glare' }));
  const stage = el('div', { class: 'cardimg-wrap' }, wrap);
  stage.addEventListener('mousemove', (e) => {
    const r = wrap.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    wrap.style.transform = `rotateY(${(x - 0.5) * 18}deg) rotateX(${(0.5 - y) * 18}deg) scale(1.03)`;
    wrap.style.setProperty('--gx', x * 100 + '%'); wrap.style.setProperty('--gy', y * 100 + '%');
  });
  stage.addEventListener('mouseleave', () => { wrap.style.transform = ''; });
  V.image(c.tcg_id).then((url) => {
    if (S.selected !== id) return;
    wrap.classList.remove('loading');
    if (url) { img.onload = () => img.classList.add('in'); img.src = url; } else wrap.append(el('div', { class: 'chart-empty' }, 'Sem imagem'));
  });

  const qtyNode = el('b', {}, c.quantity), totalNode = el('span', { class: 'muted' }, 'Total ' + eur(c._value));
  let qtyTimer;
  const setQ = (n) => {
    n = Math.max(1, Math.min(100000, n));
    c.quantity = n; decorate(c);
    qtyNode.textContent = n; totalNode.textContent = 'Total ' + eur(c._value);
    clearTimeout(qtyTimer);
    qtyTimer = setTimeout(async () => {
      await V.setQty(id, n);
      S.portfolio = (await V.getState()).portfolio;
      ['summary', 'top', 'movers'].forEach((v) => dirty.add(v));
      if (C.vl) applyFilters();
    }, 350);
  };
  const chartHost = el('div');
  const chartCard = el('div', { class: 'card', style: { padding: '12px', marginBottom: '14px' } }, el('h3', { style: { marginBottom: '6px' } }, 'Histórico do preço'), chartHost);

  d.append(
    el('button', { class: 'btn small d-close', onclick: closeDrawer }, '✕'), stage,
    el('div', { class: 'd-title' }, c.name),
    el('div', { class: 'd-sub' }, `${c.set_name}${c.number ? '  ·  #' + c.number : ''}`),
    el('div', { class: 'd-tags' }, el('span', { class: 'tag r-' + norm(c.rarity).replace(/\s+/g, '-') }, c.rarity || '–'),
      el('span', { class: 'tag' + (c._foil ? ' foil' : '') }, c.printing || 'Normal'), c.condition ? el('span', { class: 'tag' }, c.condition) : null),
    el('div', { class: 'd-prices' }, box('Trend', eur(c.price), 'big'), box('From', eur(c.low))),
    el('div', { class: 'd-stats' }, box('Média 1d', eur(c.avg1)), box('Média 7d', eur(c.avg7)), box('Média 30d', eur(c.avg30)), box('vs 7d', pct(c._d7))),
    el('div', { class: 'qty' }, el('div', {}, el('div', {}, 'Quantidade'), totalNode),
      el('div', { class: 'stepper' }, el('button', { class: 'round', onclick: () => setQ(c.quantity - 1) }, '−'), qtyNode, el('button', { class: 'round', onclick: () => setQ(c.quantity + 1) }, '+'))),
    chartCard,
    el('div', { class: 'd-actions' },
      el('button', { class: 'btn', onclick: () => V.openExternal('https://www.cardmarket.com/en/Magic/Products/Search?searchString=' + encodeURIComponent(c.name)) }, 'Ver no Cardmarket'),
      el('button', { class: 'btn danger', onclick: () => removeCard(c) }, 'Remover')));
  d.classList.add('open'); d.setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('on');
  d.scrollTop = 0;
  if (C.vl) C.vl.repaint();
  V.history(id).then((pts) => {
    if (S.selected !== id) return;
    lineChart(chartHost, pts, { height: 150, empty: 'Ainda só há 1 dia de preços. Volta a atualizar noutro dia para veres a evolução.' });
  });
}

function closeDrawer() {
  S.selected = null;
  $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('on');
  if (C.vl) C.vl.repaint();
  if (dirty.has(S.view)) renderView(S.view);
}

async function removeCard(c) {
  const ok = await modal({ title: 'Remover carta?', body: `«${c.name}» (${c.printing || 'Normal'}) sai da coleção, tal como o histórico de preços.`,
    buttons: [{ label: 'Cancelar', value: false, cancel: true }, { label: 'Remover', value: true, kind: 'danger' }] });
  if (!ok) return;
  await V.deleteCards([c.id]);
  closeDrawer();
  await loadState();
  toast('Carta removida');
}

// ------------------------------------------------------------------ Variações
function buildMovers() {
  const root = $('#view-movers .content');
  const seg = segmented([[1, '1 dia'], [7, '7 dias'], [30, '30 dias'], [90, '90 dias']], S.period, (p) => { S.period = p; renderMovers(); });
  const sort = el('select', { class: 'select', onchange: (e) => { S.msort = e.target.value; renderMovers(); } },
    el('option', { value: 'pct' }, 'Ordenar por % variação'), el('option', { value: 'delta' }, 'Ordenar por € por carta'), el('option', { value: 'total' }, 'Ordenar por € total (qtd × Δ)'));
  const min = el('input', { class: 'input mini', value: S.mmin, title: 'Ignorar cartas abaixo deste preço (€)', oninput: debounce((e) => { S.mmin = e.target.value; renderMovers(); }, 250) });
  M.info = el('div', { class: 'muted small' });
  M.up = el('div', { class: 'list-body' }); M.dn = el('div', { class: 'list-body' });
  root.append(el('div', { class: 'toolbar' }, seg, sort, el('span', { class: 'muted small' }, 'Preço mínimo €'), min), M.info,
    el('div', { class: 'cols2' },
      el('div', { class: 'card list-card' }, el('h3', {}, '▲ Maiores subidas'), M.up),
      el('div', { class: 'card list-card' }, el('h3', {}, '▼ Maiores descidas'), M.dn)));
}

let moversToken = 0;
async function renderMovers() {
  if (!S.cards.length) return;
  const tok = ++moversToken;
  const items = await V.movers(S.period, parseNum(S.mmin) || 0);
  if (tok !== moversToken) return;
  const key = { pct: (m) => m.pct, delta: (m) => m.delta, total: (m) => m.total }[S.msort];
  const ups = items.filter((m) => m.delta > 0).sort((a, b) => key(b) - key(a)).slice(0, 40);
  const dns = items.filter((m) => m.delta < 0).sort((a, b) => key(a) - key(b)).slice(0, 40);
  const fill = (host, list, kind) => {
    host.replaceChildren(...(list.length ? list.map((m, i) => moverRow(m, i, kind)) : [el('div', { class: 'chart-empty' }, 'Nada a mostrar neste período.')]));
  };
  fill(M.up, ups, 'up'); fill(M.dn, dns, 'down');
  const hist = items.filter((m) => m.src === 'histórico').length;
  M.info.textContent = `${items.length} cartas comparadas: ${hist} pelo teu histórico, ${items.length - hist} pela média que o Cardmarket publica (até teres histórico suficiente).`;
}

function moverRow(m, i, kind) {
  return el('div', { class: 'mrow', style: { '--i': i }, onclick: () => openDrawer(m.id), title: 'Referência: ' + m.src },
    el('div', { class: 'rank' }, i + 1),
    el('div', { style: { minWidth: 0 } }, el('div', { class: 'nm' }, m.name), el('div', { class: 'sb' }, `${m.set} · ${m.printing || 'Normal'} · ×${m.qty}`)),
    el('div', { class: 'price' }, eur(m.now), el('small', {}, 'antes ' + eur(m.ref))),
    el('div', { class: 'price' }, el('span', { class: 'pill ' + kind }, pct(m.pct)), el('small', {}, eurS(m.total))));
}

// ------------------------------------------------------------------ Mais valiosas
function buildTop() {
  const root = $('#view-top .content');
  T.price = el('div', { class: 'list-body' }); T.stock = el('div', { class: 'list-body' });
  root.append(el('div', { class: 'cols2' },
    el('div', { class: 'card list-card' }, el('h3', {}, 'Cartas mais caras (unidade)'), T.price),
    el('div', { class: 'card list-card' }, el('h3', {}, 'Maior valor em stock (qtd × preço)'), T.stock)));
}
const T = {};

function renderTop() {
  const priced = S.cards.filter((c) => c.price != null);
  const total = priced.reduce((s, c) => s + c._value, 0) || 1;
  const fill = (host, list, valueOf, subOf) => {
    const max = Math.max(...list.map(valueOf), 1e-9);
    host.replaceChildren(...list.map((c, i) => el('div', { class: 'trow', style: { '--i': i, '--w': (valueOf(c) / max * 100) + '%' }, onclick: () => openDrawer(c.id) },
      el('div', { class: 'rank muted num' }, i + 1),
      el('div', { style: { minWidth: 0 } }, el('div', { class: 'nm', style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.name),
        el('div', { class: 'muted small', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, subOf(c))),
      el('div', { class: 'muted num small' }, `${pct(c._value / total).replace('+', '')} da coleção`),
      el('div', { class: 'num', style: { fontWeight: 700 } }, eur(valueOf(c))))));
  };
  fill(T.price, [...priced].sort((a, b) => b.price - a.price).slice(0, 50), (c) => c.price, (c) => `${c.set_name} · ${c.printing || 'Normal'} · ×${c.quantity}`);
  fill(T.stock, [...priced].sort((a, b) => b._value - a._value).slice(0, 50), (c) => c._value, (c) => `${c.quantity} × ${eur(c.price)} · ${c.set_name}`);
}

// ------------------------------------------------------------------ Definições
function buildSettings() {
  const root = $('#view-settings .content');
  const sw = el('div', { class: 'switch' + (S.settings.autoRefresh ? ' on' : ''), role: 'switch', onclick: () => {
    S.settings.autoRefresh = !S.settings.autoRefresh;
    sw.classList.toggle('on', !!S.settings.autoRefresh);
    V.setSetting('autoRefresh', !!S.settings.autoRefresh);
  } });
  L.sw = sw;
  L.path = el('span', {}, '');
  L.box = el('div', { class: 'logbox' });
  const row = (t, sub, ctl) => el('div', { class: 'row' }, el('div', { class: 't' }, el('b', {}, t), el('span', {}, sub)), ctl);
  root.append(
    el('div', { class: 'card' }, el('h3', {}, 'Preços'),
      row('Atualizar ao abrir', 'Se ainda não atualizaste hoje, os preços são atualizados quando a app abre.', sw),
      row('Atualizar agora', 'Descarrega o guia de preços do Cardmarket (atualiza 1× por dia).', el('button', { class: 'btn', onclick: doRefresh }, 'Atualizar preços'))),
    el('div', { class: 'card' }, el('h3', {}, 'Dados'),
      row('Backup', 'Guarda um ficheiro com toda a coleção e o histórico de preços.', el('button', { class: 'btn', onclick: doBackup }, 'Guardar backup…')),
      row('Restaurar', 'Substitui a coleção atual por um backup.', el('button', { class: 'btn', onclick: doRestore }, 'Restaurar…')),
      row('Pasta de dados', 'Onde a coleção fica guardada neste Mac.', el('button', { class: 'btn', onclick: () => V.reveal() }, 'Mostrar no Finder'))),
    el('div', { class: 'card' }, el('h3', {}, 'Registo'), L.box));
}

function appendLog(m) {
  L.box.append(document.createTextNode(m + '\n'));
  L.box.scrollTop = L.box.scrollHeight;
}

// ------------------------------------------------------------------ ações
async function loadState() {
  const st = await V.getState();
  S.cards = st.cards.map(decorate);
  S.byId = new Map(S.cards.map((c) => [c.id, c]));
  S.portfolio = st.portfolio || [];
  S.settings = st.settings || {};
  S.priceDate = st.priceDate;
  S.file = st.file;
  L.sw.classList.toggle('on', !!S.settings.autoRefresh);
  renderSidebar();
  setEmpty(!S.cards.length);
  Object.keys(VIEWS).forEach((v) => dirty.add(v));
  renderView(S.view);
  if (S.selected) { if (S.byId.has(S.selected)) openDrawer(S.selected); else closeDrawer(); }
}

function doRefresh() {
  if (S.busy) return;
  if (!S.cards.length) { toast('Importa primeiro um CSV.', 'error'); return; }
  V.refresh(true);
}

async function doImportPick() {
  if (S.busy) return;
  const info = await V.pickImport();
  if (info.canceled) return;
  await startImport(info);
}

async function startImport(info) {
  if (!info) return;
  if (info.error) { toast(info.error, 'error', 5000); return; }
  if (info.dupAt) {
    const ok = await modal({ title: 'Ficheiro já importado', body: `Este ficheiro já foi importado a ${new Date(info.dupAt).toLocaleString('pt-PT')}.\nImportar outra vez pode duplicar quantidades.`,
      buttons: [{ label: 'Cancelar', value: false, cancel: true }, { label: 'Importar na mesma', value: true, kind: 'danger' }] });
    if (!ok) return;
  }
  let mode = 'add';
  if (S.cards.length) {
    mode = await modal({ title: 'Como importar?', body: `${info.name} · ${INT.format(info.rows)} linhas\n\nSomar: adiciona às quantidades que já tens (cartas novas).\nSubstituir: define a quantidade das cartas que já existem.`,
      buttons: [{ label: 'Cancelar', value: null, cancel: true }, { label: 'Substituir', value: 'replace' }, { label: 'Somar às existentes', value: 'add', kind: 'primary' }] });
    if (!mode) return;
  }
  showView('collection');
  await V.runImport({ path: info.path, mode, sha1: info.sha1 });
}

async function doExport() {
  const r = await V.exportCsv(S.rows.map((c) => c.id));
  if (r.error) toast(r.error, 'error');
  else if (r.path) toast(`Exportadas ${INT.format(r.count)} linhas`);
}
async function doBackup() { const r = await V.backupSave(); if (r.path) toast('Backup guardado'); }
async function doRestore() {
  const r = await V.backupRestore();
  if (r.error) toast(r.error, 'error');
  else if (r.count != null) { await loadState(); toast(`Coleção restaurada (${INT.format(r.count)} cartas)`); }
}

// ------------------------------------------------------------------ tarefas em segundo plano
function setJob(text, frac) {
  $('#jobText').textContent = text;
  const bar = $('#jobBar');
  if (frac == null) { bar.classList.add('indeterminate'); bar.style.width = ''; }
  else { bar.classList.remove('indeterminate'); bar.style.width = Math.round(frac * 100) + '%'; }
}

V.on.start(() => { S.busy = true; document.body.classList.add('busy'); $('#jobcard').classList.remove('hidden'); setJob('A preparar…', null); });
V.on.progress((p) => setJob(`${p.label} · ${p.done}/${p.total}`, p.total ? p.done / p.total : null));
V.on.log((m) => appendLog(m));
V.on.done(async (r) => {
  S.busy = false; document.body.classList.remove('busy'); $('#jobcard').classList.add('hidden');
  await loadState();
  if (r.error) { toast(r.error, 'error', 6000); appendLog('ERRO: ' + r.error); } else toast(r.message || 'Concluído');
});
V.on.menuImport(doImportPick);
V.on.menuRefresh(doRefresh);
$('#jobCancel').addEventListener('click', () => V.cancel());

// ------------------------------------------------------------------ eventos globais
let dragDepth = 0;
const dz = $('#dropzone');
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dz.classList.add('on'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dz.classList.remove('on'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; dz.classList.remove('on');
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (!f || S.busy) return;
  if (!/\.csv$/i.test(f.name)) { toast('Larga um ficheiro .csv', 'error'); return; }
  await startImport(await V.inspectImport(V.pathForFile(f)));
});
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'f')) { e.preventDefault(); showView('collection'); C.search.focus(); C.search.select(); }
  else if (e.key === 'Escape') { if (S.modalClose) S.modalClose(); else if (S.selected) closeDrawer(); }
});
$('#scrim').addEventListener('click', closeDrawer);
window.addEventListener('resize', debounce(() => { placeIndicator(); if (S.view === 'summary') renderSummary(); }, 250));

// ------------------------------------------------------------------ arranque
function init() {
  const nav = $('#nav');
  for (const [name, v] of Object.entries(VIEWS)) {
    nav.append(el('button', { class: 'nav-item', 'data-view': name, onclick: () => showView(name), html: ICONS[name] + `<span>${v.title}</span>` }));
  }
  $('#btnRefresh').innerHTML = ICONS.refresh + '<span>Atualizar preços</span>';
  $('#btnImport').innerHTML = ICONS.import + '<span>Importar CSV</span>';
  $('#btnRefresh').addEventListener('click', doRefresh);
  $('#btnImport').addEventListener('click', doImportPick);
  ['summary', 'collection', 'movers', 'top'].forEach((n) => $('#view-' + n).append(emptyState()));
  buildCollection(); buildMovers(); buildTop(); buildSettings();
  loadState().then(() => {
    showView('summary');
    requestAnimationFrame(placeIndicator);
    if (S.settings.autoRefresh && S.settings.lastRefresh !== todayISO() && S.cards.length) V.refresh(false);
  });
}
init();
