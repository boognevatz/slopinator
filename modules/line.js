// ── Line module: Straight line drawing & polyline builder ─────────────────────────

import { state, dom } from './editor.js';
import { generateId, svgEl, screenToCoords } from './utils.js';
import { pushAction } from './history.js';

let isDrawing = false;
let previewLine = null;
let startPt = null;
let lineStyleButtons = null;
let lineMarkerSizeInput = null;

// Polyline extend mode state
let pendingPolyline = null;
let activeExtendIdx = 0;

// Vertex drag state
let isDraggingVertex = false;
let dragVertexIdx = -1;
let dragVertexOrigPoints = null;
let dragVisualHandle = null;
let coordTooltip = null;

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

  lineMarkerSizeInput.addEventListener('change', () => {
    const val = parseFloat(lineMarkerSizeInput.value);
    if (Number.isNaN(val) || val < 2) return;
    setActiveLineMarkerSize(val);
  });

  updateLineStyleButtons();
  updateLineMarkerSizeInput();
}

export function activateLine() {
  dom.svg.style.cursor = 'crosshair';
  dom.svg.addEventListener('mousedown', onMouseDown);
}

export function deactivateLine() {
  dom.svg.style.cursor = '';
  dom.svg.removeEventListener('mousedown', onMouseDown);
  if (isDraggingVertex) {
    document.removeEventListener('mousemove', onVertexDragMove);
    document.removeEventListener('mouseup', onVertexDragEnd);
    isDraggingVertex = false;
  }
  cleanupDragUI();
  finalizePolyline();
  cancelDraw();
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  if (!state.hasImage) return;

  const target = e.target;

  // If we have a pending polyline waiting for extend/finalize
  if (pendingPolyline) {
    const clickPt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
    const threshold = getExtendHitRadius();
    const nearIdx = findNearestVertex(clickPt, pendingPolyline.points, threshold);
    if (nearIdx !== -1) {
      e.preventDefault();
      startVertexDrag(nearIdx, e);
      return;
    }
    // Clicking on other annotation → don't interfere
    if (target.classList.contains('annotation-line') ||
        target.classList.contains('annotation-text') ||
        target.classList.contains('line-hit-area')) return;
    // Clicked empty space → one-click extend from active endpoint
    addExtensionPoint(e);
    return;
  }

  // Don't start drawing on existing annotations
  if (target.classList.contains('annotation-line') ||
      target.classList.contains('annotation-text') ||
      target.classList.contains('line-hit-area') ||
      target.classList.contains('handle')) return;

  isDrawing = true;
  startPt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);

  previewLine = svgEl('line', {
    x1: startPt.x,
    y1: startPt.y,
    x2: startPt.x,
    y2: startPt.y,
    stroke: state.activeColor,
    'stroke-width': state.activeThickness,
    opacity: '0.6',
    'pointer-events': 'none',
  });
  applyLineStyle(previewLine, state.activeLineStyle);
  dom.annotationLayer.appendChild(previewLine);

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function onMouseMove(e) {
  if (!isDrawing || !previewLine) return;
  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  previewLine.setAttribute('x2', pt.x);
  previewLine.setAttribute('y2', pt.y);
}

function onMouseUp(e) {
  if (!isDrawing) return;
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);

  const endPt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);

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
  showExtendHandles(lineData, 1);

  isDrawing = false;
}

function cancelDraw() {
  if (previewLine && previewLine.parentNode) {
    previewLine.parentNode.removeChild(previewLine);
  }
  previewLine = null;
  isDrawing = false;
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
}

// ── Polyline extend mode ────────────────────────────────────────

function showExtendHandles(data, activeIdx) {
  dom.handleLayer.innerHTML = '';
  const visR = getExtendHandleRadius();
  const hitR = getExtendHitRadius();
  const pts = data.points;

  for (let i = 0; i < pts.length; i++) {
    const x = pts[i].x, y = pts[i].y;
    const isFirst = i === 0;
    const isLast = i === pts.length - 1;
    const isActive = (isFirst && activeIdx === 0) || (isLast && activeIdx === pts.length - 1);
    const handleLabel = isFirst ? 'p1' : isLast ? 'p2' : 'v' + i;

    // Hit area (larger, transparent, captures mouse events for hand cursor)
    const hit = svgEl('circle', {
      cx: x, cy: y, r: hitR,
      class: 'handle-extend',
      fill: 'transparent',
      stroke: 'none',
      'data-handle': handleLabel,
    });
    dom.handleLayer.appendChild(hit);

    // Visual circle (smaller, visible, does not capture mouse events)
    const vis = svgEl('circle', {
      cx: x, cy: y, r: visR,
      class: 'handle handle-endpoint' + (isActive ? ' active' : ' unselected'),
      'pointer-events': 'none',
    });
    dom.handleLayer.appendChild(vis);
  }
}

