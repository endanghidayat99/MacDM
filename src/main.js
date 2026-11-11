'use strict';

const {
  app, BrowserWindow, ipcMain, shell, dialog, Notification, Menu, Tray, nativeImage, nativeTheme, clipboard,
} = require('electron');
const path = require('path');
const { DownloadManager } = require('./engine/manager');
const { CATEGORY_NAMES } = require('./engine/categories');
const { startBridgeServer } = require('./server');

let win = null;
let manager = null;
let bridge = null;
let tray = null;
let quitting = false;
let trayHintShown = false;
let rendererReady = false;
const pendingExternal = []; // link dari browser yang datang sebelum UI siap

// MACDM_PLATFORM hanya untuk pengujian tampilan; default = platform asli.
const PLATFORM = process.env.MACDM_PLATFORM || process.platform;
const IS_MAC = PLATFORM === 'darwin';
const APP_ID = 'id.cipdev.macdm';

if (!app.requestSingleInstanceLock()) app.quit();
if (process.platform === 'win32') app.setAppUserModelId(APP_ID); // wajib agar notifikasi Windows muncul

const THEME = {
  dark: { bg: '#1b1c1f', symbol: '#ececee' },
  light: { bg: '#ffffff', symbol: '#1d1d1f' },
};
const theme = () => (nativeTheme.shouldUseDarkColors ? THEME.dark : THEME.light);

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 860,
    minHeight: 520,
    backgroundColor: theme().bg,
    icon: IS_MAC ? undefined : path.join(__dirname, 'assets', 'icon.png'),
    // Mac: tombol lampu lalu lintas di atas sidebar. Windows/Linux: title bar
    // disembunyikan, tombol minimize/maximize/close native digambar di atas toolbar.
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: theme().bg, symbolColor: theme().symbol, height: 52 } }),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  win.once('ready-to-show', () => win.show());
  // Tutup jendela = sembunyikan; download tetap jalan (Dock di Mac, tray di Windows).
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!IS_MAC && !trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({ title: 'MacDM tetap berjalan', body: 'Download berlanjut di latar. Buka lagi lewat ikon di system tray.' }).show();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function fmtSpeed(bps) {
  if (!bps) return '0 B/s';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bps) / Math.log(1024)));
  return `${(bps / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}/s`;
}

function updateIndicators(list) {
  const active = list.filter((d) => d.status === 'downloading' || d.status === 'connecting');
  if (app.dock) app.dock.setBadge(active.length ? String(active.length) : '');
  if (tray) {
    const speed = active.reduce((a, d) => a + (d.speed || 0), 0);
    tray.setToolTip(active.length ? `MacDM — ${active.length} aktif · ${fmtSpeed(speed)}` : 'MacDM');
  }
  if (win && !IS_MAC) {
    // Progres total di taskbar Windows
    const total = active.reduce((a, d) => a + (d.size || 0), 0);
    const done = active.reduce((a, d) => a + (d.downloaded || 0), 0);
    win.setProgressBar(active.length && total ? done / total : -1);
  }
}

function createTray() {
  if (IS_MAC) return; // di Mac cukup Dock
  const icon = nativeImage.createFromPath(
    path.join(__dirname, 'assets', process.platform === 'win32' ? 'tray.ico' : 'tray.png')
  );
  tray = new Tray(icon);
  tray.setToolTip('MacDM');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Buka MacDM', click: showWindow },
      { label: 'Tambah URL…', click: () => { showWindow(); send('menu', 'add'); } },
      { type: 'separator' },
      { label: 'Mulai Antrian', click: () => manager.startQueue() },
      { label: 'Hentikan Semua', click: () => manager.stopQueue() },
      { type: 'separator' },
      { label: 'Keluar', click: () => app.quit() },
    ])
  );
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

async function handleExternalAdd(req) {
  showWindow();
  if (!manager.settings.showAddDialog) {
    try {
      const info = await manager.probe(req.url, req.headers);
      manager.add({ ...info, url: req.url, headers: req.headers, filename: req.filename || info.filename });
    } catch (e) {
      send('toast', { kind: 'error', text: `Gagal menambah ${req.url}: ${e.message}` });
    }
    return;
  }
  if (rendererReady) send('external-add', req);
  else pendingExternal.push(req);
}

