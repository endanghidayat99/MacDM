// MacDM Integration — service worker
const DEFAULTS = {
  enabled: true,
  port: 6801,
  minSizeMB: 0,
  extensions:
    'zip rar 7z tar gz tgz bz2 xz iso dmg pkg pdf doc docx xls xlsx ppt pptx epub ' +
    'mp3 m4a flac wav aac ogg mp4 mkv mov avi webm m4v wmv flv exe msi apk jar deb rpm appimage bin torrent',
};

const getSettings = () => chrome.storage.sync.get(DEFAULTS);
const base = (port) => `http://127.0.0.1:${port}`;

async function ping(port) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 800);
    const r = await fetch(base(port) + '/ping', { signal: ctl.signal });
    clearTimeout(t);
    return r.ok && (await r.json()).app === 'MacDM';
  } catch {
    return false;
  }
}

async function cookieHeader(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

async function sendToApp({ url, filename = '', referrer = '' }) {
  const { port } = await getSettings();
  const r = await fetch(base(port) + '/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      filename,
      referrer,
      cookies: await cookieHeader(url),
      userAgent: navigator.userAgent,
    }),
  });
  if (!r.ok) throw new Error('MacDM menolak permintaan (' + r.status + ')');
}

function baseName(p) {
  return (p || '').split(/[\\/]/).pop();
}

function extOf(name) {
  const n = name.toLowerCase();
  if (n.endsWith('.tar.gz')) return 'tgz';
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(i + 1) : '';
}

function nameFromUrl(u) {
  try {
    return decodeURIComponent(new URL(u).pathname.split('/').pop() || '');
  } catch {
    return '';
  }
}

// ---------- Context menu ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'macdm-link', title: 'Download dengan MacDM', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'macdm-media', title: 'Download media ini dengan MacDM', contexts: ['video', 'audio', 'image'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'macdm-link' ? info.linkUrl : info.srcUrl;
  if (!/^https?:/i.test(url || '')) return;
  try {
    await sendToApp({ url, referrer: tab?.url || '' });
  } catch {
    notifyOffline();
  }
});

// ---------- Tangkap download otomatis ----------
const handled = new Set();

chrome.downloads.onCreated.addListener(async (item) => {
  const s = await getSettings();
  if (!s.enabled || handled.has(item.id)) return;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url)) return; // blob:, data:, file: dibiarkan ke Chrome

  const name = baseName(item.filename) || nameFromUrl(url);
  const exts = s.extensions.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const ext = extOf(name);
  if (ext && !exts.includes(ext)) return;
  if (s.minSizeMB > 0 && item.totalBytes > 0 && item.totalBytes < s.minSizeMB * 1024 * 1024) return;

  if (!(await ping(s.port))) return; // app tidak jalan → biarkan Chrome yang mengunduh
  handled.add(item.id);
  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
    await sendToApp({ url, filename: name, referrer: item.referrer || '' });
  } catch (e) {
    console.warn('MacDM: gagal mengirim, kembalikan ke Chrome', e);
    chrome.downloads.download({ url });
  }
});

function notifyOffline() {
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  chrome.action.setBadgeText({ text: '!' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'ping') {
    getSettings().then((s) => ping(s.port)).then(reply);
    return true;
  }
});
