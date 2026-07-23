// ── Settings & localStorage persistence module ─────────────

import { state } from './editor.js';

function getAppName() {
  return document.documentElement.dataset.appname || 'index';
}

export var APP_PREFIX = getAppName() + ':';

function getPrefixes() {
  return ['index:', 'pcb:'];
}

export function initSettings() {
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-settings-close').addEventListener('click', closeSettings);
  document.getElementById('btn-settings-cancel').addEventListener('click', closeSettings);
  document.getElementById('btn-settings-clear').addEventListener('click', clearAllData);
  document.getElementById('settings-popup').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });
  document.getElementById('settings-popup').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettings();
  });
  document.getElementById('btn-settings-save').addEventListener('click', saveSettings);

  document.querySelectorAll('input[name="origin-coord"]').forEach(r => {
    r.addEventListener('change', function () {
      state.originCoordinate = this.value;
      document.dispatchEvent(new CustomEvent('origin-changed'));
    });
  });

  var autosaveCb = document.getElementById('setting-autosave-enabled');
  autosaveCb.addEventListener('change', function () {
    state.autosaveEnabled = this.checked;
  });

  document.getElementById('btn-settings-opfs-refresh').addEventListener('click', renderOpfsInfo);
  document.getElementById('btn-settings-opfs-new-folder').addEventListener('click', async function() {
    var name = prompt('Enter folder name:');
    if (!name) return;
    name = name.trim();
    if (!name) return;
    try {
      var dirHandle = await _opfsGetCurrentDir();
      await dirHandle.getDirectoryHandle(name, { create: true });
      renderOpfsInfo();
    } catch (e) {
      console.error('OPFS create folder error:', e);
    }
  });
  document.getElementById('opfs-select-all').addEventListener('change', toggleSelectAllOpfs);
  document.getElementById('btn-opfs-delete').addEventListener('click', deleteSelectedOpfs);
  document.getElementById('btn-opfs-copy').addEventListener('click', copySelectedOpfs);
  document.getElementById('btn-opfs-move').addEventListener('click', moveSelectedOpfs);
  document.getElementById('btn-opfs-rename').addEventListener('click', renameSelectedOpfs);
  document.getElementById('btn-opfs-paste').addEventListener('click', pasteOpfs);
  document.getElementById('btn-opfs-cancel-clipboard').addEventListener('click', cancelOpfsClipboard);
  document.getElementById('tab-localstorage').addEventListener('click', function() { switchSettingsTab('localstorage'); });
  document.getElementById('tab-opfs').addEventListener('click', function() { switchSettingsTab('opfs'); });
}

function saveSettings() {
  saveColorPreferences();
  syncOriginRadios();
  closeSettings();
}

export function savePreference(key, value) {
  try {
    localStorage.setItem(APP_PREFIX + key, JSON.stringify(value));
  } catch (e) {
    console.warn('localStorage save failed:', e);
  }
}

export function loadPreference(key, defaultVal) {
  try {
    const raw = localStorage.getItem(APP_PREFIX + key);
    if (raw === null) return defaultVal;
    return JSON.parse(raw);
  } catch (e) {
    return defaultVal;
  }
}

export function removePreference(key) {
  var prefixes = getPrefixes();
  for (var i = 0; i < prefixes.length; i++) {
    localStorage.removeItem(prefixes[i] + key);
  }
}

export function saveColorPreferences() {
  savePreference('activeColor', state.activeColor);
  savePreference('bgColor', state.bgColor);
  savePreference('activeOpacity', state.activeOpacity);
  savePreference('bgOpacity', state.bgOpacity);
  savePreference('palette', state.palette);
  savePreference('activeThickness', state.activeThickness);
  savePreference('originCoordinate', state.originCoordinate);
  savePreference('autosaveEnabled', state.autosaveEnabled);
}

export function loadColorPreferences() {
  const color = loadPreference('activeColor');
  if (color) state.activeColor = color;

  const bgColor = loadPreference('bgColor');
  if (bgColor) state.bgColor = bgColor;

  const opacity = loadPreference('activeOpacity');
  if (opacity != null) state.activeOpacity = opacity;

  const bgOpacity = loadPreference('bgOpacity');
  if (bgOpacity != null) state.bgOpacity = bgOpacity;

  const palette = loadPreference('palette');
  if (palette) state.palette = palette;

  const thickness = loadPreference('activeThickness');
  if (thickness != null) state.activeThickness = thickness;

  const origin = loadPreference('originCoordinate');
  if (origin) state.originCoordinate = origin;

  var autosave = loadPreference('autosaveEnabled');
  if (autosave != null) state.autosaveEnabled = autosave;
}

