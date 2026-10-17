'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const core = require('./core');

let win = null;
let store = null;
let job = null;

const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };

function createWindow() {
  win = new BrowserWindow({
    width: 1380, height: 880, minWidth: 1180, minHeight: 700,
    backgroundColor: '#0a0c12',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://')) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const tpl = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'Ficheiro', submenu: [
      { label: 'Importar CSV…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:import') },
      { label: 'Atualizar preços', accelerator: 'CmdOrCtrl+R', click: () => send('menu:refresh') },
      { type: 'separator' }, mac ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'Ver', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

async function runJob(fn) {
  if (job) return;
  const cancel = { stopped: false };
  job = { cancel };
  const ctx = {
    store, dir: app.getPath('userData'), cancel,
    log: (m) => send('job:log', m),
    progress: (done, total, label) => send('job:progress', { done, total, label }),
  };
  send('job:start');
  try {
    const message = await fn(ctx);
    send('job:done', { message });
  } catch (e) {
    if (e instanceof core.Cancelled) { store.flush(); send('job:done', { cancelled: true, message: 'Cancelado.' }); }
    else send('job:done', { error: e.message || String(e) });
  } finally { job = null; }
}

const allowedExternal = (u) => /^https:\/\/(www\.cardmarket\.com|scryfall\.com)\//.test(u);

function registerIpc() {
  ipcMain.handle('state:get', () => core.slimState(store));

  ipcMain.handle('import:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'CSV exportado da TCGplayer', properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    return core.inspectImport(store, r.filePaths[0]);
  });
  ipcMain.handle('import:inspect', (_e, file) => core.inspectImport(store, String(file)));
  ipcMain.handle('import:run', (_e, args) => { runJob((ctx) => core.runImport(ctx, args)); return true; });
  ipcMain.handle('refresh:run', (_e, { force }) => { runJob((ctx) => core.runRefresh(ctx, { force: !!force })); return true; });
  ipcMain.handle('job:cancel', () => { if (job) job.cancel.stopped = true; return true; });

  ipcMain.handle('movers', (_e, { days, min }) => core.computeMovers(store, Number(days) || 7, Number(min) || 0));
  ipcMain.handle('card:history', (_e, id) => core.cardHistory(store, id));
  ipcMain.handle('card:image', async (_e, tcgId) => {
    try { return pathToFileURL(await core.fetchImage(app.getPath('userData'), tcgId)).href; } catch { return null; }
  });
  ipcMain.handle('card:setQty', (_e, { id, qty }) => {
    const c = store.byId(id);
    if (!c) return false;
    c.quantity = Math.max(1, Math.min(100000, Math.trunc(qty) || 1));
    core.snapshotPortfolio(store);
    store.save();
    return true;
  });
  ipcMain.handle('card:delete', (_e, ids) => {
    store.deleteCards(ids);
    core.snapshotPortfolio(store);
    store.save();
    return true;
  });

  ipcMain.handle('export:csv', async (_e, ids) => {
    const set = new Set(ids);
    const cards = store.data.cards.filter((c) => set.has(c.id));
    if (!cards.length) return { error: 'Não há linhas para exportar.' };
    const r = await dialog.showSaveDialog(win, { title: 'Exportar vista atual', defaultPath: 'card-vault-export.csv',
      filters: [{ name: 'CSV (abre no Excel / Numbers)', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return { canceled: true };
    core.exportCsv(cards, r.filePath);
    return { path: r.filePath, count: cards.length };
  });

  ipcMain.handle('backup:save', async () => {
    const r = await dialog.showSaveDialog(win, { title: 'Guardar backup', defaultPath: `card-vault-backup-${core.todayISO()}.json`,
      filters: [{ name: 'Backup Card Vault', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return { canceled: true };
    store.flush();
    fs.copyFileSync(store.file, r.filePath);
    return { path: r.filePath };
  });
  ipcMain.handle('backup:restore', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Restaurar backup', properties: ['openFile'],
      filters: [{ name: 'Backup Card Vault', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    let d;
    try { d = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); } catch { return { error: 'Ficheiro inválido.' }; }
    if (!d || !Array.isArray(d.cards)) return { error: 'Isto não é um backup do Card Vault.' };
    const c = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancelar', 'Substituir coleção'], defaultId: 0, cancelId: 0,
      message: 'Substituir a coleção atual pelo backup?', detail: `O backup tem ${d.cards.length} cartas. A coleção atual será substituída.` });
    if (c.response !== 1) return { canceled: true };
    store.data = d;
    store.reindex();
    store.flush();
    return { count: d.cards.length };
  });

  ipcMain.handle('settings:set', (_e, { key, value }) => { store.setting(String(key), value); return true; });
  ipcMain.handle('shell:reveal', () => { shell.showItemInFolder(store.file); return true; });
  ipcMain.handle('shell:external', (_e, url) => { if (allowedExternal(String(url))) shell.openExternal(String(url)); return true; });
}

app.whenReady().then(() => {
  store = new core.Store(app.getPath('userData'));
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => { if (store) store.flush(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
