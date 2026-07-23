import { generateSVGString, openSVGProject, updateFilenameDisplay } from './fileio.js';
import { state } from './editor.js';

const AUTOSAVE_INTERVAL = 5 * 60 * 1000;
const CHECK_INTERVAL = 10000;
const BASE_TITLE = document.title || 'Slopinator';

let _dirty = false;
let _dirtyTime = 0;
let _lastAutosaveTime = null;
let _autosaveIntervalId = null;

function getAutosaveFilename() {
  var base = state.filename.replace(/\.svg$/i, '');
  return 'autosave-' + base + '.svg';
}

async function getFileHandle(filename, create) {
  const root = await navigator.storage.getDirectory();
  return root.getFileHandle(filename, { create });
}

export async function saveToOPFS(data) {
  var name = getAutosaveFilename();
  const handle = await getFileHandle(name, true);
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
  _dirty = false;
  var file = await handle.getFile();
  _lastAutosaveTime = file.lastModified || Date.now();
}

export async function deleteAutosave(filename) {
  var name = filename || getAutosaveFilename();
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(name).catch(function() {});
}

export async function saveAutosave(showFeedback) {
  var svg = generateSVGString();
  if (!svg) {
    if (showFeedback) showNotification('Save failed: no image loaded', true);
    return;
  }
  try {
    updateDisplay('saving...');
    await saveToOPFS(svg);
    if (showFeedback) {
      document.getElementById('file-menu').hidden = true;
      showNotification('File saved successfully', false);
    }
  } catch (err) {
    if (showFeedback) showNotification('Save failed: ' + err.message, true);
  }
}

function showNotification(msg, isError) {
  var existing = document.getElementById('opfs-notification');
  if (existing) existing.remove();

  var div = document.createElement('div');
  div.id = 'opfs-notification';
  div.style.cssText = 'position:absolute;top:0;left:0;right:0;background:' + (isError ? 'rgba(200,50,50,0.9)' : 'rgba(var(--color-accent-rgb),0.9)') + ';color:#fff;display:flex;align-items:center;justify-content:center;gap:8px;padding:8px;z-index:30;font-size:13px;';

  var textSpan = document.createElement('span');
  textSpan.textContent = msg;
  div.appendChild(textSpan);

  var countSpan = document.createElement('span');
  countSpan.id = 'opfs-countdown';
  countSpan.textContent = ' (will disappear in 5s)';
  div.appendChild(countSpan);

  var closeBtn = document.createElement('button');
  closeBtn.textContent = '\u00D7';
  closeBtn.style.cssText = 'background:transparent;border:none;color:#fff;font-size:18px;line-height:1;padding:0 4px;cursor:pointer;margin-left:10px;';
  closeBtn.addEventListener('click', function() { div.remove(); });
  div.appendChild(closeBtn);

  var container = document.getElementById('editor-container');
  if (container) container.appendChild(div);

  var count = 5;
  var intervalId = setInterval(function() {
    count--;
    var cs = document.getElementById('opfs-countdown');
    if (cs) cs.textContent = ' (will disappear in ' + count + 's)';
    if (count <= 0) {
      clearInterval(intervalId);
      if (div.parentNode) div.remove();
    }
  }, 1000);
}

function updateDisplay(text) {
  var el = document.getElementById('autosave-status');
  if (el) el.textContent = text;
}

function formatRemaining(ms) {
  if (ms <= 0) return '0:00';
  var totalSec = Math.ceil(ms / 1000);
  var min = Math.floor(totalSec / 60);
  var sec = totalSec % 60;
  return min + ':' + (sec < 10 ? '0' : '') + sec;
}

function formatTimeAgo(timestamp) {
  var diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + ' mins ago';
  if (diff < 86400) {
    var h = Math.floor(diff / 3600);
    return h + ' hour' + (h > 1 ? 's' : '') + ' ago';
  }
  var d = Math.floor(diff / 86400);
  return d + ' day' + (d > 1 ? 's' : '') + ' ago';
}

function updateAutosaveDisplay() {
  if (_dirty && state.autosaveEnabled) {
    var remaining = AUTOSAVE_INTERVAL - (Date.now() - _dirtyTime);
    updateDisplay('autosave in ' + formatRemaining(remaining));
    return;
  }
  if (_lastAutosaveTime) {
    updateDisplay('Last autosave ' + formatTimeAgo(_lastAutosaveTime));
  } else {
    updateDisplay('No autosave yet');
  }
}

function trySave() {
  if (_dirty && state.autosaveEnabled) {
    var elapsed = Date.now() - _dirtyTime;
    if (elapsed >= AUTOSAVE_INTERVAL) {
      saveAutosave();
    }
  }
}

async function findLatestAutosave() {
  const root = await navigator.storage.getDirectory();
  var best = null;
  var bestTime = 0;
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'file') continue;
    if (!name.startsWith('autosave') || !name.endsWith('.svg')) continue;
    var file = await handle.getFile();
    var t = file.lastModified || 0;
    if (t > bestTime) { bestTime = t; best = { name, file }; }
  }
  return best;
}

export async function loadAutosave() {
  try {
    var found = await findLatestAutosave();
    if (!found) return;
    var svgText = await found.file.text();
    if (svgText) {
      openSVGProject(svgText);
      var recovered = found.name;
      if (recovered === 'autosave.svg') {
        state.filename = 'annotation.svg';
      } else {
        state.filename = recovered.replace(/^autosave-/, '');
      }
      updateFilenameDisplay();
      _dirty = false;
      _lastAutosaveTime = found.file.lastModified || Date.now();
      updateAutosaveDisplay();
    }
  } catch {}
}

export function markDirty() {
  _dirty = true;
  _dirtyTime = Date.now();
}

export function initAutosave() {
  document.addEventListener('editor-dirty', function(e) {
    _dirty = true;
    _dirtyTime = (e.detail && e.detail.timestamp) || Date.now();
  });

  document.addEventListener('delete-autosave', function() {
    deleteAutosave();
  });

  document.addEventListener('file-renamed', function(e) {
    var oldName = e.detail.oldName;
    var newName = e.detail.newName;
    if (oldName !== newName) {
      var oldBase = oldName.replace(/\.svg$/i, '');
      deleteAutosave('autosave-' + oldBase + '.svg');
      markDirty();
      trySave();
    }
  });

  _autosaveIntervalId = setInterval(function() {
    trySave();
    updateAutosaveDisplay();
  }, CHECK_INTERVAL);

  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
      trySave();
    }
  });

  updateAutosaveDisplay();
}

export function stopAutosave() {
  if (_autosaveIntervalId) {
    clearInterval(_autosaveIntervalId);
    _autosaveIntervalId = null;
  }
}