var _opfsRendered = false;
var _opfsPath = [];
var _opfsSelection = new Set();
var _opfsClipboard = null; // { mode: 'copy'|'move', items: [names], sourcePath: [...] }

function openSettings() {
  document.getElementById('settings-popup').hidden = false;
  syncOriginRadios();
  document.getElementById('setting-autosave-enabled').checked = state.autosaveEnabled;
  _opfsRendered = false;
  switchSettingsTab('localstorage');
  _setupEditActions();
  renderLocalStorageInfo();
}

function _setupEditActions() {
  var saveBtn = document.getElementById('btn-settings-edit-save');
  var cancelBtn = document.getElementById('btn-settings-edit-cancel');
  var valueArea = document.getElementById('settings-key-value');
  if (!valueArea || !saveBtn || !cancelBtn) return;

  valueArea.oninput = function() {
    if (!_selectedRow) { saveBtn.disabled = true; cancelBtn.disabled = true; return; }
    var current = localStorage.getItem(_selectedRow.dataset.key) || '';
    var isDiff = this.value !== current;
    this.style.borderColor = isDiff ? 'var(--color-accent)' : '#444';
    saveBtn.disabled = !isDiff;
    cancelBtn.disabled = !isDiff;
  };

  saveBtn.onclick = function() {
    if (!_selectedRow) return;
    localStorage.setItem(_selectedRow.dataset.key, valueArea.value);
    valueArea.style.borderColor = '#444';
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    renderLocalStorageInfo();
  };

  cancelBtn.onclick = function() {
    if (!_selectedRow) return;
    var original = localStorage.getItem(_selectedRow.dataset.key) || '';
    valueArea.value = original;
    valueArea.rows = Math.min(8, Math.max(2, original.split('\n').length));
    valueArea.style.borderColor = '#444';
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
  };
}

function switchSettingsTab(name) {
  var isLocal = name === 'localstorage';
  var tabLocal = document.getElementById('tab-localstorage');
  var tabOpfs = document.getElementById('tab-opfs');
  var panelLocal = document.getElementById('panel-localstorage');
  var panelOpfs = document.getElementById('panel-opfs');
  tabLocal.textContent = isLocal ? 'localStorage (saved data)' : 'localStorage';
  tabLocal.style.background = isLocal ? 'var(--color-accent)' : '#3a3a3a';
  tabLocal.style.color = isLocal ? '#fff' : '#aaa';
  tabOpfs.textContent = isLocal ? 'OPFS' : 'OPFS (Browser File System)';
  tabOpfs.style.background = isLocal ? '#3a3a3a' : 'var(--color-accent)';
  tabOpfs.style.color = isLocal ? '#aaa' : '#fff';
  panelLocal.style.display = isLocal ? 'flex' : 'none';
  panelOpfs.style.display = isLocal ? 'none' : 'block';
  if (!isLocal && !_opfsRendered) {
    _opfsRendered = true;
    renderOpfsInfo();
  }
  requestAnimationFrame(function() {
    var container = document.getElementById('settings-tab-container');
    var h = container.clientHeight;
    var cur = parseInt(container.style.minHeight) || 0;
    if (h > cur) container.style.minHeight = h + 'px';
  });
}

function syncOriginRadios() {
  document.querySelectorAll('input[name="origin-coord"]').forEach(r => {
    r.checked = r.value === state.originCoordinate;
  });
}

function closeSettings() {
  document.getElementById('settings-popup').hidden = true;
}

function clearAllData() {
  var prefixes = getPrefixes().concat(['annotator.']);
  var keys = Object.keys(localStorage).filter(function(k) {
    for (var i = 0; i < prefixes.length; i++) {
      if (k.startsWith(prefixes[i])) return true;
    }
    return false;
  });
  keys.forEach(k => localStorage.removeItem(k));
  renderLocalStorageInfo();
}

