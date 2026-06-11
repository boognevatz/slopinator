// ── File I/O module: Open, Save SVG, Export JPG ────────────────

import { state, dom, loadImage, restoreState, getViewBoxDims } from './editor.js';
import { addLineElement } from './line.js';
import { addTextElement } from './text.js';
import { clearHistory } from './history.js';
import { refreshPalette } from './palette.js';
import { downloadString, downloadBlob } from './utils.js';
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
    elements.push({
      id: g.id,
      type: 'line',
      x1: parseFloat(line.getAttribute('x1')),
      y1: parseFloat(line.getAttribute('y1')),
      x2: parseFloat(line.getAttribute('x2')),
      y2: parseFloat(line.getAttribute('y2')),
      stroke: line.getAttribute('stroke'),
      strokeWidth: parseFloat(line.getAttribute('stroke-width')),
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
      rotation: rotation,
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
      svg += `<g id="${el.id}" data-type="line">\n`;
      svg += `  <line class="annotation-line" x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" `;
      svg += `stroke="${el.stroke}" stroke-width="${el.strokeWidth}" stroke-linecap="round" />\n`;
      svg += `</g>\n`;
    } else if (el.type === 'text') {
      svg += `<text id="${el.id}" data-type="text" class="annotation-text" `;
      svg += `x="${el.x}" y="${el.y}" font-size="${el.fontSize}" fill="${el.fill}" font-family="sans-serif"`;
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
      svgStr += `<line x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" `;
      svgStr += `stroke="${el.stroke}" stroke-width="${el.strokeWidth}" stroke-linecap="round" />\n`;
    } else if (el.type === 'text') {
      svgStr += `<text x="${el.x}" y="${el.y}" font-size="${el.fontSize}" fill="${el.fill}" font-family="sans-serif"`;
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
