import { state, dom } from './editor.js';
import { generateId, svgEl, screenToCoords } from './utils.js';
import { pushAction } from './history.js';

let isDrawing = false;
let startPt = null;
let previewRect = null;
let currentBgFill = 'none';

export function initRectangle() {}

export function activateRectangle() {
  dom.svg.style.cursor = 'crosshair';
  dom.svg.addEventListener('pointerdown', onMouseDown);
}

export function deactivateRectangle() {
  dom.svg.style.cursor = '';
  dom.svg.removeEventListener('pointerdown', onMouseDown);
  cancelDraw();
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  if (!state.hasImage) return;

  const target = e.target;
  if (target.closest('.annotation-line, .annotation-text, .line-hit-area, .handle, polyline, .rect-fill, .rect-stroke')) return;

  isDrawing = true;
  startPt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);

  currentBgFill = state.bgColor === 'transparent' ? 'none' : state.bgColor;
  previewRect = svgEl('rect', {
    x: startPt.x, y: startPt.y, width: 0, height: 0,
    rx: state.activeCornerRadius,
    stroke: state.activeColor,
    'stroke-width': state.activeThickness,
    fill: currentBgFill,
    'stroke-dasharray': '4 3',
    'pointer-events': 'none',
  });
  dom.annotationLayer.appendChild(previewRect);

  document.addEventListener('pointermove', onMouseMove);
  document.addEventListener('pointerup', onMouseUp);
}

function onMouseMove(e) {
  if (!isDrawing) return;
  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  const x = Math.min(startPt.x, pt.x);
  const y = Math.min(startPt.y, pt.y);
  const w = Math.abs(pt.x - startPt.x);
  const h = Math.abs(pt.y - startPt.y);
  previewRect.setAttribute('x', x);
  previewRect.setAttribute('y', y);
  previewRect.setAttribute('width', w);
  previewRect.setAttribute('height', h);
}

function onMouseUp(e) {
  if (!isDrawing) return;
  document.removeEventListener('pointermove', onMouseMove);
  document.removeEventListener('pointerup', onMouseUp);

  if (previewRect && previewRect.parentNode) {
    previewRect.parentNode.removeChild(previewRect);
  }
  previewRect = null;
  isDrawing = false;

  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  const x = Math.min(startPt.x, pt.x);
  const y = Math.min(startPt.y, pt.y);
  const w = Math.abs(pt.x - startPt.x);
  const h = Math.abs(pt.y - startPt.y);

  if (w < 5 && h < 5) return;

  const id = generateId();
  const data = {
    id,
    type: 'rectangle',
    x, y, width: w, height: h,
    rx: state.activeCornerRadius,
    rotation: 0,
    stroke: state.activeColor,
    strokeWidth: state.activeThickness,
    fill: currentBgFill,
  };

  addRectangleElement(data);
  state.elements.push(data);

  pushAction({
    description: 'Draw rectangle',
    doFn: () => {
      addRectangleElement(data);
      state.elements.push(data);
    },
    undoFn: () => {
      removeRectangleElement(id);
      state.elements = state.elements.filter(el => el.id !== id);
    },
  });
}

function cancelDraw() {
  if (previewRect && previewRect.parentNode) {
    previewRect.parentNode.removeChild(previewRect);
  }
  previewRect = null;
  isDrawing = false;
  document.removeEventListener('pointermove', onMouseMove);
  document.removeEventListener('pointerup', onMouseUp);
}

export function addRectangleElement(data) {
  const group = svgEl('g', {
    id: data.id,
    'data-type': 'rectangle',
  });

  const fillRect = svgEl('rect', {
    x: data.x, y: data.y, width: data.width, height: data.height,
    rx: data.rx || 0,
    fill: data.fill || 'transparent',
    class: 'rect-fill',
  });

  const strokeRect = svgEl('rect', {
    x: data.x, y: data.y, width: data.width, height: data.height,
    rx: data.rx || 0,
    fill: 'none',
    stroke: data.stroke,
    'stroke-width': data.strokeWidth,
    class: 'rect-stroke',
  });

  group.appendChild(fillRect);
  group.appendChild(strokeRect);

  if (data.rotation) {
    const cx = data.x + data.width / 2;
    const cy = data.y + data.height / 2;
    group.setAttribute('transform', `rotate(${data.rotation}, ${cx}, ${cy})`);
  }

  dom.annotationLayer.appendChild(group);
}

export function updateRectangleElement(data) {
  const group = dom.annotationLayer.querySelector(`#${CSS.escape(data.id)}`);
  if (!group) return;

  const fillRect = group.querySelector('.rect-fill');
  const strokeRect = group.querySelector('.rect-stroke');

  if (fillRect) {
    fillRect.setAttribute('x', data.x);
    fillRect.setAttribute('y', data.y);
    fillRect.setAttribute('width', data.width);
    fillRect.setAttribute('height', data.height);
    fillRect.setAttribute('rx', data.rx || 0);
    fillRect.setAttribute('fill', data.fill || 'transparent');
  }
  if (strokeRect) {
    strokeRect.setAttribute('x', data.x);
    strokeRect.setAttribute('y', data.y);
    strokeRect.setAttribute('width', data.width);
    strokeRect.setAttribute('height', data.height);
    strokeRect.setAttribute('rx', data.rx || 0);
    strokeRect.setAttribute('stroke', data.stroke);
    strokeRect.setAttribute('stroke-width', data.strokeWidth);
  }

  if (data.rotation) {
    const cx = data.x + data.width / 2;
    const cy = data.y + data.height / 2;
    group.setAttribute('transform', `rotate(${data.rotation}, ${cx}, ${cy})`);
  } else {
    group.removeAttribute('transform');
  }
}

function removeRectangleElement(id) {
  const el = dom.annotationLayer.querySelector(`#${CSS.escape(id)}`);
  if (el) el.remove();
}
