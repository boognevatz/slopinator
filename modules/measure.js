import { state, dom } from './editor.js';
import { svgEl, screenToCoords } from './utils.js';

let isDrawing = false;
let measureLine = null;
let labelText = null;
let startPt = null;
let pt1 = null;
let pt2 = null;
let isDragging = false;
let dragIdx = -1;
let dragHandle = null;
var selectedEndpoint = -1;
var arrowKeyStep = 1;

export function activateMeasure() {
  dom.svg.style.cursor = 'crosshair';
  dom.svg.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('dpi-changed', updateLabel);
  document.addEventListener('keydown', onKeyDown);
}

export function deactivateMeasure() {
  dom.svg.style.cursor = '';
  dom.svg.removeEventListener('pointerdown', onPointerDown);
  document.removeEventListener('pointermove', onPointerMove);
  document.removeEventListener('pointerup', onPointerUp);
  document.removeEventListener('dpi-changed', updateLabel);
  document.removeEventListener('keydown', onKeyDown);
  isDrawing = false;
  isDragging = false;
  cleanupElements();
}

function cleanupElements() {
  if (measureLine && measureLine.parentNode) measureLine.parentNode.removeChild(measureLine);
  if (labelText && labelText.parentNode) labelText.parentNode.removeChild(labelText);
  dom.handleLayer.innerHTML = '';
  measureLine = null;
  labelText = null;
  pt1 = null;
  pt2 = null;
  startPt = null;
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  if (!state.hasImage) return;

  // If we have existing measure elements, check for handle drag
  if (measureLine && pt1 && pt2) {
    const clickPt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
    var d1 = Math.hypot(clickPt.x - pt1.x, clickPt.y - pt1.y);
    var d2 = Math.hypot(clickPt.x - pt2.x, clickPt.y - pt2.y);
    var threshold = getHitRadius();
    if (d1 < threshold) { startHandleDrag(0, e); return; }
    if (d2 < threshold) { startHandleDrag(1, e); return; }
    return;
  }

  if (e.target.classList.contains('annotation-line') ||
      e.target.classList.contains('annotation-text') ||
      e.target.classList.contains('line-hit-area') ||
      e.target.classList.contains('handle')) return;

  isDrawing = true;
  startPt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  pt1 = { x: startPt.x, y: startPt.y };
  pt2 = { x: startPt.x, y: startPt.y };

  measureLine = svgEl('line', {
    x1: pt1.x, y1: pt1.y,
    x2: pt2.x, y2: pt2.y,
    stroke: '#4fc3f7',
    'stroke-width': 1.5,
    'stroke-dasharray': '5,3',
    'pointer-events': 'none',
  });
  dom.annotationLayer.appendChild(measureLine);

  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
}

function onPointerMove(e) {
  if (isDrawing) {
    pt2 = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
    measureLine.setAttribute('x2', pt2.x);
    measureLine.setAttribute('y2', pt2.y);
    updateLabel();
    return;
  }
  if (isDragging) {
    var pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
    if (dragIdx === 0) { pt1 = { x: pt.x, y: pt.y }; }
    else { pt2 = { x: pt.x, y: pt.y }; }
    measureLine.setAttribute('x1', pt1.x);
    measureLine.setAttribute('y1', pt1.y);
    measureLine.setAttribute('x2', pt2.x);
    measureLine.setAttribute('y2', pt2.y);
    if (dragHandle) {
      dragHandle.setAttribute('cx', pt.x);
      dragHandle.setAttribute('cy', pt.y);
    }
    updateLabel();
  }
}

function onPointerUp(e) {
  document.removeEventListener('pointermove', onPointerMove);
  document.removeEventListener('pointerup', onPointerUp);

  if (isDrawing) {
    isDrawing = false;
    var endPt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
    var dx = endPt.x - startPt.x;
    var dy = endPt.y - startPt.y;
    if (Math.sqrt(dx * dx + dy * dy) < 2) {
      cleanupElements();
      return;
    }
    pt2 = { x: endPt.x, y: endPt.y };
    measureLine.setAttribute('x2', pt2.x);
    measureLine.setAttribute('y2', pt2.y);
    selectedEndpoint = 1;
    updateLabel();
    showHandles();
    return;
  }

  if (isDragging) {
    isDragging = false;
    selectedEndpoint = dragIdx;
    dom.handleLayer.innerHTML = '';
    showHandles();
  }
}

