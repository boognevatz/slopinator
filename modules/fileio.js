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

export function initFileIO() {
  const fileInput = document.getElementById('file-input');
  const btnOpen = document.getElementById('btn-open');
  const btnOpenEmpty = document.getElementById('btn-open-empty');
  const btnSaveSvg = document.getElementById('btn-save-svg');
  const btnExportJpg = document.getElementById('btn-export-jpg');
  const exportMenu = document.getElementById('export-menu');
  const resizeNotification = document.getElementById('resize-notification');

  btnOpen.addEventListener('click', () => fileInput.click());
  btnOpenEmpty.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    handleFileOpen(file);
    fileInput.value = ''; // reset so same file can be re-opened
  });

  btnSaveSvg.addEventListener('click', saveSVG);

  // Export JPG dropdown
  btnExportJpg.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.hidden = !exportMenu.hidden;
  });

  document.addEventListener('click', () => {
    exportMenu.hidden = true;
  });

  exportMenu.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const width = btn.dataset.width;
      exportMenu.hidden = true;
      exportJPG(width);
    });
  });

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

  // Hide notification on any tool usage
  document.getElementById('editor-svg').addEventListener('mousedown', () => {
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
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || 800;
      canvas.height = img.naturalHeight || 600;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const dataURI = canvas.toDataURL('image/png');
      loadImage(dataURI, canvas.width, canvas.height);
      clearHistory();
      switchTool('text');
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
  svg += `<!-- annotator-thickness: ${state.thicknessPresets.join(',')} -->\n`;

  // Image
  const img = state.image;
  const imgTransform = dom.imageEl.getAttribute('transform') || '';
  svg += `<image data-type="background" href="${img.dataURI}" `;
  svg += `x="0" y="0" width="${img.naturalWidth}" height="${img.naturalHeight}" `;
  svg += `transform="${imgTransform}" />\n`;

  // Annotations
  svg += `<g id="annotation-layer" transform="${imgTransform}">\n`;
  for (const el of state.elements) {
    if (el.type === 'line') {
      const pts = el.points || [{x: el.x1, y: el.y1}, {x: el.x2, y: el.y2}];
      if (pts.length >= 3) {
        svg += `<polyline id="${el.id}" data-type="line" data-line-style="${normalizeLineStyle(el.lineStyle)}" data-line-marker-size="${normalizeLineMarkerSize(el.lineMarkerSize)}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round" points="${pts.map(p => `${p.x},${p.y}`).join(' ')}" />\n`;
      } else {
        svg += `<g id="${el.id}" data-type="line" data-line-style="${normalizeLineStyle(el.lineStyle)}" data-line-marker-size="${normalizeLineMarkerSize(el.lineMarkerSize)}">\n`;
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
  svgStr += `<image href="${img.dataURI}" `;
  svgStr += `x="0" y="0" width="${img.naturalWidth}" height="${img.naturalHeight}" `;
  svgStr += `transform="${imgTransform}" />\n`;

  // Annotations
  svgStr += `<g transform="${imgTransform}">\n`;
  for (const el of state.elements) {
    if (el.type === 'line') {
      const pts = el.points || [{x: el.x1, y: el.y1}, {x: el.x2, y: el.y2}];
      if (pts.length >= 3) {
        svgStr += `<polyline data-type="line" data-line-style="${normalizeLineStyle(el.lineStyle)}" data-line-marker-size="${normalizeLineMarkerSize(el.lineMarkerSize)}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round" points="${pts.map(p => `${p.x},${p.y}`).join(' ')}" />\n`;
      } else {
        svgStr += `<g data-type="line" data-line-style="${normalizeLineStyle(el.lineStyle)}" data-line-marker-size="${normalizeLineMarkerSize(el.lineMarkerSize)}">\n`;
        svgStr += `  <line data-line-style="${normalizeLineStyle(el.lineStyle)}" data-line-marker-size="${normalizeLineMarkerSize(el.lineMarkerSize)}" x1="${pts[0].x}" y1="${pts[0].y}" x2="${pts[1].x}" y2="${pts[1].y}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" />\n`;
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
        downloadBlob(blob, `annotation_${targetWidth}x${targetHeight}.jpg`);
      }
    }, 'image/jpeg', 0.92);
  };
  imgEl.onerror = () => {
    URL.revokeObjectURL(url);
    alert('Failed to render image for export. This can happen due to browser security restrictions.');
  };
  imgEl.src = url;
}

// ── Helpers ─────────────────────────────────────────────────────

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
