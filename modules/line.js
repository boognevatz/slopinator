// ── Line module: Straight line drawing & polyline builder ─────────────────────────

import { state, dom } from './editor.js';
import { generateId, svgEl, screenToCoords } from './utils.js';
import { snapToGrid } from './grid.js';
import { pushAction } from './history.js';

let isDrawing = false;
let previewLine = null;
let startPt = null;
let lineStyleButtons = null;
let lineMarkerSizeInput = null;

// Polyline extend mode state
let pendingPolyline = null;
let activeExtendIdx = 0;
let isEditingExisting = false;
let extendOrigPoints = null;
let extendOrigStyle = null;

// Vertex drag state
let isDraggingVertex = false;
let dragVertexIdx = -1;
let dragVertexOrigPoints = null;
let dragStartPt = null;
let dragVisualHandle = null;
let coordTooltip = null;

// Multi-selection (for closed polygons)
let selectedNodeIndices = new Set();
let longPressTimer = null;
const LONG_PRESS_MS = 400;

const LINE_STYLES = ['normal', 'arrows', 'circle'];
const LINE_DECORATIONS = ['none', 'arrow', 'circle'];

export function initLine() {
  ensureLineMarkers();

  lineStyleButtons = {
    normal: document.getElementById('btn-line-style-normal'),
    arrows: document.getElementById('btn-line-style-arrows'),
    circle: document.getElementById('btn-line-style-circle'),
  };
  lineMarkerSizeInput = document.getElementById('line-marker-size-input');

  for (const [style, btn] of Object.entries(lineStyleButtons)) {
    btn.addEventListener('click', () => setActiveLineStyle(style));
  }

  document.getElementById('btn-line-delete-node').addEventListener('click', deleteActiveNode);
  document.getElementById('btn-line-cut').addEventListener('click', cutPolygonEdge);

  lineMarkerSizeInput.addEventListener('change', () => {
    const val = parseFloat(lineMarkerSizeInput.value);
    if (Number.isNaN(val) || val < 2) return;
    setActiveLineMarkerSize(val);
  });

  updateLineStyleButtons();
  updateLineMarkerSizeInput();

  document.addEventListener('line-style-changed', () => {
    if (pendingPolyline) {
      applyStyleToPendingPolyline();
    }
  });
  document.addEventListener('line-marker-size-changed', () => {
    if (pendingPolyline) {
      applySizeToPendingPolyline();
    }
  });
  document.addEventListener('palette-color-changed', (e) => {
    if (isDrawing && previewLine) {
      previewLine.setAttribute('stroke', e.detail.color);
    }
    if (pendingPolyline) {
      pendingPolyline.stroke = e.detail.color;
      updateLineElement(pendingPolyline);
    }
  });
  document.addEventListener('palette-bgcolor-changed', (e) => {
    if (pendingPolyline && pendingPolyline.closed) {
      pendingPolyline.fill = e.detail.color === 'transparent' ? 'none' : e.detail.color;
      updateLineElement(pendingPolyline);
    }
  });
}

function applyStyleToPendingPolyline() {
  const isStart = activeExtendIdx === 0;
  const decors = legacyStyleToDecorations(state.activeLineStyle, state.activeLineMarkerSize);
  const decorKey = isStart ? 'startDecoration' : 'endDecoration';
  const sizeKey = isStart ? 'startDecorationSize' : 'endDecorationSize';
  pendingPolyline[decorKey] = decors[decorKey];
  pendingPolyline[sizeKey] = decors[sizeKey];
  pendingPolyline.lineStyle = state.activeLineStyle;
  pendingPolyline.lineMarkerSize = state.activeLineMarkerSize;
  updateLineElement(pendingPolyline);
  drawLineToolCircleHandles(pendingPolyline, activeExtendIdx);
}

function applySizeToPendingPolyline() {
  pendingPolyline.lineMarkerSize = state.activeLineMarkerSize;
  pendingPolyline.startDecorationSize = state.activeLineMarkerSize;
  pendingPolyline.endDecorationSize = state.activeLineMarkerSize;
  updateLineElement(pendingPolyline);
  drawLineToolCircleHandles(pendingPolyline, activeExtendIdx);
}

export function activateLine(selectedData) {
  dom.svg.style.cursor = 'crosshair';
  dom.svg.addEventListener('pointerdown', onMouseDown);
  document.addEventListener('keydown', onLineKeyDown);
  if (selectedData) {
    loadExistingPolyline(selectedData);
  }
}

function loadExistingPolyline(data) {
  if (!data.points) {
    data.points = [{x: data.x1, y: data.y1}, {x: data.x2, y: data.y2}];
  }
  pendingPolyline = data;
  isEditingExisting = true;
  if (!data.closed) delete data.fill;
  extendOrigPoints = data.points.map(p => ({...p}));
  extendOrigStyle = {
    lineStyle: data.lineStyle,
    lineMarkerSize: data.lineMarkerSize,
    startDecoration: data.startDecoration,
    endDecoration: data.endDecoration,
    startDecorationSize: data.startDecorationSize,
    endDecorationSize: data.endDecorationSize,
  };
  activeExtendIdx = data.points.length - 1;
  updateLineElement(data);
  drawLineToolCircleHandles(data, activeExtendIdx);
}

