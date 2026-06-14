// ── Crop module: Image cropping ───────────────────────────────

import { state, dom, updateViewBox, updateImageTransform } from './editor.js';
import { svgEl, screenToCoords } from './utils.js';
import { pushAction, clearHistory } from './history.js';
import { switchTool } from './tools.js';

let isCropping = false;
let isDragging = false;
let isResizing = false;
let dragStart = null;
let resizeHandle = null;
let dragOriginal = null;

let cropBox = null;
let cropAspectMode = null; // null | 'original' | '4:3' | '16:9'

const MIN_CROP_SIZE = 10;

const cropUI = {
  widthInput: null,
  heightInput: null,
  ratioOriginal: null,
  ratio43: null,
  ratio169: null,
};

export function initCrop() {
  cropUI.widthInput = document.getElementById('crop-width-input');
  cropUI.heightInput = document.getElementById('crop-height-input');
  cropUI.ratioOriginal = document.getElementById('crop-ratio-original');
  cropUI.ratio43 = document.getElementById('crop-ratio-4-3');
  cropUI.ratio169 = document.getElementById('crop-ratio-16-9');

  cropUI.widthInput.addEventListener('input', () => onCropSizeInput('width'));
  cropUI.heightInput.addEventListener('input', () => onCropSizeInput('height'));

  cropUI.ratioOriginal.addEventListener('change', () => onCropRatioToggle('original'));
  cropUI.ratio43.addEventListener('change', () => onCropRatioToggle('4:3'));
  cropUI.ratio169.addEventListener('change', () => onCropRatioToggle('16:9'));
}

export function activateCrop() {
  isCropping = true;
  dom.svg.style.cursor = 'crosshair';
  
  if (!state.hasImage) return;

  const w = state.image.naturalWidth;
  const h = state.image.naturalHeight;
  
  // Default crop box: 90% of image centered
  if (!cropBox) {
    cropBox = {
      x: w * 0.05,
      y: h * 0.05,
      width: w * 0.9,
      height: h * 0.9,
    };
  } else {
    // clamp existing crop box to new image dimensions if it was left over
    cropBox.x = Math.max(0, Math.min(cropBox.x, w - 10));
    cropBox.y = Math.max(0, Math.min(cropBox.y, h - 10));
    cropBox.width = Math.min(cropBox.width, w - cropBox.x);
    cropBox.height = Math.min(cropBox.height, h - cropBox.y);
  }

  const ratio = getActiveCropRatio();
  if (ratio) {
    setCropBoxSize(cropBox.width, cropBox.width / ratio);
  }

  syncCropControls();

  dom.svg.addEventListener('pointerdown', onMouseDown);
  drawCropOverlay();
}

export function deactivateCrop() {
  isCropping = false;
  dom.svg.style.cursor = '';
  dom.svg.removeEventListener('pointerdown', onMouseDown);
  
  // Clean up UI
  const overlay = dom.handleLayer.querySelector('#crop-overlay-group');
  if (overlay) overlay.remove();
}

function drawCropOverlay() {
  if (!isCropping || !state.hasImage) return;

  let group = dom.handleLayer.querySelector('#crop-overlay-group');
  if (!group) {
    group = svgEl('g', { id: 'crop-overlay-group' });
    dom.handleLayer.appendChild(group);
  }
  group.innerHTML = ''; // clear

  const { x, y, width, height } = cropBox;

  // Draw semi-transparent mask
  const w = state.image.naturalWidth;
  const h = state.image.naturalHeight;
  
  const pathData = `M0,0 H${w} V${h} H0 Z M${x},${y} V${y+height} H${x+width} V${y} Z`;
  const mask = svgEl('path', {
    d: pathData,
    fill: 'rgba(0, 0, 0, 0.5)',
    'fill-rule': 'evenodd',
    'pointer-events': 'none'
  });
  group.appendChild(mask);

  // Dashed box
  const selBox = svgEl('rect', {
    x, y, width, height,
    class: 'selection-box',
    'data-handle': 'move',
    style: 'cursor: move; pointer-events: all; fill: rgba(255,255,255,0.01);'
  });
  group.appendChild(selBox);

  // 4 corner handles
  const size = Math.min(width, height) * 0.1; // 10% is good for crop, 30% is too big for full screen
  const hw = Math.max(10, size); // min 10px in image coords
  const hh = hw;

  const corners = [
    { handle: 'tl', cx: x, cy: y, cursor: 'nwse-resize' },
    { handle: 'tr', cx: x + width, cy: y, cursor: 'nesw-resize' },
    { handle: 'bl', cx: x, cy: y + height, cursor: 'nesw-resize' },
    { handle: 'br', cx: x + width, cy: y + height, cursor: 'nwse-resize' },
  ];

  for (const c of corners) {
    const hRect = svgEl('rect', {
      x: c.cx - hw/2, y: c.cy - hh/2, width: hw, height: hh,
      class: 'handle handle-resize-corner',
      'data-handle': c.handle,
      style: `cursor: ${c.cursor}`,
    });
    group.appendChild(hRect);
  }

  // Label in the middle
  const labelGroup = svgEl('g', {
    transform: `translate(${x + width/2}, ${y + height/2})`,
    style: 'cursor: pointer;',
    'data-handle': 'apply-crop'
  });
  
  const text = svgEl('text', {
    x: 0, y: 0,
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    fill: 'white',
    'font-size': Math.max(16, height * 0.1) + 'px',
    'font-family': 'sans-serif',
    'font-weight': 'bold',
    'pointer-events': 'none',
    style: 'text-shadow: 1px 1px 3px black;'
  });
  text.textContent = `${Math.round(width)} × ${Math.round(height)} (Click to Crop)`;
  
  // Add a rect behind the text to make it clickable easily
  const textBg = svgEl('rect', {
    x: -width/2, y: -height*0.1, width: width, height: height*0.2,
    fill: 'transparent',
    'pointer-events': 'all'
  });

  labelGroup.appendChild(textBg);
  labelGroup.appendChild(text);
  group.appendChild(labelGroup);

  syncCropControls();
}

