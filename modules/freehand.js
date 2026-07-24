// ── Freehand module: Freehand polyline drawing ──────────────────

import { state, dom } from './editor.js';
import { generateId, svgEl, screenToCoords } from './utils.js';
import { pushAction } from './history.js';

let isDrawing = false;
let rawPoints = [];
let previewPolyline = null;
let startPt = null;
let lastCaptureTime = 0;
const CAPTURE_INTERVAL = 20; // ~50 Hz max

export function initFreehand() {
  const slider = document.getElementById('freehand-epsilon-slider');
  const valueDisplay = document.getElementById('freehand-epsilon-value');
  if (slider && valueDisplay) {
    slider.addEventListener('input', () => {
      state.activeFreehandEpsilon = parseFloat(slider.value);
      valueDisplay.textContent = slider.value;

      // Re-simplify selected freehand element in real-time
      if (state.selectedId) {
        const data = state.elements.find(el => el.id === state.selectedId);
        if (data && data.type === 'freehand') {
          const sourcePoints = data.rawPoints || data.points;
          data.epsilon = state.activeFreehandEpsilon;
          data.points = simplifyPolyline(sourcePoints, data.epsilon);
          updateFreehandElement(data);
        }
      }
    });
  }
}

export function syncFreehandEpsilonSlider(value) {
  const slider = document.getElementById('freehand-epsilon-slider');
  const valueDisplay = document.getElementById('freehand-epsilon-value');
  if (slider) {
    slider.value = value;
    state.activeFreehandEpsilon = value;
    if (valueDisplay) valueDisplay.textContent = value;
  }
}

export function activateFreehand() {
  dom.svg.style.cursor = 'crosshair';
  dom.svg.addEventListener('pointerdown', onMouseDown);
  // Reset epsilon slider to default derived from stroke width
  const slider = document.getElementById('freehand-epsilon-slider');
  const valueDisplay = document.getElementById('freehand-epsilon-value');
  if (slider) {
    const defaultEps = Math.max(0.5, Math.min(15, state.activeThickness * 1.5));
    slider.value = defaultEps;
    state.activeFreehandEpsilon = defaultEps;
    if (valueDisplay) valueDisplay.textContent = defaultEps;
  }
}

export function deactivateFreehand() {
  dom.svg.style.cursor = '';
  dom.svg.removeEventListener('pointerdown', onMouseDown);
  cancelDraw();
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  if (!state.hasImage) return;

  const target = e.target;
  if (target.closest('.annotation-line, .annotation-text, .line-hit-area, .handle, polyline')) return;

  isDrawing = true;
  startPt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  rawPoints = [{ x: startPt.x, y: startPt.y }];
  lastCaptureTime = performance.now();

  previewPolyline = svgEl('polyline', {
    points: `${startPt.x},${startPt.y}`,
    stroke: state.activeColor,
    'stroke-width': state.activeThickness,
    fill: 'none',
    opacity: '0.6',
    'pointer-events': 'none',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  dom.annotationLayer.appendChild(previewPolyline);

  document.addEventListener('pointermove', onMouseMove);
  document.addEventListener('pointerup', onMouseUp);
}

function onMouseMove(e) {
  if (!isDrawing) return;

  const now = performance.now();
  if (now - lastCaptureTime < CAPTURE_INTERVAL) return;
  lastCaptureTime = now;

  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  rawPoints.push({ x: pt.x, y: pt.y });

  const ptsStr = rawPoints.map(p => `${p.x},${p.y}`).join(' ');
  previewPolyline.setAttribute('points', ptsStr);
}

function onMouseUp(e) {
  if (!isDrawing) return;
  document.removeEventListener('pointermove', onMouseMove);
  document.removeEventListener('pointerup', onMouseUp);

  if (previewPolyline && previewPolyline.parentNode) {
    previewPolyline.parentNode.removeChild(previewPolyline);
  }
  previewPolyline = null;

  isDrawing = false;

  if (rawPoints.length < 2) {
    rawPoints = [];
    return;
  }

  // Bounding box check
  const xs = rawPoints.map(p => p.x);
  const ys = rawPoints.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  if (maxX - minX < 20 && maxY - minY < 20) {
    rawPoints = [];
    return;
  }

  const epsilon = state.activeFreehandEpsilon || Math.max(0.5, Math.min(15, state.activeThickness * 1.5));
  const simplified = simplifyPolyline(rawPoints, epsilon);

  if (simplified.length < 2) {
    rawPoints = [];
    return;
  }

  const id = generateId();
  const data = {
    id,
    type: 'freehand',
    points: simplified,
    rawPoints,
    epsilon,
    stroke: state.activeColor,
    strokeWidth: state.activeThickness,
  };

  addFreehandElement(data);

  pushAction({
    description: 'Draw freehand',
    doFn: () => {
      addFreehandElement(data);
    },
    undoFn: () => {
      removeFreehandElement(id);
    },
  });

  rawPoints = [];
}

function cancelDraw() {
  if (previewPolyline && previewPolyline.parentNode) {
    previewPolyline.parentNode.removeChild(previewPolyline);
  }
  previewPolyline = null;
  isDrawing = false;
  rawPoints = [];
  document.removeEventListener('pointermove', onMouseMove);
  document.removeEventListener('pointerup', onMouseUp);
}

export function addFreehandElement(data) {
  const polyline = svgEl('polyline', {
    id: data.id,
    'data-type': 'freehand',
    'data-epsilon': data.epsilon,
    points: data.points.map(p => `${p.x},${p.y}`).join(' '),
    stroke: data.stroke,
    'stroke-width': data.strokeWidth,
    fill: 'none',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });

  // Invisible wider hit area
  const hitArea = svgEl('polyline', {
    points: data.points.map(p => `${p.x},${p.y}`).join(' '),
    class: 'line-hit-area',
  });

  const group = svgEl('g', { id: data.id, 'data-type': 'freehand' });
  group.appendChild(hitArea);
  group.appendChild(polyline);
  dom.annotationLayer.appendChild(group);
}

export function updateFreehandElement(data) {
  const group = dom.annotationLayer.querySelector(`#${CSS.escape(data.id)}`);
  if (group) group.remove();
  addFreehandElement(data);
}

function removeFreehandElement(id) {
  const el = dom.annotationLayer.querySelector(`#${CSS.escape(id)}`);
  if (el) el.remove();
}

export function simplifyPolyline(points, epsilon) {
  if (points.length < 3) return points.slice();

  let dmax = 0;
  let idx = 0;
  const end = points.length - 1;

  for (let i = 1; i < end; i++) {
    const d = perpendicularDistance(points[i], points[0], points[end]);
    if (d > dmax) {
      dmax = d;
      idx = i;
    }
  }

  if (dmax > epsilon) {
    const left = simplifyPolyline(points.slice(0, idx + 1), epsilon);
    const right = simplifyPolyline(points.slice(idx), epsilon);
    return left.concat(right.slice(1));
  }

  return [points[0], points[end]];
}

function perpendicularDistance(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return Math.sqrt((point.x - a.x) ** 2 + (point.y - a.y) ** 2);

  const num = Math.abs(dy * point.x - dx * point.y + b.x * a.y - b.y * a.x);
  return num / len;
}
