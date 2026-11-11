'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const EventEmitter = require('events');
const { Download, probe, sanitizeFilename } = require('./download');
const { categorize } = require('./categories');

const DEFAULT_SETTINGS = {
  downloadDir: path.join(os.homedir(), 'Downloads'),
  useCategoryFolders: true,
  connections: 8,
  maxConcurrent: 3,
  retries: 5,
  serverPort: 6801,
  showAddDialog: true,
  notifyOnComplete: true,
};

const ACTIVE = new Set(['connecting', 'downloading']);

class DownloadManager extends EventEmitter {
  constructor(storeDir) {
    super();
    this.storeDir = storeDir;
    this.storeFile = path.join(storeDir, 'downloads.json');
    this.settingsFile = path.join(storeDir, 'settings.json');
    this.settings = { ...DEFAULT_SETTINGS };
    this.items = new Map(); // id -> Download
    this.order = [];
    this.speed = new Map(); // id -> { last, at, bps }
    this._saveTimer = null;
    this._tick = null;
  }

  async init() {
    await fsp.mkdir(this.storeDir, { recursive: true });
    try {
      Object.assign(this.settings, JSON.parse(await fsp.readFile(this.settingsFile, 'utf8')));
    } catch { /* default */ }
    try {
      const list = JSON.parse(await fsp.readFile(this.storeFile, 'utf8'));
      for (const rec of list) {
        // Yang sedang berjalan saat app ditutup dianggap pause.
        if (ACTIVE.has(rec.status)) rec.status = 'paused';
        this._attach(rec);
      }
    } catch { /* kosong */ }
    this._tick = setInterval(() => this._onTick(), 500);
  }

  _attach(rec) {
    const dl = new Download(rec, { connections: this.settings.connections, retries: this.settings.retries });
    dl.on('status', () => { this._scheduleSave(); this._emitUpdate(); });
    dl.on('settled', (r) => {
      if (r.status === 'completed') this.emit('completed', this.snapshot(r.id));
      if (r.status === 'error') this.emit('failed', this.snapshot(r.id));
      this._pump();
    });
    this.items.set(rec.id, dl);
    if (!this.order.includes(rec.id)) this.order.push(rec.id);
    return dl;
  }

  // ---------- API publik ----------

  async probe(url, headers) {
    const info = await probe(url, headers);
    const category = categorize(info.filename);
    return { ...info, category, dir: this.dirFor(category) };
  }

  dirFor(category) {
    return this.settings.useCategoryFolders
      ? path.join(this.settings.downloadDir, category)
      : this.settings.downloadDir;
  }

