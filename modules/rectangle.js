import { state, dom, applyImageRotationToPoint, applyInverseImageRotationToPoint } from './editor.js';
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
var rectDrag = null;
var resizeLastAnn = null;

export function initRectangle() {}

export function activateRectangle(preSelectId) {
  dom.svg.style.cursor = 'crosshair';
  dom.svg.addEventListener('pointerdown', onMouseDown);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('palette-bgcolor-changed', onPaletteBgChange);
  var targetId = preSelectId || state.selectedId;
  if (targetId) {
    if (preSelectId) { selectElement(preSelectId); dom.handleLayer.innerHTML = ''; }
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
  if (rectDrag) { rectDrag.remove(); rectDrag = null; }
  isResizing = false;
  isMoving = false;
  resizeAnchor = null;
  resizeStart = null;
  resizeOrig = null;
  resizeLastAnn = null;
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

  // Compute actual visual corners of the rotated rect in viewBox space
  var cx = data.x + data.width / 2, cy = data.y + data.height / 2;
  var halfW = data.width / 2, halfH = data.height / 2;
  var relPts = [
    { x: -halfW, y: -halfH },
    { x: halfW, y: -halfH },
    { x: halfW, y: halfH },
    { x: -halfW, y: halfH },
  ];
  if (data.rotation) {
    var rad = data.rotation * Math.PI / 180;
    var cos = Math.cos(rad), sin = Math.sin(rad);
    relPts = relPts.map(function(p) {
      return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
    });
  }
  var pts = relPts.map(function(p) { return { x: cx + p.x, y: cy + p.y }; });
  var vbCorners = pts.map(function(p) { return applyImageRotationToPoint(p.x, p.y); });
  var xs = vbCorners.map(function(c) { return c.x; });
  var ys = vbCorners.map(function(c) { return c.y; });
  var vbX = Math.min.apply(null, xs);
  var vbY = Math.min.apply(null, ys);
  var vbW = Math.max.apply(null, xs) - vbX;
  var vbH = Math.max.apply(null, ys) - vbY;

  var cornerPts = [
    { x: vbX, y: vbY },
    { x: vbX + vbW, y: vbY },
    { x: vbX + vbW, y: vbY + vbH },
    { x: vbX, y: vbY + vbH },
  ];
  var anchors = [
    { x: vbX + vbW, y: vbY + vbH },
    { x: vbX,       y: vbY + vbH },
    { x: vbX,       y: vbY },
    { x: vbX + vbW, y: vbY },
  ];
  var pt = { x: cornerPts[activeCorner].x + dx, y: cornerPts[activeCorner].y + dy };
  var ax = anchors[activeCorner].x;
  var ay = anchors[activeCorner].y;
  var newVbX = Math.min(ax, pt.x);
  var newVbY = Math.min(ay, pt.y);
  var newVbW = Math.max(5, Math.abs(pt.x - ax));
  var newVbH = Math.max(5, Math.abs(pt.y - ay));

  var ann = vbRectToAnnotation(newVbX, newVbY, newVbW, newVbH);
  data.x = Math.round(ann.x);
  data.y = Math.round(ann.y);
  data.width = Math.round(ann.width);
  data.height = Math.round(ann.height);
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
    var vbPt = applyImageRotationToPoint(pt.x, pt.y);
    for (var i = 0; i < handles.length; i++) {
      var c = handles[i];
      var cx = parseFloat(c.getAttribute('cx'));
      var cy = parseFloat(c.getAttribute('cy'));
      var r = parseFloat(c.getAttribute('r'));
      var dx = vbPt.x - cx;
      var dy = vbPt.y - cy;
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
      dom.handleLayer.innerHTML = '';
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
    }
  }

  if (target.closest('.annotation-line, .annotation-text, .line-hit-area, .handle, polyline')) return;

  isDrawing = true;
  var vbPt = applyImageRotationToPoint(pt.x, pt.y);
  startPt = vbPt;

  currentBgFill = state.bgColor === 'transparent' ? 'none' : state.bgColor;
  rectDrag = svgEl('g', { id: 'rect-drag' });
  dom.handleLayer.appendChild(rectDrag);
  previewRect = svgEl('rect', {
    x: startPt.x, y: startPt.y, width: 0, height: 0,
    rx: state.activeCornerRadius,
    stroke: state.activeColor,
    'stroke-width': state.activeThickness,
    fill: currentBgFill,
    'stroke-dasharray': '4 3',
    'pointer-events': 'none',
  });
  rectDrag.appendChild(previewRect);

  document.addEventListener('pointermove', onMouseMove);
  document.addEventListener('pointerup', onMouseUp);
}