export function deactivateLine() {
  dom.svg.style.cursor = '';
  dom.svg.removeEventListener('pointerdown', onMouseDown);
  document.removeEventListener('keydown', onLineKeyDown);
  cleanupVertexClickState();
  if (isDraggingVertex) {
    document.removeEventListener('pointermove', onVertexDragMove);
    document.removeEventListener('pointerup', onVertexDragEnd);
    isDraggingVertex = false;
  }
  cleanupDragUI();
  selectedNodeIndices.clear();
  finalizePolyline();
  cancelDraw();
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  if (!state.hasImage) return;
  if (!e.isPrimary) return;
  if (isDraggingVertex) return;

  const target = e.target;

  // If we have a pending polyline waiting for extend/finalize
  if (pendingPolyline) {
    const clickPt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
    let handleEl = target.closest('.handle-endpoint');
    if (!handleEl) {
      const handles = dom.handleLayer.querySelectorAll('.handle-endpoint');
      for (let i = 0; i < handles.length; i++) {
        const c = handles[i];
        const cx = parseFloat(c.getAttribute('cx'));
        const cy = parseFloat(c.getAttribute('cy'));
        const r = parseFloat(c.getAttribute('r'));
        const dx = clickPt.x - cx;
        const dy = clickPt.y - cy;
        if (dx * dx + dy * dy <= (r + 3) * (r + 3)) {
          handleEl = c;
          break;
        }
      }
    }
    if (handleEl) {
      e.preventDefault();
      const idx = parseInt(handleEl.dataset.index);

      // Shift+click → toggle multi-selection without drag
      if (e.shiftKey) {
        if (selectedNodeIndices.has(idx)) {
          selectedNodeIndices.delete(idx);
        } else {
          selectedNodeIndices.add(idx);
        }
        activeExtendIdx = idx;
        drawLineToolCircleHandles(pendingPolyline, activeExtendIdx);
        updateCutButtonState();
        return;
      }

      // Non-Shift click → clear multi-selection
      const prevSelection = new Set(selectedNodeIndices);
      selectedNodeIndices.clear();

      const pts = pendingPolyline.points;
      if (pts.length >= 3 && !isEditingExisting &&
          ((activeExtendIdx === 0 && idx === pts.length - 1) ||
           (activeExtendIdx === pts.length - 1 && idx === 0))) {
        pendingPolyline.closed = true;
        pendingPolyline.fill = state.bgColor && state.bgColor !== 'transparent' ? state.bgColor : 'none';
        pendingPolyline.startDecoration = 'none';
        pendingPolyline.endDecoration = 'none';
        updateLineElement(pendingPolyline);
        activeExtendIdx = idx;
        selectedNodeIndices.add(idx);
        drawLineToolCircleHandles(pendingPolyline, activeExtendIdx);
        updateCutButtonState();
        return;
      }

      // Select the node immediately — show handles + tooltip without dragging
      const prevActive = activeExtendIdx;
      activeExtendIdx = idx;
      dragVertexIdx = idx;
      dragStartPt = { x: clickPt.x, y: clickPt.y };
      dragVertexOrigPoints = pendingPolyline.points.map(p => ({...p}));
      isDraggingVertex = false;

      if (prevActive !== idx) {
        drawLineToolCircleHandles(pendingPolyline, activeExtendIdx);
      } else {
        updateCoordTooltipForIdx(pendingPolyline, activeExtendIdx);
      }

      // Long-press timer for multi-selection
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        // Build selection: always include the long-pressed node, plus up to 1 from prevSelection
        const result = new Set([idx]);
        for (const i of prevSelection) {
          if (result.size >= 2) break;
          if (i !== idx) result.add(i);
        }
        selectedNodeIndices.clear();
        for (const i of result) selectedNodeIndices.add(i);
        drawLineToolCircleHandles(pendingPolyline, activeExtendIdx);
        updateCutButtonState();
        // Cancel drag prep — staying in multi-select mode
        document.removeEventListener('pointermove', onVertexDragPrepare);
        document.removeEventListener('pointerup', onVertexClickEnd);
        dragVertexOrigPoints = null;
        dragVertexIdx = -1;
        dragStartPt = null;
      }, LONG_PRESS_MS);

      document.addEventListener('pointermove', onVertexDragPrepare);
      document.addEventListener('pointerup', onVertexClickEnd);
      return;
    }

    // Clicking on other annotation → don't interfere
    if (target.closest('.annotation-line, .annotation-text, .line-hit-area, .handle')) return;
    // Check if click is on the pending polyline's stroke (target is SVG root due to pointer-events:stroke)
    const lineGroup = dom.annotationLayer.querySelector(`#${CSS.escape(pendingPolyline.id)}`);
    if (lineGroup) {
      const lineEl = lineGroup.querySelector('.annotation-line');
      const hitArea = lineGroup.querySelector('.line-hit-area');
      if (lineEl || hitArea) {
        const svgPt = dom.svg.createSVGPoint();
        svgPt.x = clickPt.x;
        svgPt.y = clickPt.y;
        if ((lineEl && lineEl.isPointInStroke(svgPt)) ||
            (hitArea && hitArea.isPointInStroke(svgPt))) return;
      }
    }
    // Clicked empty space → one-click extend from active endpoint (not for closed polygons)
    if (pendingPolyline.closed) return;
    // Don't extend if click is too close to an existing vertex
    const nearR = getExtendHandleRadius() * 2.5;
    for (let i = 0; i < pendingPolyline.points.length; i++) {
      const dx = clickPt.x - pendingPolyline.points[i].x;
      const dy = clickPt.y - pendingPolyline.points[i].y;
      if (dx * dx + dy * dy < nearR * nearR) return;
    }
    addExtensionPoint(e);
    return;
  }

  // Don't start drawing on existing annotations
  if (target.classList.contains('annotation-line') ||
      target.classList.contains('annotation-text') ||
      target.classList.contains('line-hit-area') ||
      target.classList.contains('handle')) return;

  isDrawing = true;
  startPt = snapToGrid(screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY));

  previewLine = svgEl('line', {
    x1: startPt.x,
    y1: startPt.y,
    x2: startPt.x,
    y2: startPt.y,
    stroke: state.activeColor,
    'stroke-width': state.activeThickness,
    'pointer-events': 'none',
  });
  applyLineStyle(previewLine, state.activeLineStyle);
  dom.annotationLayer.appendChild(previewLine);

  document.addEventListener('pointermove', onMouseMove);
  document.addEventListener('pointerup', onMouseUp);
}

