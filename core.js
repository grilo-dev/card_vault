'use strict';
// Núcleo do Card Vault: armazenamento JSON, importação TCGplayer, preços Cardmarket, variações.
// Sem dependências externas (só Node 18+ / Electron).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PRICE_GUIDE_URL = 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json';
const UA = 'CardVault/2.0';
const WORKERS = 6;
const MIN_INTERVAL = 105;               // ms entre pedidos ao Scryfall (~9/s; o limite é 10/s)
const GUIDE_MAX_AGE = 6 * 3600 * 1000;  // reutiliza o guia de preços descarregado há menos de 6 h
const GUIDE_KEYS = ['trend', 'trend-foil', 'low', 'low-foil', 'avg1', 'avg1-foil', 'avg7', 'avg7-foil', 'avg30', 'avg30-foil'];

class Cancelled extends Error {}
class UserError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayISO = () => new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD (hora local)

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

class RateLimiter {
  constructor(interval) { this.interval = interval; this.next = 0; }
  async wait() {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.interval;
    if (at > now) await sleep(at - now);
  }
}
const limiter = new RateLimiter(MIN_INTERVAL);

// ------------------------------------------------------------------ rede (substituível nos testes)
const api = {
  async lookupCardmarketId(tcgId, cancel) {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (cancel.stopped) throw new Cancelled();
      await limiter.wait();
      let res;
      try {
        res = await fetch(`https://api.scryfall.com/cards/tcgplayer/${encodeURIComponent(tcgId)}`,
          { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      } catch { await sleep(1000 * (attempt + 1)); continue; }
      if (res.status === 200) { const j = await res.json(); return j.cardmarket_id ?? null; }
      if (res.status === 404) return null;
      if (res.status === 429) { await sleep((Number(res.headers.get('retry-after')) || 5) * 1000); continue; }
      await sleep(1000 * (attempt + 1));
    }
    throw new UserError('O Scryfall não respondeu (verifica a ligação à internet).');
  },
  async fetchPriceGuide() {
    let res;
    try { res = await fetch(PRICE_GUIDE_URL, { headers: { 'User-Agent': UA, Accept: 'application/json' } }); }
    catch (e) { throw new UserError(`Sem ligação à internet? (${e.message})`); }
    if (!res.ok) throw new UserError(`Não foi possível descarregar o guia de preços do Cardmarket (HTTP ${res.status}).`);
    return res.json();
  },
  async fetchImageBytes(tcgId) {
    await limiter.wait();
    const res = await fetch(`https://api.scryfall.com/cards/tcgplayer/${encodeURIComponent(tcgId)}?format=image&version=png`,
      { headers: { 'User-Agent': UA, Accept: 'image/png' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return Buffer.from(await res.arrayBuffer());
  },
};

// ------------------------------------------------------------------ CSV
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = text.split('\n', 1)[0];
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.some((x) => x !== '')).map((r) => {
    const o = {};
    head.forEach((h, i) => { o[h] = r[i] ?? ''; });
    return o;
  });
}

const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// ------------------------------------------------------------------ armazenamento
class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'vault.json');
    this.timer = null;
    this.lastBak = 0;
    this.load();
  }
  load() {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* ficheiro novo */ }
    this.data = d && Array.isArray(d.cards) ? d : { version: 1, nextId: 1, cards: [], portfolio: [], imports: [], settings: {} };
    this.reindex();
    return this;
  }
  reindex() {
    this.index = new Map();
    this.byIdMap = new Map();
    for (const c of this.data.cards) {
      this.index.set(Store.key(c.tcg_id, c.condition, c.printing), c);
      this.byIdMap.set(c.id, c);
    }
  }
  static key(tcg, cond, pr) { return `${tcg}|${cond}|${pr}`; }
  byId(id) { return this.byIdMap.get(id); }
  addCard(c) {
    c.id = this.data.nextId++;
    c.hist = c.hist || [];
    this.data.cards.push(c);
    this.index.set(Store.key(c.tcg_id, c.condition, c.printing), c);
    this.byIdMap.set(c.id, c);
    return c;
  }
  deleteCards(ids) {
    const s = new Set(ids);
    this.data.cards = this.data.cards.filter((c) => !s.has(c.id));
    this.reindex();
  }
  save() { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 300); }
  flush() {
    clearTimeout(this.timer);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    if (fs.existsSync(this.file) && Date.now() - this.lastBak > 3600e3) {
      try { fs.copyFileSync(this.file, this.file + '.bak'); this.lastBak = Date.now(); } catch { /* ignora */ }
    }
    fs.renameSync(tmp, this.file);
  }
  setting(k, v) { this.data.settings[k] = v; this.save(); }
}

