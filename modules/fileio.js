// ── File I/O module: Open, Save SVG, Export JPG ────────────────

import { state, dom, loadImage, restoreState, getViewBoxDims } from './editor.js';
import { addLineElement, getLineDecorationsSvg, normalizeLineStyle, normalizeLineMarkerSize, normalizeLineDecoration } from './line.js';
import { addTextElement } from './text.js';
import { addFreehandElement } from './freehand.js';
import { addRectangleElement } from './rectangle.js';
import { clearHistory } from './history.js';
import { refreshPalette } from './palette.js';
import { downloadString, downloadBlob, generateId } from './utils.js';
import { switchTool } from './tools.js';
import { isLayerVisible, updateWatermark } from './layers.js';

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
  btnFileDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
    fileMenu.hidden = !fileMenu.hidden;
    if (!fileMenu.hidden) activateTab(currentFormat);
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
    fileMenu.hidden = true;
    if (currentFormat === 'pdf') {
      const pageSize = exportPdfSizeSelect.value;
      const res = exportPdfResSelect.value;
      exportPDF(res, pageSize);
    } else {
      const width = exportSizeSelect.value;
      exportJPG(width);
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
        physicallyResizeImage(parseInt(widthOpt));
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

  // ── Resize dropdown ─────────────────────────────────────────
  const sizeLabel = document.getElementById('image-size-label');
  const resizeMenu = document.getElementById('resize-menu');
  const resizeW = document.getElementById('resize-width-input');
  const resizeH = document.getElementById('resize-height-input');
  const resizeRatioRadios = document.querySelectorAll('input[name="resize-ratio"]');
  const btnResizeApply = document.getElementById('btn-resize-apply');
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

  sizeLabel.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.hasImage) return;
    const dims = getViewBoxDims();
    resizeW.value = Math.round(dims.width);
    resizeH.value = Math.round(dims.height);
    resizeMenu.hidden = !resizeMenu.hidden;
    if (!resizeMenu.hidden) { resizeW.focus(); resizeW.select(); }
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

  btnResizeApply.addEventListener('click', () => {
    const w = parseInt(resizeW.value);
    const h = parseInt(resizeH.value);
    if (isNaN(w) || isNaN(h) || w < 1 || h < 1) return;
    resizeMenu.hidden = true;
    resizeImage(w, h);
  });
}

// ── Open File ───────────────────────────────────────────────────

function handleFileOpen(file) {
  const isSVG = file.name.toLowerCase().endsWith('.svg');

  const exportFilename = document.getElementById('export-filename');
  if (exportFilename) {
    exportFilename.value = file.name;
    const dot = file.name.lastIndexOf('.');
    if (dot !== -1) {
      exportFilename.setSelectionRange(0, dot);
    } else {
      exportFilename.select();
    }
    exportFilename.focus();
  }

  if (isSVG) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const svgText = e.target.result;
      openSVGProject(svgText);
    };
    reader.readAsText(file);
  } else {
    openImageFile(file);
  }
}

function openImageFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataURI = e.target.result;
    const img = new Image();
    img.onload = () => {
      loadImage(dataURI, img.naturalWidth, img.naturalHeight);
      clearHistory();
      switchTool('text');
      updateWatermark();
      
      const maxDim = Math.max(img.naturalWidth, img.naturalHeight);
      const resizeNotification = document.getElementById('resize-notification');
      if (maxDim > 1000) {
        resizeNotification.hidden = false;
      } else {
        resizeNotification.hidden = true;
      }
    };
    img.onerror = () => {
      alert('Failed to load image.');
    };
    img.src = dataURI;
  };
  reader.readAsDataURL(file);
}

// ── Resize Original Image ───────────────────────────────────────

function physicallyResizeImage(targetWidth) {
  if (!state.hasImage) return;

  const currentW = state.image.naturalWidth;
  const currentH = state.image.naturalHeight;

  // Don't upscale
  if (targetWidth >= currentW) return;

  const targetHeight = Math.round((targetWidth / currentW) * currentH);

  const imgEl = new Image();
  imgEl.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    
    // Draw scaled down
    ctx.drawImage(imgEl, 0, 0, targetWidth, targetHeight);
    
    // Convert back to base64
    const newDataURI = canvas.toDataURL('image/jpeg', 0.92);
    
    // Reload image into editor
    loadImage(newDataURI, targetWidth, targetHeight);
    clearHistory();
    switchTool('text');
    updateWatermark();
  };
  imgEl.src = state.image.dataURI;
}

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
  const savedElements = state.elements.map(el => {
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
      state.elements.push(el);
    }

    clearHistory();
    switchTool('text');
    updateWatermark();
  };
  imgEl.src = state.image.dataURI;
}