function onMouseMove(e) {
  if (!isDrawing || !previewLine) return;
  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  previewLine.setAttribute('x2', pt.x);
  previewLine.setAttribute('y2', pt.y);
}

function onMouseUp(e) {
  if (!isDrawing) return;
  document.removeEventListener('pointermove', onMouseMove);
  document.removeEventListener('pointerup', onMouseUp);

  const endPt = snapToGrid(screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY));

  // Remove preview
  if (previewLine && previewLine.parentNode) {
    previewLine.parentNode.removeChild(previewLine);
  }
  previewLine = null;

  // Don't create zero-length lines (click without drag)
  const dx = endPt.x - startPt.x;
  const dy = endPt.y - startPt.y;
  if (Math.sqrt(dx * dx + dy * dy) < 2) {
    isDrawing = false;
    return;
  }

  // Create the line element
  const id = generateId();
  const pts = [
    { x: startPt.x, y: startPt.y },
    { x: endPt.x, y: endPt.y },
  ];
  const lineData = {
    id,
    type: 'line',
    points: pts,
    x1: pts[0].x, y1: pts[0].y,
    x2: pts[1].x, y2: pts[1].y,
    stroke: state.activeColor,
    strokeWidth: state.activeThickness,
    lineStyle: state.activeLineStyle,
    lineMarkerSize: state.activeLineMarkerSize,
    ...legacyStyleToDecorations(state.activeLineStyle, state.activeLineMarkerSize),
  };

  addLineElement(lineData);
  state.elements.push(lineData);

  // Enter extend mode instead of pushing to history immediately
  // Each click on empty space adds a new segment from the active endpoint
  pendingPolyline = lineData;
  activeExtendIdx = 1; // last point is active by default
  drawLineToolCircleHandles(lineData, 1);

  isDrawing = false;
}

function cancelDraw() {
  if (previewLine && previewLine.parentNode) {
    previewLine.parentNode.removeChild(previewLine);
  }
  previewLine = null;
  isDrawing = false;
  document.removeEventListener('pointermove', onMouseMove);
  document.removeEventListener('pointerup', onMouseUp);
}

// ── Polyline extend mode ────────────────────────────────────────

function drawLineToolCircleHandles(data, activeIdx) {
  dom.handleLayer.innerHTML = '';
  const viewBox = dom.svg.viewBox.baseVal;
  const svgRect = dom.svg.getBoundingClientRect();
  const scale = viewBox && viewBox.width ? viewBox.width / svgRect.width : 1;
  const visR = Math.max(6, 10 * scale);
  const pts = data.points;
  for (let i = 0; i < pts.length; i++) {
    const x = pts[i].x, y = pts[i].y;
    const isActive = i === activeIdx || selectedNodeIndices.has(i);
    dom.handleLayer.appendChild(svgEl('circle', {
      cx: x, cy: y, r: visR,
      class: 'handle handle-endpoint' + (isActive ? ' active' : ' unselected'),
      'data-index': i,
    }));
  }
  updateCoordTooltipForIdx(data, activeIdx);
}

function updateCoordTooltipForIdx(data, idx) {
  const pts = data.points;
  if (idx >= 0 && idx < pts.length) {
    var pt = pts[idx];
    var svgPt = dom.svg.createSVGPoint();
    svgPt.x = pt.x;
    svgPt.y = pt.y;
    var screenPt = svgPt.matrixTransform(dom.svg.getScreenCTM());
    if (!coordTooltip) {
      coordTooltip = document.createElement('div');
      coordTooltip.style.cssText = 'position:fixed;background:rgba(0,0,0,0.75);color:#fff;padding:2px 7px;border-radius:3px;font-size:12px;pointer-events:none;z-index:100;font-family:monospace;';
      document.body.appendChild(coordTooltip);
    }
    updateCoordTooltip(screenPt.x, screenPt.y, pt);
  }
}

function getExtendHandleRadius() {
  const viewBox = dom.svg.viewBox.baseVal;
  if (!viewBox || viewBox.width === 0) return 10;
  const svgRect = dom.svg.getBoundingClientRect();
  const scale = viewBox.width / svgRect.width;
  return Math.max(6, 10 * scale);
}

function addExtensionPoint(e) {
  if (!pendingPolyline) return;

  const pt = snapToGrid(screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY));
  const pts = pendingPolyline.points;
  const anchorPt = pts[activeExtendIdx];

  // Don't place if too close to avoid zero-length segments
  const dx = pt.x - anchorPt.x;
  const dy = pt.y - anchorPt.y;
  if (Math.sqrt(dx * dx + dy * dy) < 5) return;

  if (activeExtendIdx === 0) {
    // Extending from first point — prepend
    pts.unshift({ x: pt.x, y: pt.y });
    pendingPolyline.x1 = pt.x;
    pendingPolyline.y1 = pt.y;
  } else {
    // Extending from last point — append
    pts.push({ x: pt.x, y: pt.y });
    pendingPolyline.x2 = pt.x;
    pendingPolyline.y2 = pt.y;
  }

  // Re-render the element (becomes <polyline> if >= 3 points)
  updateLineElement(pendingPolyline);

  // The new point becomes the active endpoint
  activeExtendIdx = activeExtendIdx === 0 ? 0 : pts.length - 1;
  drawLineToolCircleHandles(pendingPolyline, activeExtendIdx);
}