// ------------------------------------------------------------------ caches
function loadIdCache(dir) {
  const own = path.join(dir, 'cardmarket_id_cache.json');
  const home = os.homedir();
  const cands = [own,
    path.join(home, 'Library', 'Application Support', 'Card Vault', 'cardmarket_id_cache.json'),
    path.join(home, 'Library', 'Application Support', 'Cardmarket Inventory', 'cardmarket_id_cache.json')];
  for (const f of cands) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* tenta o seguinte */ } }
  return {};
}
function saveIdCache(dir, cache) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'cardmarket_id_cache.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(cache));
  fs.renameSync(f + '.tmp', f);
}

async function resolveIds(ids, cache, ctx) {
  const todo = ids.filter((i) => !(i in cache));
  ctx.log(`${ids.length} produtos únicos: ${ids.length - todo.length} em cache, ${todo.length} a consultar no Scryfall.`);
  if (!todo.length) return;
  let done = 0, idx = 0, failure = null;
  const worker = async () => {
    while (!failure) {
      const i = idx++;
      if (i >= todo.length) return;
      if (ctx.cancel.stopped) throw new Cancelled();
      try {
        const cm = await api.lookupCardmarketId(todo[i], ctx.cancel);
        if (cm != null) cache[todo[i]] = cm; // não guarda falhas: o Scryfall pode adicionar o ID depois
      } catch (e) { failure = e; throw e; }
      done++;
      ctx.progress(done, todo.length, 'A procurar Cardmarket IDs');
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(WORKERS, todo.length) }, worker));
  } finally { saveIdCache(ctx.dir, cache); }
}

async function loadPriceGuide(dir, log, force) {
  const file = path.join(dir, 'price_guide_cache.json');
  if (!force) {
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < GUIDE_MAX_AGE) {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        log(`Guia de preços em cache (de ${d.createdAt}).`);
        return { guide: new Map(Object.entries(d.prices).map(([k, v]) => [Number(k), v])), gdate: d.date };
      }
    } catch { /* sem cache válida */ }
  }
  log('A descarregar o guia de preços do Cardmarket...');
  const data = await api.fetchPriceGuide();
  const guides = Array.isArray(data) ? data : data.priceGuides;
  const created = (!Array.isArray(data) && data.createdAt) ? String(data.createdAt) : '';
  const gdate = /^\d{4}-\d{2}-\d{2}/.test(created) ? created.slice(0, 10) : todayISO();
  const prices = {};
  for (const g of guides) {
    const o = {};
    for (const k of GUIDE_KEYS) if (g[k] != null) o[k] = g[k];
    prices[g.idProduct] = o;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ createdAt: created || gdate, date: gdate, prices }));
  } catch { /* cache é opcional */ }
  log(`  ${guides.length.toLocaleString('pt-PT')} produtos, guia de ${gdate}`);
  return { guide: new Map(Object.entries(prices).map(([k, v]) => [Number(k), v])), gdate };
}

// ------------------------------------------------------------------ preços
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

function pickPrices(g, printing) {
  if (!g) return [null, 'não está no guia de preços'];
  let sfx = /foil/i.test(printing || '') ? '-foil' : '';
  let note = null;
  let price = num(g['trend' + sfx]);
  if (!price && sfx) { sfx = ''; note = 'sem trend foil, usado o trend normal'; price = num(g.trend); }
  if (!price) return [null, 'sem preço trend'];
  return [{ price, low: num(g['low' + sfx]), avg1: num(g['avg1' + sfx]), avg7: num(g['avg7' + sfx]), avg30: num(g['avg30' + sfx]) }, note];
}

const maxPriceDate = (cards) => cards.reduce((m, c) => (c.price_date && c.price_date > m ? c.price_date : m), '') || null;

function snapshotPortfolio(store) {
  const d = maxPriceDate(store.data.cards);
  if (!d) return;
  let value = 0, qty = 0, n = 0;
  for (const c of store.data.cards) if (c.price != null) { value += c.quantity * c.price; qty += c.quantity; n++; }
  const row = [d, Math.round(value * 100) / 100, qty, n];
  const p = store.data.portfolio;
  const i = p.findIndex((r) => r[0] === d);
  if (i >= 0) p[i] = row; else { p.push(row); p.sort((a, b) => (a[0] < b[0] ? -1 : 1)); }
}

