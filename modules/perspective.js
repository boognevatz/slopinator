import { state, dom, loadImage } from './editor.js';
import { generateId, svgEl, screenToCoords } from './utils.js';
import { pushAction } from './history.js';
import { addLineElement } from './line.js';
import { addTextElement } from './text.js';
import { addFreehandElement } from './freehand.js';
import { addRectangleElement } from './rectangle.js';

let corners = [];
let isDrawing = false;
let isDraggingCorner = false;
let dragIdx = -1;
let dragStart = null;
let dragOrigCorners = null;
let startPt = null;
let previewRect = null;
let previewOverlay = null;

function getScale() {
  const viewBox = dom.svg.viewBox.baseVal;
  if (!viewBox || viewBox.width === 0) return 1;
  const svgRect = dom.svg.getBoundingClientRect();
  return viewBox.width / svgRect.width;
}

export function initPerspective() {
  document.getElementById('btn-perspective-apply').addEventListener('click', applyTransform);
  document.getElementById('btn-perspective-reset').addEventListener('click', resetTool);
}

export function activatePerspective() {
  dom.svg.style.cursor = 'crosshair';
  dom.svg.addEventListener('pointerdown', onPointerDown);
  document.getElementById('perspective-group').hidden = false;
  updateUI();
}

export function deactivatePerspective() {
  dom.svg.style.cursor = '';
  dom.svg.removeEventListener('pointerdown', onPointerDown);
  document.getElementById('perspective-group').hidden = true;
  cleanup();
}

function cleanup() {
  corners = [];
  isDrawing = false;
  isDraggingCorner = false;
  startPt = null;
  previewRect = null;
  dom.handleLayer.innerHTML = '';
  document.removeEventListener('pointermove', onDrawMove);
  document.removeEventListener('pointerup', onDrawEnd);
  document.removeEventListener('pointermove', onDragCornerMove);
  document.removeEventListener('pointerup', onDragCornerEnd);
  updateUI();
}

function resetTool() {
  cleanup();
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  if (!state.hasImage) return;

  const target = e.target;
  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);

  if (corners.length === 4) {
    for (let i = 0; i < 4; i++) {
      const dx = pt.x - corners[i].x;
      const dy = pt.y - corners[i].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const threshold = 15 * getScale();
      if (dist < threshold) {
        isDraggingCorner = true;
        dragIdx = i;
        dragStart = pt;
        dragOrigCorners = corners.map(c => ({ x: c.x, y: c.y }));
        document.addEventListener('pointermove', onDragCornerMove);
        document.addEventListener('pointerup', onDragCornerEnd);
        return;
      }
    }
    return;
  }

  if (corners.length === 0) {
    isDrawing = true;
    startPt = pt;
    previewRect = svgEl('rect', {
      x: pt.x, y: pt.y, width: 0, height: 0,
      stroke: '#0078d4',
      'stroke-width': 2 / getScale(),
      fill: 'rgba(0,120,212,0.08)',
      'stroke-dasharray': `${4 / getScale()} ${3 / getScale()}`,
    });
    dom.handleLayer.appendChild(previewRect);
    document.addEventListener('pointermove', onDrawMove);
    document.addEventListener('pointerup', onDrawEnd);
  }
}

function onDrawMove(e) {
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

function onDrawEnd(e) {
  document.removeEventListener('pointermove', onDrawMove);
  document.removeEventListener('pointerup', onDrawEnd);
  if (!isDrawing) return;
  isDrawing = false;

  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  const x = Math.min(startPt.x, pt.x);
  const y = Math.min(startPt.y, pt.y);
  const w = Math.abs(pt.x - startPt.x);
  const h = Math.abs(pt.y - startPt.y);

  if (w < 10 && h < 10) {
    if (previewRect && previewRect.parentNode) previewRect.parentNode.removeChild(previewRect);
    previewRect = null;
    return;
  }

  corners = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];

  if (previewRect && previewRect.parentNode) previewRect.parentNode.removeChild(previewRect);
  previewRect = null;
  drawQuad();
  updateUI();
}

function onDragCornerMove(e) {
  if (!isDraggingCorner) return;
  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  corners[dragIdx] = { x: pt.x, y: pt.y };
  drawQuad();
}