// ── Vertex dragging ─────────────────────────────────────────────

function syncLineEndpoints(data) {
  data.x1 = data.points[0].x;
  data.y1 = data.points[0].y;
  data.x2 = data.points[data.points.length - 1].x;
  data.y2 = data.points[data.points.length - 1].y;
}

function cleanupDragUI() {
  if (coordTooltip) {
    coordTooltip.remove();
    coordTooltip = null;
  }
  dragVisualHandle = null;
}

function updateCoordTooltip(clientX, clientY, pt) {
  if (!coordTooltip) return;
  const x = Math.round(pt.x);
  var y = Math.round(pt.y);
  if (state.originCoordinate === 'bottom-left') {
    y = Math.round(dom.svg.viewBox.baseVal.height - pt.y);
  }
  coordTooltip.textContent = `${x}, ${y}`;
  coordTooltip.style.left = (clientX + 14) + 'px';
  coordTooltip.style.top = (clientY - 26) + 'px';
}

function startVertexDrag(idx, e) {
  isDraggingVertex = true;
  dragVertexIdx = idx;
  dragVertexOrigPoints = pendingPolyline.points.map(p => ({...p}));

  if (idx === 0 || idx === pendingPolyline.points.length - 1) {
    activeExtendIdx = idx;
  }

  dom.svg.style.cursor = 'move';
  dom.handleLayer.innerHTML = '';

  // Show the dragged vertex as an active (white filled) circle
  const pt = pendingPolyline.points[idx];
  const r = getExtendHandleRadius();
  dragVisualHandle = svgEl('circle', {
    cx: pt.x, cy: pt.y, r,
    class: 'handle handle-endpoint active',
    'pointer-events': 'none',
  });
  dom.handleLayer.appendChild(dragVisualHandle);

  // Coordinate tooltip
  coordTooltip = document.createElement('div');
  coordTooltip.style.cssText = 'position:fixed;background:rgba(0,0,0,0.75);color:#fff;padding:2px 7px;border-radius:3px;font-size:12px;pointer-events:none;z-index:100;font-family:monospace;';
  document.body.appendChild(coordTooltip);
  updateCoordTooltip(e.clientX, e.clientY, pt);

  document.addEventListener('pointermove', onVertexDragMove);
  document.addEventListener('pointerup', onVertexDragEnd);
}

function onVertexDragMove(e) {
  if (!isDraggingVertex || !pendingPolyline) return;
  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  const pts = pendingPolyline.points;

  pts[dragVertexIdx] = { x: pt.x, y: pt.y };
  syncLineEndpoints(pendingPolyline);

  updateLineElement(pendingPolyline);

  if (dragVisualHandle) {
    dragVisualHandle.setAttribute('cx', pt.x);
    dragVisualHandle.setAttribute('cy', pt.y);
  }
  updateCoordTooltip(e.clientX, e.clientY, pt);
}

function onVertexDragEnd() {
  document.removeEventListener('pointermove', onVertexDragMove);
  document.removeEventListener('pointerup', onVertexDragEnd);

  if (!isDraggingVertex || !pendingPolyline) return;
  isDraggingVertex = false;
  dragVertexIdx = -1;
  dragStartPt = null;

  const origPt = dragVertexOrigPoints[dragVertexIdx];
  const currPt = pendingPolyline.points[dragVertexIdx];
  if (!isEditingExisting && (origPt.x !== currPt.x || origPt.y !== currPt.y)) {
    const data = pendingPolyline;
    const origSnap = dragVertexOrigPoints;
    const finalSnap = data.points.map(p => ({...p}));

    pushAction({
      description: 'Move vertex',
      doFn: () => {
        for (let i = 0; i < data.points.length; i++) {
          data.points[i].x = finalSnap[i].x;
          data.points[i].y = finalSnap[i].y;
        }
        syncLineEndpoints(data);
        updateLineElement(data);
      },
      undoFn: () => {
        for (let i = 0; i < data.points.length; i++) {
          data.points[i].x = origSnap[i].x;
          data.points[i].y = origSnap[i].y;
        }
        syncLineEndpoints(data);
        updateLineElement(data);
      },
    });
  }

  dom.svg.style.cursor = 'crosshair';
  cleanupDragUI();
  drawLineToolCircleHandles(pendingPolyline, activeExtendIdx);
}

function onVertexDragPrepare(e) {
  clearTimeout(longPressTimer);
  if (!pendingPolyline || !dragStartPt) { cleanupVertexClickState(); return; }
  const currentPt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  const dx = currentPt.x - dragStartPt.x;
  const dy = currentPt.y - dragStartPt.y;
  if (Math.sqrt(dx * dx + dy * dy) < 3) return;

  document.removeEventListener('pointermove', onVertexDragPrepare);
  document.removeEventListener('pointerup', onVertexClickEnd);

  isDraggingVertex = true;
  dom.svg.style.cursor = 'move';
  dom.handleLayer.innerHTML = '';

  const r = getExtendHandleRadius();
  const pt = pendingPolyline.points[dragVertexIdx];
  dragVisualHandle = svgEl('circle', {
    cx: pt.x, cy: pt.y, r,
    class: 'handle handle-endpoint active',
    'pointer-events': 'none',
  });
  dom.handleLayer.appendChild(dragVisualHandle);

  document.addEventListener('pointermove', onVertexDragMove);
  document.addEventListener('pointerup', onVertexDragEnd);
}

