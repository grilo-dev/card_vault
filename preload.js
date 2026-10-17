'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch, arg) => ipcRenderer.invoke(ch, arg);
const sub = (ch) => (cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('vault', {
  getState: () => invoke('state:get'),
  pickImport: () => invoke('import:pick'),
  inspectImport: (p) => invoke('import:inspect', p),
  runImport: (a) => invoke('import:run', a),
  refresh: (force) => invoke('refresh:run', { force }),
  cancel: () => invoke('job:cancel'),
  movers: (days, min) => invoke('movers', { days, min }),
  history: (id) => invoke('card:history', id),
  image: (tcgId) => invoke('card:image', tcgId),
  setQty: (id, qty) => invoke('card:setQty', { id, qty }),
  deleteCards: (ids) => invoke('card:delete', ids),
  exportCsv: (ids) => invoke('export:csv', ids),
  backupSave: () => invoke('backup:save'),
  backupRestore: () => invoke('backup:restore'),
  setSetting: (key, value) => invoke('settings:set', { key, value }),
  reveal: () => invoke('shell:reveal'),
  openExternal: (url) => invoke('shell:external', url),
  pathForFile: (file) => webUtils.getPathForFile(file),
  on: {
    start: sub('job:start'), progress: sub('job:progress'), log: sub('job:log'), done: sub('job:done'),
    menuImport: sub('menu:import'), menuRefresh: sub('menu:refresh'),
  },
});