// ── Open SVG Project ────────────────────────────────────────────

function openSVGProject(svgText) {
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
      switchTool('text');
      updateWatermark();
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      alert('Failed to load SVG as image.');
      URL.revokeObjectURL(url);
    };
    img.src = url;
    return;
  }

  // Parse the annotator SVG
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');
  const svgRoot = doc.documentElement;

  // Parse image
  const imgEl = svgRoot.querySelector('image[data-type="background"]');
  if (!imgEl) {
    alert('No background image found in SVG project.');
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

  const commentRegex = /<!--\s*annotator-palette:\s*(.+?)\s*-->/;
  const thicknessRegex = /<!--\s*annotator-thickness:\s*(.+?)\s*-->/;

  const paletteMatch = svgText.match(commentRegex);
  if (paletteMatch) {
    palette = paletteMatch[1].split(',').map(c => c.trim());
  }

  const thicknessMatch = svgText.match(thicknessRegex);
  if (thicknessMatch) {
    thicknessPresets = thicknessMatch[1].split(',').map(v => parseFloat(v.trim()));
  }

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

  // Parse polyline lines (3+ points)
  svgRoot.querySelectorAll('polyline[data-type="line"]').forEach(p => {
    const ptsAttr = p.getAttribute('points') || '';
    const pts = ptsAttr.trim().split(/\s+/).filter(Boolean).map(pair => {
      const [x, y] = pair.split(',').map(Number);
      return { x, y };
    });
    if (pts.length < 2) return;
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
      stroke: r.getAttribute('stroke') || '#ff0000',
      strokeWidth: parseFloat(r.getAttribute('stroke-width')) || 2,
      fill: 'transparent',
    });
  });

  // Restore state
  const parsedElements = restoreState({
    dataURI,
    naturalWidth,
    naturalHeight,
    rotation,
    flipH,
    flipV,
    palette,
    thicknessPresets,
    elements,
  });

  // Recreate annotation SVG elements
  for (const el of parsedElements) {
    if (el.type === 'line') {
      addLineElement(el);
    } else if (el.type === 'text') {
      addTextElement(el);
    } else if (el.type === 'freehand') {
      addFreehandElement(el);
    } else if (el.type === 'rectangle') {
      addRectangleElement(el);
    }
    state.elements.push(el);
  }

  clearHistory();
  refreshPalette();
  switchTool('text');
  updateWatermark();
}

// ── Save SVG ────────────────────────────────────────────────────