function buildMenu() {
  if (!IS_MAC) {
    // Windows/Linux: tanpa menu bar; shortcut Ctrl+… ditangani di UI.
    Menu.setApplicationMenu(null);
    return;
  }
  const template = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'Tambah URL…', accelerator: 'Cmd+N', click: () => { showWindow(); send('menu', 'add'); } },
        { label: 'Tambah dari Clipboard', accelerator: 'Cmd+Shift+V', click: () => {
          showWindow(); send('menu', { action: 'add', url: clipboard.readText().trim() });
        } },
        { type: 'separator' },
        { label: 'Mulai Antrian', accelerator: 'Cmd+R', click: () => manager.startQueue() },
        { label: 'Hentikan Semua', accelerator: 'Cmd+.', click: () => manager.stopQueue() },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    // viewMenu bawaan memakai Cmd+R untuk reload (bentrok dengan Mulai Antrian).
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  // Hanya terima IPC dari frame utama jendela MacDM yang memuat UI lokal
  // (temuan REA: handler sebelumnya tidak memvalidasi pengirim). Navigasi keluar
  // sudah diblokir, jadi frame utama selalu UI bawaan app.
  const trusted = (e) =>
    !!win && !win.isDestroyed() && e.sender === win.webContents &&
    e.senderFrame === win.webContents.mainFrame && e.senderFrame.url.startsWith('file:');
  const h = (ch, fn) =>
    ipcMain.handle(ch, (e, ...args) => {
      if (!trusted(e)) throw new Error('IPC ditolak: pengirim tidak dikenal');
      return fn(...args);
    });
  ipcMain.on('platform', (e) => { e.returnValue = trusted(e) ? PLATFORM : null; });
  h('renderer-ready', () => {
    rendererReady = true;
    for (const req of pendingExternal.splice(0)) send('external-add', req);
  });
  h('list', () => manager.list());
  h('categories', () => CATEGORY_NAMES);
  h('settings:get', () => manager.settings);
  h('settings:set', (patch) => manager.updateSettings(patch));
  h('probe', (url, headers) => manager.probe(url, headers));
  h('dir-for', (category) => manager.dirFor(category));
  h('add', (opts) => manager.add(opts));
  h('pause', (id) => manager.pause(id));
  h('resume', (id) => manager.resume(id));
  h('remove', (id, deleteFile) => manager.remove(id, deleteFile));
  h('queue:start', () => manager.startQueue());
  h('queue:stop', () => manager.stopQueue());
  h('clear-completed', () => manager.clearCompleted());
  h('open-file', (id) => {
    const s = manager.snapshot(id);
    if (s?.savedPath) return shell.openPath(s.savedPath);
  });
  h('show-in-folder', (id) => {
    const s = manager.snapshot(id);
    if (s?.savedPath) shell.showItemInFolder(s.savedPath);
    else if (s) shell.openPath(s.dir);
  });
  h('copy-url', (id) => {
    const s = manager.snapshot(id);
    if (s) clipboard.writeText(s.url);
  });
  h('choose-dir', async (current) => {
    const r = await dialog.showOpenDialog(win, {
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  h('clipboard-url', () => {
    const t = clipboard.readText().trim();
    return /^https?:\/\/\S+$/i.test(t) ? t : '';
  });
}

app.whenReady().then(async () => {
  manager = new DownloadManager(path.join(app.getPath('userData'), 'data'));
  await manager.init();

  manager.on('update', (list) => { send('update', list); updateIndicators(list); });
  manager.on('completed', (d) => {
    if (manager.settings.notifyOnComplete && Notification.isSupported()) {
      const n = new Notification({ title: 'Download selesai', body: d.filename, silent: false });
      n.on('click', () => shell.showItemInFolder(d.savedPath));
      n.show();
    }
    if (app.dock) app.dock.bounce('informational');
  });
  manager.on('failed', (d) => send('toast', { kind: 'error', text: `${d.filename}: ${d.error}` }));

  registerIpc();
  buildMenu();
  createWindow();
  createTray();
  nativeTheme.on('updated', () => {
    if (!win || IS_MAC) return;
    win.setBackgroundColor(theme().bg);
    try { win.setTitleBarOverlay({ color: theme().bg, symbolColor: theme().symbol }); } catch { /* bukan Windows */ }
  });

  bridge = startBridgeServer({
    port: manager.settings.serverPort,
    version: app.getVersion(),
    onAdd: handleExternalAdd,
  });

  app.on('activate', showWindow);
});

app.on('second-instance', showWindow);

app.on('before-quit', async (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  try {
    bridge?.close();
    await manager?.shutdown();
  } finally {
    app.exit(0);
  }
});
