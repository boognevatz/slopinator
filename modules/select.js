// ── Select module: Selection, move, resize, delete ─────────────

import { state, dom } from './editor.js';
import { svgEl, screenToSVG } from './utils.js';
import { pushAction } from './history.js';
import { startEditing, isEditing } from './text.js';

let isDragging = false;
let isResizing = false;
let dragStart = null;
let dragOriginal = null;
let resizeHandle = null; // 'p1' | 'p2' for line endpoints, 'tl'|'tr'|'bl'|'br' for text corners
let resizeAnchor = null; // { x, y } — the fixed corner during text resize
let origBbox = null;     // original text bounding box at resize start
let origBaselineOffY = 0; // data.y - bbox.y at resize start
let origBaselineOffX = 0; // data.x - bbox.x at resize start
let origDiagLen = 0;      // diagonal length of original bbox
let origDiagVec = null;   // unit vector along anchor → dragged corner

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

  const pad = 4;
  const bx = bbox.x - pad;
  const by = bbox.y - pad;
  const bw = bbox.width + pad * 2;
  const bh = bbox.height + pad * 2;

  // Dashed selection box
  const selBox = svgEl('rect', {
    x: bx, y: by, width: bw, height: bh,
    class: 'selection-box',
  });
  dom.handleLayer.appendChild(selBox);

  // 4 corner resize handles, square, 30% of the longest edge
  const size = Math.min(bw, bh) * 0.3;
  const hw = size;
  const hh = size;

  const corners = [
    { handle: 'tl', x: bx,            y: by,            cursor: 'nwse-resize' },
    { handle: 'tr', x: bx + bw - hw,  y: by,            cursor: 'nesw-resize' },
    { handle: 'bl', x: bx,            y: by + bh - hh,  cursor: 'nesw-resize' },
    { handle: 'br', x: bx + bw - hw,  y: by + bh - hh,  cursor: 'nwse-resize' },
  ];

  for (const c of corners) {
    const h = svgEl('rect', {
      x: c.x, y: c.y, width: hw, height: hh,
      class: 'handle handle-resize-corner',
      'data-handle': c.handle,
      style: `cursor: ${c.cursor}`,
    });
    dom.handleLayer.appendChild(h);
  }
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

  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data) return;

  isResizing = true;
  resizeHandle = handleType;
  dragStart = startPt;
  dragOriginal = { ...data };

  // For text corner handles, compute the anchor (opposite corner) and bbox info
  if (data.type === 'text' && ['tl', 'tr', 'bl', 'br'].includes(handleType)) {
    const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(data.id)}`);
    if (textEl) {
      try {
        const bb = textEl.getBBox();
        const pad = 4;
        origBbox = {
          x: bb.x - pad, y: bb.y - pad,
          width: bb.width + pad * 2, height: bb.height + pad * 2,
        };
      } catch {
        origBbox = { x: data.x, y: data.y - data.fontSize, width: data.fontSize * 4, height: data.fontSize };
      }
    }

    // Baseline offset relative to bbox top-left
    origBaselineOffX = data.x - origBbox.x;
    origBaselineOffY = data.y - origBbox.y;

    // Anchor = opposite corner of the bounding box
    const anchorMap = {
      tl: { x: origBbox.x + origBbox.width, y: origBbox.y + origBbox.height },
      tr: { x: origBbox.x,                  y: origBbox.y + origBbox.height },
      bl: { x: origBbox.x + origBbox.width, y: origBbox.y },
      br: { x: origBbox.x,                  y: origBbox.y },
    };
    resizeAnchor = anchorMap[handleType];

    // Original diagonal length (anchor to dragged corner)
    const draggedCornerMap = {
      tl: { x: origBbox.x,                  y: origBbox.y },
      tr: { x: origBbox.x + origBbox.width, y: origBbox.y },
      bl: { x: origBbox.x,                  y: origBbox.y + origBbox.height },
      br: { x: origBbox.x + origBbox.width, y: origBbox.y + origBbox.height },
    };
    const dc = draggedCornerMap[handleType];
    const dx = dc.x - resizeAnchor.x;
    const dy = dc.y - resizeAnchor.y;
    origDiagLen = Math.sqrt(dx * dx + dy * dy);
    origDiagVec = origDiagLen > 0
      ? { x: dx / origDiagLen, y: dy / origDiagLen }
      : { x: 1, y: 1 };
  }

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
  } else if (data.type === 'text' && resizeAnchor) {
    // Project mouse vector onto original diagonal to get signed scale
    const mx = pt.x - resizeAnchor.x;
    const my = pt.y - resizeAnchor.y;
    const projLen = mx * origDiagVec.x + my * origDiagVec.y;
    const scaleFactor = origDiagLen > 0 ? projLen / origDiagLen : 1;

    // Clamp to minimum size
    const newSize = Math.max(8, Math.round(dragOriginal.fontSize * Math.abs(scaleFactor)));
    const s = newSize / dragOriginal.fontSize;

    data.fontSize = newSize;

    // Reposition so the anchor corner stays fixed.
    // New bbox top-left = anchor - (anchor_to_origTopLeft) * s
    // But which component depends on which corner is anchored.
    const handle = resizeHandle;
    if (handle === 'br') {
      // anchor = original top-left of bbox
      data.x = resizeAnchor.x + origBaselineOffX * s;
      data.y = resizeAnchor.y + origBaselineOffY * s;
    } else if (handle === 'bl') {
      // anchor = original top-right → new top-left = anchor.x - newWidth
      data.x = resizeAnchor.x - origBbox.width * s + origBaselineOffX * s;
      data.y = resizeAnchor.y + origBaselineOffY * s;
    } else if (handle === 'tr') {
      // anchor = original bottom-left → new top-left.y = anchor.y - newHeight
      data.x = resizeAnchor.x + origBaselineOffX * s;
      data.y = resizeAnchor.y - origBbox.height * s + origBaselineOffY * s;
    } else if (handle === 'tl') {
      // anchor = original bottom-right
      data.x = resizeAnchor.x - origBbox.width * s + origBaselineOffX * s;
      data.y = resizeAnchor.y - origBbox.height * s + origBaselineOffY * s;
    }

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
  } else if (data.type === 'text' && (orig.fontSize !== final.fontSize || orig.x !== final.x || orig.y !== final.y)) {
    pushAction({
      description: 'Resize text',
      doFn: () => { data.fontSize = final.fontSize; data.x = final.x; data.y = final.y; updateTextSVG(data); drawHandles(data); },
      undoFn: () => { data.fontSize = orig.fontSize; data.x = orig.x; data.y = orig.y; updateTextSVG(data); drawHandles(data); },
    });
  }

  dragOriginal = null;
  resizeAnchor = null;
  origBbox = null;
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

// We'll set these from main.js to avoid circular imports
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
