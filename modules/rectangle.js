import { state, dom } from './editor.js';
import { generateId, svgEl, screenToCoords } from './utils.js';
import { pushAction } from './history.js';
import { selectElement, clearSelection } from './select.js';

let isDrawing = false;
let startPt = null;
let previewRect = null;
let currentBgFill = 'none';

let activeCorner = -1;
let isResizing = false;
let isMoving = false;
let resizeAnchor = null;
let resizeStart = null;
let resizeOrig = null;
let moveStart = null;
let moveOrig = null;

let isPreparingDrag = false;
let dragStartPt = null;
let dragCornerIdx = -1;

var CORNERS = ['tl', 'tr', 'br', 'bl'];

export function initRectangle() {}

export function activateRectangle() {
  dom.svg.style.cursor = 'crosshair';
  dom.svg.addEventListener('pointerdown', onMouseDown);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('palette-bgcolor-changed', onPaletteBgChange);
  if (state.selectedId) {
    var data = state.elements.find(function(el) { return el.id === state.selectedId; });
    if (data && data.type === 'rectangle') {
      drawRectToolCircleHandles(data, activeCorner);
    }
  }
}

export function deactivateRectangle() {
  dom.svg.style.cursor = '';
  dom.svg.removeEventListener('pointerdown', onMouseDown);
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('palette-bgcolor-changed', onPaletteBgChange);
  dom.handleLayer.innerHTML = '';
  cancelDraw();
  cancelResizeMove();
}

function onPaletteBgChange() {
  if (state.selectedId) {
    var data = state.elements.find(function(el) { return el.id === state.selectedId; });
    if (data && data.type === 'rectangle') {
      drawRectToolCircleHandles(data, activeCorner);
    }
  }
}

function cancelResizeMove() {
  if (isPreparingDrag) {
    document.removeEventListener('pointermove', onDragPrepare);
    document.removeEventListener('pointerup', onDragCancel);
    isPreparingDrag = false;
  }
  isResizing = false;
  isMoving = false;
  resizeAnchor = null;
  resizeStart = null;
  resizeOrig = null;
  moveStart = null;
  moveOrig = null;
  dragStartPt = null;
  dragCornerIdx = -1;
  document.removeEventListener('pointermove', onResizeMove);
  document.removeEventListener('pointerup', onResizeEnd);
}