function refreshPrices(store, guide, gdate, log) {
  let changed = 0;
  const problems = [];
  for (const c of store.data.cards) {
    const label = `  ${c.name} [${c.set_name}] ${c.printing}`;
    if (c.cm_id == null) { problems.push(label + ' - sem Cardmarket ID no Scryfall'); continue; }
    const [p, note] = pickPrices(guide.get(Number(c.cm_id)), c.printing);
    if (note) problems.push(`${label} - ${note}`);
    if (!p) continue;
    if (c.price !== p.price) changed++;
    Object.assign(c, p, { price_date: gdate });
    // histórico comprimido: só guarda quando o preço muda (valor num dia = último ponto <= dia)
    const h = c.hist || (c.hist = []);
    const last = h[h.length - 1];
    if (last && last[0] === gdate) last[1] = p.price;
    else if (!last || last[1] !== p.price) h.push([gdate, p.price]);
  }
  snapshotPortfolio(store);
  store.data.settings.lastRefresh = todayISO();
  log(`\n${changed} preços mudaram (guia de ${gdate}).`);
  if (problems.length) {
    log(`${problems.length} carta(s) sem preço:`);
    problems.slice(0, 200).forEach((p) => log(p));
  }
  return changed;
}

function applyIds(store, cache) {
  for (const c of store.data.cards) if (c.cm_id == null && cache[c.tcg_id] != null) c.cm_id = cache[c.tcg_id];
}

// ------------------------------------------------------------------ tarefas
async function runRefresh(ctx, { force = true } = {}) {
  const store = ctx.store;
  if (!store.data.cards.length) throw new UserError('A coleção está vazia. Importa primeiro um CSV.');
  const cache = loadIdCache(ctx.dir);
  const missing = [...new Set(store.data.cards.filter((c) => c.cm_id == null).map((c) => c.tcg_id))];
  const gp = loadPriceGuide(ctx.dir, ctx.log, force);
  gp.catch(() => {});
  await resolveIds(missing, cache, ctx);
  const { guide, gdate } = await gp;
  if (ctx.cancel.stopped) throw new Cancelled();
  applyIds(store, cache);
  const n = refreshPrices(store, guide, gdate, ctx.log);
  store.flush();
  return `Preços atualizados (${n} alterações).`;
}

function parseQty(r) {
  const q = String(r['Total Quantity'] || r['Add to Quantity'] || '1').trim();
  const n = q ? Math.trunc(parseFloat(q)) : 1;
  return Number.isFinite(n) ? n : 1;
}

function inspectImport(store, file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { error: 'Não consegui ler o ficheiro: ' + e.message }; }
  const rows = parseCSV(text);
  if (!rows.length || !('Product ID' in rows[0])) return { error: "Isto não parece uma exportação da TCGplayer (falta a coluna 'Product ID')." };
  const sha1 = crypto.createHash('sha1').update(text).digest('hex');
  const prev = store.data.imports.find((i) => i.sha1 === sha1);
  return { path: file, name: path.basename(file), sha1, rows: rows.length, dupAt: prev ? prev.at : null };
}

async function runImport(ctx, { path: file, mode = 'add', sha1 = '' }) {
  const store = ctx.store;
  const rows = parseCSV(fs.readFileSync(file, 'utf8'));
  if (!rows.length || !('Product ID' in rows[0])) throw new UserError("Isto não parece uma exportação da TCGplayer (falta a coluna 'Product ID').");
  const agg = new Map();
  for (const r of rows) {
    const pid = String(r['Product ID'] || '').trim();
    const qty = parseQty(r);
    if (!pid || qty <= 0) continue;
    const cond = String(r.Condition || '').trim(), pr = String(r.Printing || '').trim();
    const k = Store.key(pid, cond, pr);
    const a = agg.get(k);
    if (a) a.qty += qty;
    else agg.set(k, { pid, cond, pr, qty, name: r['Product Name'] || '', set: r['Set Name'] || '', number: r.Number || '', rarity: r.Rarity || '' });
  }
  if (!agg.size) throw new UserError('O CSV não tem cartas válidas.');
  ctx.log(`${rows.length} linhas no CSV -> ${agg.size} cartas distintas.`);

  const cache = loadIdCache(ctx.dir);
  const ids = [...new Set([...agg.values()].map((a) => a.pid))];
  const gp = loadPriceGuide(ctx.dir, ctx.log, false);
  gp.catch(() => {});
  await resolveIds(ids, cache, ctx);
  const { guide, gdate } = await gp;
  if (ctx.cancel.stopped) throw new Cancelled();

  let added = 0, updated = 0;
  const now = new Date().toISOString();
  for (const [k, d] of agg) {
    const cm = cache[d.pid] ?? null;
    const ex = store.index.get(k);
    if (ex) {
      ex.quantity = mode === 'add' ? ex.quantity + d.qty : d.qty;
      if (ex.cm_id == null && cm != null) ex.cm_id = cm;
      updated++;
    } else {
      store.addCard({ tcg_id: d.pid, cm_id: cm, name: d.name, set_name: d.set, number: d.number, rarity: d.rarity,
        condition: d.cond, printing: d.pr, quantity: d.qty, added_at: now, price: null, low: null, avg1: null, avg7: null,
        avg30: null, price_date: null });
      added++;
    }
  }
  store.data.imports.push({ sha1, filename: path.basename(file), at: now, rows: rows.length, new_cards: added });
  applyIds(store, cache);
  ctx.log(`${added} cartas novas, ${updated} já existiam (${mode === 'add' ? 'somadas' : 'substituídas'}).`);
  refreshPrices(store, guide, gdate, ctx.log);
  store.flush();
  return `Importação concluída: ${added} novas, ${updated} atualizadas.`;
}

