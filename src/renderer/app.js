'use strict';

const api = window.macdm;
const $ = (id) => document.getElementById(id);

// ---------- platform ----------
const IS_MAC = api.platform === 'darwin';
const PLAT = {
  MOD: IS_MAC ? '⌘' : 'Ctrl+',
  FINDER: IS_MAC ? 'Finder' : api.platform === 'win32' ? 'Explorer' : 'File Manager',
  DEL: IS_MAC ? '⌫' : 'Del',
};
const plat = (str) => str.replace(/\{(MOD|FINDER|DEL)\}/g, (_, k) => PLAT[k]);
const isMod = (e) => (IS_MAC ? e.metaKey : e.ctrlKey);

function applyPlatform() {
  document.body.classList.add('platform-' + api.platform);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue.includes('{')) n.nodeValue = plat(n.nodeValue);
  }
  for (const el of document.querySelectorAll('[title]')) el.title = plat(el.title);
}
applyPlatform();

const state = {
  items: [],
  filter: 'all',
  search: '',
  selected: new Set(),
  anchor: null,
  categories: [],
  settings: {},
};

const STATUS_LABEL = {
  queued: 'Antri',
  connecting: 'Menghubungkan',
  downloading: 'Mengunduh',
  paused: 'Dijeda',
  completed: 'Selesai',
  error: 'Gagal',
};

const ICONS = {
  all: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  unfinished: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  finished: '<circle cx="12" cy="12" r="8"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  queued: '<path d="M4 6h10M4 12h10M4 18h6M16 14v6l5-3z"/>',
  Compressed: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12 3v2m0 2v2m0 2v2"/>',
  Documents: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  Music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  Video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  Programs: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 10 3 2-3 2M12 15h5"/>',
  Images: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  Other: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
};

