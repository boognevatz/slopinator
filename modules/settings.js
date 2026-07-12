// ── Settings & localStorage persistence module ─────────────

import { state } from './editor.js';

const LS_PREFIX = 'annotator.';

export function initSettings() {
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-settings-close').addEventListener('click', closeSettings);
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
}

function openSettings() {
  document.getElementById('settings-popup').hidden = false;
  syncOriginRadios();
  renderLocalStorageInfo();
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
