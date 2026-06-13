// ── Select module: Selection, move, resize, delete ─────────────

import { state, dom } from './editor.js';
import { svgEl, screenToCoords } from './utils.js';
import { pushAction } from './history.js';
import { startEditing, isEditing } from './text.js';
import { normalizeLineStyle, setActiveLineStyle, setActiveLineMarkerSize, normalizeLineMarkerSize, updateLineElement, normalizeLineDecoration, styleToDecoration, decorationToStyle, legacyStyleToDecorations } from './line.js';
import { updateFreehandElement, syncFreehandEpsilonSlider } from './freehand.js';
import { updateRectangleElement } from './rectangle.js';

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
let textInteractMode = 'resize'; // 'resize' | 'rotate'
let origRotation = 0;     // original rotation angle when starting rotation
let rotationCenter = null; // { cx, cy }
let lineEditMode = 'move';  // 'move' | 'change-end'
let selectedLineEndpoint = 'end'; // 'start' | 'end'
let rotationTooltip = null;


export function initSelect() {
  // Listen for color/thickness changes on selected element
  document.addEventListener('palette-color-changed', (e) => {
    applyColorToSelected(e.detail.color);
  });
  document.addEventListener('palette-thickness-changed', (e) => {
    applyThicknessToSelected(e.detail.thickness);
  });
  document.addEventListener('line-style-changed', (e) => {
    applyLineStyleToSelected(e.detail.style);
  });
  document.addEventListener('line-marker-size-changed', (e) => {
    applyLineMarkerSizeToSelected(e.detail.size);
  });

  // Font size input
  const fontSizeInput = document.getElementById('font-size-input');
  fontSizeInput.addEventListener('change', () => {
    const val = parseFloat(fontSizeInput.value);
    if (isNaN(val) || val < 1) return;
    state.activeFontSize = val;
    applyFontSizeToSelected(val);
  });

  const lineModeMove = document.getElementById('btn-line-mode-move');
  const lineModeChangeEnd = document.getElementById('btn-line-mode-change-end');
  if (lineModeMove && lineModeChangeEnd) {
    lineModeMove.addEventListener('click', () => setLineEditMode('move'));
    lineModeChangeEnd.addEventListener('click', () => setLineEditMode('change-end'));
  }

  setLineEditMode(state.activeLineEditMode || 'move');

  // Corner radius input
  const radiusInput = document.getElementById('corner-radius-input');
  if (radiusInput) {
    radiusInput.addEventListener('change', () => {
      const val = parseFloat(radiusInput.value);
      if (isNaN(val) || val < 0) return;
      state.activeCornerRadius = val;
      applyCornerRadiusToSelected(val);
    });
  }
}

function setLineEditMode(mode) {
  lineEditMode = mode;
  state.activeLineEditMode = mode;
  const moveBtn = document.getElementById('btn-line-mode-move');
  const changeBtn = document.getElementById('btn-line-mode-change-end');
  if (moveBtn && changeBtn) {
    moveBtn.classList.toggle('active', mode === 'move');
    changeBtn.classList.toggle('active', mode === 'change-end');
  }
  const data = state.selectedId ? state.elements.find(el => el.id === state.selectedId) : null;
  if (mode === 'change-end') {
    selectedLineEndpoint = null;
  }
  refreshSelection();
  if (data) {
    document.dispatchEvent(new CustomEvent('selection-changed', { detail: { id: data.id, data } }));
  }
}

function setSelectedLineEndpoint(endpoint) {
  selectedLineEndpoint = endpoint === 'start' ? 'start' : 'end';
  state.activeLineEndpoint = selectedLineEndpoint;

  const data = state.selectedId ? state.elements.find(el => el.id === state.selectedId) : null;
  if (data && data.type === 'line') {
    syncLineToolbarFromSelection(data);
  }
}

function getDefaultLineEndpoint(data) {
  if (normalizeLineDecoration(data.endDecoration) !== 'none') return 'end';
  if (normalizeLineDecoration(data.startDecoration) !== 'none') return 'start';
  return 'end';
}