function onMouseMove(e) {
  if (!isDrawing) return;
  var pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  var vbPt = applyImageRotationToPoint(pt.x, pt.y);
  var x = Math.min(startPt.x, vbPt.x);
  var y = Math.min(startPt.y, vbPt.y);
  var w = Math.abs(vbPt.x - startPt.x);
  var h = Math.abs(vbPt.y - startPt.y);
  previewRect.setAttribute('x', x);
  previewRect.setAttribute('y', y);
  previewRect.setAttribute('width', w);
  previewRect.setAttribute('height', h);
}

function vbRectToAnnotation(vbX, vbY, vbW, vbH) {
  var vbCX = vbX + vbW / 2, vbCY = vbY + vbH / 2;
  var annCenter = applyInverseImageRotationToPoint(vbCX, vbCY);
  return { x: annCenter.x - vbW / 2, y: annCenter.y - vbH / 2, width: vbW, height: vbH };
}

function onMouseUp(e) {
  if (!isDrawing) return;
  document.removeEventListener('pointermove', onMouseMove);
  document.removeEventListener('pointerup', onMouseUp);

  var vbX = parseFloat(previewRect.getAttribute('x'));
  var vbY = parseFloat(previewRect.getAttribute('y'));
  var vbW = parseFloat(previewRect.getAttribute('width'));
  var vbH = parseFloat(previewRect.getAttribute('height'));
  if (rectDrag) { rectDrag.remove(); rectDrag = null; }
  previewRect = null;
  isDrawing = false;

  if (vbW < 5 && vbH < 5) return;

  var imageRotation = state.image.rotation || 0;
  var vbCX = vbX + vbW / 2, vbCY = vbY + vbH / 2;
  var annCenter = applyInverseImageRotationToPoint(vbCX, vbCY);
  var ann = {
    x: annCenter.x - vbW / 2,
    y: annCenter.y - vbH / 2,
    width: vbW,
    height: vbH,
    rotation: imageRotation ? -imageRotation : 0,
  };

  var id = generateId();
  var data = {
    id,
    type: 'rectangle',
    x: ann.x, y: ann.y, width: ann.width, height: ann.height,
    rx: state.activeCornerRadius,
    rotation: ann.rotation,
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
  dom.handleLayer.innerHTML = '';
  activeCorner = -1;
  drawRectToolCircleHandles(data, activeCorner);
}

function startHandleDrag(idx, pt) {
  if (isResizing || isPreparingDrag) return;
  activeCorner = idx;
  dragCornerIdx = idx;
  var vbPt = applyImageRotationToPoint(pt.x, pt.y);
  dragStartPt = { x: vbPt.x, y: vbPt.y };
  isPreparingDrag = true;

  var data = captureElementState(state.selectedId);
  if (data) drawRectToolCircleHandles(data, activeCorner);

  document.addEventListener('pointermove', onDragPrepare);
  document.addEventListener('pointerup', onDragCancel);
}

function onDragPrepare(e) {
  var pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  var vbPt = applyImageRotationToPoint(pt.x, pt.y);
  var dx = vbPt.x - dragStartPt.x;
  var dy = vbPt.y - dragStartPt.y;
  if (dx * dx + dy * dy < 9) return;

  document.removeEventListener('pointermove', onDragPrepare);
  document.removeEventListener('pointerup', onDragCancel);
  isPreparingDrag = false;
  startResizeRect(dragCornerIdx, vbPt);
}

function onDragCancel(e) {
  document.removeEventListener('pointermove', onDragPrepare);
  document.removeEventListener('pointerup', onDragCancel);
  isPreparingDrag = false;
  dragStartPt = null;
  dragCornerIdx = -1;
  if (rectDrag) { rectDrag.remove(); rectDrag = null; }
}

function startResizeRect(idx, vbPt) {
  activeCorner = idx;
  var data = captureElementState(state.selectedId);
  if (!data || data.type !== 'rectangle') return;

  var groupEl = document.getElementById(data.id);
  if (groupEl) groupEl.style.visibility = 'hidden';

  // Compute actual visual corners of the rotated rect in annotation space
  var cx = data.x + data.width / 2, cy = data.y + data.height / 2;
  var halfW = data.width / 2, halfH = data.height / 2;
  var relPts = [
    { x: -halfW, y: -halfH },
    { x: halfW, y: -halfH },
    { x: halfW, y: halfH },
    { x: -halfW, y: halfH },
  ];
  if (data.rotation) {
    var rad = data.rotation * Math.PI / 180;
    var cos = Math.cos(rad), sin = Math.sin(rad);
    relPts = relPts.map(function(p) {
      return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
    });
  }
  var pts = relPts.map(function(p) { return { x: cx + p.x, y: cy + p.y }; });
  // Convert to viewBox space
  var vbCorners = pts.map(function(p) { return applyImageRotationToPoint(p.x, p.y); });
  var xs = vbCorners.map(function(c) { return c.x; });
  var ys = vbCorners.map(function(c) { return c.y; });
  var vbX = Math.min.apply(null, xs);
  var vbY = Math.min.apply(null, ys);
  var vbW = Math.max.apply(null, xs) - vbX;
  var vbH = Math.max.apply(null, ys) - vbY;

  // Create rect drag group on handleLayer
  rectDrag = svgEl('g', { id: 'rect-drag' });
  dom.handleLayer.appendChild(rectDrag);
  var polyPts = vbCorners.map(function(c) { return c.x + ',' + c.y; }).join(' ');
  var vPoly = svgEl('polygon', {
    points: polyPts,
    fill: data.fill || 'transparent',
    stroke: data.stroke,
    'stroke-width': data.strokeWidth,
    'pointer-events': 'none',
  });
  rectDrag.appendChild(vPoly);

  var anchorMap = {
    tl: { x: vbX + vbW, y: vbY + vbH },
    tr: { x: vbX,        y: vbY + vbH },
    bl: { x: vbX + vbW, y: vbY },
    br: { x: vbX,        y: vbY },
  };
  var corner = CORNERS[idx];
  resizeAnchor = anchorMap[corner];
  resizeStart = { x: vbPt.x, y: vbPt.y };
  resizeOrig = { x: data.x, y: data.y, width: data.width, height: data.height, rx: data.rx, rotation: data.rotation, fill: data.fill, stroke: data.stroke, strokeWidth: data.strokeWidth };

  isResizing = true;
  document.addEventListener('pointermove', onResizeMove);
  document.addEventListener('pointerup', onResizeEnd);
}

function onResizeMove(e) {
  if (!isResizing) return;
  var pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  var vbPt = applyImageRotationToPoint(pt.x, pt.y);
  if (!state.selectedId || !rectDrag) return;

  var ax = resizeAnchor.x;
  var ay = resizeAnchor.y;
  var nx = Math.min(ax, vbPt.x);
  var ny = Math.min(ay, vbPt.y);
  var nw = Math.abs(vbPt.x - ax);
  var nh = Math.abs(vbPt.y - ay);

  if (nw < 5) nw = 5;
  if (nh < 5) nh = 5;

  // Update rectDrag on handleLayer
  var ann = vbRectToAnnotation(nx, ny, nw, nh);
  ann.rotation = resizeOrig.rotation;
  resizeLastAnn = { x: ann.x, y: ann.y, width: ann.width, height: ann.height, rotation: ann.rotation };

  // Compute visual corners from annotation bbox + rotation
  var cx = ann.x + ann.width / 2, cy = ann.y + ann.height / 2;
  var halfW = ann.width / 2, halfH = ann.height / 2;
  var relPts = [
    { x: -halfW, y: -halfH },
    { x: halfW, y: -halfH },
    { x: halfW, y: halfH },
    { x: -halfW, y: halfH },
  ];
  if (ann.rotation) {
    var rad = ann.rotation * Math.PI / 180;
    var cos2 = Math.cos(rad), sin2 = Math.sin(rad);
    relPts = relPts.map(function(p) {
      return { x: p.x * cos2 - p.y * sin2, y: p.x * sin2 + p.y * cos2 };
    });
  }
  var vbPts = relPts.map(function(p) {
    var tp = applyImageRotationToPoint(cx + p.x, cy + p.y);
    return tp.x + ',' + tp.y;
  });
  var poly = rectDrag.querySelector('polygon');
  poly.setAttribute('points', vbPts.join(' '));

  drawRectToolCircleHandles(ann, activeCorner);
}

function onResizeEnd(e) {
  document.removeEventListener('pointermove', onResizeMove);
  document.removeEventListener('pointerup', onResizeEnd);
  if (!isResizing) return;
  isResizing = false;

  var id = state.selectedId;
  if (!id) return;

  // Read final rect from rectDrag (viewBox space)
  if (!rectDrag) return;
  rectDrag.remove();
  rectDrag = null;

  var orig = resizeOrig;
  var ann = resizeLastAnn || orig;
  var final = { x: Math.round(ann.x), y: Math.round(ann.y), width: Math.round(ann.width), height: Math.round(ann.height), rotation: orig.rotation };
  var cornerIdx = activeCorner;

  // Show original annotation rect
  var groupEl = document.getElementById(id);
  if (groupEl) groupEl.style.visibility = 'visible';

  // Update annotation layer rect
  updateRectangleElement({ id: id, x: final.x, y: final.y, width: final.width, height: final.height, rx: orig.rx || 0, rotation: orig.rotation, fill: orig.fill, stroke: orig.stroke, strokeWidth: orig.strokeWidth });

  if (orig.x !== final.x || orig.y !== final.y || orig.width !== final.width || orig.height !== final.height) {
    pushAction({
      description: 'Resize rectangle',
      doFn: function() {
        updateRectangleElement({ id: id, x: final.x, y: final.y, width: final.width, height: final.height, rx: orig.rx || 0, rotation: orig.rotation, fill: orig.fill, stroke: orig.stroke, strokeWidth: orig.strokeWidth });
        drawRectToolCircleHandles(final, cornerIdx);
      },
      undoFn: function() {
        updateRectangleElement({ id: id, x: orig.x, y: orig.y, width: orig.width, height: orig.height, rx: orig.rx || 0, rotation: orig.rotation, fill: orig.fill, stroke: orig.stroke, strokeWidth: orig.strokeWidth });
        drawRectToolCircleHandles(orig, cornerIdx);
      },
    });
  }

  drawRectToolCircleHandles(final, activeCorner);
}

function cancelDraw() {
  if (rectDrag) { rectDrag.remove(); rectDrag = null; }
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
  dom.handleLayer.querySelectorAll('.handle-endpoint').forEach(function(el) { el.remove(); });
  var viewBox = dom.svg.viewBox.baseVal;
  var svgRect = dom.svg.getBoundingClientRect();
  var scale = viewBox && viewBox.width ? viewBox.width / svgRect.width : 1;
  var visR = Math.max(6, 10 * scale);
  var cx = data.x + data.width / 2, cy = data.y + data.height / 2;
  var halfW = data.width / 2, halfH = data.height / 2;
  var relPts = [
    { x: -halfW, y: -halfH },
    { x: halfW, y: -halfH },
    { x: halfW, y: halfH },
    { x: -halfW, y: halfH },
  ];
  if (data.rotation) {
    var rad = data.rotation * Math.PI / 180;
    var cos = Math.cos(rad), sin = Math.sin(rad);
    relPts = relPts.map(function(p) {
      return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
    });
  }
  var pts = relPts.map(function(p) { return { x: cx + p.x, y: cy + p.y }; });
  for (var i = 0; i < pts.length; i++) {
    var tp = applyImageRotationToPoint(pts[i].x, pts[i].y);
    var isActive = i === activeIdx;
    dom.handleLayer.appendChild(svgEl('circle', { cx: tp.x, cy: tp.y, r: visR, class: 'handle handle-endpoint' + (isActive ? ' active' : ' unselected'), 'data-index': i, 'data-corner': CORNERS[i] }));
  }
}
