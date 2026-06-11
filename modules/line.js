// ── Line module: Straight line drawing ─────────────────────────

import { state, dom } from './editor.js';
import { generateId, svgEl, screenToCoords } from './utils.js';
import { pushAction } from './history.js';

let isDrawing = false;
let previewLine = null;
let startPt = null;
let lineStyleButtons = null;

const LINE_STYLES = ['normal', 'arrows', 'circle'];

export function initLine() {
  ensureLineMarkers();

  lineStyleButtons = {
    normal: document.getElementById('btn-line-style-normal'),
    arrows: document.getElementById('btn-line-style-arrows'),
    circle: document.getElementById('btn-line-style-circle'),
  };

  for (const [style, btn] of Object.entries(lineStyleButtons)) {
    btn.addEventListener('click', () => setActiveLineStyle(style));
  }

  updateLineStyleButtons();
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
  group.dataset.lineStyle = normalizeLineStyle(data.lineStyle);

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
  dom.annotationLayer.appendChild(group);
}

export function normalizeLineStyle(style) {
  return LINE_STYLES.includes(style) ? style : 'normal';
}

export function applyLineStyle(el, style) {
  const norm = normalizeLineStyle(style);
  el.setAttribute('data-line-style', norm);
  el.setAttribute('stroke-linecap', 'round');
  if (el.getAttribute('stroke')) {
    el.setAttribute('color', el.getAttribute('stroke'));
  }
  el.removeAttribute('marker-start');
  el.removeAttribute('marker-end');

  if (norm === 'arrows') {
    el.setAttribute('marker-start', 'url(#annotator-line-arrow-start)');
    el.setAttribute('marker-end', 'url(#annotator-line-arrow-end)');
  } else if (norm === 'circle') {
    el.setAttribute('marker-start', 'url(#annotator-line-circle-start)');
  }
}

export function getLineStyleSvgAttrs(style) {
  const norm = normalizeLineStyle(style);
  if (norm === 'arrows') {
    return ' stroke-linecap="round" marker-start="url(#annotator-line-arrow-start)" marker-end="url(#annotator-line-arrow-end)"';
  }
  if (norm === 'circle') {
    return ' stroke-linecap="round" marker-start="url(#annotator-line-circle-start)"';
  }
  return ' stroke-linecap="round"';
}

export function getLineMarkerDefsSvg() {
  return `
    <defs>
      <marker id="annotator-line-arrow-start" markerWidth="10" markerHeight="10" refX="7" refY="5" orient="auto" markerUnits="userSpaceOnUse">
        <path d="M10 0L0 5L10 10Z" fill="currentColor"></path>
      </marker>
      <marker id="annotator-line-arrow-end" markerWidth="10" markerHeight="10" refX="3" refY="5" orient="auto" markerUnits="userSpaceOnUse">
        <path d="M0 0L10 5L0 10Z" fill="currentColor"></path>
      </marker>
      <marker id="annotator-line-circle-start" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto" markerUnits="userSpaceOnUse">
        <circle cx="5" cy="5" r="4" fill="currentColor"></circle>
      </marker>
    </defs>`;
}

export function setActiveLineStyle(style) {
  state.activeLineStyle = normalizeLineStyle(style);
  updateLineStyleButtons();
  document.dispatchEvent(new CustomEvent('line-style-changed', { detail: { style: state.activeLineStyle } }));
}

function updateLineStyleButtons() {
  if (!lineStyleButtons) return;
  for (const [style, btn] of Object.entries(lineStyleButtons)) {
    btn.classList.toggle('active', style === state.activeLineStyle);
  }
}

function ensureLineMarkers() {
  if (!dom.svg) return;
  if (dom.svg.querySelector('#annotator-line-marker-defs')) return;
  const defsHost = dom.svg.querySelector('defs') || dom.svg.insertBefore(document.createElementNS('http://www.w3.org/2000/svg', 'defs'), dom.svg.firstChild);
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.id = 'annotator-line-marker-defs';

  const arrowStart = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  arrowStart.setAttribute('id', 'annotator-line-arrow-start');
  arrowStart.setAttribute('markerWidth', '10');
  arrowStart.setAttribute('markerHeight', '10');
  arrowStart.setAttribute('refX', '7');
  arrowStart.setAttribute('refY', '5');
  arrowStart.setAttribute('orient', 'auto');
  arrowStart.setAttribute('markerUnits', 'userSpaceOnUse');
  arrowStart.appendChild(svgEl('path', { d: 'M10 0L0 5L10 10Z', fill: 'currentColor' }));

  const arrowEnd = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  arrowEnd.setAttribute('id', 'annotator-line-arrow-end');
  arrowEnd.setAttribute('markerWidth', '10');
  arrowEnd.setAttribute('markerHeight', '10');
  arrowEnd.setAttribute('refX', '3');
  arrowEnd.setAttribute('refY', '5');
  arrowEnd.setAttribute('orient', 'auto');
  arrowEnd.setAttribute('markerUnits', 'userSpaceOnUse');
  arrowEnd.appendChild(svgEl('path', { d: 'M0 0L10 5L0 10Z', fill: 'currentColor' }));

  const circleStart = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  circleStart.setAttribute('id', 'annotator-line-circle-start');
  circleStart.setAttribute('markerWidth', '10');
  circleStart.setAttribute('markerHeight', '10');
  circleStart.setAttribute('refX', '5');
  circleStart.setAttribute('refY', '5');
  circleStart.setAttribute('orient', 'auto');
  circleStart.setAttribute('markerUnits', 'userSpaceOnUse');
  circleStart.appendChild(svgEl('circle', { cx: 5, cy: 5, r: 4, fill: 'currentColor' }));

  defs.appendChild(arrowStart);
  defs.appendChild(arrowEnd);
  defs.appendChild(circleStart);
  defsHost.appendChild(defs);
}

function removeLineElement(id) {
  const el = dom.annotationLayer.querySelector(`#${CSS.escape(id)}`);
  if (el) el.remove();
}
