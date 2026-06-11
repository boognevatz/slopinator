// ── Transform module: Image rotate / flip ──────────────────────

import { state, updateViewBox, updateImageTransform } from './editor.js';
import { pushAction } from './history.js';

export function rotateCW() {
  const oldRotation = state.image.rotation;
  const newRotation = (oldRotation + 90) % 360;
  state.image.rotation = newRotation;
  updateViewBox();
  updateImageTransform();

  pushAction({
    description: 'Rotate CW',
    doFn: () => {
      state.image.rotation = newRotation;
      updateViewBox();
      updateImageTransform();
    },
    undoFn: () => {
      state.image.rotation = oldRotation;
      updateViewBox();
      updateImageTransform();
    },
  });
}

export function rotateCCW() {
  const oldRotation = state.image.rotation;
  const newRotation = (oldRotation + 270) % 360;
  state.image.rotation = newRotation;
  updateViewBox();
  updateImageTransform();

  pushAction({
    description: 'Rotate CCW',
    doFn: () => {
      state.image.rotation = newRotation;
      updateViewBox();
      updateImageTransform();
    },
    undoFn: () => {
      state.image.rotation = oldRotation;
      updateViewBox();
      updateImageTransform();
    },
  });
}

export function flipH() {
  const oldFlip = state.image.flipH;
  state.image.flipH = !oldFlip;
  updateImageTransform();

  pushAction({
    description: 'Flip Horizontal',
    doFn: () => {
      state.image.flipH = !oldFlip;
      updateImageTransform();
    },
    undoFn: () => {
      state.image.flipH = oldFlip;
      updateImageTransform();
    },
  });
}

export function flipV() {
  const oldFlip = state.image.flipV;
  state.image.flipV = !oldFlip;
  updateImageTransform();

  pushAction({
    description: 'Flip Vertical',
    doFn: () => {
      state.image.flipV = !oldFlip;
      updateImageTransform();
    },
    undoFn: () => {
      state.image.flipV = oldFlip;
      updateImageTransform();
    },
  });
}

export function zoomIn(focusX, focusY) {
  if (!state.hasImage) return;
  const newScale = Math.min(10.0, Math.round((state.image.zoomScale + 0.1) * 10) / 10);
  applyZoom(newScale, focusX, focusY);
}

export function zoomOut(focusX, focusY) {
  if (!state.hasImage) return;
  const newScale = Math.max(0.1, Math.round((state.image.zoomScale - 0.1) * 10) / 10);
  applyZoom(newScale, focusX, focusY);
}

export function zoomFit() {
  if (!state.hasImage) return;
  state.image.zoomScale = 1.0;
  state.image.zoomX = 0;
  state.image.zoomY = 0;
  updateViewBox();
}

function applyZoom(newScale, focusX, focusY) {
  const { rotation, naturalWidth, naturalHeight, zoomScale, zoomX, zoomY } = state.image;
  const isRotated = rotation === 90 || rotation === 270;
  const vbW = isRotated ? naturalHeight : naturalWidth;
  const vbH = isRotated ? naturalWidth : naturalHeight;

  const oldW = vbW / zoomScale;
  const oldH = vbH / zoomScale;
  
  // If no focus provided, use the center of the current view
  const fx = focusX !== undefined ? focusX : zoomX + oldW / 2;
  const fy = focusY !== undefined ? focusY : zoomY + oldH / 2;

  // New dimensions
  const newW = vbW / newScale;
  const newH = vbH / newScale;

  // Keep the focus point at the exact same location in the new view
  // fx = newZoomX + (fx_relative_to_old) * (new_w / old_w)?
  // Actually, fx and fy are absolute SVG coords.
  // The distance from the new zoomX to fx must be proportional to newW as the old distance was to oldW.
  // (fx - newZoomX) / newW = (fx - zoomX) / oldW
  // => fx - newZoomX = ((fx - zoomX) / oldW) * newW
  // => newZoomX = fx - ((fx - zoomX) / oldW) * newW

  const newZoomX = fx - ((fx - zoomX) / oldW) * newW;
  const newZoomY = fy - ((fy - zoomY) / oldH) * newH;

  state.image.zoomScale = newScale;
  state.image.zoomX = newZoomX;
  state.image.zoomY = newZoomY;

  updateViewBox();
}
