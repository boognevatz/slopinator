// ── Line module: Straight line drawing ─────────────────────────

import { state, dom } from './editor.js';
import { generateId, svgEl, screenToCoords } from './utils.js';
import { pushAction } from './history.js';

let isDrawing = false;
let previewLine = null;
let startPt = null;

export function initLine() {
  // handled by tools.js activation
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
    'stroke-linecap': 'round',
    opacity: '0.6',
    'pointer-events': 'none',
  });
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

  // Visible line
  const line = svgEl('line', {
    x1: data.x1,
    y1: data.y1,
    x2: data.x2,
    y2: data.y2,
    stroke: data.stroke,
    'stroke-width': data.strokeWidth,
    'stroke-linecap': 'round',
    class: 'annotation-line',
  });

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

function removeLineElement(id) {
  const el = dom.annotationLayer.querySelector(`#${CSS.escape(id)}`);
  if (el) el.remove();
}