function onVertexClickEnd() {
  clearTimeout(longPressTimer);
  document.removeEventListener('pointermove', onVertexDragPrepare);
  document.removeEventListener('pointerup', onVertexClickEnd);
  dragVertexOrigPoints = null;
  dragVertexIdx = -1;
  dragStartPt = null;
  updateCutButtonState();
}

function cleanupVertexClickState() {
  clearTimeout(longPressTimer);
  document.removeEventListener('pointermove', onVertexDragPrepare);
  document.removeEventListener('pointerup', onVertexClickEnd);
  dragVertexOrigPoints = null;
  dragVertexIdx = -1;
  dragStartPt = null;
  isDraggingVertex = false;
}

function updateCutButtonState() {
  const btn = document.getElementById('btn-line-cut');
  if (!btn) return;
  const canCut = pendingPolyline && pendingPolyline.closed &&
    selectedNodeIndices.size === 2 &&
    areAdjacent([...selectedNodeIndices], pendingPolyline.points.length);
  btn.disabled = !canCut;
}

function areAdjacent(indices, pointCount) {
  const [a, b] = indices.sort((x, y) => x - y);
  return (b === a + 1) || (a === 0 && b === pointCount - 1);
}

function cutPolygonEdge() {
  if (!pendingPolyline || !pendingPolyline.closed) return;
  if (selectedNodeIndices.size !== 2) return;

  const [i1, i2] = [...selectedNodeIndices].sort((a, b) => a - b);
  const pts = pendingPolyline.points;
  const N = pts.length;

  if (!areAdjacent([i1, i2], N)) return;

  let startIdx, endIdx;
  if (i2 === i1 + 1) {
    startIdx = i2;
    endIdx = i1;
  } else {
    startIdx = i1;
    endIdx = i2;
  }

  const newPts = [];
  let idx = startIdx;
  while (true) {
    newPts.push({ x: pts[idx].x, y: pts[idx].y });
    if (idx === endIdx) break;
    idx = (idx + 1) % N;
  }

  pendingPolyline.points = newPts;
  pendingPolyline.closed = false;
  syncLineEndpoints(pendingPolyline);
  updateLineElement(pendingPolyline);

  selectedNodeIndices.clear();
  activeExtendIdx = newPts.length - 1;
  drawLineToolCircleHandles(pendingPolyline, activeExtendIdx);
  updateCutButtonState();
}

export function deleteActiveNode() {
  if (!pendingPolyline) return;
  const pts = pendingPolyline.points;
  if (pts.length <= 2) return;

  const idx = activeExtendIdx;
  pts.splice(idx, 1);

  if (activeExtendIdx >= pts.length) activeExtendIdx = pts.length - 1;
  if (pts.length === 2) {
    activeExtendIdx = 1;
    pendingPolyline.closed = false;
  }

  syncLineEndpoints(pendingPolyline);
  updateLineElement(pendingPolyline);
  selectedNodeIndices.clear();
  drawLineToolCircleHandles(pendingPolyline, activeExtendIdx);
  updateCutButtonState();
}

export function finalizePolyline() {
  if (!pendingPolyline) return;

  dom.handleLayer.innerHTML = '';

  const data = pendingPolyline;
  const id = data.id;

  if (isEditingExisting) {
    const origSnap = extendOrigPoints;
    const finalSnap = data.points.map(p => ({...p}));
    const origStyle = extendOrigStyle;
    const finalStyle = {
      lineStyle: data.lineStyle,
      lineMarkerSize: data.lineMarkerSize,
      startDecoration: data.startDecoration,
      endDecoration: data.endDecoration,
      startDecorationSize: data.startDecorationSize,
      endDecorationSize: data.endDecorationSize,
    };
    isEditingExisting = false;
    extendOrigPoints = null;
    extendOrigStyle = null;

    pushAction({
      description: data.points.length > origSnap.length ? 'Extend polyline' : 'Move vertices',
      doFn: () => {
        data.points.length = 0;
        for (const p of finalSnap) data.points.push({...p});
        syncLineEndpoints(data);
        Object.assign(data, finalStyle);
        updateLineElement(data);
      },
      undoFn: () => {
        data.points.length = 0;
        for (const p of origSnap) data.points.push({...p});
        syncLineEndpoints(data);
        Object.assign(data, origStyle);
        updateLineElement(data);
      },
    });
  } else {
    pushAction({
      description: data.points.length > 2 ? 'Draw polyline' : 'Draw line',
      doFn: () => {
        addLineElement(data);
        state.elements.push(data);
      },
      undoFn: () => {
        removeLineElement(id);
        state.elements = state.elements.filter(el => el.id !== id);
      },
    });
  }

  pendingPolyline = null;
  updateCutButtonState();
}

export function handlePolylineEscape() {
  if (pendingPolyline) {
    finalizePolyline();
    return true;
  }
  return false;
}

export function isLineExtending() {
  return !!pendingPolyline;
}