function getLocalStorageItems() {
  var prefixes = getPrefixes().concat(['annotator.']);
  const items = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    var matchedPrefix = null;
    for (var p = 0; p < prefixes.length; p++) {
      if (key.startsWith(prefixes[p])) { matchedPrefix = prefixes[p]; break; }
    }
    if (!matchedPrefix) continue;
    const val = localStorage.getItem(key);
    const displayKey = key.slice(matchedPrefix.length);
    const size = val ? new Blob([val]).size : 0;
    items.push({ key: displayKey, size, raw: key, prefix: matchedPrefix });
  }
  items.sort(function(a, b) {
    var diff = a.prefix.localeCompare(b.prefix);
    if (diff !== 0) return diff;
    return a.key.localeCompare(b.key);
  });
  return items;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  return (bytes / 1024).toFixed(1) + ' KB';
}

function formatRelativeTime(ts) {
  var diff = Date.now() - ts;
  var mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min' + (mins !== 1 ? 's' : '') + ' ago';
  var hours = Math.round(mins / 60);
  if (hours < 24) return hours + ' hour' + (hours !== 1 ? 's' : '') + ' ago';
  var days = Math.round(hours / 24);
  if (days < 7) return days + ' day' + (days !== 1 ? 's' : '') + ' ago';
  return new Date(ts).toLocaleString();
}

let _selectedRow = null;

function renderLocalStorageInfo() {
  const items = getLocalStorageItems();
  const tbody = document.getElementById('settings-storage-tbody');
  tbody.innerHTML = '';
  const valueArea = document.getElementById('settings-key-value');
  if (valueArea) { valueArea.value = ''; valueArea.rows = 1; valueArea.style.borderColor = '#444'; }
  _selectedRow = null;

  var saveBtn = document.getElementById('btn-settings-edit-save');
  var cancelBtn = document.getElementById('btn-settings-edit-cancel');
  if (saveBtn) saveBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;

  let total = 0;
  for (const item of items) {
    total += item.size;
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.dataset.key = item.raw;
    tr.addEventListener('click', () => {
      if (_selectedRow) _selectedRow.style.background = '';
      tr.style.setProperty('background', 'var(--color-accent)');
      _selectedRow = tr;
      const val = localStorage.getItem(item.raw);
      valueArea.value = val || '';
      valueArea.rows = Math.min(8, Math.max(2, (val || '').split('\n').length));
      valueArea.style.borderColor = '#444';
      if (saveBtn) saveBtn.disabled = true;
      if (cancelBtn) cancelBtn.disabled = true;
    });
    const tdKey = document.createElement('td');
    tdKey.textContent = item.prefix + item.key;
    const tdSize = document.createElement('td');
    tdSize.style.textAlign = 'right';
    tdSize.textContent = formatSize(item.size);
    tr.appendChild(tdKey);
    tr.appendChild(tdSize);
    tbody.appendChild(tr);
  }

  document.getElementById('settings-total-usage').textContent = formatSize(total);
  document.getElementById('settings-total-items').textContent = items.length + ' item' + (items.length !== 1 ? 's' : '');
  document.getElementById('btn-settings-clear').disabled = items.length === 0;
}

