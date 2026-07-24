// ── File I/O module: Open, Save SVG, Export JPG ────────────────

import { state, dom, loadImage, restoreState, getViewBoxDims, showLoading, hideLoading } from './editor.js';
import { addLineElement, getLineDecorationsSvg, normalizeLineStyle, normalizeLineMarkerSize, normalizeLineDecoration } from './line.js';
import { addTextElement } from './text.js';
import { addFreehandElement } from './freehand.js';
import { addRectangleElement } from './rectangle.js';
import { clearHistory } from './history.js';

const BASE_TITLE = document.title || 'Slopinator';
import { refreshPalette } from './palette.js';
import { downloadString, downloadBlob, generateId } from './utils.js';
import { savePreference, loadPreference } from './settings.js';
import { switchTool } from './tools.js';
import { isLayerVisible, updateWatermark, renderLayerList, selectLayer, setLayerOrder, setUserLayerCounter } from './layers.js';
import { captureAllElementsState, captureElementState } from './dom-utils.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Export temp file store (OPFS + in-memory fallback) ──
const _tmpFiles = new Map();

async function _tmpWrite(name, data) {
  try {
    const root = await navigator.storage.getDirectory();
    const w = await (await root.getFileHandle(name, { create: true })).createWritable();
    await w.write(data);
    await w.close();
    return true;
  } catch {
    _tmpFiles.set(name, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
    return false;
  }
}

async function _tmpReadBlob(name) {
  try {
    return await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile();
  } catch {}
  const d = _tmpFiles.get(name);
  return d ? new Blob([d]) : null;
}

async function _tmpReadBytes(name) {
  try {
    var file = await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {}
  return _tmpFiles.get(name) || null;
}

async function _tmpRemove(name) {
  try { (await navigator.storage.getDirectory()).removeEntry(name).catch(()=>{}); } catch {}
  _tmpFiles.delete(name);
}

async function _tmpCleanup(names) {
  for (const n of names) await _tmpRemove(n);
}

async function _tmpCreateWriter(name) {
  var opfsWriter, fallbackChunks = [];
  try {
    const root = await navigator.storage.getDirectory();
    opfsWriter = await (await root.getFileHandle(name, { create: true })).createWritable();
  } catch {}
  return {
    write: async function(data) {
      if (opfsWriter) await opfsWriter.write(data);
      else fallbackChunks.push(data instanceof Uint8Array ? data : new TextEncoder().encode(data));
    },
    close: async function() {
      if (opfsWriter) await opfsWriter.close();
      else {
        var totalLen = 0;
        for (var i = 0; i < fallbackChunks.length; i++) totalLen += fallbackChunks[i].length;
        var out = new Uint8Array(totalLen);
        var off = 0;
        for (var i = 0; i < fallbackChunks.length; i++) { out.set(fallbackChunks[i], off); off += fallbackChunks[i].length; }
        _tmpFiles.set(name, out);
      }
    }
  };
}

var _exportStartTime = 0;
var _exportProgressText = '';
var _exportCloseHandler = null;

function _renderProgress(bar, span) {
  if (!_exportStartTime) { span.textContent = _exportProgressText; return; }
  var elapsed = Math.floor((Date.now() - _exportStartTime) / 1000);
  var min = Math.floor(elapsed / 60);
  var sec = elapsed % 60;
  var timeStr = min > 0 ? min + 'm ' + sec + 's' : sec + 's';
  span.textContent = _exportProgressText + ' [' + timeStr + ']';
}

function showExportProgress(text) {
  _exportStartTime = Date.now();
  _exportProgressText = text;
  var bar = document.getElementById('resize-notification');
  if (!bar) return;
  for (var ci = 0; ci < bar.children.length; ci++)
    if (bar.children[ci].tagName === 'BUTTON') bar.children[ci].style.display = 'none';
  var span = bar.querySelector('span');
  if (span) _renderProgress(bar, span);
  bar.hidden = false;
}

function updateExportProgress(text) {
  _exportProgressText = text;
  var bar = document.getElementById('resize-notification');
  if (!bar) return;
  var span = bar.querySelector('span');
  if (span) _renderProgress(bar, span);
}

function hideExportProgress() {
  if (_exportCloseHandler) {
    var cb = document.getElementById('btn-close-notification');
    if (cb) cb.removeEventListener('click', _exportCloseHandler);
    _exportCloseHandler = null;
  }
  _exportStartTime = 0;
  _exportProgressText = '';
  var bar = document.getElementById('resize-notification');
  if (!bar) return;
  bar.hidden = true;
  for (var ci = 0; ci < bar.children.length; ci++)
    if (bar.children[ci].tagName === 'BUTTON') bar.children[ci].style.display = '';
  var span = bar.querySelector('span');
  if (span) span.textContent = 'Image is very large. Resize to:';
}

async function showExportDone() {
  var bar = document.getElementById('resize-notification');
  if (!bar) return;
  var span = bar.querySelector('span');
  if (!span) return;

  var elapsed = Math.floor((Date.now() - _exportStartTime) / 1000);
  var min = Math.floor(elapsed / 60);
  var sec = elapsed % 60;
  var timeStr = min > 0 ? min + 'm ' + sec + 's' : sec + 's';

  // Reuse the existing close button from the HTML
  var closeBtn = document.getElementById('btn-close-notification');
  closeBtn.style.display = ''; // show it (overrides display:none from showExportProgress)

  var done = false;
  _exportCloseHandler = function() {
    done = true;
    hideExportProgress();
  };
  closeBtn.addEventListener('click', _exportCloseHandler);

  for (var c = 5; c > 0; c--) {
    if (done) return;
    if (span) span.textContent = 'Done! [' + timeStr + ']  (auto-close in ' + c + ')';
    await sleep(1000);
  }

  if (!done) hideExportProgress();
}

export function initFileIO() {
  const fileInput = document.getElementById('file-input');
  const btnOpen = document.getElementById('btn-open');
  const btnOpenEmpty = document.getElementById('btn-open-empty');
  const btnSaveSvg = document.getElementById('btn-save-svg');
  const btnFileDropdown = document.getElementById('btn-file-dropdown-btn');
  const fileMenu = document.getElementById('file-menu');
  const exportMenu = document.getElementById('export-menu');
  const exportFilename = document.getElementById('export-filename');
  const tabJpg = document.getElementById('export-tab-jpg');
  const tabPdf = document.getElementById('export-tab-pdf');
  const jpgOptions = document.getElementById('export-jpg-options');
  const pdfOptions = document.getElementById('export-pdf-options');
  const exportPdfSizeSelect = document.getElementById('export-pdf-size-select');
  const exportSizeSelect = document.getElementById('export-size-select');
  const exportPdfResSelect = document.getElementById('export-pdf-res-select');
  const btnExportDo = document.getElementById('btn-export-do');
  const resizeNotification = document.getElementById('resize-notification');

  let currentFormat = 'jpg';

  // Margin unit switching
  var currentMarginUnit = 'mm';
  const marginIds = ['export-margin-top', 'export-margin-right', 'export-margin-bottom', 'export-margin-left'];
  const unitToMm = { mm: 1, cm: 10, pt: 25.4 / 72, in: 25.4 };
  document.getElementById('margin-unit-select').addEventListener('change', function() {
    var newUnit = this.value;
    var toMm = unitToMm[currentMarginUnit];
    var fromMm = 1 / unitToMm[newUnit];
    for (var i = 0; i < marginIds.length; i++) {
      var el = document.getElementById(marginIds[i]);
      var valMm = parseFloat(el.value) || 0;
      el.value = Math.round(valMm * fromMm * 100) / 100;
    }
    currentMarginUnit = newUnit;
    document.querySelectorAll('.margin-unit-label').forEach(function(el) { el.textContent = newUnit; });
    redrawPageBox();
  });

  // Margin persistence
  const marginKeys = ['exportPdfMarginTop', 'exportPdfMarginRight', 'exportPdfMarginBottom', 'exportPdfMarginLeft'];
  function saveMarginPrefs() {
    var unit = document.getElementById('margin-unit-select').value;
    var toMm = unitToMm[unit];
    for (var i = 0; i < marginIds.length; i++) {
      var val = parseFloat(document.getElementById(marginIds[i]).value) || 0;
      savePreference(marginKeys[i], val * toMm);
    }
  }
  function loadMarginPrefs() {
    var unit = document.getElementById('margin-unit-select').value;
    var fromMm = 1 / unitToMm[unit];
    for (var i = 0; i < marginIds.length; i++) {
      var valMm = loadPreference(marginKeys[i]);
      if (valMm != null) {
        document.getElementById(marginIds[i]).value = Math.round(valMm * fromMm * 100) / 100;
      }
    }
  }
  loadMarginPrefs();

  // Page box canvas rendering — select sits at bottom below canvas
  var a4W = 210, a4H = 297, pad = 8, selectH = 22;
  var toMm = { mm: 1, cm: 10, pt: 25.4 / 72, in: 25.4 };
  function updatePageBox() {
    var box = document.getElementById('pdf-page-box');
    var canvas = document.getElementById('pdf-page-canvas');
    var size = exportPdfSizeSelect.value;
    var cw, ch;
    if (size === 'A4-landscape') { cw = 240; ch = Math.round(240 * a4W / a4H); }
    else if (size === 'A4-portrait') { cw = 170; ch = Math.round(170 * a4H / a4W); }
    else {
      if (state.hasImage && state.image.naturalWidth > 0 && state.image.naturalHeight > 0) {
        var iw = state.image.naturalWidth, ih = state.image.naturalHeight;
        var maxW = 220, maxH = 180, sc = Math.min(maxW / iw, maxH / ih, 1);
        cw = Math.max(80, Math.round(iw * sc)); ch = Math.max(60, Math.round(ih * sc));
      } else { cw = 200; ch = 140; }
    }
    canvas.width = cw; canvas.height = ch;
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    box.style.width = cw + 'px'; box.style.height = ch + 'px';
    redrawPageBox();
  }

  function redrawPageBox() {
    var canvas = document.getElementById('pdf-page-canvas');
    var ctx = canvas.getContext('2d');
    var cw = canvas.width, ch = canvas.height;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch);

    var size = exportPdfSizeSelect.value;
    var unit = document.getElementById('margin-unit-select').value;
    var ml = (parseFloat(document.getElementById('export-margin-left').value) || 0) * toMm[unit];
    var mt = (parseFloat(document.getElementById('export-margin-top').value) || 0) * toMm[unit];
    var mr = (parseFloat(document.getElementById('export-margin-right').value) || 0) * toMm[unit];
    var mb = (parseFloat(document.getElementById('export-margin-bottom').value) || 0) * toMm[unit];

    if (size === 'fit') {
      ctx.strokeStyle = '#666'; ctx.lineWidth = 1;
      ctx.strokeRect(pad, pad, cw - pad * 2, ch - pad * 2);
      return;
    }

    var pageW = size === 'A4-landscape' ? a4H : a4W;
    var pageH = size === 'A4-landscape' ? a4W : a4H;
    var sc = Math.min((cw - pad * 2) / pageW, (ch - pad * 2) / pageH);
    var pw = pageW * sc, ph = pageH * sc;
    var px = (cw - pw) / 2, py = (ch - ph) / 2;

    var innerX = px + ml * sc, innerY = py + mt * sc;
    var innerW = pw - (ml + mr) * sc, innerH = ph - (mt + mb) * sc;

    if (ml > 0 || mr > 0 || mt > 0 || mb > 0) {
      ctx.save(); ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#4a9eff'; ctx.lineWidth = 1.5;
      if (mt > 0) { ctx.beginPath(); ctx.moveTo(px, innerY); ctx.lineTo(px + pw, innerY); ctx.stroke(); }
      if (mr > 0) { ctx.beginPath(); ctx.moveTo(innerX + innerW, py); ctx.lineTo(innerX + innerW, py + ph); ctx.stroke(); }
      if (mb > 0) { ctx.beginPath(); ctx.moveTo(px, innerY + innerH); ctx.lineTo(px + pw, innerY + innerH); ctx.stroke(); }
      if (ml > 0) { ctx.beginPath(); ctx.moveTo(innerX, py); ctx.lineTo(innerX, py + ph); ctx.stroke(); }
      ctx.restore();
    }
  }

  // Wire up page box events
  exportPdfSizeSelect.addEventListener('change', updatePageBox);
  for (var i = 0; i < marginIds.length; i++) {
    (function(id) { document.getElementById(id).addEventListener('input', redrawPageBox); })(marginIds[i]);
  }
  setTimeout(updatePageBox, 0);

  btnOpen.addEventListener('click', () => fileInput.click());
  btnOpenEmpty.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    handleFileOpen(file);
    fileInput.value = ''; // reset so same file can be re-opened
  });

  btnSaveSvg.addEventListener('click', saveSVG);

  // ── Filename rename UI ──────────────────────────────────
  var _cancelFilenameRename = null;
  _setupFilenameRename();

  function _setupFilenameRename() {
    var currentFilenameSpan = document.getElementById('current-filename');
    var filenameInput = document.getElementById('filename-input');
    var filenameActions = document.getElementById('filename-actions');
    var btnFilenameSave = document.getElementById('btn-filename-save');
    var btnFilenameCancel = document.getElementById('btn-filename-cancel');
    var _originalFilename = '';
    const BORDER_DEFAULT = '#444';

    function enterRenameMode() {
      _originalFilename = state.filename;
      filenameInput.value = state.filename.replace(/\.svg$/i, '');
      filenameInput.style.borderColor = BORDER_DEFAULT;
      currentFilenameSpan.hidden = true;
      filenameInput.hidden = false;
      filenameActions.style.display = 'flex';
      filenameActions.hidden = false;
      btnFilenameSave.disabled = true;
      btnFilenameCancel.disabled = true;
      filenameInput.focus();
      filenameInput.select();
    }

    function exitRenameMode(cancel) {
      var oldName = state.filename;
      if (!cancel) {
        var val = filenameInput.value.trim();
        if (val) state.filename = val.replace(/\.svg$/i, '') + '.svg';
      }
      filenameInput.hidden = true;
      filenameActions.style.display = '';
      filenameActions.hidden = true;
      currentFilenameSpan.hidden = false;
      updateFilenameDisplay();
      if (!cancel && state.filename !== oldName) {
        document.dispatchEvent(new CustomEvent('file-renamed', {
          detail: { oldName, newName: state.filename }
        }));
      }
    }

    function syncFilenameButtons() {
      var origBase = _originalFilename.replace(/\.svg$/i, '');
      var isDiff = (filenameInput.value !== origBase);
      filenameInput.style.borderColor = isDiff ? 'var(--color-accent)' : BORDER_DEFAULT;
      btnFilenameSave.disabled = !isDiff;
      btnFilenameCancel.disabled = !isDiff;
    }

    _cancelFilenameRename = function() {
      if (filenameInput.hidden) return;
      state.filename = _originalFilename;
      updateFilenameDisplay();
      filenameInput.hidden = true;
      filenameActions.style.display = '';
      filenameActions.hidden = true;
      currentFilenameSpan.hidden = false;
    };

    currentFilenameSpan.onclick = function(e) { e.stopPropagation(); enterRenameMode(); };
    btnFilenameSave.onclick = function(e) { e.stopPropagation(); exitRenameMode(false); };
    btnFilenameCancel.onclick = function(e) { e.stopPropagation(); exitRenameMode(true); };
    filenameInput.onkeydown = function(e) {
      if (e.key === 'Enter') { e.preventDefault(); exitRenameMode(false); return; }
      if (e.key === 'Escape') { exitRenameMode(true); return; }
      setTimeout(syncFilenameButtons, 0);
      e.stopPropagation();
    };
    filenameInput.oninput = function() {
      this.value = this.value.replace(/[^0-9a-zA-Z_-]/g, '');
      syncFilenameButtons();
    };
    filenameInput.onclick = function(e) { e.stopPropagation(); };
  }

  updateFilenameDisplay();

  function createNewImage(w, h) {
    state.filename = 'annotation.svg';
    if (_cancelFilenameRename) _cancelFilenameRename();
    fileMenu.hidden = true;
    dom.annotationLayer.innerHTML = '';
    dom.handleLayer.innerHTML = '';
    state.selectedId = null;
    clearHistory();

    // Create a blank white image
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);
    const dataURI = canvas.toDataURL('image/png');
    loadImage(dataURI, w, h);
    switchTool('select');
    updateFilenameDisplay();
  }

  document.getElementById('btn-new-create').addEventListener('click', (e) => {
    e.stopPropagation();
    if (_cancelFilenameRename) _cancelFilenameRename();
    fileMenu.hidden = true;
    var w = parseInt(document.getElementById('new-width').value) || 640;
    var h = parseInt(document.getElementById('new-height').value) || 480;
    createNewImage(w, h);
  });

  document.getElementById('btn-new-create-empty').addEventListener('click', () => {
    var w = parseInt(document.getElementById('new-width-empty').value) || 640;
    var h = parseInt(document.getElementById('new-height-empty').value) || 480;
    createNewImage(w, h);
  });

  // About button
  const btnAbout = document.getElementById('btn-about');
  const aboutPopup = document.getElementById('about-popup');
  btnAbout.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_cancelFilenameRename) _cancelFilenameRename();
    fileMenu.hidden = true;
    aboutPopup.hidden = false;
  });
  document.getElementById('btn-about-close').addEventListener('click', () => {
    aboutPopup.hidden = true;
  });
  aboutPopup.addEventListener('click', (e) => {
    if (e.target === aboutPopup) aboutPopup.hidden = true;
  });

  function activateTab(format) {
    currentFormat = format;
    tabJpg.classList.toggle('active', format === 'jpg');
    tabPdf.classList.toggle('active', format === 'pdf');
    jpgOptions.hidden = format !== 'jpg';
    pdfOptions.hidden = format !== 'pdf';
  }

  tabJpg.addEventListener('click', (e) => { e.stopPropagation(); activateTab('jpg'); });
  tabPdf.addEventListener('click', (e) => { e.stopPropagation(); activateTab('pdf'); });

  // File dropdown toggle
  function positionDropdown(menu, btn) {
    if (window.innerWidth < 768) {
      // CSS handles positioning via position: fixed media query
      menu.style.position = '';
      menu.style.top = '';
      menu.style.left = '';
    } else {
      menu.style.position = '';
      menu.style.top = '';
      menu.style.left = '';
    }
  }
  btnFileDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_cancelFilenameRename) _cancelFilenameRename();
    fileMenu.hidden = !fileMenu.hidden;
    if (!fileMenu.hidden) {
      activateTab(currentFormat);
      positionDropdown(fileMenu, btnFileDropdown);
    }
  });

  // Nested export dropdown toggle
  const exportNestedBtn = document.getElementById('btn-export-nested-btn');
  const exportNested = document.getElementById('export-nested');
  exportNestedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.hidden = !exportMenu.hidden;
    if (!exportMenu.hidden) activateTab(currentFormat);
  });

  fileMenu.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.addEventListener('click', () => {
    if (_cancelFilenameRename) _cancelFilenameRename();
    fileMenu.hidden = true;
    exportMenu.hidden = true;
  });

  btnExportDo.addEventListener('click', (e) => {
    e.stopPropagation();
    doExport();
  });

  exportFilename.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doExport();
    }
  });

  function doExport() {
    if (_cancelFilenameRename) _cancelFilenameRename();
    fileMenu.hidden = true;
    saveMarginPrefs();
    if (currentFormat === 'pdf') {
      const pageSize = exportPdfSizeSelect.value;
      const res = exportPdfResSelect.value;
      exportPDF(res, pageSize).catch(err => { console.error(err); hideExportProgress(); });
    } else {
      const width = exportSizeSelect.value;
      exportJPG(width).catch(err => { console.error(err); hideExportProgress(); });
    }
  }

  // Resize notification logic
  document.getElementById('btn-close-notification').addEventListener('click', () => {
    resizeNotification.hidden = true;
  });

  resizeNotification.querySelectorAll('button[data-width]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const widthOpt = e.target.dataset.width;
      resizeNotification.hidden = true;
      if (widthOpt !== 'original') {
        var targetW = parseInt(widthOpt);
        var ratio = targetW / state.image.naturalWidth;
        var targetH = Math.round(state.image.naturalHeight * ratio);
        resizeImage(targetW, targetH);
      }
    });
  });

  // Expose test PDF generator for console debugging
  window.buildTestPdf = buildTestPdf;
  document.getElementById('btn-test-pdf').addEventListener('click', buildTestPdf);
  document.getElementById('btn-test-pdf-img').addEventListener('click', buildTestPdfWithImage);

  // Hide notification on any tool usage
  document.getElementById('editor-svg').addEventListener('pointerdown', () => {
    resizeNotification.hidden = true;
  }, { capture: true });

  // ── Resize dropdown + DPI (combined popup) ──────────────
  const sizeLabel = document.getElementById('image-size-label');
  const resizeMenu = document.getElementById('resize-menu');
  const resizeW = document.getElementById('resize-width-input');
  const resizeH = document.getElementById('resize-height-input');
  const resizeRatioRadios = document.querySelectorAll('input[name="resize-ratio"]');
  const btnResizeApply = document.getElementById('btn-resize-apply');
  const dpiInput = document.getElementById('dpi-input');
  let lastResizeInput = 'width';

  function getResizeRatio() {
    for (const r of resizeRatioRadios) {
      if (r.checked) return r.value;
    }
    return 'free';
  }

  function getAspectRatioValue() {
    const mode = getResizeRatio();
    const ow = state.image.naturalWidth;
    const oh = state.image.naturalHeight;
    if (mode === 'aspect') return ow / oh;
    if (mode === '4:3') return 4 / 3;
    if (mode === '16:9') return 16 / 9;
    return null;
  }

  function applyAspectRatio(changed) {
    const ratio = getAspectRatioValue();
    if (ratio === null) return;
    if (changed === 'width') {
      const w = parseFloat(resizeW.value);
      if (!isNaN(w) && w > 0) resizeH.value = Math.round(w / ratio);
    } else {
      const h = parseFloat(resizeH.value);
      if (!isNaN(h) && h > 0) resizeW.value = Math.round(h * ratio);
    }
  }

  function openResizePopup() {
    if (!state.hasImage) return;
    const dims = getViewBoxDims();
    resizeW.value = Math.round(dims.width);
    resizeH.value = Math.round(dims.height);
    dpiInput.value = state.image.dpi;
    resizeMenu.hidden = !resizeMenu.hidden;
    if (!resizeMenu.hidden) { resizeW.focus(); resizeW.select(); }
  }

  sizeLabel.addEventListener('click', (e) => {
    e.stopPropagation();
    openResizePopup();
  });

  document.getElementById('dpi-display').addEventListener('click', (e) => {
    e.stopPropagation();
    openResizePopup();
  });

  resizeW.addEventListener('focus', () => { lastResizeInput = 'width'; });
  resizeH.addEventListener('focus', () => { lastResizeInput = 'height'; });
  resizeW.addEventListener('input', () => applyAspectRatio('width'));
  resizeH.addEventListener('input', () => applyAspectRatio('height'));
  resizeRatioRadios.forEach(r => r.addEventListener('change', () => {
    applyAspectRatio(lastResizeInput);
  }));

  document.addEventListener('click', (e) => {
    if (!resizeMenu.hidden && !e.target.closest('#resize-dropdown')) {
      resizeMenu.hidden = true;
    }
  });

  function saveDpi() {
    var v = parseInt(dpiInput.value);
    if (!isNaN(v) && v > 0) {
      state.image.dpi = v;
      document.getElementById('dpi-display').textContent = v + ' DPI';
      document.dispatchEvent(new CustomEvent('dpi-changed'));
    }
    resizeMenu.hidden = true;
  }

  function doApplyResize() {
    const w = parseInt(resizeW.value);
    const h = parseInt(resizeH.value);
    if (isNaN(w) || isNaN(h) || w < 1 || h < 1) return;
    resizeMenu.hidden = true;
    var dims = getViewBoxDims();
    if (w !== Math.round(dims.width) || h !== Math.round(dims.height)) {
      resizeImage(w, h);
    }
  }

  btnResizeApply.addEventListener('click', doApplyResize);
  dpiInput.addEventListener('change', saveDpi);
  dpiInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveDpi(); } });
  resizeW.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doApplyResize(); } });
  resizeH.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doApplyResize(); } });

  document.addEventListener('image-loaded', recalcDpi);
  document.addEventListener('selection-changed', recalcDpi);
  recalcDpi();
}

