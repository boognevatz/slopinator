import { generateSVGString, openSVGProject, updateFilenameDisplay } from './fileio.js';
import { state } from './editor.js';

const AUTOSAVE_FILE = 'autosave.svg';
const AUTOSAVE_INTERVAL = 5 * 60 * 1000;
const BASE_TITLE = document.title || 'Slopinator';

let _dirty = false;
let _intervalId = null;

async function getFileHandle(create) {
  const root = await navigator.storage.getDirectory();
  return root.getFileHandle(AUTOSAVE_FILE, { create });
}

export async function saveToOPFS(data) {
  const handle = await getFileHandle(true);
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
  _dirty = false;
}

export async function loadFromOPFS() {
  const handle = await getFileHandle(false);
  const file = await handle.getFile();
  return await file.text();
}

export async function deleteAutosave() {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(AUTOSAVE_FILE).catch(function() {});
}

export async function saveAutosave(showFeedback) {
  var svg = generateSVGString();
  if (!svg) {
    if (showFeedback) showNotification('Save failed: no image loaded', true);
    return;
  }
  try {
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

export async function loadAutosave() {
  try {
    var svgText = await loadFromOPFS();
    if (svgText) {
      openSVGProject(svgText);
      state.filename = 'autosave.svg';
      updateFilenameDisplay();
      _dirty = false;
    }
  } catch {}
}

export function markDirty() {
  _dirty = true;
}

export function initAutosave() {
  document.addEventListener('editor-dirty', function() {
    _dirty = true;
  });

  document.addEventListener('delete-autosave', function() {
    deleteAutosave();
  });

  _intervalId = setInterval(function() {
    if (_dirty && state.autosaveEnabled) {
      saveAutosave();
    }
  }, AUTOSAVE_INTERVAL);
}

export function stopAutosave() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
}