function onMouseDown(e) {
  if (e.button !== 0) return;

  const target = e.target;
  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);

  const handleEl = target.closest ? target.closest('[data-handle]') : null;
  if (handleEl) {
    e.preventDefault();
    e.stopPropagation();

    const handle = handleEl.dataset.handle;
    
    if (handle === 'apply-crop') {
      applyCrop();
      return;
    }

    if (handle === 'move') {
      isDragging = true;
    } else {
      isResizing = true;
      resizeHandle = handle;
    }

    dragStart = pt;
    dragOriginal = { ...cropBox };

    document.addEventListener('pointermove', onMouseMove);
    document.addEventListener('pointerup', onMouseUp);
    return;
  }

  const cropOverlay = target.closest ? target.closest('#crop-overlay-group') : null;
  if (cropOverlay) {
    e.preventDefault();
    isDragging = true;
    dragStart = pt;
    dragOriginal = { ...cropBox };
    document.addEventListener('pointermove', onMouseMove);
    document.addEventListener('pointerup', onMouseUp);
  }
}

function onMouseMove(e) {
  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  const dx = pt.x - dragStart.x;
  const dy = pt.y - dragStart.y;

  const w = state.image.naturalWidth;
  const h = state.image.naturalHeight;

  if (isDragging) {
    let newX = dragOriginal.x + dx;
    let newY = dragOriginal.y + dy;
    
    // Clamp
    newX = Math.max(0, Math.min(newX, w - cropBox.width));
    newY = Math.max(0, Math.min(newY, h - cropBox.height));
    
    cropBox.x = newX;
    cropBox.y = newY;
  } else if (isResizing) {
    resizeCropBoxFromDrag(pt);
  }

  clampCropBoxToImage();
  syncCropControls();
  drawCropOverlay();
}

function onMouseUp(e) {
  document.removeEventListener('pointermove', onMouseMove);
  document.removeEventListener('pointerup', onMouseUp);
  isDragging = false;
  isResizing = false;
}

function onCropSizeInput(source) {
  if (!cropBox || !state.hasImage) return;

  const widthVal = parseFloat(cropUI.widthInput.value);
  const heightVal = parseFloat(cropUI.heightInput.value);
  if (Number.isNaN(widthVal) || Number.isNaN(heightVal)) return;

  const ratio = getActiveCropRatio();
  let nextWidth = Math.max(MIN_CROP_SIZE, widthVal);
  let nextHeight = Math.max(MIN_CROP_SIZE, heightVal);

  if (ratio) {
    if (source === 'width') {
      nextHeight = nextWidth / ratio;
    } else {
      nextWidth = nextHeight * ratio;
    }
  }

  setCropBoxSize(nextWidth, nextHeight);
  drawCropOverlay();
}

function onCropRatioToggle(mode) {
  const checkbox = getRatioCheckbox(mode);
  if (!checkbox.checked) {
    if (cropAspectMode === mode) {
      cropAspectMode = null;
    syncCropRatioChecks();
  }
    return;
  }

  cropAspectMode = mode;
  syncCropRatioChecks(mode);

  if (cropBox) {
    const ratio = getActiveCropRatio();
    if (ratio) {
      const nextWidth = cropBox.width;
      setCropBoxSize(nextWidth, nextWidth / ratio);
      drawCropOverlay();
    }
  }
}