// ------------------------------------------------------------------ consultas
function valueAt(hist, iso) {
  let v = null;
  for (const [d, p] of hist || []) { if (d <= iso) v = p; else break; }
  return v;
}

function computeMovers(store, days, minPrice = 0) {
  const latest = maxPriceDate(store.data.cards);
  if (!latest) return [];
  const cutoff = addDays(latest, -days);
  const col = { 1: 'avg1', 7: 'avg7', 30: 'avg30' }[days];
  const out = [];
  for (const c of store.data.cards) {
    if (c.price == null) continue;
    let ref = valueAt(c.hist, cutoff), src = 'histórico';
    if (ref == null) {
      if (col && c[col]) { ref = c[col]; src = `média CM ${days}d`; } else continue;
    }
    if (!ref || ref <= 0 || Math.max(ref, c.price) < minPrice) continue;
    const delta = c.price - ref;
    out.push({ id: c.id, name: c.name, set: c.set_name, printing: c.printing, qty: c.quantity, ref, now: c.price,
      delta, pct: delta / ref, total: delta * c.quantity, src });
  }
  return out;
}

function cardHistory(store, id) {
  const c = store.byId(id);
  if (!c) return [];
  const h = (c.hist || []).map((x) => x.slice());
  if (c.price != null && c.price_date && (!h.length || h[h.length - 1][0] < c.price_date)) h.push([c.price_date, c.price]);
  return h;
}

function slimState(store) {
  const d = store.data;
  return { cards: d.cards.map(({ hist, ...c }) => c), portfolio: d.portfolio, settings: d.settings,
    priceDate: maxPriceDate(d.cards), file: store.file };
}

function exportCsv(cards, file) {
  const head = ['Quantity', 'Set', 'Name', 'Number', 'Rarity', 'Condition', 'Printing', 'Cardmarket ID',
    'Cardmarket Trend (EUR)', 'Cardmarket From (EUR)', 'Total Value (EUR)', 'Price Date'];
  const lines = [head.join(',')];
  for (const c of cards) {
    const total = c.price != null ? Math.round(c.quantity * c.price * 100) / 100 : '';
    lines.push([c.quantity, c.set_name, c.name, c.number, c.rarity, c.condition, c.printing, c.cm_id, c.price, c.low, total, c.price_date]
      .map(csvCell).join(','));
  }
  fs.writeFileSync(file, '\ufeff' + lines.join('\r\n'));
}

async function fetchImage(dir, tcgId) {
  const folder = path.join(dir, 'images');
  fs.mkdirSync(folder, { recursive: true });
  const f = path.join(folder, `${String(tcgId).replace(/[^\w-]/g, '')}.png`);
  try { if (fs.statSync(f).size > 1000) return f; } catch { /* ainda não existe */ }
  const bytes = await api.fetchImageBytes(tcgId);
  fs.writeFileSync(f + '.tmp', bytes);
  fs.renameSync(f + '.tmp', f);
  return f;
}

module.exports = { api, Store, Cancelled, UserError, parseCSV, runImport, runRefresh, inspectImport, computeMovers,
  cardHistory, slimState, exportCsv, fetchImage, snapshotPortfolio, pickPrices, valueAt, todayISO };
