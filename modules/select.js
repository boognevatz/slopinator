// ── Select module: Selection, move, resize, delete ─────────────

import { state, dom } from './editor.js';
import { svgEl, screenToSVG } from './utils.js';
import { pushAction } from './history.js';
import { startEditing, isEditing } from './text.js';

let isDragging = false;
let isResizing = false;
let dragStart = null;
let dragOriginal = null;
let resizeHandle = null; // 'p1' | 'p2' for line endpoints, 'br' for text resize

export function initSelect() {
  // Listen for color/thickness changes on selected element
  document.addEventListener('palette-color-changed', (e) => {
    applyColorToSelected(e.detail.color);
  });
  document.addEventListener('palette-thickness-changed', (e) => {
    applyThicknessToSelected(e.detail.thickness);
  });

  // Font size input
  const fontSizeInput = document.getElementById('font-size-input');
  fontSizeInput.addEventListener('change', () => {
    const val = parseFloat(fontSizeInput.value);
    if (isNaN(val) || val < 1) return;
    state.activeFontSize = val;
    applyFontSizeToSelected(val);
  });
}

export function activateSelect() {
  dom.svg.style.cursor = 'default';
  dom.svg.addEventListener('mousedown', onMouseDown);
}

export function deactivateSelect() {
  dom.svg.style.cursor = '';
  dom.svg.removeEventListener('mousedown', onMouseDown);
  clearSelection();
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  if (isEditing()) return;

  const target = e.target;
  const pt = screenToSVG(dom.svg, e.clientX, e.clientY);

  // Check if clicking a handle
  if (target.classList.contains('handle')) {
    e.preventDefault();
    e.stopPropagation();
    startResize(target, pt, e);
    return;
  }

  // Check if clicking an annotation
  const annotGroup = findAnnotationParent(target);
  if (annotGroup) {
    e.preventDefault();
    const id = annotGroup.id;

    // Double-click on text → edit (defer to next frame so mousedown
    // processing completes and doesn't steal focus from the textarea)
    if (e.detail === 2) {
      const data = state.elements.find(el => el.id === id);
      if (data && data.type === 'text') {
        setTimeout(() => startEditing(id), 0);
        return;
      }
    }

    selectElement(id);
    startDrag(id, pt);
    return;
  }

  // Clicked empty space → deselect
  clearSelection();
}

function findAnnotationParent(target) {
  let el = target;
  while (el && el !== dom.svg) {
    if (el.dataset && el.dataset.type === 'line') return el;
    if (el.dataset && el.dataset.type === 'text') return el;
    el = el.parentElement;
  }
  return null;
}

// ── Selection ───────────────────────────────────────────────────

export function selectElement(id) {
  clearSelection();
  state.selectedId = id;

  const data = state.elements.find(el => el.id === id);
  if (!data) return;

  // Update active color/thickness from selected element
  if (data.type === 'line') {
    state.activeColor = data.stroke;
    state.activeThickness = data.strokeWidth;
    document.getElementById('font-size-group').hidden = true;
  } else if (data.type === 'text') {
    state.activeColor = data.fill;
    state.activeFontSize = data.fontSize;
    document.getElementById('font-size-group').hidden = false;
    document.getElementById('font-size-input').value = data.fontSize;
  }

  drawHandles(data);
  document.getElementById('btn-delete').disabled = false;

  // Dispatch event so palette highlights update
  document.dispatchEvent(new CustomEvent('selection-changed', { detail: { id, data } }));
}

export function clearSelection() {
  state.selectedId = null;
  dom.handleLayer.innerHTML = '';
  document.getElementById('btn-delete').disabled = true;
  document.getElementById('font-size-group').hidden = state.activeTool !== 'text';
}

function drawHandles(data) {
  dom.handleLayer.innerHTML = '';

  if (data.type === 'line') {
    drawLineHandles(data);
  } else if (data.type === 'text') {
    drawTextHandles(data);
  }
}