function onKeyDown(e) {
  if (isDrawing || isResizing || isMoving || isPreparingDrag) return;
  var tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (!state.selectedId) return;
  var data = state.elements.find(function(el) { return el.id === state.selectedId; });
  if (!data || data.type !== 'rectangle') return;

  if (e.key === 'Tab') {
    e.preventDefault();
    if (activeCorner < 0) activeCorner = 0;
    else if (e.shiftKey) activeCorner = activeCorner <= 0 ? 3 : activeCorner - 1;
    else activeCorner = activeCorner >= 3 ? 0 : activeCorner + 1;
    drawRectToolCircleHandles(data, activeCorner);
    return;
  }

  if (activeCorner < 0) return;

  var dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  var dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
  if (!dx && !dy) return;
  e.preventDefault();

  var cornerPts = [
    { x: data.x, y: data.y },
    { x: data.x + data.width, y: data.y },
    { x: data.x + data.width, y: data.y + data.height },
    { x: data.x, y: data.y + data.height },
  ];
  var anchors = [
    { x: data.x + data.width, y: data.y + data.height },
    { x: data.x,              y: data.y + data.height },
    { x: data.x,              y: data.y },
    { x: data.x + data.width, y: data.y },
  ];
  var pt = { x: cornerPts[activeCorner].x + dx, y: cornerPts[activeCorner].y + dy };
  var ax = anchors[activeCorner].x;
  var ay = anchors[activeCorner].y;
  data.x = Math.min(ax, pt.x);
  data.y = Math.min(ay, pt.y);
  data.width = Math.max(5, Math.abs(pt.x - ax));
  data.height = Math.max(5, Math.abs(pt.y - ay));
  updateRectangleElement(data);
  drawRectToolCircleHandles(data, activeCorner);
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  if (!state.hasImage) return;

  var target = e.target;
  var pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);

  var handleEl = target.closest('.handle-endpoint');
  if (!handleEl) {
    var handles = dom.handleLayer.querySelectorAll('.handle-endpoint');
    for (var i = 0; i < handles.length; i++) {
      var c = handles[i];
      var cx = parseFloat(c.getAttribute('cx'));
      var cy = parseFloat(c.getAttribute('cy'));
      var r = parseFloat(c.getAttribute('r'));
      var dx = pt.x - cx;
      var dy = pt.y - cy;
      if (dx * dx + dy * dy <= (r + 3) * (r + 3)) {
        handleEl = c;
        break;
      }
    }
  }
  if (handleEl) {
    e.preventDefault();
    var idx = parseInt(handleEl.dataset.index);
    if (!isNaN(idx)) {
      startHandleDrag(idx, pt);
      return;
    }
  }

  var rectBody = target.closest('.rect-fill, .rect-stroke');
  var foundId = null;
  if (rectBody) {
    var parentG = rectBody.closest('g[data-type="rectangle"]');
    if (parentG) foundId = parentG.id;
  }
  if (!foundId) {
    for (var i = state.elements.length - 1; i >= 0; i--) {
      var el = state.elements[i];
      if (el.type !== 'rectangle') continue;
      if (pt.x >= el.x && pt.x <= el.x + el.width &&
          pt.y >= el.y && pt.y <= el.y + el.height) {
        foundId = el.id;
        break;
      }
    }
  }
  if (foundId) {
    e.preventDefault();
    if (foundId === state.selectedId) {
      clearSelection();
      activeCorner = -1;
    } else {
      selectElement(foundId);
      var data = state.elements.find(function(el) { return el.id === foundId; });
      if (data) drawRectToolCircleHandles(data, activeCorner);
    }
    return;
  }

  if (state.selectedId) {
    var selEl = state.elements.find(function(el) { return el.id === state.selectedId; });
    if (selEl && selEl.type === 'rectangle') {
      clearSelection();
      activeCorner = -1;
      return;
    }
  }

  if (target.closest('.annotation-line, .annotation-text, .line-hit-area, .handle, polyline')) return;

  isDrawing = true;
  startPt = pt;

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
  var pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  var x = Math.min(startPt.x, pt.x);
  var y = Math.min(startPt.y, pt.y);
  var w = Math.abs(pt.x - startPt.x);
  var h = Math.abs(pt.y - startPt.y);
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

  var pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  var x = Math.min(startPt.x, pt.x);
  var y = Math.min(startPt.y, pt.y);
  var w = Math.abs(pt.x - startPt.x);
  var h = Math.abs(pt.y - startPt.y);

  if (w < 5 && h < 5) return;

  var id = generateId();
  var data = {
    id,
    type: 'rectangle',
    x: x, y: y, width: w, height: h,
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
    doFn: function() {
      addRectangleElement(data);
      state.elements.push(data);
    },
    undoFn: function() {
      removeRectangleElement(id);
      state.elements = state.elements.filter(function(el) { return el.id !== id; });
    },
  });

  selectElement(id);
  activeCorner = -1;
  drawRectToolCircleHandles(data, activeCorner);
}

function startHandleDrag(idx, pt) {
  if (isResizing || isPreparingDrag) return;
  activeCorner = idx;
  dragCornerIdx = idx;
  dragStartPt = { x: pt.x, y: pt.y };
  isPreparingDrag = true;

  var data = state.elements.find(function(el) { return el.id === state.selectedId; });
  if (data) drawRectToolCircleHandles(data, activeCorner);

  document.addEventListener('pointermove', onDragPrepare);
  document.addEventListener('pointerup', onDragCancel);
}

function onDragPrepare(e) {
  var pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  var dx = pt.x - dragStartPt.x;
  var dy = pt.y - dragStartPt.y;
  if (dx * dx + dy * dy < 9) return;

  document.removeEventListener('pointermove', onDragPrepare);
  document.removeEventListener('pointerup', onDragCancel);
  isPreparingDrag = false;
  startResizeRect(dragCornerIdx, pt);
}

function onDragCancel(e) {
  document.removeEventListener('pointermove', onDragPrepare);
  document.removeEventListener('pointerup', onDragCancel);
  isPreparingDrag = false;
  dragStartPt = null;
  dragCornerIdx = -1;
}

function startResizeRect(idx, pt) {
  activeCorner = idx;
  var data = state.elements.find(function(el) { return el.id === state.selectedId; });
  if (!data || data.type !== 'rectangle') return;

  var anchorMap = {
    tl: { x: data.x + data.width, y: data.y + data.height },
    tr: { x: data.x,               y: data.y + data.height },
    bl: { x: data.x + data.width, y: data.y },
    br: { x: data.x,               y: data.y },
  };
  var corner = CORNERS[idx];
  resizeAnchor = anchorMap[corner];
  resizeStart = { x: pt.x, y: pt.y };
  resizeOrig = { x: data.x, y: data.y, width: data.width, height: data.height };

  drawRectToolCircleHandles(data, activeCorner);
  isResizing = true;
  document.addEventListener('pointermove', onResizeMove);
  document.addEventListener('pointerup', onResizeEnd);
}