  add({ url, filename, headers, dir, category, size, resumable, startNow = true }) {
    if (!/^https?:\/\//i.test(url || '')) throw new Error('URL harus diawali http:// atau https://');
    const name = sanitizeFilename(filename || new URL(url).pathname.split('/').pop() || 'download');
    const cat = category || categorize(name);
    const rec = {
      id: crypto.randomUUID(),
      url,
      headers: headers || {},
      filename: name,
      category: cat,
      dir: dir || this.dirFor(cat),
      size: size || 0,
      resumable: !!resumable,
      segments: [],
      downloaded: 0,
      status: startNow ? 'queued' : 'paused',
      createdAt: Date.now(),
      finishedAt: null,
      error: null,
    };
    this._attach(rec);
    this._scheduleSave();
    this._emitUpdate();
    this._pump();
    return this.snapshot(rec.id);
  }

  /** Resume langsung (tidak menunggu antrian), seperti tombol Resume di IDM. */
  resume(id) {
    const dl = this.items.get(id);
    if (!dl || dl.running || dl.rec.status === 'completed') return;
    dl.opts.connections = this.settings.connections;
    dl.start();
  }

  async pause(id) {
    const dl = this.items.get(id);
    if (!dl) return;
    if (dl.rec.status === 'queued') { dl.rec.status = 'paused'; this._emitUpdate(); this._scheduleSave(); }
    await dl.pause();
  }

  startQueue() {
    for (const id of this.order) {
      const r = this.items.get(id).rec;
      if (r.status === 'paused' || r.status === 'error') r.status = 'queued';
    }
    this._emitUpdate();
    this._pump();
  }

  async stopQueue() {
    await Promise.all(this.order.map((id) => this.pause(id)));
  }

  async remove(id, deleteFile = false) {
    const dl = this.items.get(id);
    if (!dl) return;
    await dl.pause();
    await dl.discardPartial();
    if (deleteFile && dl.rec.savedPath) await fsp.rm(dl.rec.savedPath, { force: true });
    this.items.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.speed.delete(id);
    this._scheduleSave();
    this._emitUpdate();
  }

  async clearCompleted() {
    for (const id of [...this.order]) {
      if (this.items.get(id).rec.status === 'completed') {
        this.items.delete(id);
        this.order = this.order.filter((x) => x !== id);
      }
    }
    this._scheduleSave();
    this._emitUpdate();
  }

  async updateSettings(patch) {
    const allowed = Object.keys(DEFAULT_SETTINGS);
    for (const k of Object.keys(patch || {})) if (allowed.includes(k)) this.settings[k] = patch[k];
    this.settings.connections = clampInt(this.settings.connections, 1, 32);
    this.settings.maxConcurrent = clampInt(this.settings.maxConcurrent, 1, 10);
    this.settings.retries = clampInt(this.settings.retries, 0, 20);
    await fsp.writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2));
    this._pump();
    return this.settings;
  }

  snapshot(id) {
    const dl = this.items.get(id);
    if (!dl) return null;
    const r = dl.rec;
    const sp = this.speed.get(id);
    const downloaded = dl.downloaded;
    const bps = ACTIVE.has(r.status) ? sp?.bps || 0 : 0;
    return {
      id: r.id,
      url: r.url,
      filename: r.filename,
      category: r.category,
      dir: r.dir,
      savedPath: r.savedPath || null,
      size: r.size,
      downloaded,
      status: r.status,
      resumable: r.resumable,
      error: r.error,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      speed: bps,
      eta: bps > 0 && r.size ? Math.round((r.size - downloaded) / bps) : null,
      connections: dl.activeConnections,
      segments: (r.segments || []).map((s) => ({ start: s.start, end: s.end, pos: s.pos })),
    };
  }

  list() {
    return this.order.map((id) => this.snapshot(id));
  }

  async shutdown() {
    clearInterval(this._tick);
    await Promise.all([...this.items.values()].map((d) => d.pause()));
    await this._saveNow();
  }

  // ---------- internal ----------

  _pump() {
    let running = [...this.items.values()].filter((d) => d.running).length;
    for (const id of this.order) {
      if (running >= this.settings.maxConcurrent) break;
      const dl = this.items.get(id);
      if (dl.rec.status === 'queued' && !dl.running) {
        dl.opts.connections = this.settings.connections;
        dl.start();
        running++;
      }
    }
  }

  _onTick() {
    const now = Date.now();
    let changed = false;
    for (const [id, dl] of this.items) {
      if (!dl.running) continue;
      const cur = dl.downloaded;
      const sp = this.speed.get(id);
      if (sp) {
        const inst = ((cur - sp.last) * 1000) / Math.max(1, now - sp.at);
        sp.bps = sp.bps ? sp.bps * 0.7 + inst * 0.3 : inst; // smoothing
        sp.last = cur; sp.at = now;
      } else {
        this.speed.set(id, { last: cur, at: now, bps: 0 });
      }
      changed = true;
    }
    if (changed) { this._emitUpdate(); this._scheduleSave(2000); }
  }

  _emitUpdate() {
    this.emit('update', this.list());
  }

  _scheduleSave(delay = 300) {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._saveNow(); }, delay);
  }

  _saveNow() {
    // Diserialkan agar dua penyimpanan tidak saling menimpa file .tmp.
    this._saving = (this._saving || Promise.resolve()).then(() => this._write()).catch(() => {});
    return this._saving;
  }

  async _write() {
    const data = this.order.map((id) => {
      const { active, ...rec } = this.items.get(id).rec;
      return { ...rec, segments: (rec.segments || []).map(({ start, end, pos }) => ({ start, end, pos })) };
    });
    const tmp = this.storeFile + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data));
    await fsp.rename(tmp, this.storeFile);
  }
}

function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

module.exports = { DownloadManager, DEFAULT_SETTINGS };