function showHandles() {
  if (!pt1 || !pt2) return;
  dom.handleLayer.innerHTML = '';
  var r = getHandleRadius();
  var hitR = getHitRadius();
  var pts = [pt1, pt2];
  for (var i = 0; i < pts.length; i++) {
    var hit = svgEl('circle', {
      cx: pts[i].x, cy: pts[i].y, r: hitR,
      fill: 'transparent', stroke: 'none',
      'data-handle': 'p' + (i + 1),
    });
    dom.handleLayer.appendChild(hit);
    var isActive = i === selectedEndpoint;
    var vis = svgEl('circle', {
      cx: pts[i].x, cy: pts[i].y, r: r,
      fill: isActive ? '#4fc3f7' : '#fff',
      stroke: '#4fc3f7', 'stroke-width': 1.5,
      'pointer-events': 'none',
    });
    dom.handleLayer.appendChild(vis);
  }
}

function onKeyDown(e) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  var tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  var step = arrowKeyStep;
  var moved = false;
  switch (e.key) {
    case 'ArrowUp': moveEndpoint(0, -step); moved = true; break;
    case 'ArrowDown': moveEndpoint(0, step); moved = true; break;
    case 'ArrowLeft': moveEndpoint(-step, 0); moved = true; break;
    case 'ArrowRight': moveEndpoint(step, 0); moved = true; break;
  }
  if (moved) e.preventDefault();
}

function moveEndpoint(dx, dy) {
  if (!measureLine || selectedEndpoint < 0) return;
  var pt = selectedEndpoint === 0 ? pt1 : pt2;
  if (!pt) return;
  pt.x += dx;
  pt.y += dy;
  measureLine.setAttribute('x1', pt1.x);
  measureLine.setAttribute('y1', pt1.y);
  measureLine.setAttribute('x2', pt2.x);
  measureLine.setAttribute('y2', pt2.y);
  updateLabel();
  dom.handleLayer.innerHTML = '';
  showHandles();
}

function startHandleDrag(idx, e) {
  isDragging = true;
  dragIdx = idx;
  dom.handleLayer.innerHTML = '';
  var pt = idx === 0 ? pt1 : pt2;
  var r = getHandleRadius();
  dragHandle = svgEl('circle', {
    cx: pt.x, cy: pt.y, r: r,
    fill: '#fff', stroke: '#4fc3f7', 'stroke-width': 1.5,
    'pointer-events': 'none',
  });
  dom.handleLayer.appendChild(dragHandle);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
}

function updateLabel() {
  if (!pt1 || !pt2) return;
  var dx = pt2.x - pt1.x;
  var dy = pt2.y - pt1.y;
  var pixelLen = Math.sqrt(dx * dx + dy * dy);
  var mmLen = pixelLen / (state.image.dpi / 25.4);
  var midX = (pt1.x + pt2.x) / 2;
  var midY = (pt1.y + pt2.y) / 2;

  var text = Math.round(pixelLen) + 'px  \u00B7  ' + mmLen.toFixed(1) + 'mm';

  if (!labelText) {
    labelText = svgEl('text', {
      x: midX, y: midY - 12,
      'text-anchor': 'middle',
      fill: '#4fc3f7',
      'font-size': '13',
      'font-family': 'monospace',
      'font-weight': 'bold',
      'pointer-events': 'none',
    });
    dom.annotationLayer.appendChild(labelText);
  }

  labelText.setAttribute('x', midX);
  labelText.setAttribute('y', midY - 12);
  labelText.textContent = text;

  var bg = labelText._bg;
  if (!bg) {
    bg = svgEl('rect', {
      fill: 'rgba(0,0,0,0.65)',
      rx: 3, ry: 3,
      'pointer-events': 'none',
    });
    labelText.parentNode.insertBefore(bg, labelText);
    labelText._bg = bg;
  }
  var bbox = labelText.getBBox();
  bg.setAttribute('x', bbox.x - 4);
  bg.setAttribute('y', bbox.y - 2);
  bg.setAttribute('width', bbox.width + 8);
  bg.setAttribute('height', bbox.height + 4);
}

function getHandleRadius() {
  var viewBox = dom.svg.viewBox.baseVal;
  if (!viewBox || viewBox.width === 0) return 6;
  var svgRect = dom.svg.getBoundingClientRect();
  var scale = viewBox.width / svgRect.width;
  return Math.max(4, 6 * scale);
}

function getHitRadius() {
  return getHandleRadius() + 4;
}