function onResizeMove(e) {
  if (!isResizing) return;
  var pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  var data = state.elements.find(function(el) { return el.id === state.selectedId; });
  if (!data || data.type !== 'rectangle') return;

  var ax = resizeAnchor.x;
  var ay = resizeAnchor.y;
  var nx = Math.min(ax, pt.x);
  var ny = Math.min(ay, pt.y);
  var nw = Math.abs(pt.x - ax);
  var nh = Math.abs(pt.y - ay);

  if (nw < 5) nw = 5;
  if (nh < 5) nh = 5;

  data.x = nx;
  data.y = ny;
  data.width = nw;
  data.height = nh;

  updateRectangleElement(data);
  drawRectToolCircleHandles(data, activeCorner);
}

function onResizeEnd(e) {
  document.removeEventListener('pointermove', onResizeMove);
  document.removeEventListener('pointerup', onResizeEnd);
  if (!isResizing) return;
  isResizing = false;

  var data = state.elements.find(function(el) { return el.id === state.selectedId; });
  if (!data) return;

  var orig = resizeOrig;
  var final = { x: data.x, y: data.y, width: data.width, height: data.height };
  var cornerIdx = activeCorner;

  if (orig.x !== final.x || orig.y !== final.y || orig.width !== final.width || orig.height !== final.height) {
    pushAction({
      description: 'Resize rectangle',
      doFn: function() {
        data.x = final.x; data.y = final.y; data.width = final.width; data.height = final.height;
        updateRectangleElement(data); drawRectToolCircleHandles(data, cornerIdx);
      },
      undoFn: function() {
        data.x = orig.x; data.y = orig.y; data.width = orig.width; data.height = orig.height;
        updateRectangleElement(data); drawRectToolCircleHandles(data, cornerIdx);
      },
    });
  }

  drawRectToolCircleHandles(data, activeCorner);
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
  var group = svgEl('g', {
    id: data.id,
    'data-type': 'rectangle',
  });

  var fillRect = svgEl('rect', {
    x: data.x, y: data.y, width: data.width, height: data.height,
    rx: data.rx || 0,
    fill: data.fill || 'transparent',
    class: 'rect-fill',
  });

  var strokeRect = svgEl('rect', {
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
    var cx = data.x + data.width / 2;
    var cy = data.y + data.height / 2;
    group.setAttribute('transform', 'rotate(' + data.rotation + ', ' + cx + ', ' + cy + ')');
  }

  dom.annotationLayer.appendChild(group);
}

export function updateRectangleElement(data) {
  var group = dom.annotationLayer.querySelector('#' + CSS.escape(data.id));
  if (!group) return;

  var fillRect = group.querySelector('.rect-fill');
  var strokeRect = group.querySelector('.rect-stroke');

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
    var cx = data.x + data.width / 2;
    var cy = data.y + data.height / 2;
    group.setAttribute('transform', 'rotate(' + data.rotation + ', ' + cx + ', ' + cy + ')');
  } else {
    group.removeAttribute('transform');
  }
}

function removeRectangleElement(id) {
  var el = dom.annotationLayer.querySelector('#' + CSS.escape(id));
  if (el) el.remove();
}

function drawRectToolCircleHandles(data, activeIdx) {
  dom.handleLayer.innerHTML = '';
  var viewBox = dom.svg.viewBox.baseVal;
  var svgRect = dom.svg.getBoundingClientRect();
  var scale = viewBox && viewBox.width ? viewBox.width / svgRect.width : 1;
  var visR = Math.max(6, 10 * scale);
  var pts = [
    { x: data.x, y: data.y },
    { x: data.x + data.width, y: data.y },
    { x: data.x + data.width, y: data.y + data.height },
    { x: data.x, y: data.y + data.height },
  ];
  for (var i = 0; i < pts.length; i++) {
    var x = pts[i].x, y = pts[i].y;
    var isActive = i === activeIdx;
    dom.handleLayer.appendChild(svgEl('circle', { cx: x, cy: y, r: visR, class: 'handle handle-endpoint' + (isActive ? ' active' : ' unselected'), 'data-index': i, 'data-corner': CORNERS[i] }));
  }
}
