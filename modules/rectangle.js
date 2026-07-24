import { state, dom } from './editor.js';
import { generateId, svgEl, screenToCoords } from './utils.js';
import { pushAction } from './history.js';
import { selectElement, clearSelection } from './select.js';
import { captureElementState, readRectGeometry } from './dom-utils.js';

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

export function activateRectangle(preSelectId) {
  dom.svg.style.cursor = 'crosshair';
  dom.svg.addEventListener('pointerdown', onMouseDown);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('palette-bgcolor-changed', onPaletteBgChange);
  var targetId = preSelectId || state.selectedId;
  if (targetId) {
    if (preSelectId) selectElement(preSelectId);
    var data = captureElementState(targetId);
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
    var data = captureElementState(state.selectedId);
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
  var data = captureElementState(state.selectedId);
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
    var allRects = dom.annotationLayer.querySelectorAll('g[data-type="rectangle"]');
    for (var i = allRects.length - 1; i >= 0; i--) {
      var gEl = allRects[i];
      var geom = readRectGeometry(gEl);
      if (!geom) continue;
      if (pt.x >= geom.x && pt.x <= geom.x + geom.width &&
          pt.y >= geom.y && pt.y <= geom.y + geom.height) {
        foundId = gEl.id;
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
      var data = captureElementState(foundId);
      if (data) drawRectToolCircleHandles(data, activeCorner);
    }
    return;
  }

  if (state.selectedId) {
    var selEl = document.getElementById(state.selectedId);
    if (selEl && selEl.dataset.type === 'rectangle') {
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

  pushAction({
    description: 'Draw rectangle',
    doFn: function() {
      addRectangleElement(data);
    },
    undoFn: function() {
      removeRectangleElement(id);
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

  var data = captureElementState(state.selectedId);
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
  var data = captureElementState(state.selectedId);
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
  if (!state.selectedId) return;

  var ax = resizeAnchor.x;
  var ay = resizeAnchor.y;
  var nx = Math.min(ax, pt.x);
  var ny = Math.min(ay, pt.y);
  var nw = Math.abs(pt.x - ax);
  var nh = Math.abs(pt.y - ay);

  if (nw < 5) nw = 5;
  if (nh < 5) nh = 5;

  var el = dom.annotationLayer.querySelector('#' + CSS.escape(state.selectedId));
  if (!el) return;
  var fillRect = el.querySelector('.rect-fill');
  var strokeRect = el.querySelector('.rect-stroke');
  if (fillRect) {
    fillRect.setAttribute('x', nx);
    fillRect.setAttribute('y', ny);
    fillRect.setAttribute('width', nw);
    fillRect.setAttribute('height', nh);
  }
  if (strokeRect) {
    strokeRect.setAttribute('x', nx);
    strokeRect.setAttribute('y', ny);
    strokeRect.setAttribute('width', nw);
    strokeRect.setAttribute('height', nh);
  }

  drawRectToolCircleHandles({ x: nx, y: ny, width: nw, height: nh }, activeCorner);
}

function onResizeEnd(e) {
  document.removeEventListener('pointermove', onResizeMove);
  document.removeEventListener('pointerup', onResizeEnd);
  if (!isResizing) return;
  isResizing = false;

  var id = state.selectedId;
  if (!id) return;

  var orig = resizeOrig;
  var finalData = captureElementState(id);
  if (!finalData) return;
  var final = { x: finalData.x, y: finalData.y, width: finalData.width, height: finalData.height };
  var cornerIdx = activeCorner;

  if (orig.x !== final.x || orig.y !== final.y || orig.width !== final.width || orig.height !== final.height) {
    pushAction({
      description: 'Resize rectangle',
      doFn: function() {
        var el = dom.annotationLayer.querySelector('#' + CSS.escape(id));
        if (!el) return;
        var fr = el.querySelector('.rect-fill'), sr = el.querySelector('.rect-stroke');
        [fr, sr].forEach(function(r) {
          if (!r) return;
          r.setAttribute('x', final.x); r.setAttribute('y', final.y);
          r.setAttribute('width', final.width); r.setAttribute('height', final.height);
        });
        drawRectToolCircleHandles(final, cornerIdx);
      },
      undoFn: function() {
        var el = dom.annotationLayer.querySelector('#' + CSS.escape(id));
        if (!el) return;
        var fr = el.querySelector('.rect-fill'), sr = el.querySelector('.rect-stroke');
        [fr, sr].forEach(function(r) {
          if (!r) return;
          r.setAttribute('x', orig.x); r.setAttribute('y', orig.y);
          r.setAttribute('width', orig.width); r.setAttribute('height', orig.height);
        });
        drawRectToolCircleHandles(orig, cornerIdx);
      },
    });
  }

  drawRectToolCircleHandles(final, activeCorner);
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