function getRatioCheckbox(mode) {
  if (mode === 'original') return cropUI.ratioOriginal;
  if (mode === '4:3') return cropUI.ratio43;
  return cropUI.ratio169;
}

function syncCropRatioChecks(activeMode = cropAspectMode) {
  cropUI.ratioOriginal.checked = activeMode === 'original';
  cropUI.ratio43.checked = activeMode === '4:3';
  cropUI.ratio169.checked = activeMode === '16:9';
}

function getActiveCropRatio() {
  if (!state.hasImage || !cropAspectMode) return null;
  if (cropAspectMode === 'original') {
    return state.image.naturalWidth / state.image.naturalHeight;
  }
  if (cropAspectMode === '4:3') return 4 / 3;
  if (cropAspectMode === '16:9') return 16 / 9;
  return null;
}

function syncCropControls() {
  if (!cropUI.widthInput || !cropUI.heightInput) return;
  if (!cropBox) return;

  cropUI.widthInput.value = Math.round(cropBox.width);
  cropUI.heightInput.value = Math.round(cropBox.height);
  syncCropRatioChecks();
}

function setCropBoxSize(width, height) {
  if (!state.hasImage || !cropBox) return;

  const imgW = state.image.naturalWidth;
  const imgH = state.image.naturalHeight;
  const centerX = cropBox.x + cropBox.width / 2;
  const centerY = cropBox.y + cropBox.height / 2;
  const ratio = getActiveCropRatio();

  let newW = Math.max(MIN_CROP_SIZE, Math.min(width, imgW));
  let newH = Math.max(MIN_CROP_SIZE, Math.min(height, imgH));

  if (ratio) {
    const scale = Math.min(imgW / newW, imgH / newH, 1);
    newW *= scale;
    newH *= scale;
  }

  cropBox.width = newW;
  cropBox.height = newH;
  cropBox.x = centerX - newW / 2;
  cropBox.y = centerY - newH / 2;

  clampCropBoxToImage();
}

function clampCropBoxToImage() {
  if (!cropBox || !state.hasImage) return;

  const imgW = state.image.naturalWidth;
  const imgH = state.image.naturalHeight;

  cropBox.width = Math.max(MIN_CROP_SIZE, Math.min(cropBox.width, imgW));
  cropBox.height = Math.max(MIN_CROP_SIZE, Math.min(cropBox.height, imgH));

  cropBox.x = Math.max(0, Math.min(cropBox.x, imgW - cropBox.width));
  cropBox.y = Math.max(0, Math.min(cropBox.y, imgH - cropBox.height));
}

function resizeCropBoxFromDrag(pt) {
  const imgW = state.image.naturalWidth;
  const imgH = state.image.naturalHeight;
  const ratio = getActiveCropRatio();

  const box = { ...dragOriginal };

  if (ratio) {
    applyRatioResize(box, pt, ratio);
  } else {
    applyFreeResize(box, pt);
  }

  if (ratio) {
    const scale = Math.min(imgW / box.width, imgH / box.height, 1);
    box.width *= scale;
    box.height *= scale;
  }

  box.width = Math.max(MIN_CROP_SIZE, Math.min(box.width, imgW));
  box.height = Math.max(MIN_CROP_SIZE, Math.min(box.height, imgH));

  box.x = Math.max(0, Math.min(box.x, imgW - box.width));
  box.y = Math.max(0, Math.min(box.y, imgH - box.height));

  cropBox = box;
}

function applyFreeResize(box, pt) {
  if (resizeHandle.includes('l')) {
    const x2 = dragOriginal.x + dragOriginal.width;
    box.x = Math.max(0, Math.min(pt.x, x2 - MIN_CROP_SIZE));
    box.width = x2 - box.x;
  }
  if (resizeHandle.includes('r')) {
    box.width = Math.max(MIN_CROP_SIZE, pt.x - dragOriginal.x);
  }
  if (resizeHandle.includes('t')) {
    const y2 = dragOriginal.y + dragOriginal.height;
    box.y = Math.max(0, Math.min(pt.y, y2 - MIN_CROP_SIZE));
    box.height = y2 - box.y;
  }
  if (resizeHandle.includes('b')) {
    box.height = Math.max(MIN_CROP_SIZE, pt.y - dragOriginal.y);
  }
}

