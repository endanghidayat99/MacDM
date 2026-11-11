'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const EventEmitter = require('events');

const PART_EXT = '.macdm-part';
const MIN_SPLIT = 512 * 1024; // segmen < 2x ini tidak dipecah lagi
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// Aman untuk macOS dan Windows: karakter terlarang, nama perangkat Windows
// (CON, NUL, COM1, …), serta titik/spasi di akhir nama.
function sanitizeFilename(name) {
  let cleaned = String(name || '')
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 200);
  if (WIN_RESERVED.test(cleaned)) cleaned = '_' + cleaned;
  return cleaned || 'download';
}

function filenameFromDisposition(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try { return decodeURIComponent(star[2].trim().replace(/^"|"$/g, '')); } catch { /* lanjut */ }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  if (plain) return (plain[2] ?? plain[1]).trim();
  return null;
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : u.hostname;
  } catch {
    return null;
  }
}

/** fetch() hanya bilang "fetch failed"; alasan sebenarnya ada di err.cause. */
function describeError(err) {
  const c = err?.cause;
  const detail = c ? [c.code, c.message].filter(Boolean).join(': ') : '';
  const base = err?.message || String(err);
  return detail && !base.includes(detail) ? `${base} (${detail})` : base;
}

async function fetchOrExplain(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    const e = new Error(describeError(err));
    e.cause = err;
    throw e;
  }
}

function buildHeaders(extra) {
  return { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...(extra || {}) };
}

/**
 * Cek server: ukuran file, nama file, dan dukungan Range (resume + multi-koneksi).
 */
async function probe(url, headers, signal) {
  const res = await fetchOrExplain(url, {
    headers: buildHeaders({ ...headers, Range: 'bytes=0-' }),
    redirect: 'follow',
    signal,
  });
  try {
    if (res.status >= 400) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    let size = 0;
    let resumable = false;
    const cr = res.headers.get('content-range');
    if (res.status === 206 && cr) {
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) { size = Number(m[1]); resumable = size > 0; }
    }
    if (!size) size = Number(res.headers.get('content-length')) || 0;
    const filename = sanitizeFilename(
      filenameFromDisposition(res.headers.get('content-disposition')) ||
        filenameFromUrl(res.url) ||
        filenameFromUrl(url)
    );
    return {
      size,
      resumable,
      filename,
      finalUrl: res.url,
      mime: res.headers.get('content-type') || '',
      etag: res.headers.get('etag') || '',
      lastModified: res.headers.get('last-modified') || '',
    };
  } finally {
    res.body?.cancel().catch(() => {});
  }
}

async function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  for (let i = 1; ; i++) {
    try {
      await fsp.access(candidate);
      candidate = path.join(dir, `${base} (${i})${ext}`);
    } catch {
      return candidate;
    }
  }
}

/**
 * Satu item download. State disimpan di `rec` (plain object) agar mudah dipersist.
 * rec.segments: [{ start, end, pos }] — pos = byte berikutnya yang akan ditulis.
 */
class Download extends EventEmitter {
  constructor(rec, opts = {}) {
    super();
    this.rec = rec;
    this.opts = { connections: 8, retries: 5, ...opts };
    this.ac = null;
    this.fh = null;
    this.running = false;
    this.userStopped = false;
    this.activeConnections = 0;
  }

  get partPath() {
    return path.join(this.rec.dir, this.rec.filename + PART_EXT);
  }

  get downloaded() {
    const r = this.rec;
    if (r.resumable && r.segments?.length) {
      let remaining = 0;
      for (const s of r.segments) remaining += Math.max(0, s.end - s.pos + 1);
      return r.size - remaining;
    }
    return r.downloaded || 0;
  }

  _setStatus(status, extra = {}) {
    Object.assign(this.rec, { status, ...extra });
    this.emit('status', this.rec);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.userStopped = false;
    this.ac = new AbortController();
    this._setStatus('connecting', { error: null });

    try {
      const info = await probe(this.rec.url, this.rec.headers, this.ac.signal);
      const r = this.rec;
      // File di server berubah sejak terakhir? Mulai ulang dari nol.
      const changed =
        r.segments?.length &&
        (info.size !== r.size || (r.etag && info.etag && r.etag !== info.etag));
      if (changed || !info.resumable) r.segments = [];
      Object.assign(r, {
        size: info.size || r.size || 0,
        resumable: info.resumable,
        etag: info.etag,
        mime: r.mime || info.mime,
      });

      await fsp.mkdir(r.dir, { recursive: true });

      if (r.resumable) await this._runSegmented();
      else await this._runSingle();

      if (this.userStopped) throw new Error('stopped');
      await this._finish();
    } catch (err) {
      await this._closeFile();
      if (this.userStopped) {
        this._setStatus('paused');
      } else {
        this._setStatus('error', { error: err?.message || String(err) });
      }
    } finally {
      this.running = false;
      this.activeConnections = 0;
      this.emit('settled', this.rec);
    }
  }

  /** Pause: hentikan semua koneksi; state segmen tetap tersimpan untuk resume. */
  async pause() {
    if (!this.running) return;
    this.userStopped = true;
    this.ac?.abort();
    await new Promise((resolve) => {
      if (!this.running) return resolve();
      this.once('settled', resolve);
    });
  }