// ---------- format ----------
function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
const fmtSpeed = (bps) => (bps > 0 ? fmtBytes(bps) + '/s' : '');
function fmtEta(s) {
  if (s == null || !isFinite(s)) return '';
  if (s < 60) return `${s} dtk`;
  if (s < 3600) return `${Math.floor(s / 60)} mnt ${s % 60} dtk`;
  return `${Math.floor(s / 3600)} jam ${Math.floor((s % 3600) / 60)} mnt`;
}
function fmtDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  const time = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Hari ini ${time}`;
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) + ' ' + time;
}
function extLabel(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1, i + 5) : '•';
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (d) => (d.size ? Math.min(100, Math.floor((d.downloaded / d.size) * 100)) : d.status === 'completed' ? 100 : 0);
const isActive = (d) => d.status === 'downloading' || d.status === 'connecting';

// ---------- filtering ----------
function matches(d, filter) {
  switch (filter) {
    case 'all': return true;
    case 'unfinished': return d.status !== 'completed';
    case 'finished': return d.status === 'completed';
    case 'queued': return d.status === 'queued';
    default: return d.category === filter;
  }
}
function visibleItems() {
  const q = state.search.toLowerCase();
  return state.items
    .filter((d) => matches(d, state.filter))
    .filter((d) => !q || d.filename.toLowerCase().includes(q) || d.url.toLowerCase().includes(q))
    .slice()
    .reverse(); // terbaru di atas
}

// ---------- render ----------
function renderNav() {
  const groups = [
    ['Download', [['all', 'Semua'], ['unfinished', 'Belum selesai'], ['finished', 'Selesai'], ['queued', 'Antrian']]],
    ['Kategori', state.categories.map((c) => [c, c === 'Other' ? 'Lainnya' : c])],
  ];
  const html = groups
    .map(([title, entries]) =>
      `<div class="nav-group">${title}</div>` +
      entries
        .map(([key, label]) => {
          const n = state.items.filter((d) => matches(d, key)).length;
          return `<div class="nav-item ${state.filter === key ? 'active' : ''}" data-filter="${esc(key)}">
            <svg viewBox="0 0 24 24">${ICONS[key] || ICONS.Other}</svg><span>${esc(label)}</span>
            <span class="count">${n || ''}</span></div>`;
        })
        .join('')
    )
    .join('');
  if (html !== renderNav.last) { $('nav').innerHTML = html; renderNav.last = html; }
}

function rowHtml(d) {
  const p = pct(d);
  const statusText = d.status === 'error' ? `Gagal` : STATUS_LABEL[d.status] || d.status;
  return `<tr data-id="${d.id}" data-status="${d.status}" class="${state.selected.has(d.id) ? 'sel' : ''}" title="${esc(d.error || d.url)}">
    <td class="c-name"><div class="name-cell"><span class="file-badge" data-cat="${esc(d.category)}">${esc(extLabel(d.filename))}</span><span class="fname">${esc(d.filename)}</span></div></td>
    <td class="c-size">${d.size ? fmtBytes(d.size) : '—'}</td>
    <td class="c-progress"><div class="bar"><div class="track"><div class="fill"></div></div><span class="pct">${p}%</span></div></td>
    <td class="c-status"><span class="status ${d.status}">${statusText}</span></td>
    <td class="c-speed">${fmtSpeed(d.speed)}</td>
    <td class="c-eta">${isActive(d) ? fmtEta(d.eta) : ''}</td>
    <td class="c-date">${fmtDate(d.createdAt)}</td>
  </tr>`;
}

// Baris dipakai ulang (bukan innerHTML ulang) agar klik ganda & seleksi tidak
// terganggu oleh update progres tiap 500 ms.
const rowCache = new Map();

function createRow(d) {
  const t = document.createElement('tbody');
  t.innerHTML = rowHtml(d);
  const tr = t.firstElementChild;
  updateRow(tr, d);
  return tr;
}

function updateRow(tr, d) {
  const p = pct(d);
  tr.dataset.status = d.status;
  tr.className = state.selected.has(d.id) ? 'sel' : '';
  tr.title = d.error || d.url;
  const c = tr.children;
  const fname = c[0].querySelector('.fname');
  if (fname.textContent !== d.filename) fname.textContent = d.filename;
  c[1].textContent = d.size ? fmtBytes(d.size) : '—';
  c[2].querySelector('.fill').style.width = p + '%';
  c[2].querySelector('.pct').textContent = p + '%';
  const st = c[3].firstElementChild;
  st.className = `status ${d.status}`;
  st.textContent = STATUS_LABEL[d.status] || d.status;
  c[4].textContent = fmtSpeed(d.speed);
  c[5].textContent = isActive(d) ? fmtEta(d.eta) : '';
}

function renderRows() {
  const list = visibleItems();
  const body = $('rows');
  const keep = new Set(list.map((d) => d.id));
  for (const [id, tr] of rowCache) {
    if (!keep.has(id)) { tr.remove(); rowCache.delete(id); }
  }
  let prev = null;
  for (const d of list) {
    let tr = rowCache.get(d.id);
    if (!tr) { tr = createRow(d); rowCache.set(d.id, tr); }
    else updateRow(tr, d);
    const expected = prev ? prev.nextSibling : body.firstChild;
    if (expected !== tr) body.insertBefore(tr, expected);
    prev = tr;
  }
  $('empty').classList.toggle('hidden', list.length > 0);
}

function renderTotals() {
  const total = state.items.reduce((a, d) => a + (isActive(d) ? d.speed : 0), 0);
  const el = $('totalSpeed');
  el.textContent = total > 0 ? fmtSpeed(total) : 'Diam';
  el.parentElement.classList.toggle('live', total > 0);
}

function renderToolbar() {
  const sel = selectedItems();
  const btn = (a) => document.querySelector(`[data-action="${a}"]`);
  btn('resume').disabled = !sel.some((d) => !isActive(d) && d.status !== 'completed');
  btn('pause').disabled = !sel.some((d) => isActive(d) || d.status === 'queued');
  btn('remove').disabled = sel.length === 0;
}

function renderDetails() {
  const sel = selectedItems();
  const box = $('details');
  if (sel.length !== 1) return box.classList.add('hidden');
  const d = sel[0];
  box.classList.remove('hidden');
  $('dIcon').textContent = extLabel(d.filename);
  $('dIcon').dataset.cat = d.category;
  $('dName').textContent = d.filename;
  $('dUrl').textContent = d.url;
  $('dStatus').textContent = d.status === 'error' ? `Gagal — ${d.error}` : STATUS_LABEL[d.status];
  $('dDone').textContent = `${fmtBytes(d.downloaded)} / ${d.size ? fmtBytes(d.size) : '?'} (${pct(d)}%)`;
  $('dSpeed').textContent = isActive(d) ? `${fmtSpeed(d.speed) || '—'} · ${fmtEta(d.eta) || '—'}` : '—';
  $('dConn').textContent = isActive(d) ? String(d.connections) : '—';
  $('dResume').textContent = d.resumable ? 'Didukung' : d.size ? 'Tidak didukung server' : 'Belum diketahui';
  $('dPath').textContent = d.savedPath || d.dir;
  $('dOpen').disabled = d.status !== 'completed';

  const map = $('segMap');
  const segs = d.segments || [];
  $('dSegCount').textContent = segs.length > 1 ? `· ${segs.length} segmen` : '';
  if (!d.size || !segs.length) {
    const w = d.status === 'completed' ? 100 : pct(d);
    map.replaceChildren(segEl(d.status === 'completed' ? 'complete' : 'live', 0, 100, w));
    return;
  }
  map.replaceChildren(
    ...segs
      .slice()
      .sort((a, b) => a.start - b.start)
      .map((s) => {
        const len = s.end - s.start + 1;
        const done = Math.max(0, Math.min(len, s.pos - s.start));
        return segEl(done >= len ? 'complete' : isActive(d) ? 'live' : '', (s.start / d.size) * 100, (len / d.size) * 100, (done / len) * 100);
      })
  );
}

// CSP melarang atribut style inline, jadi posisi diset lewat CSSOM.
function segEl(cls, left, width, donePct) {
  const el = document.createElement('div');
  el.className = 'seg ' + cls;
  el.style.left = left + '%';
  el.style.width = width + '%';
  const done = document.createElement('div');
  done.className = 'done';
  done.style.width = donePct + '%';
  el.appendChild(done);
  return el;
}

function render() {
  renderNav();
  renderRows();
  renderTotals();
  renderToolbar();
  renderDetails();
}

// ---------- selection ----------
function selectedItems() {
  return state.items.filter((d) => state.selected.has(d.id));
}

$('rows').addEventListener('mousedown', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const id = tr.dataset.id;
  if (isMod(e)) {
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
    state.anchor = id;
  } else if (e.shiftKey && state.anchor) {
    const ids = visibleItems().map((d) => d.id);
    const [a, b] = [ids.indexOf(state.anchor), ids.indexOf(id)].sort((x, y) => x - y);
    state.selected = new Set(ids.slice(a, b + 1));
  } else if (!(e.button === 2 && state.selected.has(id))) {
    state.selected = new Set([id]);
    state.anchor = id;
  }
  render();
});

$('rows').addEventListener('dblclick', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const d = state.items.find((x) => x.id === tr.dataset.id);
  if (!d) return;
  if (d.status === 'completed') api.openFile(d.id);
  else if (isActive(d)) api.pause(d.id);
  else api.resume(d.id);
});

document.querySelector('.list-wrap').addEventListener('mousedown', (e) => {
  if (!e.target.closest('tr') && !e.target.closest('thead')) {
    state.selected.clear();
    render();
  }
});

$('nav').addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item');
  if (!item) return;
  state.filter = item.dataset.filter;
  render();
});

$('search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderRows();
});

// ---------- actions ----------
const actions = {
  add: () => openAddDialog(),
  resume: () => selectedItems().forEach((d) => d.status !== 'completed' && api.resume(d.id)),
  pause: () => selectedItems().forEach((d) => api.pause(d.id)),
  remove: () => openRemoveDialog(),
  startQueue: () => api.startQueue(),
  stopQueue: () => api.stopQueue(),
  settings: () => openSettings(),
};

document.querySelector('.toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (b && !b.disabled) actions[b.dataset.action]();
});

// Windows/Linux tidak punya menu bar, jadi shortcut global ditangani di sini.
document.addEventListener('keydown', async (e) => {
  if (IS_MAC || !e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if (k === 'n' && !e.shiftKey) { e.preventDefault(); openAddDialog(); }
  else if (k === 'v' && e.shiftKey) { e.preventDefault(); openAddDialog({ url: await api.clipboardUrl() }); }
  else if (k === 'r' && !e.shiftKey) { e.preventDefault(); api.startQueue(); }
  else if (k === '.') { e.preventDefault(); api.stopQueue(); }
});

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || e.target.matches('input, select')) return;
  if (e.key === 'Backspace' || e.key === 'Delete') { if (state.selected.size) openRemoveDialog(); e.preventDefault(); }
  else if (e.key === ' ') {
    const sel = selectedItems();
    if (sel.some(isActive)) actions.pause(); else actions.resume();
    e.preventDefault();
  } else if (e.key === 'a' && isMod(e)) {
    state.selected = new Set(visibleItems().map((d) => d.id));
    render();
    e.preventDefault();
  } else if (e.key === 'f' && isMod(e)) {
    $('search').focus();
    e.preventDefault();
  }
});

$('dOpen').onclick = () => { const d = selectedItems()[0]; d && api.openFile(d.id); };
$('dFolder').onclick = () => { const d = selectedItems()[0]; d && api.showInFolder(d.id); };
$('dCopy').onclick = () => { const d = selectedItems()[0]; d && api.copyUrl(d.id).then(() => toast('URL disalin')); };

// ---------- context menu ----------
const ctx = $('ctx');
document.querySelector('.list-wrap').addEventListener('contextmenu', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  e.preventDefault();
  const sel = selectedItems();
  const one = sel.length === 1 ? sel[0] : null;
  const entries = [
    ['Buka', () => api.openFile(one.id), !(one && one.status === 'completed')],
    [plat('Tampilkan di {FINDER}'), () => api.showInFolder(one.id), !one],
    null,
    ['Resume', actions.resume, !sel.some((d) => !isActive(d) && d.status !== 'completed')],
    ['Pause', actions.pause, !sel.some((d) => isActive(d) || d.status === 'queued')],
    null,
    ['Salin URL', () => api.copyUrl(one.id).then(() => toast('URL disalin')), !one],
    ['Download ulang', () => redownload(one), !one],
    null,
    ['Hapus…', actions.remove, !sel.length],
  ];
  ctx.innerHTML = '';
  for (const en of entries) {
    if (!en) { ctx.appendChild(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.textContent = en[0];
    b.disabled = en[2];
    b.onclick = () => { hideCtx(); en[1](); };
    ctx.appendChild(b);
  }
  ctx.classList.remove('hidden');
  const { innerWidth: W, innerHeight: H } = window;
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(e.clientX, W - r.width - 8) + 'px';
  ctx.style.top = Math.min(e.clientY, H - r.height - 8) + 'px';
});
const hideCtx = () => ctx.classList.add('hidden');
document.addEventListener('mousedown', (e) => { if (!ctx.contains(e.target)) hideCtx(); });
window.addEventListener('blur', hideCtx);

function redownload(d) {
  openAddDialog({ url: d.url });
}

// ---------- add dialog ----------
const add = {
  dlg: $('addDialog'),
  headers: {},
  probed: null,
};

function resetAddInfo() {
  add.probed = null;
  $('addInfo').classList.add('hidden');
  $('addError').classList.add('hidden');
  $('addStart').disabled = true;
  $('addLater').disabled = true;
}

async function openAddDialog(pre = {}) {
  resetAddInfo();
  add.headers = pre.headers || {};
  $('addUrl').value = pre.url || (await api.clipboardUrl()) || '';
  $('addCategory').innerHTML = state.categories
    .map((c) => `<option value="${esc(c)}">${esc(c === 'Other' ? 'Lainnya' : c)}</option>`)
    .join('');
  if (!add.dlg.open) add.dlg.showModal();
  if ($('addUrl').value) runProbe(pre.filename);
  else $('addUrl').focus();
}

async function runProbe(preferredName) {
  const url = $('addUrl').value.trim();
  resetAddInfo();
  if (!/^https?:\/\//i.test(url)) return showAddError('Masukkan URL yang diawali http:// atau https://');
  $('addProbe').disabled = true;
  $('addProbe').textContent = 'Memeriksa…';
  try {
    const info = await api.probe(url, add.headers);
    add.probed = info;
    $('addName').value = preferredName || info.filename;
    $('addCategory').value = info.category;
    $('addDir').value = info.dir;
    $('addSize').textContent = info.size ? fmtBytes(info.size) : 'Tidak diketahui';
    const note = $('addResumable');
    note.textContent = info.resumable
      ? `✓ Server mendukung resume — diunduh dengan ${state.settings.connections} koneksi paralel.`
      : '⚠ Server tidak mendukung resume: satu koneksi, dan jika dijeda akan mulai dari awal.';
    note.classList.toggle('warn', !info.resumable);
    $('addInfo').classList.remove('hidden');
    $('addStart').disabled = false;
    $('addLater').disabled = false;
    $('addStart').focus();
  } catch (e) {
    showAddError('Tidak bisa menghubungi server: ' + cleanErr(e));
  } finally {
    $('addProbe').disabled = false;
    $('addProbe').textContent = 'Periksa';
  }
}

function cleanErr(e) {
  return String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
function showAddError(msg) {
  $('addError').textContent = msg;
  $('addError').classList.remove('hidden');
}

$('addProbe').onclick = () => runProbe();
$('addUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runProbe(); } });
$('addUrl').addEventListener('input', resetAddInfo);
$('addCategory').onchange = async () => { $('addDir').value = await api.dirFor($('addCategory').value); };
$('addChoose').onclick = async () => {
  const dir = await api.chooseDir($('addDir').value);
  if (dir) $('addDir').value = dir;
};
$('addCancel').onclick = () => add.dlg.close();

async function submitAdd(startNow) {
  if (!add.probed) return;
  try {
    const d = await api.add({
      url: $('addUrl').value.trim(),
      filename: $('addName').value.trim(),
      headers: add.headers,
      dir: $('addDir').value.trim(),
      category: $('addCategory').value,
      size: add.probed.size,
      resumable: add.probed.resumable,
      startNow,
    });
    add.dlg.close();
    state.selected = new Set([d.id]);
    state.filter = 'all';
  } catch (e) {
    showAddError(cleanErr(e));
  }
}
$('addStart').onclick = () => submitAdd(true);
$('addLater').onclick = () => submitAdd(false);

// ---------- remove dialog ----------
function openRemoveDialog() {
  const sel = selectedItems();
  if (!sel.length) return;
  $('removeText').textContent = sel.length === 1 ? sel[0].filename : `${sel.length} item dipilih`;
  $('removeFile').checked = false;
  const dlg = $('removeDialog');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', async function onClose() {
    dlg.removeEventListener('close', onClose);
    if (dlg.returnValue !== 'ok') return;
    const del = $('removeFile').checked;
    for (const d of sel) await api.remove(d.id, del);
    state.selected.clear();
  });
}

// ---------- settings ----------
async function openSettings() {
  const s = await api.getSettings();
  $('sDir').value = s.downloadDir;
  $('sCatFolders').checked = s.useCategoryFolders;
  $('sConn').value = s.connections;
  $('sMax').value = s.maxConcurrent;
  $('sRetry').value = s.retries;
  $('sDialog').checked = s.showAddDialog;
  $('sNotify').checked = s.notifyOnComplete;
  $('sPort').value = s.serverPort;
  const dlg = $('settingsDialog');
  dlg.returnValue = '';
  dlg.showModal();
}
$('sChoose').onclick = async () => {
  const dir = await api.chooseDir($('sDir').value);
  if (dir) $('sDir').value = dir;
};
$('sClear').onclick = async () => { await api.clearCompleted(); toast('Daftar yang selesai dibersihkan'); };
$('settingsDialog').addEventListener('close', async () => {
  if ($('settingsDialog').returnValue !== 'ok') return;
  state.settings = await api.setSettings({
    downloadDir: $('sDir').value.trim(),
    useCategoryFolders: $('sCatFolders').checked,
    connections: Number($('sConn').value),
    maxConcurrent: Number($('sMax').value),
    retries: Number($('sRetry').value),
    showAddDialog: $('sDialog').checked,
    notifyOnComplete: $('sNotify').checked,
    serverPort: Number($('sPort').value),
  });
  $('bridgeHint').textContent = `Ekstensi browser: port ${state.settings.serverPort}`;
  toast('Pengaturan disimpan');
});

// ---------- toast ----------
function toast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3000);
}

// ---------- boot ----------
(async () => {
  state.categories = await api.categories();
  state.settings = await api.getSettings();
  state.items = await api.list();
  $('bridgeHint').textContent = `Ekstensi browser: port ${state.settings.serverPort}`;
  render();
  api.onUpdate((list) => {
    state.items = list;
    const ids = new Set(list.map((d) => d.id));
    for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
    render();
  });
  api.onExternalAdd((req) => openAddDialog(req));
  api.onMenu((m) => {
    if (m === 'add') openAddDialog();
    else if (m?.action === 'add') openAddDialog({ url: m.url });
  });
  api.onToast((t) => toast(t.text, t.kind));
  api.ready(); // semua listener terpasang; main boleh mengirim link yang tertunda
})();