// ── Open File ───────────────────────────────────────────────────

function handleFileOpen(file) {
  const isSVG = file.name.toLowerCase().endsWith('.svg');

  state.filename = file.name;
  // updateFilenameDisplay is called at the end of the load, so we let the load settle first
  var filenameDisplay = document.getElementById('current-filename');
  if (filenameDisplay) filenameDisplay.textContent = file.name;

  if (isSVG) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const svgText = e.target.result;
      openSVGProject(svgText);
      updateFilenameDisplay();
    };
    reader.readAsText(file);
  } else {
    openImageFile(file);
  }
}

export function updateFilenameDisplay() {
  var span = document.getElementById('current-filename');
  if (span) span.textContent = state.filename;
  document.title = BASE_TITLE + ' - ' + state.filename;
  var exportEl = document.getElementById('export-filename');
  if (exportEl) exportEl.value = state.filename;
}

function openImageFile(file) {
  showLoading();
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataURI = e.target.result;
    const img = new Image();
    img.onload = () => {
      loadImage(dataURI, img.naturalWidth, img.naturalHeight);
      clearHistory();
      switchTool('select');
      updateWatermark();
      
      const maxDim = Math.max(img.naturalWidth, img.naturalHeight);
      const resizeNotification = document.getElementById('resize-notification');
      if (maxDim > 1000) {
        resizeNotification.hidden = false;
      } else {
        resizeNotification.hidden = true;
      }
      updateFilenameDisplay();
    };
    img.onerror = () => {
      alert('Failed to load image.');
    };
    img.src = dataURI;
  };
  reader.readAsDataURL(file);
}

