'use strict';
// Tes mesin download terhadap server lokal: multi-segment, pause/resume,
// server tanpa Range, koneksi yang putus di tengah, dan header cookie/referer.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { DownloadManager } = require('../src/engine/manager');

const SIZE = 12 * 1024 * 1024 + 12345;
const DATA = crypto.randomBytes(SIZE);
const SHA = crypto.createHash('sha256').update(DATA).digest('hex');
let rangeRequests = 0;
let seenCookie = null;
const flakyCount = new Map();

function sendSlow(res, buf, bytesPerTick = 32 * 1024, dropAfter = Infinity) {
  let off = 0;
  const t = setInterval(() => {
    if (res.destroyed) return clearInterval(t);
    if (off >= dropAfter) { clearInterval(t); return res.destroy(); }
    const end = Math.min(buf.length, off + bytesPerTick);
    res.write(buf.subarray(off, end));
    off = end;
    if (off >= buf.length) { clearInterval(t); res.end(); }
  }, 20);
  res.on('close', () => clearInterval(t));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/file.bin' || u.pathname === '/flaky.bin') {
    seenCookie = req.headers.cookie || seenCookie;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!m) {
      res.writeHead(200, { 'Content-Length': SIZE, 'Accept-Ranges': 'bytes' });
      return sendSlow(res, DATA);
    }
    rangeRequests++;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : SIZE - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${SIZE}`,
      'Content-Length': end - start + 1,
      'Content-Disposition': 'attachment; filename="Laporan Pajak 2026.zip"',
      ETag: '"v1"',
    });
    // flaky: tiap request ke-2 per offset diputus setelah 300KB
    let drop = Infinity;
    if (u.pathname === '/flaky.bin') {
      const n = (flakyCount.get(start) || 0) + 1;
      flakyCount.set(start, n);
      if (n === 1) drop = 300 * 1024;
    }
    return sendSlow(res, DATA.subarray(start, end + 1), 32 * 1024, drop);
  }
  if (u.pathname === '/norange.bin') {
    res.writeHead(200, { 'Content-Length': SIZE });
    return sendSlow(res, DATA, 512 * 1024);
  }
  if (u.pathname === '/redirect') {
    res.writeHead(302, { Location: '/file.bin' });
    return res.end();
  }
  res.writeHead(404); res.end();
});

const waitFor = (mgr, id, statuses, timeout = 30000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout menunggu ' + statuses)), timeout);
    const check = () => {
      const s = mgr.snapshot(id);
      if (s && statuses.includes(s.status)) { clearTimeout(t); mgr.off('update', check); resolve(s); }
    };
    mgr.on('update', check);
    check();
  });

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'macdm-'));
  const mgr = new DownloadManager(path.join(tmp, 'store'));
  await mgr.init();
  await mgr.updateSettings({ downloadDir: path.join(tmp, 'dl'), connections: 8, maxConcurrent: 2 });

  // 1. Probe: nama dari Content-Disposition, ukuran, resumable, kategori
  const info = await mgr.probe(base + '/redirect');
  assert.strictEqual(info.filename, 'Laporan Pajak 2026.zip');
  assert.strictEqual(info.size, SIZE);
  assert.strictEqual(info.resumable, true);
  assert.strictEqual(info.category, 'Compressed');
  console.log('✓ probe (redirect, content-disposition, ukuran, kategori)');

  // 2. Multi-segment + pause/resume + cookie
  const a = mgr.add({ url: base + '/file.bin', filename: info.filename, headers: { Cookie: 'sess=abc' } });
  await waitFor(mgr, a.id, ['downloading']);
  await new Promise((r) => setTimeout(r, 400));
  const mid = mgr.snapshot(a.id);
  assert.ok(mid.connections > 1, 'harus memakai banyak koneksi, dapat ' + mid.connections);
  await mgr.pause(a.id);
  const paused = mgr.snapshot(a.id);
  assert.strictEqual(paused.status, 'paused');
  assert.ok(paused.downloaded > 0 && paused.downloaded < SIZE, 'progres parsial saat pause');
  console.log(`✓ multi-koneksi (${mid.connections}) & pause di ${(paused.downloaded / SIZE * 100).toFixed(0)}%`);

  // Simulasikan app ditutup lalu dibuka: manager baru membaca state dari disk
  await mgr.shutdown();
  const mgr2 = new DownloadManager(path.join(tmp, 'store'));
  await mgr2.init();
  const restored = mgr2.snapshot(a.id);
  assert.strictEqual(restored.downloaded, paused.downloaded, 'progres tersimpan setelah restart');
  const before = rangeRequests;
  mgr2.resume(a.id);
  const done = await waitFor(mgr2, a.id, ['completed', 'error']);
  assert.strictEqual(done.status, 'completed', done.error);
  assert.strictEqual(sha(done.savedPath), SHA, 'hash file harus sama');
  assert.ok(done.savedPath.includes(path.join('dl', 'Compressed')), 'masuk folder kategori');
  assert.strictEqual(seenCookie, 'sess=abc');
  console.log(`✓ resume setelah restart, file utuh (sha256 cocok), ${rangeRequests - before} request range`);

  // 3. Server tanpa Range → satu koneksi
  const b = mgr2.add({ url: base + '/norange.bin', filename: 'video.mp4' });
  const bd = await waitFor(mgr2, b.id, ['completed', 'error']);
  assert.strictEqual(bd.status, 'completed', bd.error);
  assert.strictEqual(bd.resumable, false);
  assert.strictEqual(sha(bd.savedPath), SHA);
  console.log('✓ server tanpa Range (single connection)');

  // 4. Koneksi putus → retry otomatis dari posisi terakhir
  const c = mgr2.add({ url: base + '/flaky.bin', filename: 'flaky.bin' });
  const cd = await waitFor(mgr2, c.id, ['completed', 'error']);
  assert.strictEqual(cd.status, 'completed', cd.error);
  assert.strictEqual(sha(cd.savedPath), SHA);
  console.log('✓ koneksi putus di tengah → retry & file tetap utuh');

  // 5. Antrian: maxConcurrent=1 → hanya satu jalan bersamaan
  await mgr2.updateSettings({ maxConcurrent: 1 });
  const q = [1, 2, 3].map((i) => mgr2.add({ url: base + '/file.bin', filename: `q${i}.bin` }));
  await new Promise((r) => setTimeout(r, 300));
  const states = q.map((x) => mgr2.snapshot(x.id).status);
  assert.strictEqual(states.filter((s) => s === 'queued').length, 2, 'dua menunggu: ' + states);
  const results = await Promise.all(q.map((x) => waitFor(mgr2, x.id, ['completed', 'error'], 60000)));
  assert.ok(results.every((r) => r.status === 'completed'));
  assert.ok(fs.existsSync(path.join(tmp, 'dl', 'Programs', 'q3.bin')));
  console.log('✓ antrian (max 1 bersamaan) berjalan berurutan');

  // 6. Nama file bentrok → "(1)"
  const d = mgr2.add({ url: base + '/file.bin', filename: 'q1.bin' });
  const dd = await waitFor(mgr2, d.id, ['completed', 'error']);
  assert.ok(dd.savedPath.endsWith('q1 (1).bin'), dd.savedPath);
  console.log('✓ nama bentrok jadi "q1 (1).bin"');

  await mgr2.shutdown();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nSemua tes lulus.');
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