function syncLineToolbarFromSelection(data) {
  const endpoint = selectedLineEndpoint === 'start' ? 'start' : 'end';
  const decoration = endpoint === 'start' ? normalizeLineDecoration(data.startDecoration) : normalizeLineDecoration(data.endDecoration);
  const size = endpoint === 'start' ? normalizeLineMarkerSize(data.startDecorationSize ?? data.lineMarkerSize) : normalizeLineMarkerSize(data.endDecorationSize ?? data.lineMarkerSize);
  setActiveLineStyle(decorationToStyle(decoration));
  setActiveLineMarkerSize(size);
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
  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);

  // Check if clicking a handle (including child elements of a handle group)
  const handleEl = target.closest ? target.closest('.handle') : null;
  if (handleEl) {
    e.preventDefault();
    e.stopPropagation();
    
    // Toggle interact mode for text center icon
    if (handleEl.dataset.handle === 'mode-toggle') {
      textInteractMode = textInteractMode === 'resize' ? 'rotate' : 'resize';
      refreshSelection();
      return;
    }

    if (state.selectedId) {
      const selected = state.elements.find(el => el.id === state.selectedId);
      if (selected && selected.type === 'line' && lineEditMode === 'change-end') {
        if (handleEl.dataset.handle === 'p1' || handleEl.dataset.handle === 'p2') {
          setSelectedLineEndpoint(handleEl.dataset.handle === 'p1' ? 'start' : 'end');
          refreshSelection();
          return;
        }
      }
    }

    startResize(handleEl, pt, e);
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
    const data = state.elements.find(el => el.id === id);
    if (data && data.type === 'line' && lineEditMode === 'change-end') {
      return;
    }
    startDrag(id, pt);
    return;
  }

  // Clicked empty space → deselect
  clearSelection();
}

