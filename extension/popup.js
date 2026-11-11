const DEFAULTS = { enabled: true, port: 6801, minSizeMB: 0, extensions: '' };
const ids = ['enabled', 'port', 'minSizeMB', 'extensions'];
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(null, (s) => {
  for (const id of ids) {
    const v = s[id] ?? DEFAULTS[id];
    if (id === 'enabled') $(id).checked = v !== false;
    else $(id).value = v;
  }
  // nilai default ekstensi ada di background.js
  if (!$('extensions').value) {
    $('extensions').placeholder = 'zip rar dmg pdf mp4 …';
  }
});

let timer;
for (const id of ids) {
  $(id).addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const val = {
        enabled: $('enabled').checked,
        port: Number($('port').value) || 6801,
        minSizeMB: Number($('minSizeMB').value) || 0,
      };
      if ($('extensions').value.trim()) val.extensions = $('extensions').value.trim();
      chrome.storage.sync.set(val, () => {
        $('saved').textContent = 'Tersimpan';
        setTimeout(() => ($('saved').textContent = ''), 1200);
        check();
      });
    }, 300);
  });
}

function check() {
  chrome.runtime.sendMessage({ type: 'ping' }, (ok) => {
    $('status').className = 'status ' + (ok ? 'on' : 'off');
    $('statusText').textContent = ok ? 'Terhubung ke MacDM' : 'MacDM tidak berjalan — download ditangani Chrome';
  });
}
check();