function drawLineHandles(data) {
  // Endpoint handles
  const r = getHandleRadius();

  const h1 = svgEl('circle', {
    cx: data.x1, cy: data.y1, r,
    class: 'handle handle-endpoint',
    'data-handle': 'p1',
  });
  const h2 = svgEl('circle', {
    cx: data.x2, cy: data.y2, r,
    class: 'handle handle-endpoint',
    'data-handle': 'p2',
  });

  dom.handleLayer.appendChild(h1);
  dom.handleLayer.appendChild(h2);

  // Midpoint move handle
  const mx = (data.x1 + data.x2) / 2;
  const my = (data.y1 + data.y2) / 2;
  const hm = svgEl('rect', {
    x: mx - r, y: my - r, width: r * 2, height: r * 2,
    class: 'handle handle-move',
    'data-handle': 'move',
  });
  dom.handleLayer.appendChild(hm);
}

function drawTextHandles(data) {
  // Get bounding box of the text element
  const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(data.id)}`);
  if (!textEl) return;

  let bbox;
  try {
    bbox = textEl.getBBox();
  } catch {
    return;
  }

  const r = getHandleRadius();

  // Dashed selection box
  const rect = svgEl('rect', {
    x: bbox.x - 4, y: bbox.y - 4,
    width: bbox.width + 8, height: bbox.height + 8,
    class: 'selection-box',
  });
  dom.handleLayer.appendChild(rect);

  // Move handle (top-left)
  const hm = svgEl('rect', {
    x: bbox.x - 4 - r, y: bbox.y - 4 - r,
    width: r * 2, height: r * 2,
    class: 'handle handle-move',
    'data-handle': 'move',
  });
  dom.handleLayer.appendChild(hm);

  // Resize handle (bottom-right)
  const hr = svgEl('rect', {
    x: bbox.x + bbox.width + 4 - r, y: bbox.y + bbox.height + 4 - r,
    width: r * 2, height: r * 2,
    class: 'handle handle-resize',
    'data-handle': 'br',
  });
  dom.handleLayer.appendChild(hr);
}

function getHandleRadius() {
  // Scale handle size based on viewBox so they look consistent
  const viewBox = dom.svg.viewBox.baseVal;
  if (!viewBox || viewBox.width === 0) return 6;
  const svgRect = dom.svg.getBoundingClientRect();
  const scale = viewBox.width / svgRect.width;
  return Math.max(4, 6 * scale);
}

// ── Drag (move) ─────────────────────────────────────────────────

function startDrag(id, startPt) {
  const data = state.elements.find(el => el.id === id);
  if (!data) return;

  isDragging = true;
  dragStart = startPt;
  dragOriginal = { ...data };

  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e) {
  if (!isDragging) return;
  const pt = screenToSVG(dom.svg, e.clientX, e.clientY);
  const dx = pt.x - dragStart.x;
  const dy = pt.y - dragStart.y;
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data) return;

  if (data.type === 'line') {
    data.x1 = dragOriginal.x1 + dx;
    data.y1 = dragOriginal.y1 + dy;
    data.x2 = dragOriginal.x2 + dx;
    data.y2 = dragOriginal.y2 + dy;
    updateLineSVG(data);
  } else if (data.type === 'text') {
    data.x = dragOriginal.x + dx;
    data.y = dragOriginal.y + dy;
    updateTextSVG(data);
  }

  drawHandles(data);
}

function onDragEnd() {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);

  if (!isDragging) return;
  isDragging = false;

  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data) return;

  const orig = { ...dragOriginal };
  const final = { ...data };

  // Only push to history if actually moved
  if (data.type === 'line' && (orig.x1 !== final.x1 || orig.y1 !== final.y1)) {
    pushAction({
      description: 'Move line',
      doFn: () => { Object.assign(data, { x1: final.x1, y1: final.y1, x2: final.x2, y2: final.y2 }); updateLineSVG(data); drawHandles(data); },
      undoFn: () => { Object.assign(data, { x1: orig.x1, y1: orig.y1, x2: orig.x2, y2: orig.y2 }); updateLineSVG(data); drawHandles(data); },
    });
  } else if (data.type === 'text' && (orig.x !== final.x || orig.y !== final.y)) {
    pushAction({
      description: 'Move text',
      doFn: () => { data.x = final.x; data.y = final.y; updateTextSVG(data); drawHandles(data); },
      undoFn: () => { data.x = orig.x; data.y = orig.y; updateTextSVG(data); drawHandles(data); },
    });
  }

  dragOriginal = null;
}

// ── Resize ──────────────────────────────────────────────────────

function startResize(handleEl, startPt, e) {
  e.preventDefault();
  const handleType = handleEl.dataset.handle;

  if (handleType === 'move') {
    // Treat move handle as drag
    startDrag(state.selectedId, startPt);
    return;
  }

  isResizing = true;
  resizeHandle = handleType;
  dragStart = startPt;

  const data = state.elements.find(el => el.id === state.selectedId);
  if (data) dragOriginal = { ...data };

  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeEnd);
}

function onResizeMove(e) {
  if (!isResizing) return;
  const pt = screenToSVG(dom.svg, e.clientX, e.clientY);
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data) return;

  if (data.type === 'line') {
    if (resizeHandle === 'p1') {
      data.x1 = pt.x;
      data.y1 = pt.y;
    } else if (resizeHandle === 'p2') {
      data.x2 = pt.x;
      data.y2 = pt.y;
    }
    updateLineSVG(data);
  } else if (data.type === 'text' && resizeHandle === 'br') {
    // Resize text by changing font size proportionally to drag distance
    // Use ratio-based scaling: distance from text origin determines scale factor
    const origBboxH = dragOriginal.fontSize; // approximate height
    const dy = pt.y - dragStart.y;
    const scaleFactor = 1 + dy / Math.max(origBboxH, 20);
    const newSize = Math.max(8, Math.round(dragOriginal.fontSize * scaleFactor));
    data.fontSize = newSize;
    updateTextSVG(data);
    document.getElementById('font-size-input').value = data.fontSize;
  }

  drawHandles(data);
}

function onResizeEnd() {
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeEnd);

  if (!isResizing) return;
  isResizing = false;

  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data) return;

  const orig = { ...dragOriginal };
  const final = { ...data };

  if (data.type === 'line') {
    pushAction({
      description: 'Resize line',
      doFn: () => { Object.assign(data, { x1: final.x1, y1: final.y1, x2: final.x2, y2: final.y2 }); updateLineSVG(data); drawHandles(data); },
      undoFn: () => { Object.assign(data, { x1: orig.x1, y1: orig.y1, x2: orig.x2, y2: orig.y2 }); updateLineSVG(data); drawHandles(data); },
    });
  } else if (data.type === 'text' && orig.fontSize !== final.fontSize) {
    pushAction({
      description: 'Resize text',
      doFn: () => { data.fontSize = final.fontSize; updateTextSVG(data); drawHandles(data); },
      undoFn: () => { data.fontSize = orig.fontSize; updateTextSVG(data); drawHandles(data); },
    });
  }

  dragOriginal = null;
}

// ── Delete ──────────────────────────────────────────────────────

export function deleteSelected() {
  if (!state.selectedId) return;
  const id = state.selectedId;
  const idx = state.elements.findIndex(el => el.id === id);
  if (idx === -1) return;

  const data = { ...state.elements[idx] };
  state.elements.splice(idx, 1);

  const el = dom.annotationLayer.querySelector(`#${CSS.escape(id)}`);
  if (el) el.remove();

  clearSelection();

  pushAction({
    description: 'Delete element',
    doFn: () => {
      const i = state.elements.findIndex(e => e.id === id);
      if (i !== -1) state.elements.splice(i, 1);
      const svgEl = dom.annotationLayer.querySelector(`#${CSS.escape(id)}`);
      if (svgEl) svgEl.remove();
      if (state.selectedId === id) clearSelection();
    },
    undoFn: () => {
      state.elements.splice(idx, 0, data);
      if (data.type === 'line') {
        addLineSVGAtIndex(data, idx);
      } else if (data.type === 'text') {
        addTextSVGAtIndex(data, idx);
      }
    },
  });
}