function findAnnotationParent(target) {
  let el = target;
  while (el && el !== dom.svg) {
    if (el.dataset && (el.dataset.type === 'line' || el.dataset.type === 'freehand' || el.dataset.type === 'rectangle')) return el;
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
    setLineEditMode('move');
    state.activeColor = data.stroke;
    state.activeThickness = data.strokeWidth;
    setActiveLineStyle(data.lineStyle);
    setActiveLineMarkerSize(data.lineMarkerSize);
  } else if (data.type === 'text') {
    state.activeColor = data.stroke || state.activeColor;
    state.bgColor = data.fill || state.bgColor;
    state.activeThickness = data.strokeWidth || state.activeThickness;
    state.activeFontSize = data.fontSize;
    document.getElementById('font-size-input').value = data.fontSize;
  } else if (data.type === 'freehand') {
    state.activeColor = data.stroke;
    state.activeThickness = data.strokeWidth;
    syncFreehandEpsilonSlider(data.epsilon);
  } else if (data.type === 'rectangle') {
    state.activeColor = data.stroke;
    state.activeThickness = data.strokeWidth;
    state.activeCornerRadius = data.rx || 0;
    document.getElementById('corner-radius-input').value = data.rx || 0;
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
  textInteractMode = 'resize';
  hideRotationTooltip();
}

function drawHandles(data) {
  dom.handleLayer.innerHTML = '';

  if (data.type === 'line') {
    drawLineHandles(data);
  } else if (data.type === 'text') {
    drawTextHandles(data);
  } else if (data.type === 'freehand') {
    drawFreehandHandles(data);
  } else if (data.type === 'rectangle') {
    drawRectangleHandles(data);
  }
}

function drawLineHandles(data) {
  // Endpoint handles
  const r = getHandleRadius();
  const startActive = lineEditMode === 'change-end' && selectedLineEndpoint === 'start';
  const endActive = lineEditMode === 'change-end' && selectedLineEndpoint === 'end';
  const startUnselected = lineEditMode === 'change-end' && !startActive;
  const endUnselected = lineEditMode === 'change-end' && !endActive;

  const h1 = svgEl('circle', {
    cx: data.x1, cy: data.y1, r,
    class: 'handle handle-endpoint' + (startActive ? ' active' : '') + (startUnselected ? ' unselected' : ''),
    'data-handle': 'p1',
  });
  const h2 = svgEl('circle', {
    cx: data.x2, cy: data.y2, r,
    class: 'handle handle-endpoint' + (endActive ? ' active' : '') + (endUnselected ? ' unselected' : ''),
    'data-handle': 'p2',
  });

  dom.handleLayer.appendChild(h1);
  dom.handleLayer.appendChild(h2);

  if (lineEditMode === 'move') {
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

  // Center of the text
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;

  // Create a group for the handles to apply the same rotation as the text
  const handleGroup = svgEl('g', {
    transform: `rotate(${data.rotation || 0}, ${cx}, ${cy})`
  });
  dom.handleLayer.appendChild(handleGroup);

  // Dashed selection box
  const selBox = svgEl('rect', {
    x: bx, y: by, width: bw, height: bh,
    class: 'selection-box',
  });
  handleGroup.appendChild(selBox);

  // 4 corner resize handles, square, 30% of the longest edge
  const size = Math.min(bw, bh) * 0.3;
  const hw = size;
  const hh = size;

  const isRotate = textInteractMode === 'rotate';

  const corners = [
    { handle: 'tl', x: bx,            y: by,            cursor: isRotate ? 'grab' : 'nwse-resize' },
    { handle: 'tr', x: bx + bw - hw,  y: by,            cursor: isRotate ? 'grab' : 'nesw-resize' },
    { handle: 'bl', x: bx,            y: by + bh - hh,  cursor: isRotate ? 'grab' : 'nesw-resize' },
    { handle: 'br', x: bx + bw - hw,  y: by + bh - hh,  cursor: isRotate ? 'grab' : 'nwse-resize' },
  ];

  for (const c of corners) {
    const h = svgEl('rect', {
      x: c.x, y: c.y, width: hw, height: hh,
      class: 'handle handle-resize-corner',
      'data-handle': c.handle,
      style: `cursor: ${c.cursor}`,
    });
    handleGroup.appendChild(h);
  }

  // Draw the center mode-toggle icon
  const iconSize = 24; // Base size for icon viewBox
  
  // Scale the icon so it stays visually proportional to the box size (unclamped)
  // Making it roughly the same size as the corner handles (or slightly larger)
  const desiredIconSize = Math.min(bw, bh) * 0.4;
  const iconScale = desiredIconSize / iconSize;
  const actualSize = iconSize * iconScale;

  const iconG = svgEl('g', {
    class: 'handle',
    'data-handle': 'mode-toggle',
    transform: `translate(${cx - actualSize / 2}, ${cy - actualSize / 2}) scale(${iconScale})`,
    style: 'cursor: pointer; opacity: 0.6;'
  });

  // Background circle for visibility
  iconG.appendChild(svgEl('circle', {
    cx: 12, cy: 12, r: 12,
    fill: '#000',
  }));

  // SVG paths for icons (Material Design)
  const crossArrowPath = 'M12 2L8 6h3v5H6V8L2 12l4 4v-3h5v5H8l4 4 4-4h-3v-5h5v3l4-4-4-4v3h-5V6h3z';
  const recyclePath = 'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z';

  const pathEl = svgEl('path', {
    d: isRotate ? recyclePath : crossArrowPath,
    fill: '#fff'
  });
  iconG.appendChild(pathEl);

  iconG.addEventListener('mouseenter', () => iconG.style.opacity = '1');
  iconG.addEventListener('mouseleave', () => iconG.style.opacity = '0.6');

  handleGroup.appendChild(iconG);
}

function drawFreehandHandles(data) {
  const r = getHandleRadius();
  let cx = 0, cy = 0;
  for (const p of data.points) { cx += p.x; cy += p.y; }
  cx /= data.points.length;
  cy /= data.points.length;
  const hm = svgEl('rect', {
    x: cx - r, y: cy - r, width: r * 2, height: r * 2,
    class: 'handle handle-move',
    'data-handle': 'move',
  });
  dom.handleLayer.appendChild(hm);
}

function drawRectangleHandles(data) {
  const hw = 22;
  const hh = 22;
  const { x, y, width: w, height: h } = data;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const isRotate = textInteractMode === 'rotate';

  const handleGroup = svgEl('g', {
    transform: `rotate(${data.rotation || 0}, ${cx}, ${cy})`
  });

  const selBox = svgEl('rect', {
    x, y, width: w, height: h,
    class: 'selection-box',
  });
  handleGroup.appendChild(selBox);

  const corners = [
    { handle: 'tl', x, y, cursor: isRotate ? 'grab' : 'nwse-resize' },
    { handle: 'tr', x: x + w - hw, y, cursor: isRotate ? 'grab' : 'pointer' },
    { handle: 'bl', x, y: y + h - hh, cursor: isRotate ? 'grab' : 'pointer' },
    { handle: 'br', x: x + w - hw, y: y + h - hh, cursor: isRotate ? 'grab' : 'nwse-resize' },
  ];

  for (const c of corners) {
    const h = svgEl('rect', {
      x: c.x, y: c.y, width: hw, height: hh,
      class: 'handle handle-resize-corner',
      'data-handle': c.handle,
      style: `cursor: ${c.cursor}`,
    });
    handleGroup.appendChild(h);
  }

  const iconSize = 24;
  const desiredIconSize = Math.min(w, h) * 0.4;
  const iconScale = Math.max(0.5, Math.min(1.5, desiredIconSize / iconSize));
  const actualSize = iconSize * iconScale;

  const iconG = svgEl('g', {
    class: 'handle',
    'data-handle': 'mode-toggle',
    transform: `translate(${cx - actualSize / 2}, ${cy - actualSize / 2}) scale(${iconScale})`,
    style: 'cursor: pointer; opacity: 0.6;',
  });

  iconG.appendChild(svgEl('circle', { cx: 12, cy: 12, r: 12, fill: '#000' }));

  const movePath = 'M12 2L8 6h3v5H6V8L2 12l4 4v-3h5v5H8l4 4 4-4h-3v-5h5v3l4-4-4-4v3h-5V6h3z';
  const rotatePath = 'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z';

  iconG.appendChild(svgEl('path', {
    d: isRotate ? rotatePath : movePath,
    fill: '#fff',
  }));

  iconG.addEventListener('mouseenter', () => iconG.style.opacity = '1');
  iconG.addEventListener('mouseleave', () => iconG.style.opacity = '0.6');

  handleGroup.appendChild(iconG);
  dom.handleLayer.appendChild(handleGroup);
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
  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  const dx = pt.x - dragStart.x;
  const dy = pt.y - dragStart.y;
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data) return;

  if (data.type === 'line') {
    if (data.points) {
      data.points = dragOriginal.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
      data.x1 = data.points[0].x;
      data.y1 = data.points[0].y;
      data.x2 = data.points[data.points.length - 1].x;
      data.y2 = data.points[data.points.length - 1].y;
    } else {
      data.x1 = dragOriginal.x1 + dx;
      data.y1 = dragOriginal.y1 + dy;
      data.x2 = dragOriginal.x2 + dx;
      data.y2 = dragOriginal.y2 + dy;
    }
    updateLineSVG(data);
  } else if (data.type === 'text') {
    data.x = dragOriginal.x + dx;
    data.y = dragOriginal.y + dy;
    updateTextSVG(data);
  } else if (data.type === 'freehand') {
    data.points = dragOriginal.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
    if (data.rawPoints) {
      data.rawPoints = dragOriginal.rawPoints.map(p => ({ x: p.x + dx, y: p.y + dy }));
    }
    updateFreehandElement(data);
  } else if (data.type === 'rectangle') {
    data.x = dragOriginal.x + dx;
    data.y = dragOriginal.y + dy;
    updateRectangleElement(data);
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
      doFn: () => { Object.assign(data, { x1: final.x1, y1: final.y1, x2: final.x2, y2: final.y2, points: final.points ? final.points.map(p => ({...p})) : undefined }); updateLineSVG(data); drawHandles(data); },
      undoFn: () => { Object.assign(data, { x1: orig.x1, y1: orig.y1, x2: orig.x2, y2: orig.y2, points: orig.points ? orig.points.map(p => ({...p})) : undefined }); updateLineSVG(data); drawHandles(data); },
    });
  } else if (data.type === 'text' && (orig.x !== final.x || orig.y !== final.y)) {
    pushAction({
      description: 'Move text',
      doFn: () => { data.x = final.x; data.y = final.y; updateTextSVG(data); drawHandles(data); },
      undoFn: () => { data.x = orig.x; data.y = orig.y; updateTextSVG(data); drawHandles(data); },
    });
  } else if (data.type === 'freehand' && (orig.points[0].x !== final.points[0].x || orig.points[0].y !== final.points[0].y)) {
    pushAction({
      description: 'Move freehand',
      doFn: () => { data.points = final.points; data.rawPoints = final.rawPoints; updateFreehandElement(data); drawHandles(data); },
      undoFn: () => { data.points = orig.points; data.rawPoints = orig.rawPoints; updateFreehandElement(data); drawHandles(data); },
    });
  } else if (data.type === 'rectangle' && (orig.x !== final.x || orig.y !== final.y)) {
    pushAction({
      description: 'Move rectangle',
      doFn: () => { data.x = final.x; data.y = final.y; updateRectangleElement(data); drawHandles(data); },
      undoFn: () => { data.x = orig.x; data.y = orig.y; updateRectangleElement(data); drawHandles(data); },
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

    origRotation = data.rotation || 0;
    rotationCenter = {
      x: origBbox.x + origBbox.width / 2,
      y: origBbox.y + origBbox.height / 2
    };

    if (textInteractMode === 'rotate') {
      // Calculate original angle from center to mouse
      dragStart.angle = Math.atan2(startPt.y - rotationCenter.y, startPt.x - rotationCenter.x) * 180 / Math.PI;
    } else {
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
  } else if (data.type === 'rectangle') {
    origRotation = data.rotation || 0;
    rotationCenter = {
      x: data.x + data.width / 2,
      y: data.y + data.height / 2
    };

    if (textInteractMode === 'rotate') {
      dragStart.angle = Math.atan2(startPt.y - rotationCenter.y, startPt.x - rotationCenter.x) * 180 / Math.PI;
    } else if (handleType === 'tl' || handleType === 'br') {
      const anchorMap = {
        tl: { x: data.x + data.width, y: data.y + data.height },
        br: { x: data.x, y: data.y },
      };
      resizeAnchor = anchorMap[handleType];
      const dc = handleType === 'tl'
        ? { x: data.x, y: data.y }
        : { x: data.x + data.width, y: data.y + data.height };
      const dx = dc.x - resizeAnchor.x;
      const dy = dc.y - resizeAnchor.y;
      origDiagLen = Math.sqrt(dx * dx + dy * dy);
      origDiagVec = origDiagLen > 0
        ? { x: dx / origDiagLen, y: dy / origDiagLen }
        : { x: 1, y: 1 };
    } else if (handleType === 'bl' || handleType === 'tr') {
      resizeAnchor = {
        x: handleType === 'bl' ? data.x : data.x + data.width,
        y: handleType === 'bl' ? data.y + data.height : data.y,
      };
    }
  }

  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeEnd);
}

function onResizeMove(e) {
  if (!isResizing) return;
  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data) return;

  if (data.type === 'line') {
    if (resizeHandle === 'p1') {
      data.x1 = pt.x;
      data.y1 = pt.y;
      if (data.points) { data.points[0] = { x: pt.x, y: pt.y }; }
    } else if (resizeHandle === 'p2') {
      data.x2 = pt.x;
      data.y2 = pt.y;
      if (data.points) { data.points[data.points.length - 1] = { x: pt.x, y: pt.y }; }
    }
    updateLineSVG(data);
  } else if (data.type === 'text') {
    if (textInteractMode === 'rotate') {
      const currentAngle = Math.atan2(pt.y - rotationCenter.y, pt.x - rotationCenter.x) * 180 / Math.PI;
      const angleDiff = currentAngle - dragStart.angle;
      let newRot = origRotation + angleDiff;
      
      // Snap to 5 degrees
      newRot = Math.round(newRot / 5) * 5;
      
      // Keep it 0-360
      newRot = ((newRot % 360) + 360) % 360;
      
      data.rotation = newRot;
      updateTextSVG(data);
    } else if (resizeAnchor) {
      // Un-rotate mouse point so it matches the unrotated bounding box space
      const angleRad = -(data.rotation || 0) * Math.PI / 180;
      const cosA = Math.cos(angleRad);
      const sinA = Math.sin(angleRad);
      const dxMouse = pt.x - rotationCenter.x;
      const dyMouse = pt.y - rotationCenter.y;
      const unrotatedPtX = rotationCenter.x + dxMouse * cosA - dyMouse * sinA;
      const unrotatedPtY = rotationCenter.y + dxMouse * sinA + dyMouse * cosA;

      // Project unrotated mouse vector onto original diagonal to get signed scale
      const mx = unrotatedPtX - resizeAnchor.x;
      const my = unrotatedPtY - resizeAnchor.y;
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
  } else if (data.type === 'rectangle') {
    if (textInteractMode === 'rotate') {
      const currentAngle = Math.atan2(pt.y - rotationCenter.y, pt.x - rotationCenter.x) * 180 / Math.PI;
      const angleDiff = currentAngle - dragStart.angle;
      let newRot = origRotation + angleDiff;
      newRot = Math.round(newRot / 5) * 5;
      newRot = ((newRot % 360) + 360) % 360;
      data.rotation = newRot;
      updateRectangleElement(data);
      showRotationTooltip(e, newRot);
    } else if (resizeHandle === 'tl' || resizeHandle === 'br') {
      const angleRad = -(data.rotation || 0) * Math.PI / 180;
      const cosA = Math.cos(angleRad);
      const sinA = Math.sin(angleRad);
      const dxMouse = pt.x - rotationCenter.x;
      const dyMouse = pt.y - rotationCenter.y;
      const unrotatedPtX = rotationCenter.x + dxMouse * cosA - dyMouse * sinA;
      const unrotatedPtY = rotationCenter.y + dxMouse * sinA + dyMouse * cosA;

      const mx = unrotatedPtX - resizeAnchor.x;
      const my = unrotatedPtY - resizeAnchor.y;
      const projLen = mx * origDiagVec.x + my * origDiagVec.y;
      const scaleFactor = origDiagLen > 0 ? Math.max(0.1, projLen / origDiagLen) : 1;

      const newW = Math.max(5, Math.round(dragOriginal.width * Math.abs(scaleFactor)));
      const newH = Math.max(5, Math.round(dragOriginal.height * Math.abs(scaleFactor)));

      if (resizeHandle === 'br') {
        data.x = resizeAnchor.x;
        data.y = resizeAnchor.y;
        data.width = newW;
        data.height = newH;
      } else { // tl
        data.x = resizeAnchor.x - newW;
        data.y = resizeAnchor.y - newH;
        data.width = newW;
        data.height = newH;
      }

      const maxRx = Math.min(data.width, data.height) / 2;
      if (data.rx > maxRx) {
        data.rx = maxRx;
        document.getElementById('corner-radius-input').value = data.rx;
        state.activeCornerRadius = data.rx;
      }

      updateRectangleElement(data);
    } else if (resizeHandle === 'bl' || resizeHandle === 'tr') {
      const cornerX = resizeAnchor.x;
      const cornerY = resizeAnchor.y;
      const dx = pt.x - cornerX;
      const dy = pt.y - cornerY;

      const diagX = resizeHandle === 'bl' ? data.width : -data.width;
      const diagY = resizeHandle === 'bl' ? -data.height : data.height;
      const diagLen = Math.sqrt(diagX * diagX + diagY * diagY);
      if (diagLen > 0) {
        const diagUnitX = diagX / diagLen;
        const diagUnitY = diagY / diagLen;
        const proj = dx * diagUnitX + dy * diagUnitY;
        const origRx = dragOriginal.rx || 0;
        const newRx = Math.max(0, Math.min(origRx + proj, Math.min(data.width, data.height) / 2));
        data.rx = newRx;
        updateRectangleElement(data);
        document.getElementById('corner-radius-input').value = data.rx;
        state.activeCornerRadius = data.rx;
      }
    }
  }

  drawHandles(data);
}

function onResizeEnd() {
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeEnd);

  hideRotationTooltip();

  if (!isResizing) return;
  isResizing = false;

  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data) return;

  const orig = { ...dragOriginal };
  const final = { ...data };

  if (data.type === 'line') {
    pushAction({
      description: 'Resize line',
      doFn: () => { Object.assign(data, { x1: final.x1, y1: final.y1, x2: final.x2, y2: final.y2, points: final.points ? final.points.map(p => ({...p})) : undefined }); updateLineSVG(data); drawHandles(data); },
      undoFn: () => { Object.assign(data, { x1: orig.x1, y1: orig.y1, x2: orig.x2, y2: orig.y2, points: orig.points ? orig.points.map(p => ({...p})) : undefined }); updateLineSVG(data); drawHandles(data); },
    });
  } else if (data.type === 'text' && (orig.fontSize !== final.fontSize || orig.x !== final.x || orig.y !== final.y || orig.rotation !== final.rotation)) {
    pushAction({
      description: textInteractMode === 'rotate' ? 'Rotate text' : 'Resize text',
      doFn: () => { data.fontSize = final.fontSize; data.x = final.x; data.y = final.y; data.rotation = final.rotation; updateTextSVG(data); drawHandles(data); },
      undoFn: () => { data.fontSize = orig.fontSize; data.x = orig.x; data.y = orig.y; data.rotation = orig.rotation; updateTextSVG(data); drawHandles(data); },
    });
  } else if (data.type === 'rectangle' && (orig.width !== final.width || orig.height !== final.height || orig.x !== final.x || orig.y !== final.y || orig.rx !== final.rx || orig.rotation !== final.rotation)) {
    pushAction({
      description: textInteractMode === 'rotate' ? 'Rotate rectangle' : 'Resize rectangle',
      doFn: () => { Object.assign(data, final); updateRectangleElement(data); drawHandles(data); },
      undoFn: () => { Object.assign(data, orig); updateRectangleElement(data); drawHandles(data); },
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
      } else if (data.type === 'freehand') {
        addFreehandSVGAtIndex(data, idx);
      } else if (data.type === 'rectangle') {
        addRectangleSVGAtIndex(data, idx);
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

function addFreehandSVGAtIndex(data, _idx) {
  const { addFreehandElement } = _freehandModule;
  addFreehandElement(data);
}

function addRectangleSVGAtIndex(data, _idx) {
  const { addRectangleElement } = _rectangleModule;
  addRectangleElement(data);
}

// We'll set these from main.js to avoid circular imports
let _lineModule = {};
let _textModule = {};
let _freehandModule = {};
let _rectangleModule = {};

export function setModuleRefs(lineMod, textMod, freehandMod, rectangleMod) {
  _lineModule = lineMod;
  _textModule = textMod;
  _freehandModule = freehandMod || {};
  _rectangleModule = rectangleMod || {};
}

// ── SVG Update Helpers ──────────────────────────────────────────

function updateLineSVG(data) {
  updateLineElement(data);
}

function updateTextSVG(data) {
  const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(data.id)}`);
  if (!textEl) return;
  textEl.setAttribute('x', data.x);
  textEl.setAttribute('y', data.y);
  textEl.setAttribute('font-size', data.fontSize);
  textEl.setAttribute('fill', data.fill);
  textEl.setAttribute('stroke', data.stroke || 'none');
  textEl.setAttribute('stroke-width', data.strokeWidth || 0);
  textEl.textContent = data.content;
  
  if (data.rotation) {
    try {
      const bbox = textEl.getBBox();
      const cx = bbox.x + bbox.width / 2;
      const cy = bbox.y + bbox.height / 2;
      textEl.setAttribute('transform', `rotate(${data.rotation}, ${cx}, ${cy})`);
    } catch {
      // ignore
    }
  } else {
    textEl.removeAttribute('transform');
  }
}

// ── Rotation Tooltip ────────────────────────────────────────────

function showRotationTooltip(e, angle) {
  if (!rotationTooltip) {
    rotationTooltip = document.createElement('div');
    rotationTooltip.style.cssText = 'position:fixed;background:rgba(0,0,0,0.75);color:#fff;padding:2px 7px;border-radius:3px;font-size:12px;pointer-events:none;z-index:100;font-family:monospace;';
    document.body.appendChild(rotationTooltip);
  }
  rotationTooltip.textContent = `${angle}°`;
  rotationTooltip.style.left = (e.clientX + 14) + 'px';
  rotationTooltip.style.top = (e.clientY - 26) + 'px';
}

function hideRotationTooltip() {
  if (rotationTooltip) {
    rotationTooltip.remove();
    rotationTooltip = null;
  }
}

// ── Apply property changes to selected ──────────────────────────

function applyColorToSelected(color) {
  if (!state.selectedId) return;
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data) return;

  const oldColor = data.type === 'text' ? data.stroke : data.stroke;
  if (oldColor === color) return;

  if (data.type === 'line') {
    data.stroke = color;
    updateLineSVG(data);
  } else if (data.type === 'text') {
    data.stroke = color;
    updateTextSVG(data);
  } else if (data.type === 'freehand') {
    data.stroke = color;
    updateFreehandElement(data);
  } else if (data.type === 'rectangle') {
    data.stroke = color;
    updateRectangleElement(data);
  }

  pushAction({
    description: 'Change color',
    doFn: () => {
      if (data.type === 'line') { data.stroke = color; updateLineSVG(data); }
      else if (data.type === 'text') { data.stroke = color; updateTextSVG(data); }
      else if (data.type === 'freehand') { data.stroke = color; updateFreehandElement(data); }
      else if (data.type === 'rectangle') { data.stroke = color; updateRectangleElement(data); }
    },
    undoFn: () => {
      if (data.type === 'line') { data.stroke = oldColor; updateLineSVG(data); }
      else if (data.type === 'text') { data.stroke = oldColor; updateTextSVG(data); }
      else if (data.type === 'freehand') { data.stroke = oldColor; updateFreehandElement(data); }
      else if (data.type === 'rectangle') { data.stroke = oldColor; updateRectangleElement(data); }
    },
  });
}

function applyThicknessToSelected(thickness) {
  if (!state.selectedId) return;
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data || (data.type !== 'line' && data.type !== 'freehand' && data.type !== 'rectangle' && data.type !== 'text')) return;

  const oldThickness = data.strokeWidth;
  if (oldThickness === thickness) return;

  data.strokeWidth = thickness;
  if (data.type === 'line') {
    updateLineSVG(data);
  } else if (data.type === 'rectangle') {
    updateRectangleElement(data);
  } else if (data.type === 'text') {
    updateTextSVG(data);
  } else {
    updateFreehandElement(data);
  }

  pushAction({
    description: 'Change thickness',
    doFn: () => { data.strokeWidth = thickness; if (data.type === 'line') updateLineSVG(data); else if (data.type === 'rectangle') updateRectangleElement(data); else if (data.type === 'text') updateTextSVG(data); else updateFreehandElement(data); },
    undoFn: () => { data.strokeWidth = oldThickness; if (data.type === 'line') updateLineSVG(data); else if (data.type === 'rectangle') updateRectangleElement(data); else if (data.type === 'text') updateTextSVG(data); else updateFreehandElement(data); },
  });
}

function applyLineMarkerSizeToSelected(size) {
  if (!state.selectedId) return;
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data || data.type !== 'line') return;

  const newSize = normalizeLineMarkerSize(size);

  if (lineEditMode === 'change-end') {
    if (!selectedLineEndpoint) return;
    const sizeKey = selectedLineEndpoint === 'start' ? 'startDecorationSize' : 'endDecorationSize';
    const oldSize = data[sizeKey];
    const normOld = normalizeLineMarkerSize(oldSize ?? data.lineMarkerSize);
    if (normOld === newSize) return;

    const oldStartSize = data.startDecorationSize;
    const oldEndSize = data.endDecorationSize;

    data[sizeKey] = newSize;
    updateLineSVG(data);

    pushAction({
      description: 'Change line end marker size',
      doFn: () => { data[sizeKey] = newSize; updateLineSVG(data); },
      undoFn: () => {
        data.startDecorationSize = oldStartSize;
        data.endDecorationSize = oldEndSize;
        updateLineSVG(data);
      },
    });
    return;
  }

  const oldSize = normalizeLineMarkerSize(data.lineMarkerSize);
  const oldStartSize = data.startDecorationSize;
  const oldEndSize = data.endDecorationSize;
  if (oldSize === newSize) return;

  data.lineMarkerSize = newSize;
  data.startDecorationSize = newSize;
  data.endDecorationSize = newSize;
  updateLineSVG(data);

  pushAction({
    description: 'Change line marker size',
    doFn: () => {
      data.lineMarkerSize = newSize;
      data.startDecorationSize = newSize;
      data.endDecorationSize = newSize;
      updateLineSVG(data);
    },
    undoFn: () => {
      data.lineMarkerSize = oldSize;
      data.startDecorationSize = oldStartSize;
      data.endDecorationSize = oldEndSize;
      updateLineSVG(data);
    },
  });
}

function applyLineStyleToSelected(style) {
  if (!state.selectedId) return;
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data || data.type !== 'line') return;

  const newStyle = normalizeLineStyle(style);
  const newDecor = styleToDecoration(newStyle);

  if (lineEditMode === 'change-end') {
    if (!selectedLineEndpoint) return;
    const decorKey = selectedLineEndpoint === 'start' ? 'startDecoration' : 'endDecoration';
    const sizeKey = selectedLineEndpoint === 'start' ? 'startDecorationSize' : 'endDecorationSize';
    const oldDecor = normalizeLineDecoration(data[decorKey]);
    const oldSize = data[sizeKey];
    if (oldDecor === newDecor) return;

    const oldStartDecor = data.startDecoration;
    const oldEndDecor = data.endDecoration;
    const oldStartSize = data.startDecorationSize;
    const oldEndSize = data.endDecorationSize;

    data[decorKey] = newDecor;
    data[sizeKey] = normalizeLineMarkerSize(state.activeLineMarkerSize);
    updateLineSVG(data);

    pushAction({
      description: 'Change line end decoration',
      doFn: () => {
        data[decorKey] = newDecor;
        data[sizeKey] = normalizeLineMarkerSize(state.activeLineMarkerSize);
        updateLineSVG(data);
      },
      undoFn: () => {
        data.startDecoration = oldStartDecor;
        data.endDecoration = oldEndDecor;
        data.startDecorationSize = oldStartSize;
        data.endDecorationSize = oldEndSize;
        updateLineSVG(data);
      },
    });
    return;
  }

  const oldStyle = data.lineStyle;
  const oldStartDecor = data.startDecoration;
  const oldEndDecor = data.endDecoration;
  const oldStartDecorSize = data.startDecorationSize;
  const oldEndDecorSize = data.endDecorationSize;

  const targetDecor = styleToDecoration(newStyle);
  const startHas = data.startDecoration && data.startDecoration !== 'none';

  if (targetDecor === 'none') {
    data.lineStyle = 'normal';
    data.startDecoration = 'none';
    data.endDecoration = 'none';
  } else if (!startHas && !endHas) {
    const decors = legacyStyleToDecorations(newStyle, state.activeLineMarkerSize);
    data.lineStyle = newStyle;
    data.startDecoration = decors.startDecoration;
    data.endDecoration = decors.endDecoration;
    data.startDecorationSize = decors.startDecorationSize;
    data.endDecorationSize = decors.endDecorationSize;
  } else {
    data.lineStyle = newStyle;
    if (startHas) {
      data.startDecoration = targetDecor;
      data.startDecorationSize = normalizeLineMarkerSize(state.activeLineMarkerSize);
    }
    if (endHas) {
      data.endDecoration = targetDecor;
      data.endDecorationSize = normalizeLineMarkerSize(state.activeLineMarkerSize);
    }
  }
  updateLineSVG(data);

  pushAction({
    description: 'Change line style',
    doFn: () => {
      data.lineStyle = newStyle;
      if (targetDecor === 'none') {
        data.startDecoration = 'none';
        data.endDecoration = 'none';
      } else if (!startHas && !endHas) {
        const d = legacyStyleToDecorations(newStyle, state.activeLineMarkerSize);
        data.startDecoration = d.startDecoration;
        data.endDecoration = d.endDecoration;
        data.startDecorationSize = d.startDecorationSize;
        data.endDecorationSize = d.endDecorationSize;
      } else {
        if (startHas) { data.startDecoration = targetDecor; data.startDecorationSize = normalizeLineMarkerSize(state.activeLineMarkerSize); }
        if (endHas) { data.endDecoration = targetDecor; data.endDecorationSize = normalizeLineMarkerSize(state.activeLineMarkerSize); }
      }
      updateLineSVG(data);
    },
    undoFn: () => {
      data.lineStyle = oldStyle;
      data.startDecoration = oldStartDecor;
      data.endDecoration = oldEndDecor;
      data.startDecorationSize = oldStartDecorSize;
      data.endDecorationSize = oldEndDecorSize;
      updateLineSVG(data);
    },
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

function applyCornerRadiusToSelected(radius) {
  if (!state.selectedId) return;
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data || data.type !== 'rectangle') return;

  const oldRadius = data.rx || 0;
  if (oldRadius === radius) return;

  const clampedRadius = Math.min(radius, Math.min(data.width, data.height) / 2);
  data.rx = clampedRadius;
  updateRectangleElement(data);
  drawHandles(data);

  pushAction({
    description: 'Change corner radius',
    doFn: () => { data.rx = clampedRadius; updateRectangleElement(data); drawHandles(data); },
    undoFn: () => { data.rx = oldRadius; updateRectangleElement(data); drawHandles(data); },
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
  if (data.type === 'line' && lineEditMode === 'change-end') {
    syncLineToolbarFromSelection(data);
  } else if (data.type === 'line') {
    setActiveLineStyle(normalizeLineStyle(data.lineStyle));
  } else if (data.type === 'freehand') {
    syncFreehandEpsilonSlider(data.epsilon);
  } else if (data.type === 'rectangle') {
    document.getElementById('corner-radius-input').value = data.rx || 0;
    state.activeCornerRadius = data.rx || 0;
  }
  drawHandles(data);
}
