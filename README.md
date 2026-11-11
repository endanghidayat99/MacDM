# MacDM — Download Manager ala IDM untuk macOS & Windows

Aplikasi desktop (Electron) untuk mempercepat dan mengelola download di Mac dan Windows.

## Fitur

- **Multi-segment download** — satu file dipecah ke beberapa koneksi paralel (default 8, maks 32).
  Segmentasi dinamis: koneksi yang selesai lebih dulu mengambil separuh sisa dari segmen terbesar,
  persis cara IDM mempertahankan kecepatan sampai akhir.
- **Pause / resume** — progres tiap segmen disimpan; tetap bisa dilanjutkan setelah app ditutup atau Mac restart.
  Jika file di server berubah (ukuran/ETag beda), download otomatis diulang dari awal.
- **Retry otomatis** — koneksi yang putus dicoba ulang dari byte terakhir (backoff eksponensial).
- **Antrian & kategori** — batas download bersamaan, folder otomatis per kategori
  (`~/Downloads/Compressed`, `Video`, `Documents`, `Music`, `Programs`, `Images`, `Other`).
- **Integrasi Chrome** — ekstensi menangkap download otomatis (berdasarkan ekstensi file) dan menambah menu klik kanan
  "Download dengan MacDM". Cookie, Referer, dan User-Agent ikut dikirim agar link yang butuh login tetap jalan.
- Peta koneksi per segmen, kecepatan total, notifikasi selesai, mode gelap/terang.
- Mac: badge jumlah download aktif di Dock. Windows: ikon di system tray (menutup jendela = tetap jalan di latar),
  progres total di taskbar, tombol jendela native.

## Menjalankan dari source

```bash
cd ~/Workspace/MacDM
npm install
npm start          # mode development
npm test           # tes mesin download (multi-segment, resume, retry, antrian)
```

## Build aplikasi

```bash
npm run dist:mac        # macOS: dist/MacDM-1.0.0-arm64.dmg (+ .zip)
npm run dist:win        # Windows x64: dist/MacDM-1.0.0-x64-setup.exe + MacDM-1.0.0-portable.exe
npm run dist:win-arm64  # Windows on ARM (mis. Windows 11 di Parallels pada Mac Apple Silicon)
```

Jika build Windows dari Mac gagal karena Wine, pasang dulu `brew install --cask wine-stable` (dipakai untuk menulis ikon & info versi ke .exe).

**Mac:** app ditandatangani ad-hoc (tanpa Apple Developer ID). Saat pertama dibuka: klik kanan **MacDM.app → Open**,
atau `xattr -dr com.apple.quarantine /Applications/MacDM.app`.

**Windows:** installer belum ditandatangani sertifikat code signing, jadi SmartScreen menampilkan
"Windows protected your PC" → **More info → Run anyway**. Data app ada di `%APPDATA%\MacDM\data\`.

## Memasang ekstensi browser (Chrome / Edge / Brave)

1. Buka `chrome://extensions` (Edge: `edge://extensions`), aktifkan **Developer mode**.
2. **Load unpacked** → pilih folder `extension/`.
3. Klik ikon MacDM di toolbar Chrome: status harus "Terhubung ke MacDM" saat app berjalan.

Jika MacDM tidak berjalan, download otomatis dikembalikan ke Chrome seperti biasa.

## Keamanan

- Bridge lokal hanya mendengarkan di `127.0.0.1:6801` dan menolak request ber-`Origin` halaman web,
  sehingga situs tidak bisa diam-diam menambahkan download. Tiap link dari browser juga dikonfirmasi lewat dialog
  (bisa dimatikan di Pengaturan).
- Renderer berjalan dengan `contextIsolation`, `sandbox`, tanpa `nodeIntegration`, dan CSP ketat.
- Electron fuses dikunci saat build (`build/afterPack.js`): `RunAsNode`, `NODE_OPTIONS`, dan `--inspect` dimatikan,
  integritas `app.asar` divalidasi. Hook yang sama memperbaiki bug electron-builder saat build Windows dari Mac/Linux
  (path integritas `resources/app.asar` → `resources\app.asar`; tanpa ini .exe langsung crash).
- IPC hanya diterima dari frame utama jendela MacDM.

## Struktur

```
src/engine/download.js   mesin download per file (probe, segmen, resume, retry)
src/engine/manager.js    antrian, persistensi, pengaturan, kecepatan
src/server.js            bridge HTTP lokal untuk ekstensi browser
src/main.js              proses utama Electron (window, menu, IPC, notifikasi)
src/preload.js           API aman untuk UI
src/renderer/            UI
extension/               ekstensi Chrome (Manifest V3)
test/                    tes engine + E2E Playwright
```

Data app tersimpan di `~/Library/Application Support/MacDM/data/` (Mac) atau `%APPDATA%\MacDM\data\` (Windows).
