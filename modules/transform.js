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