async function renderOpfsInfo() {
  renderBreadcrumb();
  const tbody = document.getElementById('settings-opfs-tbody');
  tbody.innerHTML = '<tr><td colspan="4" style="padding:8px;text-align:center;color:#666;font-style:italic;">Loading...</td></tr>';
  let total = 0;
  let fileCount = 0;
  let dirCount = 0;
  try {
    var dirHandle = await _opfsGetCurrentDir();
    const rows = [];

    if (_opfsPath.length > 0) {
      var tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      var td0 = document.createElement('td');
      td0.style.width = '30px';
      td0.style.textAlign = 'center';
      var tdName = document.createElement('td');
      tdName.textContent = '\u2191 ..';
      tdName.style.fontFamily = 'monospace';
      tdName.style.fontSize = '11px';
      tdName.addEventListener('click', function() {
        _opfsPath.pop();
        _opfsSelection = new Set();
        renderOpfsInfo();
      });
      var tdSize = document.createElement('td');
      tdSize.style.textAlign = 'right';
      tdSize.style.fontFamily = 'monospace';
      tdSize.style.fontSize = '11px';
      var tdDate = document.createElement('td');
      tdDate.style.textAlign = 'right';
      tdDate.style.fontFamily = 'monospace';
      tdDate.style.fontSize = '11px';
      tr.appendChild(td0);
      tr.appendChild(tdName);
      tr.appendChild(tdSize);
      tr.appendChild(tdDate);
      rows.push({ tr, isParent: true, name: '..' });
    }

    for await (const [name, handle] of dirHandle.entries()) {
      var tr = document.createElement('tr');

      var td0 = document.createElement('td');
      td0.style.width = '30px';
      td0.style.textAlign = 'center';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = _opfsSelection.has(name);
      cb.addEventListener('change', function(n, h) {
        return function() {
          if (this.checked) _opfsSelection.add(n);
          else _opfsSelection.delete(n);
          updateOpfsToolbar();
          updateSelectAllCheckbox();
        };
      }(name, handle));
      td0.appendChild(cb);

      var tdName = document.createElement('td');
      tdName.style.fontFamily = 'monospace';
      tdName.style.fontSize = '11px';
      tdName.style.whiteSpace = 'nowrap';
      tdName.style.overflow = 'hidden';
      tdName.style.textOverflow = 'ellipsis';
      tdName.style.maxWidth = '160px';

      var tdSize = document.createElement('td');
      tdSize.style.textAlign = 'right';
      tdSize.style.fontFamily = 'monospace';
      tdSize.style.fontSize = '11px';

      var tdDate = document.createElement('td');
      tdDate.style.textAlign = 'right';
      tdDate.style.fontFamily = 'monospace';
      tdDate.style.fontSize = '11px';
      tdDate.style.color = '#999';

      if (handle.kind === 'directory') {
        dirCount++;
        tdName.textContent = '\uD83D\uDCC1 ' + name;
        tdName.style.cursor = 'pointer';
        tdSize.textContent = '\u2014';
        tdDate.textContent = '\u2014';

        var navTimer = null;
        function navInto() {
          _opfsPath.push(name);
          _opfsSelection = new Set();
          renderOpfsInfo();
        }

        tdName.addEventListener('dblclick', function(e) {
          e.preventDefault();
          navInto();
        });

        tdName.addEventListener('mousedown', function(e) {
          navTimer = setTimeout(navInto, 500);
        });
        tdName.addEventListener('mouseup', function() { if (navTimer) { clearTimeout(navTimer); navTimer = null; } });
        tdName.addEventListener('mouseleave', function() { if (navTimer) { clearTimeout(navTimer); navTimer = null; } });

        tdName.addEventListener('touchstart', function(e) {
          navTimer = setTimeout(navInto, 500);
        }, { passive: true });
        tdName.addEventListener('touchend', function() { if (navTimer) { clearTimeout(navTimer); navTimer = null; } });
        tdName.addEventListener('touchmove', function() { if (navTimer) { clearTimeout(navTimer); navTimer = null; } }, { passive: true });
      } else {
        var file = await handle.getFile();
        total += file.size;
        fileCount++;
        tdName.textContent = '\uD83D\uDCC4 ' + name;
        tdName.title = name;
        tdSize.textContent = formatSize(file.size);
        tdDate.textContent = file.lastModified ? formatRelativeTime(file.lastModified) : '-';
      }

      // Clipboard highlight
      var samePath = _opfsClipboard && _opfsClipboard.sourcePath.join('/') === _opfsPath.join('/');
      var inClipboard = samePath && _opfsClipboard.items.indexOf(name) !== -1;
      if (inClipboard) {
        tr.style.opacity = '0.4';
        var icon = _opfsClipboard.mode === 'copy' ? '\uD83D\uDCCB' : '\u2702';
        tdName.textContent = icon + ' ' + name;
        if (handle.kind === 'directory') tdName.style.cursor = 'pointer';
        else tdName.style.cursor = 'default';
      }

      // Single click on name toggles checkbox
      tdName.style.cursor = !inClipboard && handle.kind === 'directory' ? 'pointer' : 'default';
      tdName.addEventListener('click', function(n) {
        return function() {
          var checkbox = tr.cells[0].querySelector('input[type="checkbox"]');
          if (checkbox) {
            checkbox.checked = !checkbox.checked;
            if (checkbox.checked) _opfsSelection.add(n);
            else _opfsSelection.delete(n);
            updateOpfsToolbar();
            updateSelectAllCheckbox();
          }
        };
      }(name));

      tr.dataset.name = name;
      tr.appendChild(td0);
      tr.appendChild(tdName);
      tr.appendChild(tdSize);
      tr.appendChild(tdDate);
      rows.push({ tr, isParent: false, isDir: handle.kind === 'directory', name });
    }

    rows.sort(function(a, b) {
      if (a.isParent) return -1;
      if (b.isParent) return 1;
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    tbody.innerHTML = '';
    for (var i = 0; i < rows.length; i++) tbody.appendChild(rows[i].tr);

    var itemLabel = fileCount + ' file' + (fileCount !== 1 ? 's' : '');
    if (dirCount > 0) itemLabel += ', ' + dirCount + ' folder' + (dirCount !== 1 ? 's' : '');
    document.getElementById('settings-opfs-total-usage').textContent = formatSize(total);
    document.getElementById('settings-opfs-total-items').textContent = itemLabel;

    updateOpfsToolbar();
    updateSelectAllCheckbox();
  } catch (e) {
    if (_opfsPath.length > 0) {
      _opfsPath = [];
      _opfsSelection = new Set();
      renderOpfsInfo();
      return;
    }
    tbody.innerHTML = '<tr><td colspan="4" style="padding:8px;text-align:center;color:#c66;font-style:italic;">OPFS unavailable</td></tr>';
    document.getElementById('settings-opfs-total-usage').textContent = '0 B';
    document.getElementById('settings-opfs-total-items').textContent = '0 items';
  }
}

function renderBreadcrumb() {
  var el = document.getElementById('opfs-breadcrumb');
  if (!el) return;
  var parts = ['Home'];
  for (var i = 0; i < _opfsPath.length; i++) parts.push(_opfsPath[i]);
  el.innerHTML = '';
  for (var i = 0; i < parts.length; i++) {
    if (i > 0) {
      var sep = document.createElement('span');
      sep.textContent = ' \u203A ';
      sep.style.color = '#555';
      el.appendChild(sep);
    }
    var seg = document.createElement('span');
    seg.textContent = parts[i];
    seg.style.cursor = 'pointer';
    seg.style.color = i === parts.length - 1 ? '#ccc' : '#888';
    (function(idx) {
      seg.addEventListener('click', function() {
        _opfsPath = _opfsPath.slice(0, idx);
        _opfsSelection = new Set();
        renderOpfsInfo();
      });
      seg.addEventListener('mouseenter', function() {
        this.style.color = '#fff';
      });
      seg.addEventListener('mouseleave', function() {
        this.style.color = idx === parts.length - 1 ? '#ccc' : '#888';
      });
    })(i);
    el.appendChild(seg);
  }
}

function updateOpfsToolbar() {
  var settingsInner = document.querySelector('#settings-popup > div');
  if (settingsInner) {
    var w = settingsInner.offsetWidth;
    if (w > 0) {
      var mw = parseInt(settingsInner.style.minWidth) || 0;
      if (w > mw) settingsInner.style.minWidth = w + 'px';
    }
  }

  var normal = document.getElementById('opfs-toolbar-normal');
  var clipboard = document.getElementById('opfs-toolbar-clipboard');
  if (_opfsClipboard) {
    if (normal) normal.style.display = 'none';
    if (clipboard) clipboard.style.display = 'flex';
    var status = document.getElementById('opfs-clipboard-status');
    if (status) {
      var mode = _opfsClipboard.mode === 'copy' ? 'Copying' : 'Moving';
      status.textContent = mode + ' ' + _opfsClipboard.items.length + ' item' + (_opfsClipboard.items.length !== 1 ? 's' : '');
      var hint = document.getElementById('opfs-clipboard-hint');
      if (hint) hint.textContent = mode === 'Copying' ? '\uD83D\uDCCB' : '\u2702';
    }
    return;
  }
  if (normal) normal.style.display = 'flex';
  if (clipboard) clipboard.style.display = 'none';
  var hasSelection = _opfsSelection && _opfsSelection.size > 0;
  var singleSel = _opfsSelection && _opfsSelection.size === 1;
  var del = document.getElementById('btn-opfs-delete');
  var copy = document.getElementById('btn-opfs-copy');
  var move = document.getElementById('btn-opfs-move');
  var rename = document.getElementById('btn-opfs-rename');
  if (del) del.disabled = !hasSelection;
  if (copy) copy.disabled = !hasSelection;
  if (move) move.disabled = !hasSelection;
  if (rename) rename.disabled = !singleSel;
}

function updateSelectAllCheckbox() {
  var cb = document.getElementById('opfs-select-all');
  if (!cb) return;
  var tbody = document.getElementById('settings-opfs-tbody');
  var checkboxes = tbody.querySelectorAll('input[type="checkbox"]');
  if (checkboxes.length === 0) {
    cb.checked = false;
    cb.indeterminate = false;
    return;
  }
  var checked = 0;
  for (var i = 0; i < checkboxes.length; i++) {
    if (checkboxes[i].checked) checked++;
  }
  if (checked === 0) {
    cb.checked = false;
    cb.indeterminate = false;
  } else if (checked === checkboxes.length) {
    cb.checked = true;
    cb.indeterminate = false;
  } else {
    cb.checked = false;
    cb.indeterminate = true;
  }
}

function toggleSelectAllOpfs() {
  var cb = document.getElementById('opfs-select-all');
  if (!cb) return;
  var checked = cb.checked;
  _opfsSelection = new Set();
  var tbody = document.getElementById('settings-opfs-tbody');
  var cbs = tbody.querySelectorAll('input[type="checkbox"]');
  for (var i = 0; i < cbs.length; i++) {
    cbs[i].checked = checked;
    if (checked) {
      var tr = cbs[i].closest('tr');
      if (tr && tr.dataset.name) _opfsSelection.add(tr.dataset.name);
    }
  }
  updateOpfsToolbar();
}

async function _opfsGetCurrentDir() {
  var handle = await navigator.storage.getDirectory();
  for (var i = 0; i < _opfsPath.length; i++) {
    handle = await handle.getDirectoryHandle(_opfsPath[i]);
  }
  return handle;
}

async function _opfsResolvePath(segments, create) {
  var handle = await navigator.storage.getDirectory();
  for (var i = 0; i < segments.length; i++) {
    if (segments[i]) handle = await handle.getDirectoryHandle(segments[i], { create: !!create });
  }
  return handle;
}

async function _opfsNameExists(dirHandle, name) {
  try {
    await dirHandle.getFileHandle(name);
    return true;
  } catch {
    try {
      await dirHandle.getDirectoryHandle(name);
      return true;
    } catch {
      return false;
    }
  }
}

async function _opfsUniqueName(dirHandle, name) {
  if (!(await _opfsNameExists(dirHandle, name))) return name;
  var dotIdx = name.lastIndexOf('.');
  var stem = dotIdx > 0 ? name.slice(0, dotIdx) : name;
  var ext = dotIdx > 0 ? name.slice(dotIdx) : '';
  for (var i = 1; i < 1000; i++) {
    var candidate = stem + ' (' + i + ')' + ext;
    if (!(await _opfsNameExists(dirHandle, candidate))) return candidate;
  }
  return name;
}

async function _opfsCopyItem(srcDir, destDir, name, isDir) {
  if (isDir) {
    var destSub = await destDir.getDirectoryHandle(name, { create: true });
    var srcSub = await srcDir.getDirectoryHandle(name);
    for await (var [childName, childHandle] of srcSub.entries()) {
      await _opfsCopyItem(srcSub, destSub, childName, childHandle.kind === 'directory');
    }
  } else {
    var srcFile = await srcDir.getFileHandle(name);
    var file = await srcFile.getFile();
    var destFile = await destDir.getFileHandle(name, { create: true });
    var writable = await destFile.createWritable();
    await writable.write(file);
    await writable.close();
  }
}

async function renameSelectedOpfs() {
  if (!_opfsSelection || _opfsSelection.size !== 1) return;
  var oldName = Array.from(_opfsSelection)[0];
  var tbody = document.getElementById('settings-opfs-tbody');
  var tr = Array.from(tbody.querySelectorAll('tr')).find(function(el) { return el.dataset.name === oldName; });
  if (!tr) return;
  var nameCell = tr.cells[1];
  if (!nameCell) return;

  var input = document.createElement('input');
  input.type = 'text';
  input.value = oldName;
  input.style.cssText = 'width:100%;font-family:monospace;font-size:11px;background:var(--color-bg-light);color:var(--color-text);border:1px solid var(--color-accent);border-radius:2px;padding:1px 3px;outline:none;box-sizing:border-box;';
  nameCell.textContent = '';
  nameCell.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    var newName = input.value.trim();
    if (!newName || newName === oldName) { renderOpfsInfo(); return; }
    if (newName.includes('/') || newName.includes('\\')) { renderOpfsInfo(); return; }
    _doRename(oldName, newName);
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); renderOpfsInfo(); }
  });
}

