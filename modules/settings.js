// ── Settings & localStorage persistence module ─────────────

import { state } from './editor.js';

const LS_PREFIX = 'annotator.';

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
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch (e) {
    console.warn('localStorage save failed:', e);
  }
}

export function loadPreference(key, defaultVal) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (raw === null) return defaultVal;
    return JSON.parse(raw);
  } catch (e) {
    return defaultVal;
  }
}

export function removePreference(key) {
  localStorage.removeItem(LS_PREFIX + key);
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
  renderLocalStorageInfo();
}

function switchSettingsTab(name) {
  var isLocal = name === 'localstorage';
  var tabLocal = document.getElementById('tab-localstorage');
  var tabOpfs = document.getElementById('tab-opfs');
  var panelLocal = document.getElementById('panel-localstorage');
  var panelOpfs = document.getElementById('panel-opfs');
  tabLocal.textContent = isLocal ? 'Saved Data (localStorage)' : 'localStorage';
  tabLocal.style.background = isLocal ? 'var(--color-accent)' : '#3a3a3a';
  tabLocal.style.color = isLocal ? '#fff' : '#aaa';
  tabOpfs.textContent = isLocal ? 'OPFS' : 'Browser File System (OPFS)';
  tabOpfs.style.background = isLocal ? '#3a3a3a' : 'var(--color-accent)';
  tabOpfs.style.color = isLocal ? '#aaa' : '#fff';
  panelLocal.hidden = !isLocal;
  panelOpfs.hidden = isLocal;
  if (!isLocal && !_opfsRendered) {
    _opfsRendered = true;
    renderOpfsInfo();
  }
  requestAnimationFrame(function() {
    var visible = isLocal ? panelLocal : panelOpfs;
    var h = visible.scrollHeight;
    var container = document.getElementById('settings-tab-container');
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
  const keys = Object.keys(localStorage).filter(k => k.startsWith(LS_PREFIX));
  keys.forEach(k => localStorage.removeItem(k));
  renderLocalStorageInfo();
}

function getLocalStorageItems() {
  const items = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(LS_PREFIX)) continue;
    const val = localStorage.getItem(key);
    const displayKey = key.slice(LS_PREFIX.length);
    const size = val ? new Blob([val]).size : 0;
    items.push({ key: displayKey, size, raw: key });
  }
  items.sort((a, b) => a.key.localeCompare(b.key));
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
  if (valueArea) { valueArea.value = ''; valueArea.rows = 1; }
  _selectedRow = null;

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
      valueArea.rows = Math.max(10, (val || '').split('\n').length);
    });
    const tdKey = document.createElement('td');
    tdKey.textContent = item.key;
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
  let count = 0;
  try {
    const root = await navigator.storage.getDirectory();
    const rows = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'file') continue;
      const file = await handle.getFile();
      total += file.size;
      count++;
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.textContent = name;
      tdName.style.fontFamily = 'monospace';
      tdName.style.fontSize = '11px';
      const tdSize = document.createElement('td');
      tdSize.style.textAlign = 'right';
      tdSize.style.fontFamily = 'monospace';
      tdSize.style.fontSize = '11px';
      tdSize.textContent = formatSize(file.size);
      const tdDate = document.createElement('td');
      tdDate.style.textAlign = 'right';
      tdDate.style.fontFamily = 'monospace';
      tdDate.style.fontSize = '11px';
      tdDate.style.color = '#999';
      tdDate.textContent = file.lastModified ? formatRelativeTime(file.lastModified) : '-';
      const tdActions = document.createElement('td');
      tdActions.style.textAlign = 'center';
      const btn = document.createElement('button');
      btn.textContent = '↓';
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
      tr.appendChild(tdName);
      tr.appendChild(tdSize);
      tr.appendChild(tdDate);
      tr.appendChild(tdActions);
      rows.push(tr);
    }
    rows.sort(function(a, b) {
      return a.firstChild.textContent.localeCompare(b.firstChild.textContent);
    });
    tbody.innerHTML = '';
    for (var i = 0; i < rows.length; i++) tbody.appendChild(rows[i]);
    document.getElementById('settings-opfs-total-usage').textContent = formatSize(total);
    document.getElementById('settings-opfs-total-items').textContent = count + ' file' + (count !== 1 ? 's' : '');
    document.getElementById('btn-settings-opfs-clear').disabled = count === 0;
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="4" style="padding:8px;text-align:center;color:#c66;font-style:italic;">OPFS unavailable</td></tr>';
    document.getElementById('settings-opfs-total-usage').textContent = '0 B';
    document.getElementById('settings-opfs-total-items').textContent = '0 files';
    document.getElementById('btn-settings-opfs-clear').disabled = true;
  }
}

async function clearOpfsData() {
  if (!confirm('Delete all files from browser file system?')) return;
  try {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind === 'file') names.push(name);
    }
    for (const name of names) {
      await root.removeEntry(name).catch(() => {});
    }
  } catch (e) {
    console.error('OPFS clear error:', e);
  }
  renderOpfsInfo();
}