function onLineKeyDown(e) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  var tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (!pendingPolyline) return;
  if (isDraggingVertex) return;

  var pts = pendingPolyline.points;
  var idx = activeExtendIdx;
  var step = 1;
  var dx = 0, dy = 0;

  switch (e.key) {
    case 'ArrowUp': dy = -step; break;
    case 'ArrowDown': dy = step; break;
    case 'ArrowLeft': dx = -step; break;
    case 'ArrowRight': dx = step; break;
    case 'Tab':
      e.preventDefault();
      if (e.shiftKey) {
        activeExtendIdx = (idx - 1 + pts.length) % pts.length;
      } else {
        activeExtendIdx = (idx + 1) % pts.length;
      }
      drawLineToolCircleHandles(pendingPolyline, activeExtendIdx);
      return;
    case 'Delete':
    case 'Backspace':
      e.preventDefault();
      deleteActiveNode();
      return;
    default: return;
  }

  e.preventDefault();
  var pt = pts[idx];
  pt.x += dx;
  pt.y += dy;
  syncLineEndpoints(pendingPolyline);
  updateLineElement(pendingPolyline);
  drawLineToolCircleHandles(pendingPolyline, activeExtendIdx);
  if (coordTooltip) {
    var svgPt = dom.svg.createSVGPoint();
    svgPt.x = pt.x;
    svgPt.y = pt.y;
    var screenPt = svgPt.matrixTransform(dom.svg.getScreenCTM());
    updateCoordTooltip(screenPt.x, screenPt.y, pt);
  }
}

export function getPendingPolylineId() {
  return pendingPolyline ? pendingPolyline.id : null;
}

/**
 * Create SVG elements for a line annotation.
 */
export function addLineElement(data) {
  // Ensure points array (backward compat with old data format)
  const pts = data.points || [{x: data.x1, y: data.y1}, {x: data.x2, y: data.y2}];
  if (!data.points) data.points = pts;

  const group = svgEl('g', { id: data.id, 'data-type': 'line' });
  const lineState = getLineState(data);
  group.dataset.lineStyle = normalizeLineStyle(lineState.lineStyle);
  group.dataset.lineMarkerSize = normalizeLineMarkerSize(lineState.lineMarkerSize);
  group.dataset.startDecoration = lineState.startDecoration;
  group.dataset.endDecoration = lineState.endDecoration;
  group.dataset.startDecorationSize = lineState.startDecorationSize;
  group.dataset.endDecorationSize = lineState.endDecorationSize;

  const decorData = {
    ...lineState,
    x1: pts[0].x, y1: pts[0].y,
    x2: pts[pts.length - 1].x, y2: pts[pts.length - 1].y,
  };
  if (pts.length >= 3) {
    decorData.startDirX = pts[1].x;
    decorData.startDirY = pts[1].y;
    decorData.endDirX = pts[pts.length - 2].x;
    decorData.endDirY = pts[pts.length - 2].y;
  }

  if (pts.length >= 3) {
    const ptsStr = pts.map(p => `${p.x},${p.y}`).join(' ');
    if (data.closed) {
      const hasFill = data.fill && data.fill !== 'none' && data.fill !== 'transparent';
      const polygonAttrs = {
        points: ptsStr,
        fill: hasFill ? data.fill : 'none',
        stroke: data.stroke,
        'stroke-width': data.strokeWidth,
        class: 'annotation-line',
      };
      if (hasFill) polygonAttrs.style = 'pointer-events: visibleFill';
      const polygon = svgEl('polygon', polygonAttrs);
      applyLineStyle(polygon, data.lineStyle);

      const hitArea = svgEl('polygon', {
        points: ptsStr,
        fill: 'none',
        class: 'line-hit-area',
      });

      group.appendChild(hitArea);
      group.appendChild(polygon);
    } else {
      const polyline = svgEl('polyline', {
        points: ptsStr,
        fill: 'none',
        stroke: data.stroke,
        'stroke-width': data.strokeWidth,
        class: 'annotation-line',
      });
      applyLineStyle(polyline, data.lineStyle);

      const hitArea = svgEl('polyline', {
        points: ptsStr,
        fill: 'none',
        class: 'line-hit-area',
      });

      const decorations = buildLineDecorations(decorData);

      group.appendChild(hitArea);
      group.appendChild(polyline);
      group.appendChild(decorations);
    }
  } else {
    // Render as line (2 points)
    const line = svgEl('line', {
      x1: pts[0].x, y1: pts[0].y,
      x2: pts[1].x, y2: pts[1].y,
      stroke: data.stroke,
      'stroke-width': data.strokeWidth,
      class: 'annotation-line',
    });
    applyLineStyle(line, data.lineStyle);

    const decorations = buildLineDecorations(decorData);
    const hitArea = svgEl('line', {
      x1: pts[0].x, y1: pts[0].y,
      x2: pts[1].x, y2: pts[1].y,
      class: 'line-hit-area',
    });

    group.appendChild(hitArea);
    group.appendChild(line);
    group.appendChild(decorations);
  }

  if (data.rotation) {
    const cx = (pts[0].x + pts[pts.length - 1].x) / 2;
    const cy = (pts[0].y + pts[pts.length - 1].y) / 2;
    group.setAttribute('transform', `rotate(${data.rotation}, ${cx}, ${cy})`);
  }

  dom.annotationLayer.appendChild(group);
}

