'use strict';
// E2E: jalankan app Electron sungguhan, kirim link lewat bridge (seperti ekstensi),
// klik "Mulai Download" di dialog, ambil screenshot, dan pastikan file utuh.
const { _electron: electron } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SIZE = 40 * 1024 * 1024;
const DATA = crypto.randomBytes(SIZE);
const SHA = crypto.createHash('sha256').update(DATA).digest('hex');
const OUT = process.argv[2] || path.join(__dirname, 'shots');

const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1));
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Number(m[2]) : SIZE - 1;
  res.writeHead(m ? 206 : 200, {
    'Content-Length': end - start + 1,
    ...(m ? { 'Content-Range': `bytes ${start}-${end}/${SIZE}` } : {}),
    'Content-Disposition': `attachment; filename="${name}"`,
  });
  const buf = DATA.subarray(start, end + 1);
  let off = 0;
  const t = setInterval(() => {
    if (res.destroyed) return clearInterval(t);
    const e = Math.min(buf.length, off + 24 * 1024);
    res.write(buf.subarray(off, e));
    off = e;
    if (off >= buf.length) { clearInterval(t); res.end(); }
  }, 25);
  res.on('close', () => clearInterval(t));
});

const post = (port, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/add', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'macdm-e2e-'));
  const userData = path.join(tmp, 'ud');
  fs.mkdirSync(path.join(userData, 'data'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'data', 'settings.json'), JSON.stringify({ downloadDir: path.join(tmp, 'Downloads'), serverPort: 16801 }));

  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', `--user-data-dir=${userData}`, path.join(__dirname, '..')],
    env: { ...process.env, LANG: 'id_ID.UTF-8' },
  });
  // Kirim link SECEPAT bridge hidup (UI mungkin belum siap) — link tidak boleh hilang.
  const ping = () => new Promise((r) => http.get('http://127.0.0.1:16801/ping', (res) => r(res.statusCode === 200)).on('error', () => r(false)));
  while (!(await ping())) await new Promise((r) => setTimeout(r, 50));
  const early = await post(16801, { url: `http://127.0.0.1:${port}/Ubuntu-24.04-desktop.iso`, referrer: 'https://ubuntu.com' }, { Origin: 'chrome-extension://abcdef' });
  if (early.status !== 200) throw new Error('bridge gagal ' + early.status + early.body);
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1180, height: 720 });

  // Halaman web biasa tidak boleh menyuntik download
  const evil = await post(16801, { url: `http://127.0.0.1:${port}/x.zip` }, { Origin: 'https://evil.example' });
  if (evil.status !== 403) throw new Error('Origin web harus ditolak, dapat ' + evil.status);
  console.log('✓ request dari origin halaman web ditolak (403)');

  await win.waitForSelector('#addInfo:not(.hidden)', { timeout: 10000 });
  await win.screenshot({ path: path.join(OUT, '2-dialog.png') });
  console.log('✓ link dari ekstensi (dikirim sebelum UI siap) tetap membuka dialog: ' + (await win.inputValue('#addName')));
  await win.click('#addStart');

  // Tambah beberapa lagi lewat dialog manual
  for (const n of ['Laporan Realisasi PAD 2026.pdf', 'rapat-bapenda.mp4', 'epayda-backend-1.4.2.tar.gz']) {
    await win.evaluate(() => document.querySelector('[data-action="add"]').click());
    await win.fill('#addUrl', `http://127.0.0.1:${port}/${encodeURIComponent(n)}`);
    await win.click('#addProbe');
    await win.waitForSelector('#addInfo:not(.hidden)');
    await win.click(n.endsWith('.mp4') ? '#addLater' : '#addStart');
  }

  await win.waitForTimeout(2500);
  await win.click('tr:has-text("Ubuntu")');
  await win.waitForTimeout(800);
  await win.screenshot({ path: path.join(OUT, '3-mengunduh.png') });
  const conn = await win.textContent('#dConn');
  console.log('✓ sedang mengunduh, koneksi aktif:', conn);

  // Pause → Resume lewat UI
  await win.click('[data-action="pause"]');
  await win.waitForSelector('tr:has-text("Ubuntu") .status.paused');
  console.log('✓ pause lewat toolbar');
  await win.click('[data-action="resume"]');

  // Tunggu semua yang dimulai selesai
  await win.waitForFunction(() => document.querySelectorAll('.status.completed').length >= 3, null, { timeout: 120000 });
  await win.click('tr:has-text("Ubuntu")');
  await win.waitForTimeout(600);
  await win.screenshot({ path: path.join(OUT, '4-selesai.png') });

  const iso = path.join(tmp, 'Downloads', 'Compressed', 'Ubuntu-24.04-desktop.iso');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(iso)).digest('hex');
  if (sha !== SHA) throw new Error('hash tidak cocok');
  console.log('✓ file ISO utuh di folder Compressed (sha256 cocok)');

  // Pengaturan
  await win.click('[data-action="settings"]');
  await win.waitForSelector('#settingsDialog[open]');
  await win.screenshot({ path: path.join(OUT, '5-pengaturan.png') });
  await win.keyboard.press('Escape');

  await app.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nE2E lulus.');
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