async function _doRename(oldName, newName) {
  try {
    var dirHandle = await _opfsGetCurrentDir();
    var exists = await _opfsNameExists(dirHandle, newName);
    if (exists) {
      renderOpfsInfo();
      return;
    }
    var isDir = false;
    try { await dirHandle.getDirectoryHandle(oldName); isDir = true; } catch {}
    if (isDir) {
      var newDir = await dirHandle.getDirectoryHandle(newName, { create: true });
      var oldDir = await dirHandle.getDirectoryHandle(oldName);
      for await (var [childName, childHandle] of oldDir.entries()) {
        await _opfsCopyItem(oldDir, newDir, childName, childHandle.kind === 'directory');
      }
    } else {
      var srcFile = await dirHandle.getFileHandle(oldName);
      var file = await srcFile.getFile();
      var destFile = await dirHandle.getFileHandle(newName, { create: true });
      var writable = await destFile.createWritable();
      await writable.write(file);
      await writable.close();
    }
    await dirHandle.removeEntry(oldName, { recursive: true });
    _opfsSelection = new Set();
    renderOpfsInfo();
  } catch (e) {
    console.error('OPFS rename error:', e);
    renderOpfsInfo();
  }
}

async function deleteSelectedOpfs() {
  if (!_opfsSelection || _opfsSelection.size === 0) return;
  var names = Array.from(_opfsSelection);
  if (!confirm('Delete ' + names.length + ' selected item' + (names.length !== 1 ? 's' : '') + '?')) return;
  try {
    var dirHandle = await _opfsGetCurrentDir();
    for (var i = 0; i < names.length; i++) {
      await dirHandle.removeEntry(names[i], { recursive: true }).catch(function() {});
    }
    _opfsSelection = new Set();
    renderOpfsInfo();
  } catch (e) {
    console.error('OPFS delete error:', e);
  }
}

