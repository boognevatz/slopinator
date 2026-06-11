// ── Transform module: Image rotate / flip ──────────────────────

import { state, updateViewBox, updateImageTransform } from './editor.js';
import { pushAction } from './history.js';

export function rotateCW() {
  const oldRotation = state.image.rotation;
  const newRotation = (oldRotation + 90) % 360;
  state.image.rotation = newRotation;
  state.image.fitScale = null;
  updateViewBox();
  updateImageTransform();

  pushAction({
    description: 'Rotate CW',
    doFn: () => {
      state.image.rotation = newRotation;
      state.image.fitScale = null;
      updateViewBox();
      updateImageTransform();
    },
    undoFn: () => {
      state.image.rotation = oldRotation;
      state.image.fitScale = null;
      updateViewBox();
      updateImageTransform();
    },
  });
}

export function rotateCCW() {
  const oldRotation = state.image.rotation;
  const newRotation = (oldRotation + 270) % 360;
  state.image.rotation = newRotation;
  state.image.fitScale = null;
  updateViewBox();
  updateImageTransform();

  pushAction({
    description: 'Rotate CCW',
    doFn: () => {
      state.image.rotation = newRotation;
      state.image.fitScale = null;
      updateViewBox();
      updateImageTransform();
    },
    undoFn: () => {
      state.image.rotation = oldRotation;
      state.image.fitScale = null;
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
  const container = document.getElementById('editor-container');
  const svg = document.getElementById('editor-svg');
  
  // Current scroll and dimensions
  const cW = container.clientWidth;
  const cH = container.clientHeight;
  const sL = container.scrollLeft;
  const sT = container.scrollTop;
  
  // Calculate the relative focus point in the container viewport
  // If focusX/Y are not provided, default to center of the viewport
  let relX = cW / 2;
  let relY = cH / 2;
  
  if (focusX !== undefined && focusY !== undefined) {
    const cRect = container.getBoundingClientRect();
    relX = focusX - cRect.left;
    relY = focusY - cRect.top;
  }
  
  // Find where that relative point maps to inside the scrollable content
  const contentX = sL + relX;
  const contentY = sT + relY;
  
  // Calculate how much we are scaling the physical size by
  const scaleRatio = newScale / state.image.zoomScale;
  
  // Set new scale
  state.image.zoomScale = newScale;
  updateViewBox(); // Updates svg width/height
  
  // Wait a microtask for DOM to update sizes so scrollLeft works
  setTimeout(() => {
    // The point we hovered over should move proportionally
    const newContentX = contentX * scaleRatio;
    const newContentY = contentY * scaleRatio;
    
    // Set new scroll positions so the relative point stays exactly under the mouse
    container.scrollLeft = newContentX - relX;
    container.scrollTop = newContentY - relY;
  }, 0);
}
