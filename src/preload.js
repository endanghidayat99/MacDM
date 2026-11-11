'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('macdm', {
  platform: ipcRenderer.sendSync('platform') || 'darwin',
  ready: invoke('renderer-ready'),
  list: invoke('list'),
  categories: invoke('categories'),
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  probe: invoke('probe'),
  dirFor: invoke('dir-for'),
  add: invoke('add'),
  pause: invoke('pause'),
  resume: invoke('resume'),
  remove: invoke('remove'),
  startQueue: invoke('queue:start'),
  stopQueue: invoke('queue:stop'),
  clearCompleted: invoke('clear-completed'),
  openFile: invoke('open-file'),
  showInFolder: invoke('show-in-folder'),
  copyUrl: invoke('copy-url'),
  chooseDir: invoke('choose-dir'),
  clipboardUrl: invoke('clipboard-url'),
  onUpdate: on('update'),
  onExternalAdd: on('external-add'),
  onMenu: on('menu'),
  onToast: on('toast'),
});