  async _openPart(size) {
    let fileOk = false;
    try {
      const st = await fsp.stat(this.partPath);
      fileOk = st.size === size;
    } catch { /* belum ada */ }
    if (!fileOk) this.rec.segments = [];
    this.fh = await fsp.open(this.partPath, fileOk ? 'r+' : 'w+');
    if (!fileOk && size > 0) await this.fh.truncate(size); // sparse, tidak memakan disk
  }

  async _closeFile() {
    if (this.fh) {
      const fh = this.fh;
      this.fh = null;
      await fh.close().catch(() => {});
    }
  }

  // ---------- Multi-segment (IDM-style dynamic segmentation) ----------

  async _runSegmented() {
    const r = this.rec;
    await this._openPart(r.size);
    if (!r.segments.length) {
      const n = Math.max(1, Math.min(this.opts.connections, Math.ceil(r.size / MIN_SPLIT)));
      const chunk = Math.ceil(r.size / n);
      for (let i = 0; i < n; i++) {
        const start = i * chunk;
        const end = Math.min(r.size - 1, start + chunk - 1);
        if (start <= end) r.segments.push({ start, end, pos: start });
      }
    }
    for (const s of r.segments) s.active = false;
    this._setStatus('downloading');

    let firstErr = null;
    const workers = Array.from({ length: this.opts.connections }, () =>
      this._workerLoop().catch((e) => {
        if (!firstErr) firstErr = e;
        this.ac.abort();
      })
    );
    await Promise.all(workers);
    for (const s of r.segments) delete s.active;
    if (this.userStopped) return;
    if (firstErr) throw firstErr;
    if (this.downloaded !== r.size) throw new Error('Download tidak lengkap');
    this._mergeSegments();
  }

  _mergeSegments() {
    // Segmen selesai dirangkum agar metadata tetap kecil.
    this.rec.segments = [{ start: 0, end: this.rec.size - 1, pos: this.rec.size }];
  }

  async _workerLoop() {
    const signal = this.ac.signal;
    while (!signal.aborted) {
      let seg = this.rec.segments.find((s) => !s.active && s.pos <= s.end);
      if (!seg) seg = this._splitLargest();
      if (!seg) return;
      seg.active = true;
      try {
        await this._fetchSegment(seg);
      } finally {
        seg.active = false;
      }
    }
  }

  /** Ambil separuh sisa dari segmen aktif terbesar — koneksi yang selesai membantu yang lambat. */
  _splitLargest() {
    let best = null;
    let rem = 0;
    for (const s of this.rec.segments) {
      if (!s.active) continue;
      const left = s.end - s.pos + 1;
      if (left > rem) { best = s; rem = left; }
    }
    if (!best || rem < 2 * MIN_SPLIT) return null;
    const mid = best.pos + Math.floor(rem / 2);
    const seg = { start: mid, end: best.end, pos: mid, active: false };
    best.end = mid - 1;
    this.rec.segments.push(seg);
    return seg;
  }

  async _fetchSegment(seg) {
    const signal = this.ac.signal;
    let attempt = 0;
    while (seg.pos <= seg.end && !signal.aborted) {
      try {
        const res = await fetchOrExplain(this.rec.url, {
          headers: buildHeaders({ ...this.rec.headers, Range: `bytes=${seg.pos}-${seg.end}` }),
          redirect: 'follow',
          signal,
        });
        if (res.status !== 206) {
          res.body?.cancel().catch(() => {});
          throw new Error(`Server membalas HTTP ${res.status} untuk request Range`);
        }
        this.activeConnections++;
        try {
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const allowed = seg.end - seg.pos + 1; // end bisa mengecil karena split
            if (allowed <= 0) { reader.cancel().catch(() => {}); break; }
            const len = Math.min(value.byteLength, allowed);
            const at = seg.pos;
            seg.pos += len; // reservasi dulu agar split melihat posisi terbaru
            await this.fh.write(value, 0, len, at);
            attempt = 0;
            if (seg.pos > seg.end) { reader.cancel().catch(() => {}); break; }
          }
        } finally {
          this.activeConnections--;
        }
      } catch (err) {
        if (signal.aborted) return;
        attempt++;
        if (attempt > this.opts.retries) throw err;
        await sleep(Math.min(8000, 700 * 2 ** (attempt - 1)), signal);
      }
    }
  }

  // ---------- Single connection (server tanpa dukungan Range) ----------

  async _runSingle() {
    const r = this.rec;
    r.downloaded = 0;
    r.segments = [];
    this.fh = await fsp.open(this.partPath, 'w+');
    const res = await fetchOrExplain(r.url, {
      headers: buildHeaders(r.headers),
      redirect: 'follow',
      signal: this.ac.signal,
    });
    if (res.status >= 400) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    this._setStatus('downloading');
    this.activeConnections = 1;
    try {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await this.fh.write(value, 0, value.byteLength, r.downloaded);
        r.downloaded += value.byteLength;
      }
    } catch (err) {
      if (this.userStopped) return;
      throw err;
    }
    if (!r.size) r.size = r.downloaded;
    if (r.downloaded !== r.size) throw new Error('Koneksi terputus sebelum selesai');
  }

  async _finish() {
    await this._closeFile();
    const target = await uniquePath(this.rec.dir, this.rec.filename);
    await fsp.rename(this.partPath, target);
    this.rec.savedPath = target;
    this.rec.downloaded = this.rec.size;
    this._setStatus('completed', { finishedAt: Date.now() });
  }

  async discardPartial() {
    await fsp.rm(this.partPath, { force: true });
  }
}

module.exports = { Download, probe, sanitizeFilename, filenameFromDisposition, PART_EXT };