// ── Resize Original Image ───────────────────────────────────────

function resizeImage(newWidth, newHeight) {
  if (!state.hasImage) return;
  newWidth = Math.round(newWidth);
  newHeight = Math.round(newHeight);
  if (newWidth < 1 || newHeight < 1) return;

  const dims = getViewBoxDims();
  const scaleX = newWidth / dims.width;
  const scaleY = newHeight / dims.height;
  const uniformScale = Math.min(scaleX, scaleY);

  // Save and scale elements before loadImage destroys them
  var allEls = captureAllElementsState();
  const savedElements = allEls.map(el => {
    if (el.type === 'line') {
      return {
        ...el,
        x1: Math.round(el.x1 * scaleX),
        y1: Math.round(el.y1 * scaleY),
        x2: Math.round(el.x2 * scaleX),
        y2: Math.round(el.y2 * scaleY),
        lineMarkerSize: el.lineMarkerSize ? Math.round(el.lineMarkerSize * uniformScale) : el.lineMarkerSize,
        startDecorationSize: el.startDecorationSize ? Math.round(el.startDecorationSize * uniformScale) : undefined,
        endDecorationSize: el.endDecorationSize ? Math.round(el.endDecorationSize * uniformScale) : undefined,
      };
    } else if (el.type === 'text') {
      return {
        ...el,
        x: Math.round(el.x * scaleX),
        y: Math.round(el.y * scaleY),
        fontSize: Math.round(el.fontSize * uniformScale),
        strokeWidth: Math.round((el.strokeWidth || 0) * uniformScale),
      };
    } else if (el.type === 'rectangle') {
      return {
        ...el,
        x: Math.round(el.x * scaleX),
        y: Math.round(el.y * scaleY),
        width: Math.round(el.width * scaleX),
        height: Math.round(el.height * scaleY),
        rx: Math.round((el.rx || 0) * uniformScale),
      };
    }
    return el;
  });

  const rot = state.image.rotation;
  const isRotated = rot === 90 || rot === 270;
  const newNatW = isRotated ? newHeight : newWidth;
  const newNatH = isRotated ? newWidth : newHeight;

  const imgEl = new Image();
  imgEl.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = newNatW;
    canvas.height = newNatH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, newNatW, newNatH);
    const newDataURI = canvas.toDataURL('image/jpeg', 0.92);

    loadImage(newDataURI, newNatW, newNatH);

    for (const el of savedElements) {
      if (el.type === 'line') {
        addLineElement(el);
      } else if (el.type === 'text') {
        addTextElement(el);
      } else if (el.type === 'rectangle') {
        addRectangleElement(el);
      }
    }

    clearHistory();
    switchTool('select');
    updateWatermark();
  };
  imgEl.src = state.image.dataURI;
}

// ── Open SVG Project ────────────────────────────────────────────

export function openSVGProject(svgText) {
  showLoading();
  if (!state.filename) state.filename = 'annotation.svg';
  // Check if it's our annotator project file
  if (!svgText.includes('data-annotator-version')) {
    // Treat as a plain image — embed as data URI
    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      // Convert to canvas then to data URI (to rasterize)
    var canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || 800;
      canvas.height = img.naturalHeight || 600;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const dataURI = canvas.toDataURL('image/png');
      loadImage(dataURI, canvas.width, canvas.height);
      clearHistory();
      switchTool('select');
      updateWatermark();
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      alert('Failed to load SVG as image.');
      URL.revokeObjectURL(url);
      hideLoading();
    };
    img.src = url;
    return;
  }

  // Defer parsing to next task so the browser paints the loading bar first
  setTimeout(() => _openAnnotatorProject(svgText), 0);
}

