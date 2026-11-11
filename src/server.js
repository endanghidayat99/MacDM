'use strict';

const http = require('http');

// Hanya ekstensi browser (atau proses lokal tanpa Origin, mis. curl) yang boleh
// mengirim link. Halaman web biasa selalu membawa Origin http(s):// dan ditolak,
// sehingga situs tidak bisa diam-diam menyuntikkan download.
const EXT_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\//;

function startBridgeServer({ port, version, onAdd }) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && !EXT_ORIGIN.test(origin)) {
      res.writeHead(403); return res.end();
    }
    const cors = origin
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      : {};
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    const json = (code, body) => {
      res.writeHead(code, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/ping') return json(200, { app: 'MacDM', version });

    if (req.method === 'POST' && req.url === '/add') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on('end', () => {
        try {
          const p = JSON.parse(body || '{}');
          if (!/^https?:\/\//i.test(p.url || '')) return json(400, { ok: false, error: 'URL tidak valid' });
          const headers = {};
          if (p.cookies) headers.Cookie = String(p.cookies);
          if (p.referrer) headers.Referer = String(p.referrer);
          if (p.userAgent) headers['User-Agent'] = String(p.userAgent);
          onAdd({ url: p.url, filename: p.filename || '', headers });
          json(200, { ok: true });
        } catch (e) {
          json(400, { ok: false, error: e.message });
        }
      });
      return;
    }
    json(404, { ok: false });
  });
  server.on('error', (e) => console.error('[bridge]', e.message));
  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { startBridgeServer };
