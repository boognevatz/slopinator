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
  document.getElementById('btn-settings-opfs-clear').addEventListener('click', clearOpfsData);
  document.getElementById('btn-settings-opfs-new-folder').addEventListener('click', async function() {
    var name = prompt('Enter folder name:');
    if (!name) return;
    name = name.trim();
    if (!name) return;
    try {
      const root = await navigator.storage.getDirectory();
      await root.getDirectoryHandle(name, { create: true });
      renderOpfsInfo();
    } catch (e) {
      console.error('OPFS create folder error:', e);
    }
  });
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
  const tbody = document.getElementById('settings-opfs-tbody');
  tbody.innerHTML = '<tr><td colspan="4" style="padding:8px;text-align:center;color:#666;font-style:italic;">Loading...</td></tr>';
  let total = 0;
  let fileCount = 0;
  let dirCount = 0;
  try {
    const root = await navigator.storage.getDirectory();
    const rows = [];
    for await (const [name, handle] of root.entries()) {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.style.fontFamily = 'monospace';
      tdName.style.fontSize = '11px';
      const tdSize = document.createElement('td');
      tdSize.style.textAlign = 'right';
      tdSize.style.fontFamily = 'monospace';
      tdSize.style.fontSize = '11px';
      const tdDate = document.createElement('td');
      tdDate.style.textAlign = 'right';
      tdDate.style.fontFamily = 'monospace';
      tdDate.style.fontSize = '11px';
      tdDate.style.color = '#999';
      const tdActions = document.createElement('td');
      tdActions.style.textAlign = 'center';

      if (handle.kind === 'directory') {
        dirCount++;
        tdName.textContent = '\uD83D\uDCC1 ' + name;
        tdSize.textContent = '\u2014';
        tdDate.textContent = '\u2014';
        const btn = document.createElement('button');
        btn.textContent = '\u2716';
        btn.title = 'Delete folder ' + name;
        btn.style.fontSize = '11px';
        btn.style.padding = '1px 6px';
        btn.style.cursor = 'pointer';
        btn.addEventListener('click', async function(e) {
          e.stopPropagation();
          if (!confirm('Delete folder "' + name + '" and all its contents?')) return;
          try {
            const r = await navigator.storage.getDirectory();
            await r.removeEntry(name, { recursive: true });
            renderOpfsInfo();
          } catch (err) {
            console.error('OPFS delete folder error:', err);
          }
        });
        tdActions.appendChild(btn);
      } else {
        const file = await handle.getFile();
        total += file.size;
        fileCount++;
        tdName.textContent = '\uD83D\uDCC4 ' + name;
        tdSize.textContent = formatSize(file.size);
        tdDate.textContent = file.lastModified ? formatRelativeTime(file.lastModified) : '-';
        const btn = document.createElement('button');
        btn.textContent = '\u2193';
        btn.title = 'Download ' + name;
        btn.style.fontSize = '11px';
        btn.style.padding = '1px 6px';
        btn.style.cursor = 'pointer';
        btn.addEventListener('click', async function(e) {
          e.stopPropagation();
          try {
            const dlFile = await handle.getFile();
            const dlUrl = URL.createObjectURL(dlFile);
            const a = document.createElement('a');
            a.href = dlUrl;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function() { URL.revokeObjectURL(dlUrl); }, 1000);
          } catch (dlErr) {
            console.error('OPFS download error:', dlErr);
          }
        });
        tdActions.appendChild(btn);
      }

      tr.appendChild(tdName);
      tr.appendChild(tdSize);
      tr.appendChild(tdDate);
      tr.appendChild(tdActions);
      rows.push({ tr, isDir: handle.kind === 'directory', name });
    }
    rows.sort(function(a, b) {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    tbody.innerHTML = '';
    for (var i = 0; i < rows.length; i++) tbody.appendChild(rows[i].tr);
    var itemLabel = fileCount + ' file' + (fileCount !== 1 ? 's' : '');
    if (dirCount > 0) itemLabel += ', ' + dirCount + ' folder' + (dirCount !== 1 ? 's' : '');
    document.getElementById('settings-opfs-total-usage').textContent = formatSize(total);
    document.getElementById('settings-opfs-total-items').textContent = itemLabel;
    document.getElementById('btn-settings-opfs-clear').disabled = fileCount === 0 && dirCount === 0;
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="4" style="padding:8px;text-align:center;color:#c66;font-style:italic;">OPFS unavailable</td></tr>';
    document.getElementById('settings-opfs-total-usage').textContent = '0 B';
    document.getElementById('settings-opfs-total-items').textContent = '0 files';
    document.getElementById('btn-settings-opfs-clear').disabled = true;
  }
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
  } catch (e) {
    console.error('OPFS clear error:', e);
  }
  renderOpfsInfo();
}