function addLineSVGAtIndex(data, _idx) {
  // Re-import to avoid circular dep issues at module level
  const { addLineElement } = _lineModule;
  addLineElement(data);
}

function addTextSVGAtIndex(data, _idx) {
  const { addTextElement } = _textModule;
  addTextElement(data);
}

// We'll set these from app.js to avoid circular imports
let _lineModule = {};
let _textModule = {};

export function setModuleRefs(lineMod, textMod) {
  _lineModule = lineMod;
  _textModule = textMod;
}

// ── SVG Update Helpers ──────────────────────────────────────────

function updateLineSVG(data) {
  const group = dom.annotationLayer.querySelector(`#${CSS.escape(data.id)}`);
  if (!group) return;
  const lines = group.querySelectorAll('line');
  lines.forEach(line => {
    line.setAttribute('x1', data.x1);
    line.setAttribute('y1', data.y1);
    line.setAttribute('x2', data.x2);
    line.setAttribute('y2', data.y2);
  });
  // Update visible line style
  const visibleLine = group.querySelector('.annotation-line');
  if (visibleLine) {
    visibleLine.setAttribute('stroke', data.stroke);
    visibleLine.setAttribute('stroke-width', data.strokeWidth);
  }
}

function updateTextSVG(data) {
  const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(data.id)}`);
  if (!textEl) return;
  textEl.setAttribute('x', data.x);
  textEl.setAttribute('y', data.y);
  textEl.setAttribute('font-size', data.fontSize);
  textEl.setAttribute('fill', data.fill);
  textEl.textContent = data.content;
}

// ── Apply property changes to selected ──────────────────────────

function applyColorToSelected(color) {
  if (!state.selectedId) return;
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data) return;

  const oldColor = data.type === 'line' ? data.stroke : data.fill;
  if (oldColor === color) return;

  if (data.type === 'line') {
    data.stroke = color;
    updateLineSVG(data);
  } else if (data.type === 'text') {
    data.fill = color;
    updateTextSVG(data);
  }

  pushAction({
    description: 'Change color',
    doFn: () => {
      if (data.type === 'line') { data.stroke = color; updateLineSVG(data); }
      else { data.fill = color; updateTextSVG(data); }
    },
    undoFn: () => {
      if (data.type === 'line') { data.stroke = oldColor; updateLineSVG(data); }
      else { data.fill = oldColor; updateTextSVG(data); }
    },
  });
}

function applyThicknessToSelected(thickness) {
  if (!state.selectedId) return;
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data || data.type !== 'line') return;

  const oldThickness = data.strokeWidth;
  if (oldThickness === thickness) return;

  data.strokeWidth = thickness;
  updateLineSVG(data);

  pushAction({
    description: 'Change thickness',
    doFn: () => { data.strokeWidth = thickness; updateLineSVG(data); },
    undoFn: () => { data.strokeWidth = oldThickness; updateLineSVG(data); },
  });
}

function applyFontSizeToSelected(fontSize) {
  if (!state.selectedId) return;
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data || data.type !== 'text') return;

  const oldSize = data.fontSize;
  if (oldSize === fontSize) return;

  data.fontSize = fontSize;
  updateTextSVG(data);
  drawHandles(data);

  pushAction({
    description: 'Change font size',
    doFn: () => { data.fontSize = fontSize; updateTextSVG(data); },
    undoFn: () => { data.fontSize = oldSize; updateTextSVG(data); },
  });
}

/**
 * Refresh handles for the currently selected element (e.g., after undo/redo).
 */
export function refreshSelection() {
  if (!state.selectedId) {
    clearSelection();
    return;
  }
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data) {
    clearSelection();
    return;
  }
  drawHandles(data);
}