async function copySelectedOpfs() {
  if (!_opfsSelection || _opfsSelection.size === 0) return;
  _opfsClipboard = { mode: 'copy', items: Array.from(_opfsSelection), sourcePath: _opfsPath.slice() };
  _opfsSelection = new Set();
  updateOpfsToolbar();
  renderOpfsInfo();
}

async function moveSelectedOpfs() {
  if (!_opfsSelection || _opfsSelection.size === 0) return;
  _opfsClipboard = { mode: 'move', items: Array.from(_opfsSelection), sourcePath: _opfsPath.slice() };
  _opfsSelection = new Set();
  updateOpfsToolbar();
  renderOpfsInfo();
}

async function pasteOpfs() {
  if (!_opfsClipboard) return;
  try {
    var destDir = await _opfsGetCurrentDir();
    var srcDir = await _opfsResolvePath(_opfsClipboard.sourcePath, false);
    var names = _opfsClipboard.items;
    for (var i = 0; i < names.length; i++) {
      var isDir = false;
      try { await srcDir.getDirectoryHandle(names[i]); isDir = true; } catch {}
      var uniqueName = names[i];
      if (_opfsClipboard.mode === 'copy' || _opfsClipboard.sourcePath.join('/') !== _opfsPath.join('/')) {
        uniqueName = await _opfsUniqueName(destDir, names[i]);
      }
      await _opfsCopyItem(srcDir, destDir, uniqueName, isDir);
      if (_opfsClipboard.mode === 'move') {
        await srcDir.removeEntry(names[i], { recursive: true }).catch(function() {});
      }
    }
    _opfsClipboard = null;
    renderOpfsInfo();
  } catch (e) {
    console.error('OPFS paste error:', e);
    alert('Paste failed: ' + e.message);
  }
}

function cancelOpfsClipboard() {
  _opfsClipboard = null;
  updateOpfsToolbar();
  renderOpfsInfo();
}

async function clearOpfsData() {
  if (!confirm('Delete all files and folders from browser file system?')) return;
  try {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const [name] of root.entries()) {
      names.push(name);
    }
    for (const name of names) {
      await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
    _opfsPath = [];
    _opfsSelection = new Set();
  } catch (e) {
    console.error('OPFS clear error:', e);
  }
  renderOpfsInfo();
}