export function saveSVG() {
  if (!state.hasImage) return;

  const dims = getViewBoxDims();

  // Build SVG string manually for clean output
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" `;
  svg += `viewBox="0 0 ${dims.width} ${dims.height}" `;
  svg += `width="${dims.width}" height="${dims.height}" `;
  svg += `data-annotator-version="0.1">\n`;

  // Palette comment
  svg += `<!-- annotator-palette: ${state.palette.join(',')} -->\n`;

  // Image
  const img = state.image;
  const imgTransform = dom.imageEl.getAttribute('transform') || '';
  if (isLayerVisible('image-layer')) {
    svg += `<image data-type="background" href="${img.dataURI}" `;
    svg += `x="0" y="0" width="${img.naturalWidth}" height="${img.naturalHeight}" `;
    svg += `transform="${imgTransform}" />\n`;
  }

  // Annotations
  if (isLayerVisible('annotation-layer')) {
    svg += `<g id="annotation-layer" transform="${imgTransform}">\n`;
    for (const el of state.elements) {
      if (el.type === 'line') {
        const pts = el.points || [{x: el.x1, y: el.y1}, {x: el.x2, y: el.y2}];
        if (pts.length >= 3) {
          svg += `<polyline id="${el.id}" data-type="line" data-line-style="${normalizeLineStyle(el.lineStyle)}" data-line-marker-size="${normalizeLineMarkerSize(el.lineMarkerSize)}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round" points="${pts.map(p => `${p.x},${p.y}`).join(' ')}" />\n`;
        } else {
          svg += `<g id="${el.id}" data-type="line" data-line-style="${normalizeLineStyle(el.lineStyle)}" data-line-marker-size="${normalizeLineMarkerSize(el.lineMarkerSize)}"`;
          if (el.rotation) {
            const pts = el.points || [{x: el.x1, y: el.y1}, {x: el.x2, y: el.y2}];
            const cx = (pts[0].x + pts[pts.length - 1].x) / 2;
            const cy = (pts[0].y + pts[pts.length - 1].y) / 2;
            svg += ` transform="rotate(${el.rotation}, ${cx}, ${cy})"`;
          }
          svg += `>\n`;
          svg += `  <line class="annotation-line" data-line-style="${normalizeLineStyle(el.lineStyle)}" data-line-marker-size="${normalizeLineMarkerSize(el.lineMarkerSize)}" x1="${pts[0].x}" y1="${pts[0].y}" x2="${pts[1].x}" y2="${pts[1].y}" `;
          svg += `stroke="${el.stroke}" stroke-width="${el.strokeWidth}" />\n`;
          svg += `  ${getLineDecorationsSvg(el)}\n`;
          svg += `</g>\n`;
        }
      } else if (el.type === 'text') {
        svg += `<text id="${el.id}" data-type="text" class="annotation-text" `;
        svg += `x="${el.x}" y="${el.y}" font-size="${el.fontSize}" fill="${el.fill}" stroke="${el.stroke || 'none'}" stroke-width="${el.strokeWidth || 0}" font-family="sans-serif"`;
        if (el.rotation) {
          // Need to calculate cx, cy - we can approximate it or get it from DOM
          const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(el.id)}`);
          if (textEl) {
            const transform = textEl.getAttribute('transform');
            if (transform) svg += ` transform="${transform}"`;
          }
        }
        svg += `>`;
        svg += escapeXml(el.content);
        svg += `</text>\n`;
      } else if (el.type === 'freehand') {
        svg += `<polyline id="${el.id}" data-type="freehand" data-epsilon="${el.epsilon}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round" points="${el.points.map(p => `${p.x},${p.y}`).join(' ')}" />\n`;
      } else if (el.type === 'rectangle') {
        svg += `<rect id="${el.id}" data-type="rectangle" x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="${el.rx || 0}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" fill="transparent"`;
        if (el.rotation) {
          svg += ` transform="rotate(${el.rotation}, ${el.x + el.width / 2}, ${el.y + el.height / 2})"`;
        }
        svg += ` />\n`;
      }
    }
    svg += `</g>\n`;
  }

  // Watermark
  if (isLayerVisible('watermark-layer')) {
    svg += buildWatermarkDefs();
    svg += `<g id="watermark-layer" transform="${imgTransform}">\n`;
    svg += dom.watermarkLayer.innerHTML;
    svg += `</g>\n`;
  }

  svg += `</svg>`;

  downloadString(svg, 'annotation.svg', 'image/svg+xml');
}

// ── Export JPG ──────────────────────────────────────────────────

export function exportJPG(widthOption) {
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

  // Build a clean SVG string (same as save, but without hit areas)
  let svgStr = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" `;
  svgStr += `viewBox="0 0 ${dims.width} ${dims.height}" `;
  svgStr += `width="${targetWidth}" height="${targetHeight}">\n`;

  // Image
  const img = state.image;
  const imgTransform = dom.imageEl.getAttribute('transform') || '';
  if (isLayerVisible('image-layer')) {
    svgStr += `<image href="${img.dataURI}" `;
    svgStr += `x="0" y="0" width="${img.naturalWidth}" height="${img.naturalHeight}" `;
    svgStr += `transform="${imgTransform}" />\n`;
  }

  // Annotations
  if (isLayerVisible('annotation-layer')) {
    svgStr += `<g transform="${imgTransform}">\n`;
    for (const el of state.elements) {
      if (el.type === 'line') {
        const pts = el.points || [{x: el.x1, y: el.y1}, {x: el.x2, y: el.y2}];
        if (pts.length >= 3) {
          svgStr += `<polyline data-type="line" data-line-style="${normalizeLineStyle(el.lineStyle)}" data-line-marker-size="${normalizeLineMarkerSize(el.lineMarkerSize)}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round" points="${pts.map(p => `${p.x},${p.y}`).join(' ')}" />\n`;
        } else {
          svgStr += `<g data-type="line" data-line-style="${normalizeLineStyle(el.lineStyle)}" data-line-marker-size="${normalizeLineMarkerSize(el.lineMarkerSize)}"`;
          if (el.rotation) {
            const cx = (pts[0].x + pts[pts.length - 1].x) / 2;
            const cy = (pts[0].y + pts[pts.length - 1].y) / 2;
            svgStr += ` transform="rotate(${el.rotation}, ${cx}, ${cy})"`;
          }
          svgStr += `>\n`;
          svgStr += `  <line data-line-style="${normalizeLineStyle(el.lineStyle)}" data-line-marker-size="${normalizeLineMarkerSize(el.lineMarkerSize)}" x1="${pts[0].x}" y1="${pts[0].y}" x2="${pts[1].x}" y2="${pts[1].y}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" />\n`;
          svgStr += `  ${getLineDecorationsSvg(el)}\n`;
          svgStr += `</g>\n`;
        }
      } else if (el.type === 'text') {
        svgStr += `<text x="${el.x}" y="${el.y}" font-size="${el.fontSize}" fill="${el.fill}" stroke="${el.stroke || 'none'}" stroke-width="${el.strokeWidth || 0}" font-family="sans-serif"`;
        if (el.rotation) {
          const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(el.id)}`);
          if (textEl) {
            const transform = textEl.getAttribute('transform');
            if (transform) svgStr += ` transform="${transform}"`;
          }
        }
        svgStr += `>`;
        svgStr += escapeXml(el.content);
        svgStr += `</text>\n`;
      } else if (el.type === 'freehand') {
        svgStr += `<polyline data-type="freehand" data-epsilon="${el.epsilon}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round" points="${el.points.map(p => `${p.x},${p.y}`).join(' ')}" />\n`;
      } else if (el.type === 'rectangle') {
        svgStr += `<rect data-type="rectangle" x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="${el.rx || 0}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" fill="transparent"`;
        if (el.rotation) {
          svgStr += ` transform="rotate(${el.rotation}, ${el.x + el.width / 2}, ${el.y + el.height / 2})"`;
        }
        svgStr += ` />\n`;
      }
    }
    svgStr += `</g>\n`;
  }

  // Watermark
  if (isLayerVisible('watermark-layer')) {
    svgStr = svgStr.replace('>\n', '>\n' + buildWatermarkDefs());
    svgStr += `<g id="watermark-layer" transform="${imgTransform}">\n`;
    svgStr += dom.watermarkLayer.innerHTML;
    svgStr += `</g>\n`;
  }

  svgStr += `</svg>`;

  // Render SVG to canvas
  const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  const imgEl = new Image();
  imgEl.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');

    // White background for JPG
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetWidth, targetHeight);

    ctx.drawImage(imgEl, 0, 0, targetWidth, targetHeight);
    URL.revokeObjectURL(url);

    canvas.toBlob((blob) => {
      if (blob) {
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
        downloadBlob(blob, `${filename}_${targetWidth}x${targetHeight}${ext}`);
      }
    }, 'image/jpeg', 0.92);
  };
  imgEl.onerror = () => {
    URL.revokeObjectURL(url);
    alert('Failed to render image for export. This can happen due to browser security restrictions.');
  };
  imgEl.src = url;
}

// ── Export PDF ──────────────────────────────────────────────────

export function exportPDF(widthOption, pageSize) {
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

  let svgStr = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" `;
  svgStr += `viewBox="0 0 ${dims.width} ${dims.height}" `;
  svgStr += `width="${targetWidth}" height="${targetHeight}">\n`;
  const img = state.image;
  const imgTransform = dom.imageEl.getAttribute('transform') || '';
  if (isLayerVisible('image-layer')) {
    svgStr += `<image href="${img.dataURI}" `;
    svgStr += `x="0" y="0" width="${img.naturalWidth}" height="${img.naturalHeight}" `;
    svgStr += `transform="${imgTransform}" />\n`;
  }
  if (isLayerVisible('annotation-layer')) {
    svgStr += `<g transform="${imgTransform}">\n`;
    for (const el of state.elements) {
      if (el.type === 'line') {
        const pts = el.points || [{x: el.x1, y: el.y1}, {x: el.x2, y: el.y2}];
        if (pts.length >= 3) {
          svgStr += `<polyline data-type="line" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round" points="${pts.map(p => `${p.x},${p.y}`).join(' ')}" />\n`;
        } else {
          svgStr += `<g data-type="line"`;
          if (el.rotation) {
            const cx = (pts[0].x + pts[pts.length - 1].x) / 2;
            const cy = (pts[0].y + pts[pts.length - 1].y) / 2;
            svgStr += ` transform="rotate(${el.rotation}, ${cx}, ${cy})"`;
          }
          svgStr += `>\n`;
          svgStr += `  <line x1="${pts[0].x}" y1="${pts[0].y}" x2="${pts[1].x}" y2="${pts[1].y}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" />\n`;
          svgStr += `  ${getLineDecorationsSvg(el)}\n`;
          svgStr += `</g>\n`;
        }
      } else if (el.type === 'text') {
        svgStr += `<text x="${el.x}" y="${el.y}" font-size="${el.fontSize}" fill="${el.fill}" stroke="${el.stroke || 'none'}" stroke-width="${el.strokeWidth || 0}" font-family="sans-serif"`;
        if (el.rotation) {
          const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(el.id)}`);
          if (textEl) {
            const transform = textEl.getAttribute('transform');
            if (transform) svgStr += ` transform="${transform}"`;
          }
        }
        svgStr += `>${escapeXml(el.content)}</text>\n`;
      } else if (el.type === 'freehand') {
        svgStr += `<polyline data-type="freehand" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round" points="${el.points.map(p => `${p.x},${p.y}`).join(' ')}" />\n`;
      } else if (el.type === 'rectangle') {
        svgStr += `<rect data-type="rectangle" x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="${el.rx || 0}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" fill="transparent"`;
        if (el.rotation) {
          svgStr += ` transform="rotate(${el.rotation}, ${el.x + el.width / 2}, ${el.y + el.height / 2})"`;
        }
        svgStr += ` />\n`;
      }
    }
    svgStr += `</g>\n`;
  }
  if (isLayerVisible('watermark-layer')) {
    svgStr = svgStr.replace('>\n', '>\n' + buildWatermarkDefs());
    svgStr += `<g id="watermark-layer" transform="${imgTransform}">\n`;
    svgStr += dom.watermarkLayer.innerHTML;
    svgStr += `</g>\n`;
  }
  svgStr += `</svg>`;

  const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  const imgEl = new Image();
  imgEl.onload = () => {
    var canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(imgEl, 0, 0, targetWidth, targetHeight);
    URL.revokeObjectURL(url);

    var marker = findActualSizeMarker();
    var pixelsPerMm = marker ? marker.pixelsPerMm * (targetWidth / dims.width) : null;
    var marginUnit = document.getElementById('margin-unit-select').value;
    var toMm = { mm: 1, cm: 10, pt: 25.4 / 72, in: 25.4 }[marginUnit] || 1;
    var marginTopMm = (parseFloat(document.getElementById('export-margin-top').value) || 0) * toMm;
    var marginRightMm = (parseFloat(document.getElementById('export-margin-right').value) || 0) * toMm;
    var marginBottomMm = (parseFloat(document.getElementById('export-margin-bottom').value) || 0) * toMm;
    var marginLeftMm = (parseFloat(document.getElementById('export-margin-left').value) || 0) * toMm;
    console.log('PDF: viewBox=' + dims.width + 'x' + dims.height + ' target=' + targetWidth + 'x' + targetHeight + ' canvasPxPerMm=' + pixelsPerMm + ' markerPxLen=' + (marker ? marker.pixelLen : 'none') + ' markerRealMm=' + (marker ? marker.realMm : 'none'));
    var pdfBytes = buildPdf(canvas, targetWidth, targetHeight, useA4, isLandscape, pixelsPerMm, marginTopMm, marginRightMm, marginBottomMm, marginLeftMm);

    let filename = document.getElementById('export-filename')?.value?.trim() || 'annotation';
    const dot = filename.lastIndexOf('.');
    if (dot !== -1) {
      const ext = filename.slice(dot).toLowerCase();
      if (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.pdf') {
        filename = filename.slice(0, dot);
      }
    }
    downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), `${filename}_${targetWidth}x${targetHeight}.pdf`);
  };
  imgEl.onerror = () => {
    URL.revokeObjectURL(url);
    alert('Failed to render image for PDF export.');
  };
  imgEl.src = url;
}

function findActualSizeMarker() {
  var re = /^(?:actual_size|real_size)_([\d_]+)\s*(mm|cm|in)$|^(?:actual-size|real-size)-([\d_]+)\s*(mm|cm|in)$/i;
  for (var i = 0; i < state.elements.length; i++) {
    var el = state.elements[i];
    if (el.type !== 'line') continue;
    var m = re.exec(el.id);
    if (!m) continue;
    var realValue = parseFloat((m[1] || m[3]).replace(/_/g, '.'));
    var unit = (m[2] || m[4]).toLowerCase();
    if (unit === 'cm') realValue *= 10;
    else if (unit === 'in') realValue *= 25.4;
    var pts = el.points || [{x: el.x1, y: el.y1}, {x: el.x2, y: el.y2}];
    var dx = pts[pts.length - 1].x - pts[0].x;
    var dy = pts[pts.length - 1].y - pts[0].y;
    var pixelLen = Math.sqrt(dx * dx + dy * dy);
    if (pixelLen < 1) continue;
    return { pixelsPerMm: pixelLen / realValue, pixelLen: pixelLen, realMm: realValue };
  }
  return null;
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
  if (!isLayerVisible('watermark-layer')) return '';
  if (!state.activeColor || state.activeColor === 'transparent') return '';
  var thickness = parseFloat(document.getElementById('wm-thickness').value) || 1;
  var color = state.activeColor;
  var rotation = parseFloat(document.getElementById('wm-rotation').value) || 45;
  return '<defs>\n<pattern id="watermark-pattern" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(' + rotation + ')">\n<path d="M 40 0 L 0 0 0 40" fill="none" stroke="' + color + '" stroke-width="' + thickness + '" opacity="0.4"/>\n</pattern>\n</defs>\n';
}

function buildPdf(srcCanvas, imgW, imgH, useA4, isLandscape, pixelsPerMm, marginTopMm, marginRightMm, marginBottomMm, marginLeftMm) {
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

  // ── Render all pages to JPEG ──
  var jpegs = [];

  if (hasRef) {
    var ref = document.createElement('canvas');
    ref.width = pgPxW;
    ref.height = pgPxH;
    var rctx = ref.getContext('2d');
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
    jpegs.push(base64ToBytes(ref.toDataURL('image/jpeg', 0.92).split(',')[1]));
  }

  for (var ti = 0; ti < numPages; ti++) {
    var t = tiles[ti];
    var c = document.createElement('canvas');
    c.width = pgPxW;
    c.height = pgPxH;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pgPxW, pgPxH);
    ctx.drawImage(srcCanvas, t.sx, t.sy, t.sw, t.sh, t.dx, t.dy, t.dw, t.dh);
    jpegs.push(base64ToBytes(c.toDataURL('image/jpeg', 0.92).split(',')[1]));
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

  // Build image objects (self-contained: header + JPEG binary + endstream/endobj)
  var imgObjOffsets = [];
  var imageObjs = [];
  for (var p = 0; p < totalPages; p++) {
    var iN = imgBase + p;
    var hdr = iN + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + pgPxW + ' /Height ' + pgPxH + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpegs[p].length + ' >>\nstream\n';
    var ftr = '\nendstream\nendobj';
    var hdrBytes = new TextEncoder().encode(hdr);
    var ftrBytes = new TextEncoder().encode(ftr);
    var obj = new Uint8Array(hdrBytes.length + jpegs[p].length + ftrBytes.length);
    obj.set(hdrBytes, 0);
    obj.set(jpegs[p], hdrBytes.length);
    obj.set(ftrBytes, hdrBytes.length + jpegs[p].length);
    imageObjs.push(obj);
  }

  // Convert text parts to bytes
  var textStr = textParts.join('\n');
  var textBytes = new TextEncoder().encode(textStr);

  // Compute image object offsets relative to file start
  var imgSectionStart = textBytes.length;
  for (var p = 0; p < totalPages; p++) {
    imgObjOffsets.push(imgSectionStart);
    imgSectionStart += imageObjs[p].length;
  }
  var imgSectionLen = imgSectionStart - textBytes.length;
  var xrefOffset = imgSectionStart;

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

  // Assemble final PDF
  var finalLen = textBytes.length + imgSectionLen + trailerBytes.length;
  var total = new Uint8Array(finalLen);
  var off = 0;
  total.set(textBytes, off); off += textBytes.length;
  for (var p = 0; p < totalPages; p++) {
    total.set(imageObjs[p], off); off += imageObjs[p].length;
  }
  total.set(trailerBytes, off);
  return total;
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