export function updateLineElement(data) {
  const group = dom.annotationLayer.querySelector(`#${CSS.escape(data.id)}`);
  if (!group) {
    addLineElement(data);
    return;
  }
  const pts = data.points || [{x: data.x1, y: data.y1}, {x: data.x2, y: data.y2}];
  const lineEl = group.querySelector('.annotation-line');
  const hitArea = group.querySelector('.line-hit-area');
  if (!lineEl || !hitArea) {
    group.remove();
    addLineElement(data);
    return;
  }
  const lineState = getLineState(data);
  const isPoly = pts.length >= 3;
  const isClosed = !!data.closed;
  const currentTag = lineEl.tagName.toLowerCase();
  const expectedTag = isPoly ? (isClosed ? 'polygon' : 'polyline') : 'line';
  if (currentTag !== expectedTag) {
    group.remove();
    addLineElement(data);
    return;
  }
  group.dataset.lineStyle = normalizeLineStyle(lineState.lineStyle);
  group.dataset.lineMarkerSize = normalizeLineMarkerSize(lineState.lineMarkerSize);
  group.dataset.startDecoration = lineState.startDecoration;
  group.dataset.endDecoration = lineState.endDecoration;
  group.dataset.startDecorationSize = lineState.startDecorationSize;
  group.dataset.endDecorationSize = lineState.endDecorationSize;
  if (data.rotation) {
    const cx = (pts[0].x + pts[pts.length - 1].x) / 2;
    const cy = (pts[0].y + pts[pts.length - 1].y) / 2;
    group.setAttribute('transform', `rotate(${data.rotation}, ${cx}, ${cy})`);
  } else {
    group.removeAttribute('transform');
  }
  const decorData = {
    ...lineState,
    stroke: data.stroke,
    x1: pts[0].x, y1: pts[0].y,
    x2: pts[pts.length - 1].x, y2: pts[pts.length - 1].y,
  };
  if (pts.length >= 3) {
    decorData.startDirX = pts[1].x;
    decorData.startDirY = pts[1].y;
    decorData.endDirX = pts[pts.length - 2].x;
    decorData.endDirY = pts[pts.length - 2].y;
  }
  if (isPoly) {
    const ptsStr = pts.map(p => `${p.x},${p.y}`).join(' ');
    lineEl.setAttribute('points', ptsStr);
    hitArea.setAttribute('points', ptsStr);
    lineEl.setAttribute('stroke', data.stroke);
    lineEl.setAttribute('stroke-width', data.strokeWidth);
    applyLineStyle(lineEl, data.lineStyle);
    if (isClosed) {
      const hasFill = data.fill && data.fill !== 'none' && data.fill !== 'transparent';
      lineEl.setAttribute('fill', hasFill ? data.fill : 'none');
      if (hasFill) {
        lineEl.setAttribute('style', 'pointer-events: visibleFill');
      } else {
        lineEl.removeAttribute('style');
      }
      const decorations = group.querySelector('.line-decorations');
      if (decorations) decorations.remove();
    } else {
      lineEl.setAttribute('fill', 'none');
      if (lineEl.getAttribute('style') === 'pointer-events: visibleFill') {
        lineEl.removeAttribute('style');
      }
      replaceLineDecorations(group, decorData);
    }
  } else {
    lineEl.setAttribute('x1', pts[0].x);
    lineEl.setAttribute('y1', pts[0].y);
    lineEl.setAttribute('x2', pts[1].x);
    lineEl.setAttribute('y2', pts[1].y);
    lineEl.setAttribute('stroke', data.stroke);
    lineEl.setAttribute('stroke-width', data.strokeWidth);
    applyLineStyle(lineEl, data.lineStyle);
    hitArea.setAttribute('x1', pts[0].x);
    hitArea.setAttribute('y1', pts[0].y);
    hitArea.setAttribute('x2', pts[1].x);
    hitArea.setAttribute('y2', pts[1].y);
    replaceLineDecorations(group, decorData);
  }
}

function replaceLineDecorations(group, decorData) {
  const old = group.querySelector('.line-decorations');
  if (old) old.remove();
  const decorations = buildLineDecorations(decorData);
  group.appendChild(decorations);
}

export function normalizeLineStyle(style) {
  return LINE_STYLES.includes(style) ? style : 'normal';
}

export function normalizeLineMarkerSize(size) {
  const n = Number(size);
  if (Number.isNaN(n)) return 30;
  return Math.max(2, Math.min(200, n));
}

export function normalizeLineDecoration(value) {
  if (LINE_DECORATIONS.includes(value)) return value;
  if (value === 'arrow' || value === 'arrows') return 'arrow';
  if (value === 'circle') return 'circle';
  return 'none';
}

export function styleToDecoration(style) {
  if (style === 'arrows') return 'arrow';
  if (style === 'circle') return 'circle';
  return 'none';
}

export function decorationToStyle(decoration) {
  if (decoration === 'arrow') return 'arrows';
  if (decoration === 'circle') return 'circle';
  return 'normal';
}

export function legacyStyleToDecorations(style, size) {
  const norm = normalizeLineStyle(style);
  const markerSize = normalizeLineMarkerSize(size);
  if (norm === 'arrows') {
    return { startDecoration: 'arrow', endDecoration: 'arrow', startDecorationSize: markerSize, endDecorationSize: markerSize };
  }
  if (norm === 'circle') {
    return { startDecoration: 'circle', endDecoration: 'circle', startDecorationSize: markerSize, endDecorationSize: markerSize };
  }
  return { startDecoration: 'none', endDecoration: 'none', startDecorationSize: markerSize, endDecorationSize: markerSize };
}