function onDragCornerEnd() {
  document.removeEventListener('pointermove', onDragCornerMove);
  document.removeEventListener('pointerup', onDragCornerEnd);
  if (!isDraggingCorner) return;
  isDraggingCorner = false;

  const moved = dragOrigCorners.some((c, i) => c.x !== corners[i].x || c.y !== corners[i].y);
  if (moved) {
    const orig = dragOrigCorners;
    const final = corners.map(c => ({ x: c.x, y: c.y }));
    pushAction({
      description: 'Move perspective corner',
      doFn: () => { corners = final.map(c => ({ x: c.x, y: c.y })); drawQuad(); updateUI(); },
      undoFn: () => { corners = orig.map(c => ({ x: c.x, y: c.y })); drawQuad(); updateUI(); },
    });
  }

  dragStart = null;
  dragOrigCorners = null;
}

function drawQuad() {
  dom.handleLayer.innerHTML = '';

  const scale = getScale();
  const s = (v) => v / scale;

  const poly = svgEl('polygon', {
    points: corners.map(p => `${p.x},${p.y}`).join(' '),
    fill: 'rgba(0,120,212,0.08)',
    stroke: '#0078d4',
    'stroke-width': 2 / scale,
    'stroke-dasharray': `${4 / scale} ${3 / scale}`,
  });
  dom.handleLayer.appendChild(poly);

  for (let i = 0; i < 4; i++) {
    const handle = svgEl('rect', {
      x: corners[i].x - 11,
      y: corners[i].y - 11,
      width: 22,
      height: 22,
      class: 'handle',
      'vector-effect': 'non-scaling-stroke',
    });
    dom.handleLayer.appendChild(handle);
  }
}

function updateUI() {
  const hasQuad = corners.length === 4;
  document.getElementById('btn-perspective-apply').disabled = !hasQuad;
  document.getElementById('btn-perspective-reset').disabled = !hasQuad;
}

function computeHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const sx = src[i].x, sy = src[i].y;
    const dx = dst[i].x, dy = dst[i].y;
    A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]);
    b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]);
    b.push(dy);
  }
  const h = gaussElimination(A, b);
  h.push(1);
  return h;
}

function gaussElimination(A, b) {
  const n = A.length;
  for (let i = 0; i < n; i++) A[i] = [...A[i], b[i]];
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[maxRow][col])) maxRow = row;
    }
    [A[col], A[maxRow]] = [A[maxRow], A[col]];
    const pivot = A[col][col];
    if (Math.abs(pivot) < 1e-12) continue;
    for (let row = col + 1; row < n; row++) {
      const factor = A[row][col] / pivot;
      for (let j = col; j <= n; j++) A[row][j] -= factor * A[col][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = 0;
    for (let j = i + 1; j < n; j++) sum += A[i][j] * x[j];
    x[i] = (A[i][n] - sum) / A[i][i];
  }
  return x;
}

function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return {
    x: (H[0] * x + H[1] * y + H[2]) / w,
    y: (H[3] * x + H[4] * y + H[5]) / w,
  };
}

function invertHomography(H) {
  const det = H[0] * H[4] * H[8] + H[1] * H[5] * H[6] + H[2] * H[3] * H[7]
            - H[2] * H[4] * H[6] - H[1] * H[3] * H[8] - H[0] * H[5] * H[7];
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  return [
    (H[4] * H[8] - H[5] * H[7]) * invDet,
    (H[2] * H[7] - H[1] * H[8]) * invDet,
    (H[1] * H[5] - H[2] * H[4]) * invDet,
    (H[5] * H[6] - H[3] * H[8]) * invDet,
    (H[0] * H[8] - H[2] * H[6]) * invDet,
    (H[2] * H[3] - H[0] * H[5]) * invDet,
    (H[3] * H[7] - H[4] * H[6]) * invDet,
    (H[1] * H[6] - H[0] * H[7]) * invDet,
    (H[0] * H[4] - H[1] * H[3]) * invDet,
  ];
}

