// ── Line module: Straight line drawing ─────────────────────────

import { state, dom } from './editor.js';
import { generateId, svgEl, screenToCoords } from './utils.js';
import { pushAction } from './history.js';

let isDrawing = false;
let previewLine = null;
let startPt = null;
let lineStyleButtons = null;
let lineMarkerSizeInput = null;

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
  cancelDraw();
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  if (!state.hasImage) return;

  // Don't start drawing on existing annotations
  const target = e.target;
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
  const lineData = {
    id,
    type: 'line',
    x1: startPt.x,
    y1: startPt.y,
    x2: endPt.x,
    y2: endPt.y,
    stroke: state.activeColor,
    strokeWidth: state.activeThickness,
    lineStyle: state.activeLineStyle,
    lineMarkerSize: state.activeLineMarkerSize,
    ...legacyStyleToDecorations(state.activeLineStyle, state.activeLineMarkerSize),
  };

  addLineElement(lineData);
  state.elements.push(lineData);

  pushAction({
    description: 'Draw line',
    doFn: () => {
      addLineElement(lineData);
      state.elements.push(lineData);
    },
    undoFn: () => {
      removeLineElement(id);
      state.elements = state.elements.filter(el => el.id !== id);
    },
  });

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

/**
 * Create SVG elements for a line annotation.
 */
export function addLineElement(data) {
  const group = svgEl('g', { id: data.id, 'data-type': 'line' });
  const lineState = getLineState(data);
  group.dataset.lineStyle = normalizeLineStyle(lineState.lineStyle);
  group.dataset.lineMarkerSize = normalizeLineMarkerSize(lineState.lineMarkerSize);
  group.dataset.startDecoration = lineState.startDecoration;
  group.dataset.endDecoration = lineState.endDecoration;
  group.dataset.startDecorationSize = lineState.startDecorationSize;
  group.dataset.endDecorationSize = lineState.endDecorationSize;

  // Visible line
  const line = svgEl('line', {
    x1: data.x1,
    y1: data.y1,
    x2: data.x2,
    y2: data.y2,
    stroke: data.stroke,
    'stroke-width': data.strokeWidth,
    class: 'annotation-line',
  });
  applyLineStyle(line, data.lineStyle);

  // Decorations for arrows / circle
  const decorations = buildLineDecorations(lineState, data.stroke);

  // Invisible wider hit area for easier selection
  const hitArea = svgEl('line', {
    x1: data.x1,
    y1: data.y1,
    x2: data.x2,
    y2: data.y2,
    class: 'line-hit-area',
  });

  group.appendChild(hitArea);
  group.appendChild(line);
  group.appendChild(decorations);
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
  if (Number.isNaN(n)) return 12;
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
