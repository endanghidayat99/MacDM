'use strict';

// Kategori file ala IDM: menentukan subfolder tujuan berdasarkan ekstensi.
const CATEGORIES = {
  Compressed: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'iso', 'dmg', 'pkg'],
  Documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv', 'odt', 'ods', 'epub', 'pages', 'numbers', 'key'],
  Music: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'aiff'],
  Video: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv', '3gp', 'ts'],
  Programs: ['app', 'exe', 'msi', 'apk', 'jar', 'deb', 'rpm', 'appimage', 'sh', 'bin'],
  Images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'svg', 'bmp', 'tiff', 'psd'],
};

const CATEGORY_NAMES = [...Object.keys(CATEGORIES), 'Other'];

function extOf(filename) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.tar.gz')) return 'tgz';
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1) : '';
}

function categorize(filename) {
  const ext = extOf(filename);
  for (const [cat, exts] of Object.entries(CATEGORIES)) {
    if (exts.includes(ext)) return cat;
  }
  return 'Other';
}

module.exports = { CATEGORIES, CATEGORY_NAMES, categorize, extOf };