function _openAnnotatorProject(svgText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');
  const svgRoot = doc.documentElement;

  // Parse image
  const imgEl = svgRoot.querySelector('image[data-type="background"]');
  if (!imgEl) {
    var existingDlg = document.getElementById('no-image-dialog');
    if (existingDlg) existingDlg.remove();
    var dlg = document.createElement('div');
    dlg.id = 'no-image-dialog';
    dlg.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000;';
    var box = document.createElement('div');
    box.style.cssText = 'background:var(--color-bg);border:1px solid var(--color-border);border-radius:6px;padding:20px 24px;min-width:300px;color:var(--color-text);font-size:14px;';
    box.innerHTML = '<p style="margin:0 0 12px 0;"><strong>No background image found in SVG project.</strong></p><p style="margin:0 0 16px 0;font-size:13px;color:var(--color-text-muted);">The file might be corrupted or was saved without an image.</p>';
    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    var btnOk = document.createElement('button');
    btnOk.textContent = 'OK';
    btnOk.style.cssText = 'padding:4px 14px;font-size:12px;';
    var btnDelete = document.createElement('button');
    btnDelete.textContent = 'Delete broken autosaved project file';
    btnDelete.style.cssText = 'padding:4px 14px;font-size:12px;background:#c0392b;color:#fff;border-color:#c0392b;';
    btnDelete.addEventListener('click', function() {
      document.dispatchEvent(new CustomEvent('delete-autosave'));
      dlg.remove();
    });
    btnOk.addEventListener('click', function() { dlg.remove(); });
    btnRow.appendChild(btnDelete);
    btnRow.appendChild(btnOk);
    box.appendChild(btnRow);
    dlg.appendChild(box);
    document.body.appendChild(dlg);
    hideLoading();
    return;
  }

  const dataURI = imgEl.getAttribute('href') || imgEl.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
  const naturalWidth = parseFloat(imgEl.getAttribute('width'));
  const naturalHeight = parseFloat(imgEl.getAttribute('height'));

  // Parse transform to extract rotation and flip
  const transform = imgEl.getAttribute('transform') || '';
  let rotation = 0;
  let flipH = false;
  let flipV = false;

  const rotateMatch = transform.match(/rotate\((\d+)\)/);
  if (rotateMatch) rotation = parseInt(rotateMatch[1]);

  // Check for scale(-1, 1) → flipH, scale(1, -1) → flipV
  const scaleMatches = [...transform.matchAll(/scale\(([-\d.]+),\s*([-\d.]+)\)/g)];
  for (const m of scaleMatches) {
    if (parseFloat(m[1]) === -1 && parseFloat(m[2]) === 1) flipH = true;
    if (parseFloat(m[1]) === 1 && parseFloat(m[2]) === -1) flipV = true;
  }

  // Parse palette from comments
  let palette = null;
  let thicknessPresets = null;
  let originCoordinate = null;

  const commentRegex = /<!--\s*annotator-palette:\s*(.+?)\s*-->/;
  const thicknessRegex = /<!--\s*annotator-thickness:\s*(.+?)\s*-->/
  const originRegex = /<!--\s*annotator-origin:\s*(.+?)\s*-->/;
  const dpiRegex = /<!--\s*annotator-dpi:\s*(\d+)\s*-->/;

  const paletteMatch = svgText.match(commentRegex);
  if (paletteMatch) {
    palette = paletteMatch[1].split(',').map(c => c.trim());
  }

  const thicknessMatch = svgText.match(thicknessRegex);
  if (thicknessMatch) {
    thicknessPresets = thicknessMatch[1].split(',').map(v => parseFloat(v.trim()));
  }

  const originMatch = svgText.match(originRegex);
  if (originMatch) {
    originCoordinate = originMatch[1].trim();
  }

  const dpiMatch = svgText.match(dpiRegex);
  let dpi = dpiMatch ? parseInt(dpiMatch[1]) : null;

  // Parse annotation elements
  const elements = [];

  // Parse lines
  svgRoot.querySelectorAll('g[data-type="line"]').forEach(g => {
    const line = g.querySelector('line.annotation-line');
    if (!line) return;
    const lineStyleAttr = line.getAttribute('data-line-style') || g.getAttribute('data-line-style') || '';
    const markerStart = line.getAttribute('marker-start') || '';
    const markerEnd = line.getAttribute('marker-end') || '';
    const inferredStyle = lineStyleAttr || (markerStart.includes('circle') ? 'circle' : (markerStart.includes('arrow') || markerEnd.includes('arrow') ? 'arrows' : 'normal'));
    const rawStartDecor = g.getAttribute('data-start-decoration') || '';
    const rawEndDecor = g.getAttribute('data-end-decoration') || '';
    const rawStartSize = g.getAttribute('data-start-decoration-size') || '';
    const rawEndSize = g.getAttribute('data-end-decoration-size') || '';
    elements.push({
      id: g.id,
      type: 'line',
      points: [
        { x: parseFloat(line.getAttribute('x1')), y: parseFloat(line.getAttribute('y1')) },
        { x: parseFloat(line.getAttribute('x2')), y: parseFloat(line.getAttribute('y2')) },
      ],
      x1: parseFloat(line.getAttribute('x1')),
      y1: parseFloat(line.getAttribute('y1')),
      x2: parseFloat(line.getAttribute('x2')),
      y2: parseFloat(line.getAttribute('y2')),
      stroke: line.getAttribute('stroke'),
      strokeWidth: parseFloat(line.getAttribute('stroke-width')),
      lineStyle: normalizeLineStyle(inferredStyle),
      lineMarkerSize: normalizeLineMarkerSize(g.getAttribute('data-line-marker-size') || line.getAttribute('data-line-marker-size') || 30),
      startDecoration: rawStartDecor ? normalizeLineDecoration(rawStartDecor) : undefined,
      endDecoration: rawEndDecor ? normalizeLineDecoration(rawEndDecor) : undefined,
      startDecorationSize: rawStartSize ? normalizeLineMarkerSize(rawStartSize) : undefined,
      endDecorationSize: rawEndSize ? normalizeLineMarkerSize(rawEndSize) : undefined,
    });
  });

  // Parse polyline/polygon lines (3+ points)
  function parsePolyPoints(p) {
    const ptsAttr = p.getAttribute('points') || '';
    return ptsAttr.trim().split(/\s+/).filter(Boolean).map(pair => {
      const [x, y] = pair.split(',').map(Number);
      return { x, y };
    });
  }
  svgRoot.querySelectorAll('polyline[data-type="line"], polygon[data-type="line"]').forEach(p => {
    const pts = parsePolyPoints(p);
    if (pts.length < 2) return;
    const closed = p.tagName === 'polygon' || p.getAttribute('data-closed') === 'true';
    elements.push({
      id: p.id || generateId(),
      type: 'line',
      points: pts,
      x1: pts[0].x, y1: pts[0].y,
      x2: pts[pts.length - 1].x, y2: pts[pts.length - 1].y,
      stroke: p.getAttribute('stroke') || '#ff0000',
      strokeWidth: parseFloat(p.getAttribute('stroke-width')) || 2,
      lineStyle: normalizeLineStyle(p.getAttribute('data-line-style') || 'normal'),
      lineMarkerSize: normalizeLineMarkerSize(p.getAttribute('data-line-marker-size') || 30),
      closed,
      fill: p.getAttribute('fill') || 'none',
    });
  });

  // Parse texts
  svgRoot.querySelectorAll('text[data-type="text"]').forEach(t => {
    let rotation = 0;
    const transform = t.getAttribute('transform');
    if (transform) {
      const match = transform.match(/rotate\(([-\d.]+)/);
      if (match) rotation = parseFloat(match[1]);
    }

    elements.push({
      id: t.id,
      type: 'text',
      x: parseFloat(t.getAttribute('x')),
      y: parseFloat(t.getAttribute('y')),
      content: t.textContent,
      fontSize: parseFloat(t.getAttribute('font-size')),
      fill: t.getAttribute('fill'),
      stroke: t.getAttribute('stroke') || 'none',
      strokeWidth: parseFloat(t.getAttribute('stroke-width')) || 0,
      rotation: rotation,
    });
  });

  // Parse freehand polylines
  svgRoot.querySelectorAll('polyline[data-type="freehand"]').forEach(p => {
    const ptsAttr = p.getAttribute('points') || '';
    const points = ptsAttr.trim().split(/\s+/).filter(Boolean).map(pair => {
      const [x, y] = pair.split(',').map(Number);
      return { x, y };
    });
    elements.push({
      id: p.id || generateId(),
      type: 'freehand',
      points,
      rawPoints: null,
      epsilon: parseFloat(p.getAttribute('data-epsilon')) || 3,
      stroke: p.getAttribute('stroke') || '#ff0000',
      strokeWidth: parseFloat(p.getAttribute('stroke-width')) || 2,
    });
  });

  // Parse rectangles
  svgRoot.querySelectorAll('rect[data-type="rectangle"]').forEach(r => {
    let rotation = 0;
    const transform = r.getAttribute('transform');
    if (transform) {
      const m = transform.match(/rotate\(([-\d.]+)/);
      if (m) rotation = parseFloat(m[1]);
    }
    elements.push({
      id: r.id || generateId(),
      type: 'rectangle',
      x: parseFloat(r.getAttribute('x')),
      y: parseFloat(r.getAttribute('y')),
      width: parseFloat(r.getAttribute('width')),
      height: parseFloat(r.getAttribute('height')),
      rx: parseFloat(r.getAttribute('rx')) || 0,
      rotation,
      stroke: r.getAttribute('stroke') || 'none',
      strokeWidth: parseFloat(r.getAttribute('stroke-width')) || 2,
      fill: r.getAttribute('fill') || 'transparent',
    });
  });

  // Parse group elements
  svgRoot.querySelectorAll('g[data-type="group"]').forEach(g => {
    var groupId = g.id;
    var childIds = [];
    g.querySelectorAll('[id]').forEach(child => {
      if (child.id && child.id !== groupId) childIds.push(child.id);
    });
    elements.push({ id: groupId, type: 'group', childIds });
  });

  // Set parentId on group children
  for (var gi = 0; gi < elements.length; gi++) {
    if (elements[gi].type === 'group') {
      for (var cj = 0; cj < elements[gi].childIds.length; cj++) {
        var cid = elements[gi].childIds[cj];
        var childEl = elements.find(function(e) { return e.id === cid; });
        if (childEl) childEl.parentId = elements[gi].id;
      }
    }
  }

  // ── Extract layer structure from parsed SVG ──
  var parsedLayers = [];
  for (var li = 0; li < svgRoot.children.length; li++) {
    var ch = svgRoot.children[li];
    if (ch.tagName === 'g' && ch.id) {
      var lid = ch.id;
      if (lid === 'layer-image' || lid === 'layer-watermark' || lid === 'layer-grid' || lid === 'handle-layer') continue;
      parsedLayers.push({
        id: lid,
        name: ch.getAttribute('data-layer-name') || lid,
        visibility: ch.getAttribute('visibility'),
      });
    }
  }
  if (parsedLayers.length === 0) {
    parsedLayers.push({ id: 'layer-annotation', name: 'Annotations', visibility: null });
  }

  // Assign elements to parsed layers via DOM parent walk
  for (var ei = 0; ei < elements.length; ei++) {
    var elData = elements[ei];
    var domEl = doc.getElementById(elData.id);
    if (domEl) {
      var p = domEl.parentNode;
      while (p && p.id && p.id !== 'layer-annotation' && !p.id.startsWith('layer-user-')) {
        p = p.parentNode;
      }
      if (p && p.id) {
        elData._layerId = p.id;
      }
    }
    if (!elData._layerId) {
      elData._layerId = 'layer-annotation';
    }
  }

  // Restore state
  const parsedElements = restoreState({
    dataURI,
    naturalWidth,
    naturalHeight,
    rotation,
    flipH,
    flipV,
    palette,
    originCoordinate,
    thicknessPresets,
    dpi,
    elements,
  });

  // ── Rebuild layer structures ──
  // Build new layerOrder: system layers + parsed user layers
  var newLayerOrder = [
    { id: 'layer-image', name: 'Image', system: true },
  ];
  for (var pli = 0; pli < parsedLayers.length; pli++) {
    newLayerOrder.push({
      id: parsedLayers[pli].id,
      name: parsedLayers[pli].name,
      system: false,
    });
  }
  newLayerOrder.push(
    { id: 'layer-watermark', name: 'Watermark', system: true },
    { id: 'layer-grid', name: 'Grid', system: true },
  );
  setLayerOrder(newLayerOrder);

  // Set userLayerCounter to prevent ID conflicts on new layers
  var maxUserNum = 1;
  for (var pli = 0; pli < parsedLayers.length; pli++) {
    var plid = parsedLayers[pli].id;
    if (plid.startsWith('layer-user-')) {
      var n = parseInt(plid.replace('layer-user-', ''), 10);
      if (n > maxUserNum) maxUserNum = n;
    }
  }
  setUserLayerCounter(maxUserNum);

  // Group parsed elements by layer
  var elsByLayer = {};
  for (var ei2 = 0; ei2 < parsedElements.length; ei2++) {
    var el2 = parsedElements[ei2];
    var lid2 = el2._layerId || 'layer-annotation';
    if (!elsByLayer[lid2]) elsByLayer[lid2] = [];
    elsByLayer[lid2].push(el2);
    delete el2._layerId; // clean up temp property
  }

  var wmG = document.getElementById('layer-watermark');

  // For each parsed layer (in order), create/clear <g> and insert before watermark
  for (var pli2 = 0; pli2 < parsedLayers.length; pli2++) {
    var pl = parsedLayers[pli2];
    var liveG = document.getElementById(pl.id);
    if (!liveG) {
      liveG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      liveG.setAttribute('id', pl.id);
    } else {
      liveG.innerHTML = '';
    }
    if (wmG && wmG.parentNode) {
      wmG.parentNode.insertBefore(liveG, wmG);
    }
  }

  // Recreate elements per layer
  for (var pli3 = 0; pli3 < parsedLayers.length; pli3++) {
    var pl3 = parsedLayers[pli3];
    var liveG = document.getElementById(pl3.id);
    if (!liveG) continue;

    // Set dom.annotationLayer to this layer's <g> so element creators use it
    dom.annotationLayer = liveG;

    var layerEls = elsByLayer[pl3.id] || [];

    // First pass: non-group elements
    for (var ei3 = 0; ei3 < layerEls.length; ei3++) {
      var el3 = layerEls[ei3];
      if (el3.type === 'group') continue;
      recreateElement(el3);
    }

    // Second pass: groups (move children inside group <g>)
    for (var gi3 = 0; gi3 < layerEls.length; gi3++) {
      var gData3 = layerEls[gi3];
      if (gData3.type !== 'group') continue;
      var gEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      gEl.id = gData3.id;
      gEl.setAttribute('data-type', 'group');
      for (var ci3 = 0; ci3 < gData3.childIds.length; ci3++) {
        var childDom = liveG.querySelector('#' + CSS.escape(gData3.childIds[ci3]));
        if (childDom) gEl.appendChild(childDom);
      }
      liveG.appendChild(gEl);
    }
  }

  // Restore visibility from parsed layer data
  for (var pli4 = 0; pli4 < parsedLayers.length; pli4++) {
    var pl4 = parsedLayers[pli4];
    var liveG4 = document.getElementById(pl4.id);
    if (!liveG4) continue;
    if (pl4.visibility === 'hidden') {
      liveG4.setAttribute('visibility', 'hidden');
    } else if (pl4.visibility) {
      liveG4.removeAttribute('visibility');
    }
  }
  // Restore visibility for system layers (image, watermark)
  var parsedImgG = doc.getElementById('layer-image');
  if (parsedImgG && parsedImgG.hasAttribute('visibility')) {
    if (parsedImgG.getAttribute('visibility') === 'hidden') {
      dom.imageLayer.setAttribute('visibility', 'hidden');
    } else {
      dom.imageLayer.removeAttribute('visibility');
    }
  }
  var parsedWmG = doc.getElementById('layer-watermark');
  if (parsedWmG && parsedWmG.hasAttribute('visibility')) {
    if (parsedWmG.getAttribute('visibility') === 'hidden') {
      dom.watermarkLayer.setAttribute('visibility', 'hidden');
    } else {
      dom.watermarkLayer.removeAttribute('visibility');
    }
  }
  renderLayerList();

  // Select first user layer
  var firstUser = null;
  for (var fi = 0; fi < parsedLayers.length; fi++) {
    if (parsedLayers[fi].id !== 'layer-annotation') {
      firstUser = parsedLayers[fi].id;
      break;
    }
  }
  selectLayer(firstUser || 'layer-annotation');

  // Transfer watermark pattern from parsed SVG to live editor
  var parsedPattern = doc.getElementById('watermark-pattern');
  if (parsedPattern) {
    var defs = dom.svg.querySelector('defs');
    if (defs && !document.getElementById('watermark-pattern')) {
      defs.appendChild(document.importNode(parsedPattern, true));
    }
  }

  clearHistory();
  refreshPalette();
  switchTool(state.defaultTool || 'select');
  updateWatermark();
  hideLoading();
}

// ── Export render helpers ────────────────────────────────────────

function getLayerElementIds(layerId) {
  var layerEl = document.getElementById(layerId);
  if (!layerEl) return new Set();
  var ids = new Set();
  layerEl.querySelectorAll('[id]').forEach(function(el) { ids.add(el.id); });
  return ids;
}

function serializeElement(el, withinGroup) {
  if (el.type === 'group') {
    var g = `<g id="${el.id}" data-type="group">\n`;
    var groupDom = document.getElementById(el.id);
    if (groupDom) {
      for (var ci = 0; ci < groupDom.children.length; ci++) {
        var childData = captureElementState(groupDom.children[ci].id);
        if (childData) g += serializeElement(childData, true);
      }
    }
    g += `</g>\n`;
    return g;
  }
  if (el.type === 'line') {
    const pts = el.points || [{x: el.x1, y: el.y1}, {x: el.x2, y: el.y2}];
    if (pts.length >= 3) {
      if (el.closed) {
        return `<polygon id="${el.id}" data-type="line" data-closed="true" data-line-style="${normalizeLineStyle(el.lineStyle)}" data-line-marker-size="${normalizeLineMarkerSize(el.lineMarkerSize)}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" fill="${el.fill || 'none'}" stroke-linecap="round" stroke-linejoin="round" points="${pts.map(p => `${p.x},${p.y}`).join(' ')}" />\n`;
      } else {
        return `<polyline id="${el.id}" data-type="line" data-line-style="${normalizeLineStyle(el.lineStyle)}" data-line-marker-size="${normalizeLineMarkerSize(el.lineMarkerSize)}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round" points="${pts.map(p => `${p.x},${p.y}`).join(' ')}" />\n`;
      }
    } else {
      var s = `<g id="${el.id}" data-type="line" data-line-style="${normalizeLineStyle(el.lineStyle)}" data-line-marker-size="${normalizeLineMarkerSize(el.lineMarkerSize)}"`;
      if (el.rotation) {
        const cx = (pts[0].x + pts[pts.length - 1].x) / 2;
        const cy = (pts[0].y + pts[pts.length - 1].y) / 2;
        s += ` transform="rotate(${el.rotation}, ${cx}, ${cy})"`;
      }
      s += `>\n`;
      s += `  <line class="annotation-line" data-line-style="${normalizeLineStyle(el.lineStyle)}" data-line-marker-size="${normalizeLineMarkerSize(el.lineMarkerSize)}" x1="${pts[0].x}" y1="${pts[0].y}" x2="${pts[1].x}" y2="${pts[1].y}" `;
      s += `stroke="${el.stroke}" stroke-width="${el.strokeWidth}" />\n`;
      s += `  ${getLineDecorationsSvg(el)}\n`;
      s += `</g>\n`;
      return s;
    }
  }
  if (el.type === 'text') {
    var s = `<text id="${el.id}" data-type="text" class="annotation-text" `;
    s += `x="${el.x}" y="${el.y}" font-size="${el.fontSize}" fill="${el.fill}" stroke="${el.stroke || 'none'}" stroke-width="${el.strokeWidth || 0}" font-family="sans-serif"`;
    if (el.rotation) {
      const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(el.id)}`);
      if (textEl) {
        const transform = textEl.getAttribute('transform');
        if (transform) s += ` transform="${transform}"`;
      }
    }
    s += `>`;
    s += escapeXml(el.content);
    s += `</text>\n`;
    return s;
  }
  if (el.type === 'freehand') {
    return `<polyline id="${el.id}" data-type="freehand" data-epsilon="${el.epsilon}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round" points="${el.points.map(p => `${p.x},${p.y}`).join(' ')}" />\n`;
  }
  if (el.type === 'rectangle') {
    var s = `<rect id="${el.id}" data-type="rectangle" x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="${el.rx || 0}" stroke="${el.stroke || 'none'}" stroke-width="${el.strokeWidth}" fill="${el.fill || 'transparent'}"`;
    if (el.rotation) {
      s += ` transform="rotate(${el.rotation}, ${el.x + el.width / 2}, ${el.y + el.height / 2})"`;
    }
    s += ` />\n`;
    return s;
  }
  return '';
}

function getExportLayerIds() {
  var svg = document.getElementById('editor-svg');
  if (!svg) return [];
  var out = [];
  var children = svg.querySelectorAll('g[id^="layer-"], g[id^="layer-user-"]');
  for (var i = 0; i < children.length; i++) {
    var id = children[i].id;
    if (id === 'layer-grid') continue;
    out.push(id);
  }
  return out;
}

function buildLayerExportSvg(layerId, targetW, targetH) {
  var dims = getViewBoxDims();
  var imgTransform = dom.imageEl.getAttribute('transform') || '';
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ';
  svg += 'viewBox="0 0 ' + dims.width + ' ' + dims.height + '" ';
  svg += 'width="' + targetW + '" height="' + targetH + '">\n';

  if (layerId === 'layer-watermark') {
    svg += buildWatermarkDefs();
    svg += '<g transform="' + imgTransform + '">\n';
    svg += dom.watermarkLayer.innerHTML;
    svg += '</g>\n';
  } else {
    var layerEl = document.getElementById(layerId);
    svg += '<g transform="' + imgTransform + '">\n';
    if (layerEl) {
      var topEls = layerEl.querySelectorAll(':scope > g[id], :scope > text[id]');
      for (var ei = 0; ei < topEls.length; ei++) {
        var domEl = topEls[ei];
        if (!domEl.id) continue;
        var elData = captureElementState(domEl.id);
        if (elData) svg += serializeElement(elData);
      }
    }
    svg += '</g>\n';
  }

  svg += '</svg>';
  return svg;
}

function applyImageCanvasTransform(ctx, targetW, targetH) {
  var dims = getViewBoxDims();
  var img = state.image;
  var cx = dims.width / 2;
  var cy = dims.height / 2;
  ctx.save();
  ctx.scale(targetW / dims.width, targetH / dims.height);
  ctx.translate(cx, cy);
  if (img.rotation) ctx.rotate(img.rotation * Math.PI / 180);
  if (img.flipH) ctx.scale(-1, 1);
  if (img.flipV) ctx.scale(1, -1);
  ctx.translate(-img.naturalWidth / 2, -img.naturalHeight / 2);
}

async function renderSvgToCtx(ctx, svgStr, targetW, targetH) {
  await _tmpWrite('_export_tmp.svg', svgStr);
  svgStr = null;
  var blob = await _tmpReadBlob('_export_tmp.svg');
  var url = URL.createObjectURL(blob);
  return new Promise(function(resolve, reject) {
    var img = new Image();
    img.onload = function() {
      ctx.drawImage(img, 0, 0, targetW, targetH);
      URL.revokeObjectURL(url);
      _tmpRemove('_export_tmp.svg').then(resolve, resolve);
    };
    img.onerror = function() {
      URL.revokeObjectURL(url);
      _tmpRemove('_export_tmp.svg').then(function() { reject(new Error('SVG render failed')); }, function() { reject(new Error('SVG render failed')); });
    };
    img.src = url;
  });
}

async function renderExportCanvas(targetW, targetH) {
  var c = document.createElement('canvas');
  c.width = targetW;
  c.height = targetH;
  var ctx = c.getContext('2d');

  var layerIds = getExportLayerIds();

  // Determine order: image first, then annotation/user layers, then watermark last
  var renderOrder = [];
  for (var li = 0; li < layerIds.length; li++) {
    var lid = layerIds[li];
    if (lid === 'layer-image' || lid === 'layer-watermark') continue;
    if (!isLayerVisible(lid)) continue;
    var el = document.getElementById(lid);
    if (el && el.querySelector('[id]')) renderOrder.push(lid);
  }

  var imgVisible = isLayerVisible('layer-image');
  var wmVisible = isLayerVisible('layer-watermark');

  if (imgVisible) {
    updateExportProgress('Rendering image...');
    await sleep(0);
    applyImageCanvasTransform(ctx, targetW, targetH);
    ctx.drawImage(dom.imageEl, 0, 0, state.image.naturalWidth, state.image.naturalHeight);
    ctx.restore();
  }

  for (var ri = 0; ri < renderOrder.length; ri++) {
    var layerName = renderOrder[ri];
    var displayName = document.querySelector('[data-layer="' + CSS.escape(layerName) + '"] .layer-name')?.textContent || layerName;
    updateExportProgress('Rendering ' + displayName + '...');
    await sleep(0);
    var svg = buildLayerExportSvg(layerName, targetW, targetH);
    await renderSvgToCtx(ctx, svg, targetW, targetH);
  }

  if (wmVisible) {
    updateExportProgress('Rendering Watermark...');
    await sleep(0);
    var svg = buildLayerExportSvg('layer-watermark', targetW, targetH);
    await renderSvgToCtx(ctx, svg, targetW, targetH);
  }

  return { canvas: c };
}

// ── Layer helpers ────────────────────────────────────────────────

function isElementInLayer(elementId, layerId) {
  var domEl = document.getElementById(elementId);
  if (!domEl) return false;
  var p = domEl.parentNode;
  while (p && p.id && p.id !== layerId && !p.id.startsWith('layer-')) {
    p = p.parentNode;
  }
  return p && p.id === layerId;
}

export function recreateElement(el) {
  if (el.type === 'line') addLineElement(el);
  else if (el.type === 'text') addTextElement(el);
  else if (el.type === 'freehand') addFreehandElement(el);
  else if (el.type === 'rectangle') addRectangleElement(el);
}

// ── Save SVG ────────────────────────────────────────────────────

export function generateSVGString() {
  if (!state.hasImage) return null;

  const dims = getViewBoxDims();

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" `;
  svg += `viewBox="0 0 ${dims.width} ${dims.height}" `;
  svg += `width="${dims.width}" height="${dims.height}" `;
  svg += `data-annotator-version="0.1">\n`;

  svg += `<!-- annotator-palette: ${state.palette.join(',')} -->\n`;
  svg += `<!-- annotator-origin: ${state.originCoordinate} -->\n`;
  svg += `<!-- annotator-dpi: ${state.image.dpi} -->\n`;

  const img = state.image;
  const imgTransform = dom.imageEl.getAttribute('transform') || '';
  var imgVis = dom.imageLayer.getAttribute('visibility');
  svg += `<g id="layer-image" visibility="${imgVis === 'hidden' ? 'hidden' : 'visible'}">\n`;
  svg += `<image data-type="background" href="${img.dataURI}" `;
  svg += `x="0" y="0" width="${img.naturalWidth}" height="${img.naturalHeight}" `;
  svg += `transform="${imgTransform}" />\n`;
  svg += `</g>\n`;

  // Walk DOM children in order — preserves layer ordering
  var svgChildren = dom.svg.children;
  for (var i = 0; i < svgChildren.length; i++) {
    var child = svgChildren[i];
    if (child.tagName !== 'g') continue;
    var layerId = child.id;
    if (!layerId || layerId === 'layer-image' || layerId === 'layer-watermark' || layerId === 'layer-grid' || layerId === 'handle-layer') continue;

    var visibility = child.getAttribute('visibility');
    var layerName = child.getAttribute('data-layer-name') || layerId;
    var layerTransform = child.getAttribute('transform') || '';

    svg += `<g id="${layerId}" data-layer-name="${escapeXml(layerName)}" transform="${layerTransform}" visibility="${visibility === 'hidden' ? 'hidden' : 'visible'}">\n`;

    var topEls = child.querySelectorAll(':scope > g[id], :scope > text[id]');
    for (var j = 0; j < topEls.length; j++) {
      var domEl = topEls[j];
      if (!domEl.id) continue;
      var elData = captureElementState(domEl.id);
      if (elData) svg += serializeElement(elData);
    }

    svg += `</g>\n`;
  }

  svg += buildWatermarkDefs();
  var wmVis = dom.watermarkLayer.getAttribute('visibility');
  svg += `<g id="layer-watermark" transform="${imgTransform}" visibility="${wmVis === 'hidden' ? 'hidden' : 'visible'}">\n`;
  svg += dom.watermarkLayer.innerHTML;
  svg += `</g>\n`;

  svg += `</svg>`;
  return svg;
}

export function saveSVG() {
  const svg = generateSVGString();
  if (!svg) return;
  let name = state.filename || 'annotation.svg';
  const dot = name.lastIndexOf('.');
  if (dot === -1) name += '.svg';
  const ext = name.slice(dot).toLowerCase();
  if (ext !== '.svg') name = name.slice(0, dot) + '.svg';
  downloadString(svg, name, 'image/svg+xml');
}

// ── Export JPG ──────────────────────────────────────────────────

export async function exportJPG(widthOption) {
  if (!state.hasImage) return;

  const dims = getViewBoxDims();
  let targetWidth, targetHeight;

  if (widthOption === 'original') {
    targetWidth = dims.width;
    targetHeight = dims.height;
  } else {
    targetWidth = parseInt(widthOption);
    targetHeight = Math.round((targetWidth / dims.width) * dims.height);
  }

  showExportProgress('Rendering image...');
  await sleep(0);

  var result = await renderExportCanvas(targetWidth, targetHeight);

  // JPEG doesn't support alpha — fill white behind all layers
  var ctx = result.canvas.getContext('2d');
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.globalCompositeOperation = 'source-over';

  updateExportProgress('Encoding JPEG...');
  await sleep(0);

  var blob = await new Promise(function(resolve) {
    result.canvas.toBlob(function(b) { resolve(b); }, 'image/jpeg', 0.92);
  });

  if (blob) {
    updateExportProgress('Downloading...');
    await sleep(0);
    let filename = document.getElementById('export-filename')?.value?.trim() || 'annotation';
    const dot = filename.lastIndexOf('.');
    let ext = '.jpg';
    if (dot !== -1) {
      const userExt = filename.slice(dot).toLowerCase();
      if (userExt === '.jpg' || userExt === '.jpeg' || userExt === '.png') {
        ext = userExt;
        filename = filename.slice(0, dot);
      }
    }
    downloadBlob(blob, filename + '_' + targetWidth + 'x' + targetHeight + ext);
  }

  await showExportDone();
}

// ── Export PDF ──────────────────────────────────────────────────

export async function exportPDF(widthOption, pageSize) {
  if (!state.hasImage) return;

  const dims = getViewBoxDims();
  let targetWidth, targetHeight;
  if (widthOption === 'original') {
    targetWidth = dims.width;
    targetHeight = dims.height;
  } else {
    targetWidth = parseInt(widthOption);
    targetHeight = Math.round((targetWidth / dims.width) * dims.height);
  }

  const useA4 = pageSize && pageSize !== 'fit';
  const isLandscape = pageSize === 'A4-landscape';

  showExportProgress('Rendering image...');
  await sleep(0);

  var result = await renderExportCanvas(targetWidth, targetHeight);
  var canvas = result.canvas;

  var marker = findActualSizeMarker();
  var dpi = parseInt(document.getElementById('dpi-input').value) || 300;
  var markerPxPerMm = marker ? marker.pixelsPerMm : (dpi / 25.4);
  var pixelsPerMm = markerPxPerMm * (targetWidth / dims.width);
  var marginUnit = document.getElementById('margin-unit-select').value;
  var toMm = { mm: 1, cm: 10, pt: 25.4 / 72, in: 25.4 }[marginUnit] || 1;
  var marginTopMm = (parseFloat(document.getElementById('export-margin-top').value) || 0) * toMm;
  var marginRightMm = (parseFloat(document.getElementById('export-margin-right').value) || 0) * toMm;
  var marginBottomMm = (parseFloat(document.getElementById('export-margin-bottom').value) || 0) * toMm;
  var marginLeftMm = (parseFloat(document.getElementById('export-margin-left').value) || 0) * toMm;
  console.log('PDF: viewBox=' + dims.width + 'x' + dims.height + ' target=' + targetWidth + 'x' + targetHeight + ' canvasPxPerMm=' + pixelsPerMm + ' markerPxLen=' + (marker ? marker.pixelLen : 'none') + ' markerRealMm=' + (marker ? marker.realMm : 'none'));

  updateExportProgress('Encoding pages...');
  await sleep(0);

  var pdfBlob = await buildPdf(canvas, targetWidth, targetHeight, useA4, isLandscape, pixelsPerMm, marginTopMm, marginRightMm, marginBottomMm, marginLeftMm,
    function(done, total) { updateExportProgress('Encoding page ' + done + '/' + total + '...'); }
  );

  updateExportProgress('Downloading...');
  await sleep(0);

  let filename = document.getElementById('export-filename')?.value?.trim() || 'annotation';
  const dot = filename.lastIndexOf('.');
  if (dot !== -1) {
    const ext = filename.slice(dot).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.pdf') {
      filename = filename.slice(0, dot);
    }
  }
  downloadBlob(pdfBlob, filename + '_' + targetWidth + 'x' + targetHeight + '.pdf');

  await showExportDone();
}

function findActualSizeMarker() {
  var re = /^(?:actual_size|real_size)_([\d_]+)\s*(mm|cm|in)$|^(?:actual-size|real-size)-([\d_]+)\s*(mm|cm|in)$/i;
  var lineEls = dom.annotationLayer.querySelectorAll('g[data-type="line"]');
  for (var i = 0; i < lineEls.length; i++) {
    var lineG = lineEls[i];
    var elData = captureElementState(lineG.id);
    if (!elData) continue;
    var m = re.exec(elData.id);
    if (!m) continue;
    var realValue = parseFloat((m[1] || m[3]).replace(/_/g, '.'));
    var unit = (m[2] || m[4]).toLowerCase();
    if (unit === 'cm') realValue *= 10;
    else if (unit === 'in') realValue *= 25.4;
    var pts = elData.points || [{x: elData.x1, y: elData.y1}, {x: elData.x2, y: elData.y2}];
    var dx = pts[pts.length - 1].x - pts[0].x;
    var dy = pts[pts.length - 1].y - pts[0].y;
    var pixelLen = Math.sqrt(dx * dx + dy * dy);
    if (pixelLen < 1) continue;
    return { pixelsPerMm: pixelLen / realValue, pixelLen: pixelLen, realMm: realValue };
  }
  return null;
}

export function recalcDpi() {
  var display = document.getElementById('dpi-display');
  if (!display) return;
  var marker = findActualSizeMarker();
  if (marker) {
    state.image.dpi = Math.round(marker.pixelsPerMm * 25.4);
  }
  display.textContent = state.image.dpi + ' DPI';
  document.dispatchEvent(new CustomEvent('dpi-changed'));
}

async function deflateRgb(imageData) {
  if (typeof CompressionStream === 'undefined') {
    console.error('CompressionStream not supported in this browser');
    return new Uint8Array(0);
  }
  var data = imageData.data;
  var w = imageData.width, h = imageData.height;
  var rgbLen = w * h * 3;
  var rgb = new Uint8Array(rgbLen);
  for (var i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  try {
    var cs = new CompressionStream('deflate');
    var writer = cs.writable.getWriter();
    // Write in 64KB chunks to avoid oversized single writes
    var CHUNK = 65536;
    for (var off = 0; off < rgb.length; off += CHUNK) {
      var end = Math.min(off + CHUNK, rgb.length);
      await writer.write(rgb.subarray(off, end));
    }
    await writer.close();
    var reader = cs.readable.getReader();
    var chunks = [];
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
    }
    var total = chunks.reduce(function(s, c) { return s + c.length; }, 0);
    var out = new Uint8Array(total);
    var off2 = 0;
    for (var ci = 0; ci < chunks.length; ci++) {
      out.set(chunks[ci], off2);
      off2 += chunks[ci].length;
    }
    return out;
  } catch (e) {
    console.error('deflateRgb error:', e);
    return new Uint8Array(0);
  }
}

function buildWatermarkDefs() {
  if (!isLayerVisible('layer-watermark')) return '';
  if (!state.activeColor || state.activeColor === 'transparent') return '';
  var pattern = document.getElementById('watermark-pattern');
  if (!pattern) return '';
  var path = pattern.querySelector('path');
  if (!path) return '';
  var thickness = path.getAttribute('stroke-width') || '1';
  var color = path.getAttribute('stroke') || state.activeColor;
  var tf = pattern.getAttribute('patternTransform') || '';
  var m = tf.match(/rotate\(([^)]+)\)/);
  var rotation = m ? m[1] : '45';
  var spacing = pattern.getAttribute('width') || '100';
  return '<defs>\n<pattern id="watermark-pattern" width="' + spacing + '" height="' + spacing + '" patternUnits="userSpaceOnUse" patternTransform="rotate(' + rotation + ')">\n<path d="M ' + spacing + ' 0 L 0 0 0 ' + spacing + '" fill="none" stroke="' + color + '" stroke-width="' + thickness + '" opacity="0.4"/>\n</pattern>\n</defs>\n';
}

async function buildPdf(srcCanvas, imgW, imgH, useA4, isLandscape, pixelsPerMm, marginTopMm, marginRightMm, marginBottomMm, marginLeftMm, onProgress) {
  // v7 — proven PDF construction (same approach as original working version)
  var DPI = 300;
  var ptsPerPx = 72 / DPI;
  var pxPerMm = DPI / 25.4;

  var a4PtW = 595, a4PtH = 842;
  var pgPtW = useA4 ? (isLandscape ? a4PtH : a4PtW) : Math.round(Math.min(imgW * ptsPerPx, 595));
  var pgPtH = useA4 ? (isLandscape ? a4PtW : a4PtH) : Math.round(pgPtW * (imgH / imgW));

  var pgPxW = Math.round(pgPtW / ptsPerPx);
  var pgPxH = Math.round(pgPtH / ptsPerPx);

  // Margins in pixels at 300 DPI (only relevant for A4 tiling)
  var marginTopPx = useA4 ? Math.round((marginTopMm || 0) * pxPerMm) : 0;
  var marginRightPx = useA4 ? Math.round((marginRightMm || 0) * pxPerMm) : 0;
  var marginBottomPx = useA4 ? Math.round((marginBottomMm || 0) * pxPerMm) : 0;
  var marginLeftPx = useA4 ? Math.round((marginLeftMm || 0) * pxPerMm) : 0;
  var prnPxW = pgPxW - marginLeftPx - marginRightPx;
  var prnPxH = pgPxH - marginTopPx - marginBottomPx;

  // ── Determine tiles ──
  var tiles = [];

  if (pixelsPerMm && useA4) {
    var displayScale = pxPerMm / pixelsPerMm;
    var srcPerPageW = prnPxW / displayScale;
    var srcPerPageH = prnPxH / displayScale;
    var cols = Math.ceil(imgW / srcPerPageW);
    var rows = Math.ceil(imgH / srcPerPageH);

    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var sx = Math.round(c * srcPerPageW);
        var sy = Math.round(r * srcPerPageH);
        var sw = Math.min(Math.round(srcPerPageW), imgW - sx);
        var sh = Math.min(Math.round(srcPerPageH), imgH - sy);
        if (sw <= 0 || sh <= 0) continue;
        var dx = marginLeftPx + Math.round(0.5 * (prnPxW - sw * displayScale));
        var dy = marginTopPx + Math.round(0.5 * (prnPxH - sh * displayScale));
        tiles.push({ sx: sx, sy: sy, sw: sw, sh: sh, dx: dx, dy: dy, dw: Math.round(sw * displayScale), dh: Math.round(sh * displayScale) });
      }
    }
  } else {
    var fitScale = Math.min(pgPxW / imgW, pgPxH / imgH);
    var dw = Math.round(imgW * fitScale);
    var dh = Math.round(imgH * fitScale);
    var dx = Math.round((pgPxW - dw) / 2);
    var dy = Math.round((pgPxH - dh) / 2);
    tiles.push({ sx: 0, sy: 0, sw: imgW, sh: imgH, dx: dx, dy: dy, dw: dw, dh: dh });
  }

  var numPages = tiles.length;
  var hasRef = (numPages > 1 && pixelsPerMm);
  var totalPages = numPages + (hasRef ? 1 : 0);
  console.log('buildPdf[v7]: img=' + imgW + 'x' + imgH + ' cropPages=' + numPages + ' totalPages=' + totalPages);

  // ── Render all pages to JPEG, store in temp files ──
  var jpegLengths = [];
  var jpegIndex = 0;

  var sharedCanvas = document.createElement('canvas');
  sharedCanvas.width = pgPxW;
  sharedCanvas.height = pgPxH;

  function canvasToJpegBytes(cvs) {
    return new Promise(function(resolve) {
      cvs.toBlob(async function(b) {
        resolve(new Uint8Array(await b.arrayBuffer()));
      }, 'image/jpeg', 0.92);
    });
  }

  if (hasRef) {
    var rctx = sharedCanvas.getContext('2d');
    rctx.fillStyle = '#ffffff';
    rctx.fillRect(0, 0, pgPxW, pgPxH);
    var fit = Math.min(prnPxW / imgW, prnPxH / imgH);
    var fw = Math.round(imgW * fit);
    var fh = Math.round(imgH * fit);
    var fx = marginLeftPx + Math.round((prnPxW - fw) / 2);
    var fy = marginTopPx + Math.round((prnPxH - fh) / 2);
    rctx.drawImage(srcCanvas, 0, 0, imgW, imgH, fx, fy, fw, fh);
    rctx.strokeStyle = '#ff0000';
    rctx.lineWidth = 3;
    for (var rr = 0; rr <= rows; rr++) {
      var yy = fy + Math.round(rr * srcPerPageH * fit);
      rctx.beginPath(); rctx.moveTo(fx, yy); rctx.lineTo(fx + fw, yy); rctx.stroke();
    }
    for (var cc = 0; cc <= cols; cc++) {
      var xx = fx + Math.round(cc * srcPerPageW * fit);
      rctx.beginPath(); rctx.moveTo(xx, fy); rctx.lineTo(xx, fy + fh); rctx.stroke();
    }
    var refJpeg = await canvasToJpegBytes(sharedCanvas);
    jpegLengths.push(refJpeg.length);
    await _tmpWrite('export_jpeg_' + (jpegIndex++), refJpeg);
  }

  for (var ti = 0; ti < numPages; ti++) {
    var t = tiles[ti];
    var ctx = sharedCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pgPxW, pgPxH);
    ctx.drawImage(srcCanvas, t.sx, t.sy, t.sw, t.sh, t.dx, t.dy, t.dw, t.dh);
    var jpegBytes = await canvasToJpegBytes(sharedCanvas);
    jpegLengths.push(jpegBytes.length);
    await _tmpWrite('export_jpeg_' + (jpegIndex++), jpegBytes);
    if (onProgress) onProgress(ti + 1, numPages);
    await sleep(0);
  }

  // ── Build PDF using proven original approach ──

  // Build all text objects (Catalog, Pages, all Page+Content pairs, image headers)
  var textParts = ['%PDF-1.4'];

  // Track object offsets
  var offsets = [];

  function addObj(text) {
    offsets.push(byteLength(textParts.join('\n')));
    textParts.push(text);
  }

  // Obj 1: Catalog
  addObj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj');
  // Obj 2: Pages
  var kids = [];
  for (var p = 0; p < totalPages; p++) kids.push((3 + p * 2) + ' 0 R');
  addObj('2 0 obj\n<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + totalPages + ' >>\nendobj');

  var imgBase = 3 + totalPages * 2;

  // Page and Content stream objects
  for (var p = 0; p < totalPages; p++) {
    var pN = 3 + p * 2;
    var cN = pN + 1;
    var iN = imgBase + p;
    addObj(pN + ' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pgPtW + ' ' + pgPtH + '] /Contents ' + cN + ' 0 R /Resources << /XObject << /Im' + p + ' ' + iN + ' 0 R >> /ProcSet [/PDF /ImageC] >> >>\nendobj');
    var stream = 'q ' + pgPtW + ' 0 0 ' + pgPtH + ' 0 0 cm /Im' + p + ' Do Q';
    addObj(cN + ' 0 obj\n<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream\nendobj');
  }

  // Convert text parts to bytes
  var textStr = textParts.join('\n');
  var textBytes = new TextEncoder().encode(textStr);

  // Compute image object offsets for xref
  var imgObjOffsets = [];
  var off = textBytes.length;
  for (var p = 0; p < totalPages; p++) {
    var iN = imgBase + p;
    var hdr = iN + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + pgPxW + ' /Height ' + pgPxH + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpegLengths[p] + ' >>\nstream\n';
    var ftr = '\nendstream\nendobj';
    imgObjOffsets.push(off);
    off += new TextEncoder().encode(hdr).length + jpegLengths[p] + new TextEncoder().encode(ftr).length;
  }
  var xrefOffset = off;

  // Build xref/trailer
  var trailerParts = [];
  var totalObjs = imgBase + totalPages;
  trailerParts.push('xref');
  trailerParts.push('0 ' + totalObjs);
  trailerParts.push('0000000000 65535 f ');
  for (var j = 0; j < offsets.length; j++) {
    trailerParts.push(pad(offsets[j], 10) + ' 00000 n ');
  }
  for (var p = 0; p < totalPages; p++) {
    trailerParts.push(pad(imgObjOffsets[p], 10) + ' 00000 n ');
  }
  trailerParts.push('trailer');
  trailerParts.push('<< /Size ' + totalObjs + ' /Root 1 0 R >>');
  trailerParts.push('startxref');
  trailerParts.push(String(xrefOffset));
  trailerParts.push('%%EOF');
  var trailerBytes = new TextEncoder().encode(trailerParts.join('\n'));

  // Stream PDF to temp file
  var writer = await _tmpCreateWriter('export.pdf');
  await writer.write(textBytes);
  for (var p = 0; p < totalPages; p++) {
    var iN = imgBase + p;
    var hdr = iN + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + pgPxW + ' /Height ' + pgPxH + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpegLengths[p] + ' >>\nstream\n';
    var ftr = '\nendstream\nendobj';
    await writer.write(new TextEncoder().encode(hdr));
    var jpegBytes = await _tmpReadBytes('export_jpeg_' + p);
    await writer.write(jpegBytes);
    await writer.write(new TextEncoder().encode(ftr));
  }
  await writer.write(trailerBytes);
  await writer.close();

  // Clean up temp JPEG files
  var tempNames = [];
  for (var p = 0; p < totalPages; p++) tempNames.push('export_jpeg_' + p);
  await _tmpCleanup(tempNames);

  return await _tmpReadBlob('export.pdf');
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function base64ToBytes(b64) {
  var binary = atob(b64);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

function pad(n, width) {
  var s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
}

// ── Diagnostic: Test PDF with red rectangle (no images, no external resources) ──
export function buildTestPdf() {
  var pts = [0, 0, 595, 842];
  var stream = 'q\n1 0 0 rg\n100 100 395 642 re\nf\nQ';
  var sLen = new TextEncoder().encode(stream).length;
  var objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /ProcSet [/PDF] >> >>\nendobj',
    '4 0 obj\n<< /Length ' + sLen + ' >>\nstream\n' + stream + '\nendstream\nendobj'
  ];
  var segs = ['%PDF-1.4\n'];
  var offs = [0];
  for (var i = 0; i < objs.length; i++) {
    offs.push(byteLength(segs.join('')));
    segs.push(objs[i] + '\n');
  }
  var totalObjs = objs.length + 1;
  var xref = 'xref\n0 ' + totalObjs + '\n0000000000 65535 f \n';
  for (var j = 1; j < totalObjs; j++) {
    xref += pad(offs[j], 10) + ' 00000 n \n';
  }
  xref += 'trailer\n<< /Size ' + totalObjs + ' /Root 1 0 R >>\nstartxref\n' + byteLength(segs.join('')) + '\n%%EOF';
  segs.push(xref);
  var all = new TextEncoder().encode(segs.join(''));
  downloadBlob(new Blob([all], { type: 'application/pdf' }), 'test-red-rectangle.pdf');
  console.log('buildTestPdf: downloaded test-red-rectangle.pdf (' + all.length + ' bytes)');
}

// ── Diagnostic: Test PDF using ORIGINAL working buildPdf pattern ──
export function buildTestPdfWithImage() {
  var W = 200, H = 200;
  var c = document.createElement('canvas');
  c.width = W; c.height = H;
  var ctx = c.getContext('2d');
  ctx.fillStyle = '#0000ff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffff00';
  ctx.beginPath(); ctx.arc(W/2, H/2, 60, 0, Math.PI*2); ctx.fill();
  // Get JPEG data URI (same as original canvas.toBlob approach)
  var jpegDataUri = c.toDataURL('image/jpeg', 0.92);
  var imgData = jpegDataUri.split(',')[1];
  var rawBytes = base64ToBytes(imgData);
  console.log('  test jpeg=' + rawBytes.length + ' bytes valid=' + (rawBytes[0]===0xFF && rawBytes[1]===0xD8));

  // ── ORIGINAL-style PDF construction ──
  var imgWidth = W, imgHeight = H;
  var a4W = 595, a4H = 842;
  var wPt = a4W, hPt = a4H;
  var scale = Math.min(wPt / imgWidth, hPt / imgHeight);
  var drawW = Math.round(imgWidth * scale);
  var drawH = Math.round(imgHeight * scale);
  var offsetX = Math.round((wPt - drawW) / 2);
  var offsetY = Math.round((hPt - drawH) / 2);

  var objects = [];
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj');
  objects.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj');
  objects.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + wPt + ' ' + hPt + '] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> /ProcSet [/PDF /ImageC] >> >>\nendobj');

  var stream = 'q ' + drawW + ' 0 0 ' + drawH + ' ' + offsetX + ' ' + offsetY + ' cm /Im0 Do Q';
  objects.push('4 0 obj\n<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream\nendobj');

  var imgLen = rawBytes.length;
  var imgHeader = '5 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + imgWidth + ' /Height ' + imgHeight + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + imgLen + ' >>\nstream\n';
  var imgFooter = '\nendstream\nendobj';
  var footerBytes = new TextEncoder().encode(imgFooter);

  var textParts = ['%PDF-1.4'];
  var offsets = [];
  for (var i = 0; i < objects.length; i++) {
    offsets.push(byteLength(textParts.join('\n')));
    textParts.push(objects[i]);
  }
  var imgObjOffset = byteLength(textParts.join('\n'));
  textParts.push(imgHeader);

  var textStr = textParts.join('\n');
  var textBytes = new TextEncoder().encode(textStr);

  var trailerParts = [];
  var xrefOffset = byteLength(textStr) + imgLen + footerBytes.length;
  trailerParts.push('xref');
  trailerParts.push('0 ' + (objects.length + 2));
  trailerParts.push('0000000000 65535 f ');
  for (var j = 0; j < offsets.length; j++) {
    trailerParts.push(pad(offsets[j], 10) + ' 00000 n ');
  }
  trailerParts.push(pad(imgObjOffset, 10) + ' 00000 n ');
  trailerParts.push('trailer');
  trailerParts.push('<< /Size ' + (objects.length + 2) + ' /Root 1 0 R >>');
  trailerParts.push('startxref');
  trailerParts.push(String(xrefOffset));
  trailerParts.push('%%EOF');
  var trailerBytes = new TextEncoder().encode(trailerParts.join('\n'));

  var total = new Uint8Array(textBytes.length + imgLen + footerBytes.length + trailerBytes.length);
  total.set(textBytes, 0);
  total.set(rawBytes, textBytes.length);
  total.set(footerBytes, textBytes.length + imgLen);
  total.set(trailerBytes, textBytes.length + imgLen + footerBytes.length);

  downloadBlob(new Blob([total], { type: 'application/pdf' }), 'test-image-embed.pdf');
  console.log('buildTestPdfWithImage: ' + total.length + ' bytes xrefOff=' + xrefOffset + ' imgObjOff=' + imgObjOffset + ' offsets=' + JSON.stringify(offsets));
}