function sampleBilinear(data, x, y, w, h) {
  const sx = Math.max(0, Math.min(w - 1, x));
  const sy = Math.max(0, Math.min(h - 1, y));
  const ix = Math.floor(sx);
  const iy = Math.floor(sy);
  const fx = sx - ix;
  const fy = sy - iy;
  const nx = Math.min(ix + 1, w - 1);
  const ny = Math.min(iy + 1, h - 1);

  const getPixel = (cx, cy) => {
    const idx = (cy * w + cx) * 4;
    return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
  };

  const p00 = getPixel(ix, iy);
  const p10 = getPixel(nx, iy);
  const p01 = getPixel(ix, ny);
  const p11 = getPixel(nx, ny);

  return [
    p00[0] * (1 - fx) * (1 - fy) + p10[0] * fx * (1 - fy) + p01[0] * (1 - fx) * fy + p11[0] * fx * fy,
    p00[1] * (1 - fx) * (1 - fy) + p10[1] * fx * (1 - fy) + p01[1] * (1 - fx) * fy + p11[1] * fx * fy,
    p00[2] * (1 - fx) * (1 - fy) + p10[2] * fx * (1 - fy) + p01[2] * (1 - fx) * fy + p11[2] * fx * fy,
    p00[3] * (1 - fx) * (1 - fy) + p10[3] * fx * (1 - fy) + p01[3] * (1 - fx) * fy + p11[3] * fx * fy,
  ];
}

function applyTransform() {
  if (corners.length !== 4 || !state.hasImage) return;

  const w1 = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
  const w2 = Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y);
  const h1 = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
  const h2 = Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y);

  const dstW = Math.round(Math.max(w1, w2));
  const dstH = Math.round(Math.max(h1, h2));
  if (dstW < 2 || dstH < 2) return;

  const dst = [
    { x: 0, y: 0 },
    { x: dstW, y: 0 },
    { x: dstW, y: dstH },
    { x: 0, y: dstH },
  ];

  const H = computeHomography(corners, dst);
  const invH = invertHomography(H);
  if (!invH) return;

  const canvas = document.createElement('canvas');
  const imgW = state.image.naturalWidth;
  const imgH = state.image.naturalHeight;
  const maxDim = 2000;
  const scaleOut = Math.min(1, maxDim / Math.max(dstW, dstH));
  const outW = Math.round(dstW * scaleOut);
  const outH = Math.round(dstH * scaleOut);
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');

  const renderImg = new Image();
  renderImg.onload = () => {
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = imgW;
    srcCanvas.height = imgH;
    const srcCtx = srcCanvas.getContext('2d');
    srcCtx.drawImage(renderImg, 0, 0, imgW, imgH);
    const srcData = srcCtx.getImageData(0, 0, imgW, imgH);

    const dstData = ctx.createImageData(outW, outH);
    const data = dstData.data;

    const invH_adj = [
      invH[0] / scaleOut, invH[1] / scaleOut, invH[2],
      invH[3] / scaleOut, invH[4] / scaleOut, invH[5],
      invH[6] / scaleOut, invH[7] / scaleOut, invH[8],
    ];

    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const src = applyHomography(invH_adj, x, y);
        const pixel = sampleBilinear(srcData.data, src.x, src.y, imgW, imgH);
        const idx = (y * outW + x) * 4;
        data[idx] = pixel[0];
        data[idx + 1] = pixel[1];
        data[idx + 2] = pixel[2];
        data[idx + 3] = pixel[3];
      }
    }

    ctx.putImageData(dstData, 0, 0);

    const oldDataURI = state.image.dataURI;
    const oldW = imgW;
    const oldH = imgH;
    const oldElements = JSON.parse(JSON.stringify(state.elements));

    const newDataURI = canvas.toDataURL('image/jpeg', 0.92);
    const imgEl = new Image();
    imgEl.onload = () => {
      pushAction({
        description: 'Perspective transform',
        doFn: () => {
          loadImage(newDataURI, imgEl.naturalWidth, imgEl.naturalHeight);
          for (const el of oldElements) {
            addElement(el);
          }
          state.elements.push(...oldElements);
        },
        undoFn: () => {
          loadImage(oldDataURI, oldW, oldH);
          for (const el of oldElements) {
            addElement(el);
          }
          state.elements.push(...oldElements);
        },
      });

      loadImage(newDataURI, imgEl.naturalWidth, imgEl.naturalHeight);
      for (const el of oldElements) {
        addElement(el);
      }
      state.elements.push(...oldElements);
      cleanup();
    };
    imgEl.src = newDataURI;
  };
  renderImg.src = state.image.dataURI;
}

function addElement(el) {
  if (el.type === 'line') {
    addLineElement(el);
  } else if (el.type === 'text') {
    addTextElement(el);
  } else if (el.type === 'freehand') {
    addFreehandElement(el);
  } else if (el.type === 'rectangle') {
    addRectangleElement(el);
  }
}