function applyRatioResize(box, pt, ratio) {
  const left = dragOriginal.x;
  const right = dragOriginal.x + dragOriginal.width;
  const top = dragOriginal.y;
  const bottom = dragOriginal.y + dragOriginal.height;

  let width;
  let height;

  if (resizeHandle === 'br') {
    width = Math.max(MIN_CROP_SIZE, pt.x - left);
    height = width / ratio;
    if (height > pt.y - top) {
      height = Math.max(MIN_CROP_SIZE, pt.y - top);
      width = height * ratio;
    }
    box.x = left;
    box.y = top;
  } else if (resizeHandle === 'bl') {
    width = Math.max(MIN_CROP_SIZE, right - pt.x);
    height = width / ratio;
    if (height > pt.y - top) {
      height = Math.max(MIN_CROP_SIZE, pt.y - top);
      width = height * ratio;
    }
    box.x = right - width;
    box.y = top;
  } else if (resizeHandle === 'tr') {
    width = Math.max(MIN_CROP_SIZE, pt.x - left);
    height = width / ratio;
    if (height > bottom - pt.y) {
      height = Math.max(MIN_CROP_SIZE, bottom - pt.y);
      width = height * ratio;
    }
    box.x = left;
    box.y = bottom - height;
  } else if (resizeHandle === 'tl') {
    width = Math.max(MIN_CROP_SIZE, right - pt.x);
    height = width / ratio;
    if (height > bottom - pt.y) {
      height = Math.max(MIN_CROP_SIZE, bottom - pt.y);
      width = height * ratio;
    }
    box.x = right - width;
    box.y = bottom - height;
  }

  box.width = width;
  box.height = height;
}

function applyCrop() {
  if (!state.hasImage) return;

  const { x, y, width, height } = cropBox;
  const targetW = Math.round(width);
  const targetH = Math.round(height);
  const startX = Math.round(x);
  const startY = Math.round(y);

  if (targetW <= 0 || targetH <= 0) return;

  // We must render the current image to a canvas, crop it, and save the base64.
  // BUT we must also keep the old image base64 for Undo!
  
  const oldDataURI = state.image.dataURI;
  const oldW = state.image.naturalWidth;
  const oldH = state.image.naturalHeight;
  
  // Clone current elements because their coordinates will shift
  const oldElements = JSON.parse(JSON.stringify(state.elements));

  const imgEl = new Image();
  imgEl.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    
    // Draw cropped portion
    ctx.drawImage(imgEl, startX, startY, targetW, targetH, 0, 0, targetW, targetH);
    
    const newDataURI = canvas.toDataURL('image/jpeg', 0.92);
    
    // Create new elements array shifted by -startX, -startY
    const newElements = oldElements.map(el => {
      const newEl = { ...el };
      if (newEl.type === 'line') {
        newEl.x1 -= startX;
        newEl.y1 -= startY;
        newEl.x2 -= startX;
        newEl.y2 -= startY;
      } else if (newEl.type === 'text') {
        newEl.x -= startX;
        newEl.y -= startY;
      }
      return newEl;
    });

    // We use a custom do/undo action so it seamlessly replaces the image
    pushAction({
      description: 'Crop Image',
      doFn: () => {
        executeCrop(newDataURI, targetW, targetH, newElements);
      },
      undoFn: () => {
        executeCrop(oldDataURI, oldW, oldH, oldElements);
      }
    });

    // Execute immediately
    executeCrop(newDataURI, targetW, targetH, newElements);
    
    // Reset crop box for next time
    cropBox = null;
    switchTool('select');
  };
  imgEl.src = state.image.dataURI;
}

let _lineModule = {};
let _textModule = {};

export function setCropModuleRefs(lineMod, textMod) {
  _lineModule = lineMod;
  _textModule = textMod;
}

function executeCrop(dataURI, w, h, elements) {
  state.image.dataURI = dataURI;
  state.image.naturalWidth = w;
  state.image.naturalHeight = h;
  
  dom.imageEl.setAttribute('href', dataURI);
  dom.imageEl.setAttribute('width', w);
  dom.imageEl.setAttribute('height', h);
  
  state.elements = elements;
  
  dom.annotationLayer.innerHTML = '';
  dom.handleLayer.innerHTML = '';
  
  for (const el of elements) {
    if (el.type === 'line' && _lineModule.addLineElement) {
      _lineModule.addLineElement(el);
    } else if (el.type === 'text' && _textModule.addTextElement) {
      _textModule.addTextElement(el);
    }
  }
  
  // We need to trigger a view update
  state.image.fitScale = null;
  updateViewBox();
  updateImageTransform();
}