function getLineState(data) {
  const lineStyle = normalizeLineStyle(data.lineStyle);
  const markerSize = normalizeLineMarkerSize(data.lineMarkerSize);
  const startDecoration = data.startDecoration !== undefined ? normalizeLineDecoration(data.startDecoration) : styleToDecoration(lineStyle);
  const endDecoration = data.endDecoration !== undefined ? normalizeLineDecoration(data.endDecoration) : styleToDecoration(lineStyle);
  const startDecorationSize = data.startDecorationSize !== undefined ? normalizeLineMarkerSize(data.startDecorationSize) : markerSize;
  const endDecorationSize = data.endDecorationSize !== undefined ? normalizeLineMarkerSize(data.endDecorationSize) : markerSize;
  return { lineStyle, lineMarkerSize: markerSize, startDecoration, endDecoration, startDecorationSize, endDecorationSize, stroke: data.stroke };
}

export function applyLineStyle(el, style) {
  const norm = normalizeLineStyle(style);
  el.setAttribute('data-line-style', norm);
  el.setAttribute('stroke-linecap', 'round');
  el.removeAttribute('marker-start');
  el.removeAttribute('marker-end');
}

export function setActiveLineStyle(style) {
  state.activeLineStyle = normalizeLineStyle(style);
  updateLineStyleButtons();
  document.dispatchEvent(new CustomEvent('line-style-changed', { detail: { style: state.activeLineStyle } }));
}

export function setActiveLineMarkerSize(size) {
  state.activeLineMarkerSize = normalizeLineMarkerSize(size);
  updateLineMarkerSizeInput();
  document.dispatchEvent(new CustomEvent('line-marker-size-changed', { detail: { size: state.activeLineMarkerSize } }));
}

function updateLineStyleButtons() {
  if (!lineStyleButtons) return;
  for (const [style, btn] of Object.entries(lineStyleButtons)) {
    btn.classList.toggle('active', style === state.activeLineStyle);
  }
}

function updateLineMarkerSizeInput() {
  if (lineMarkerSizeInput) lineMarkerSizeInput.value = state.activeLineMarkerSize;
}

function ensureLineMarkers() {
  // Decorations are rendered per line, no shared markers needed.
}

function buildLineDecorations(data) {
  const group = svgEl('g', { class: 'line-decorations', 'pointer-events': 'none' });
  const lineColor = data.stroke || '#000';
  const sdx = data.startDirX, sdy = data.startDirY;
  const edx = data.endDirX, edy = data.endDirY;

  if (data.startDecoration && data.startDecoration !== 'none') {
    const tx = data.x1, ty = data.y1;
    const dx = (sdx != null) ? sdx : data.x2;
    const dy = (sdy != null) ? sdy : data.y2;
    group.appendChild(buildDecoration(data.startDecoration, tx, ty, dx, dy, normalizeLineMarkerSize(data.startDecorationSize), lineColor));
  }
  if (data.endDecoration && data.endDecoration !== 'none') {
    const tx = data.x2, ty = data.y2;
    const dx = (edx != null) ? edx : data.x1;
    const dy = (edy != null) ? edy : data.y1;
    group.appendChild(buildDecoration(data.endDecoration, tx, ty, dx, dy, normalizeLineMarkerSize(data.endDecorationSize), lineColor));
  }
  return group;
}

function buildDecoration(type, x1, y1, x2, y2, size, color) {
  if (type === 'circle') return buildCircle(x1, y1, x2, y2, size, color);
  return buildArrow(x1, y1, x2, y2, size, color);
}

function buildArrow(x1, y1, x2, y2, size, color) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const tip = { x: x1, y: y1 };
  const base = { x: x1 + ux * size, y: y1 + uy * size };
  const halfW = size * 0.45;
  const left = { x: base.x + px * halfW, y: base.y + py * halfW };
  const right = { x: base.x - px * halfW, y: base.y - py * halfW };
  return svgEl('polygon', {
    points: `${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`,
    fill: color,
  });
}

function buildCircle(x1, y1, x2, y2, size, color) {
  const radius = Math.max(2, size * 0.5);
  return svgEl('circle', {
    cx: x1,
    cy: y1,
    r: radius,
    fill: color,
  });
}

export function getLineDecorationsSvg(data) {
  const color = data.stroke || '#000';
  const out = [];
  if (data.startDecoration && data.startDecoration !== 'none') {
    out.push(getDecorationSvg(data.startDecoration, data.x1, data.y1, data.x2, data.y2, normalizeLineMarkerSize(data.startDecorationSize), color));
  }
  if (data.endDecoration && data.endDecoration !== 'none') {
    out.push(getDecorationSvg(data.endDecoration, data.x2, data.y2, data.x1, data.y1, normalizeLineMarkerSize(data.endDecorationSize), color));
  }
  return out.join('');
}

function getDecorationSvg(type, x1, y1, x2, y2, size, color) {
  if (type === 'circle') {
    const c = getCircleAttrs(x1, y1, x2, y2, size);
    return `<circle cx="${c.cx}" cy="${c.cy}" r="${c.r}" fill="${color}" />`;
  }
  const points = getArrowPoints(x1, y1, x2, y2, size);
  return `<polygon points="${points}" fill="${color}" />`;
}

function getArrowPoints(x1, y1, x2, y2, size) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const tip = { x: x1, y: y1 };
  const base = { x: x1 + ux * size, y: y1 + uy * size };
  const halfW = size * 0.45;
  const left = { x: base.x + px * halfW, y: base.y + py * halfW };
  const right = { x: base.x - px * halfW, y: base.y - py * halfW };
  return `${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`;
}

function getCircleAttrs(x1, y1, x2, y2, size) {
  const r = Math.max(2, size * 0.5);
  return { cx: x1, cy: y1, r };
}

function removeLineElement(id) {
  const el = dom.annotationLayer.querySelector(`#${CSS.escape(id)}`);
  if (el) el.remove();
}