function getExtendHandleRadius() {
  const viewBox = dom.svg.viewBox.baseVal;
  if (!viewBox || viewBox.width === 0) return 10;
  const svgRect = dom.svg.getBoundingClientRect();
  const scale = viewBox.width / svgRect.width;
  return Math.max(6, 10 * scale);
}

function getExtendHitRadius() {
  return getExtendHandleRadius() + 4;
}

function addExtensionPoint(e) {
  if (!pendingPolyline) return;

  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
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
  showExtendHandles(pendingPolyline, activeExtendIdx);
}

// ── Vertex dragging ─────────────────────────────────────────────

function findNearestVertex(pt, points, threshold) {
  let nearest = -1;
  let minDist = threshold;
  for (let i = 0; i < points.length; i++) {
    const dx = pt.x - points[i].x;
    const dy = pt.y - points[i].y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < minDist) {
      minDist = dist;
      nearest = i;
    }
  }
  return nearest;
}

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
  const y = Math.round(pt.y);
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

  document.addEventListener('mousemove', onVertexDragMove);
  document.addEventListener('mouseup', onVertexDragEnd);
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
  document.removeEventListener('mousemove', onVertexDragMove);
  document.removeEventListener('mouseup', onVertexDragEnd);

  if (!isDraggingVertex || !pendingPolyline) return;
  isDraggingVertex = false;

  const origPt = dragVertexOrigPoints[dragVertexIdx];
  const currPt = pendingPolyline.points[dragVertexIdx];
  if (origPt.x !== currPt.x || origPt.y !== currPt.y) {
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
  showExtendHandles(pendingPolyline, activeExtendIdx);
}

export function finalizePolyline() {
  if (!pendingPolyline) return;

  dom.handleLayer.innerHTML = '';

  const data = pendingPolyline;
  const id = data.id;

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

  pendingPolyline = null;
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

  const decorData = { ...lineState, x1: pts[0].x, y1: pts[0].y, x2: pts[pts.length - 1].x, y2: pts[pts.length - 1].y };

  if (pts.length >= 3) {
    // Render as polyline
    const ptsStr = pts.map(p => `${p.x},${p.y}`).join(' ');
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

  dom.annotationLayer.appendChild(group);
}

export function updateLineElement(data) {
  const group = dom.annotationLayer.querySelector(`#${CSS.escape(data.id)}`);
  if (group) group.remove();
  addLineElement(data);
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

function legacyStyleToDecorations(style, size) {
  const norm = normalizeLineStyle(style);
  const markerSize = normalizeLineMarkerSize(size);
  if (norm === 'arrows') {
    return { startDecoration: 'arrow', endDecoration: 'arrow', startDecorationSize: markerSize, endDecorationSize: markerSize };
  }
  if (norm === 'circle') {
    return { startDecoration: 'circle', endDecoration: 'none', startDecorationSize: markerSize, endDecorationSize: markerSize };
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

  if (data.startDecoration && data.startDecoration !== 'none') {
    group.appendChild(buildDecoration(data.startDecoration, data.x1, data.y1, data.x2, data.y2, normalizeLineMarkerSize(data.startDecorationSize), lineColor));
  }
  if (data.endDecoration && data.endDecoration !== 'none') {
    group.appendChild(buildDecoration(data.endDecoration, data.x2, data.y2, data.x1, data.y1, normalizeLineMarkerSize(data.endDecorationSize), lineColor));
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
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const radius = Math.max(2, size * 0.5);
  return svgEl('circle', {
    cx: x1 + ux * radius,
    cy: y1 + uy * radius,
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
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const r = Math.max(2, size * 0.5);
  return { cx: x1 + ux * r, cy: y1 + uy * r, r };
}

function removeLineElement(id) {
  const el = dom.annotationLayer.querySelector(`#${CSS.escape(id)}`);
  if (el) el.remove();
}
