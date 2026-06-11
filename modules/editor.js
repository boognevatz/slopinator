// ── Editor module: SVG setup, viewBox management, image rendering ──

import { svgEl } from './utils.js';

const DEFAULT_PALETTE = [
  '#000000', '#ffffff', '#ff0000', '#00aa00', '#0055ff', '#ffdd00',
  '#ff8800', '#8833cc', '#00cccc', '#ff00ff', '#888888', '#884400'
];

const DEFAULT_THICKNESS = [1, 2, 4, 6, 8, 12];

/** Application state – single source of truth */
export const state = {
  image: {
    dataURI: null,
    naturalWidth: 0,
    naturalHeight: 0,
    rotation: 0,       // 0 | 90 | 180 | 270
    flipH: false,
    flipV: false,
    zoomScale: 1.0,
    zoomX: 0,
    zoomY: 0,
  },
  elements: [],         // { id, type, ...props }
  selectedId: null,
  activeTool: 'select', // 'select' | 'line' | 'text'
  activeColor: '#ff0000',
  activeThickness: 2,
  activeFontSize: 32,
  palette: [...DEFAULT_PALETTE],
  thicknessPresets: [...DEFAULT_THICKNESS],
  hasImage: false,
};

/** DOM references */
export const dom = {
  svg: null,
  imageLayer: null,
  annotationLayer: null,
  handleLayer: null,
  imageEl: null,
  emptyState: null,
};

/** Initialize the editor */
export function initEditor() {
  dom.svg = document.getElementById('editor-svg');
  dom.imageLayer = document.getElementById('image-layer');
  dom.annotationLayer = document.getElementById('annotation-layer');
  dom.handleLayer = document.getElementById('handle-layer');
  dom.emptyState = document.getElementById('empty-state');
}

/**
 * Load an image from a base64 data URI into the SVG.
 */
export function loadImage(dataURI, naturalWidth, naturalHeight) {
  state.image.dataURI = dataURI;
  state.image.naturalWidth = naturalWidth;
  state.image.naturalHeight = naturalHeight;
  state.image.rotation = 0;
  state.image.flipH = false;
  state.image.flipV = false;
  state.image.zoomScale = 1.0;
  state.image.zoomX = 0;
  state.image.zoomY = 0;
  state.hasImage = true;

  // Clear previous
  dom.imageLayer.innerHTML = '';
  dom.annotationLayer.innerHTML = '';
  dom.handleLayer.innerHTML = '';
  state.elements = [];
  state.selectedId = null;

  // Create <image> element
  dom.imageEl = svgEl('image', {
    href: dataURI,
    x: 0,
    y: 0,
    width: naturalWidth,
    height: naturalHeight,
    'data-type': 'background',
  });
  dom.imageLayer.appendChild(dom.imageEl);

  updateViewBox();
  updateImageTransform();

  // Hide empty state
  dom.emptyState.classList.add('hidden');

  // Enable toolbar buttons
  enableImageButtons(true);
}

/**
 * Update the SVG viewBox based on image dimensions, rotation, and zoom.
 */
export function updateViewBox() {
  if (!state.hasImage) return;
  const { naturalWidth, naturalHeight, rotation, zoomScale, zoomX, zoomY } = state.image;
  const isRotated = rotation === 90 || rotation === 270;
  const vbW = isRotated ? naturalHeight : naturalWidth;
  const vbH = isRotated ? naturalWidth : naturalHeight;
  
  // Calculate scaled dimensions
  const scaledW = vbW / zoomScale;
  const scaledH = vbH / zoomScale;
  
  dom.svg.setAttribute('viewBox', `${zoomX} ${zoomY} ${scaledW} ${scaledH}`);
}

/**
 * Update the transform attribute on the image element.
 */
export function updateImageTransform() {
  if (!dom.imageEl) return;
  const { naturalWidth: w, naturalHeight: h, rotation, flipH, flipV } = state.image;
  const isRotated = rotation === 90 || rotation === 270;
  const vbW = isRotated ? h : w;
  const vbH = isRotated ? w : h;

  const transforms = [];

  // Move to center of viewBox, apply rotation, move back to image center
  const cx = vbW / 2;
  const cy = vbH / 2;

  transforms.push(`translate(${cx}, ${cy})`);
  if (rotation !== 0) {
    transforms.push(`rotate(${rotation})`);
  }
  if (flipH) {
    transforms.push(`scale(-1, 1)`);
  }
  if (flipV) {
    transforms.push(`scale(1, -1)`);
  }
  transforms.push(`translate(${-w / 2}, ${-h / 2})`);

  dom.imageEl.setAttribute('transform', transforms.join(' '));
  dom.annotationLayer.setAttribute('transform', transforms.join(' '));
  dom.handleLayer.setAttribute('transform', transforms.join(' '));
}

/**
 * Get the current effective viewBox dimensions.
 */
export function getViewBoxDims() {
  const { naturalWidth, naturalHeight, rotation } = state.image;
  const isRotated = rotation === 90 || rotation === 270;
  return {
    width: isRotated ? naturalHeight : naturalWidth,
    height: isRotated ? naturalWidth : naturalHeight,
  };
}

function enableImageButtons(enabled) {
  const ids = ['btn-save-svg', 'btn-export-jpg', 'btn-rotate-cw', 'btn-rotate-ccw', 'btn-flip-h', 'btn-flip-v', 'btn-zoom-in', 'btn-zoom-out', 'btn-zoom-fit'];
  for (const id of ids) {
    document.getElementById(id).disabled = !enabled;
  }
}

/**
 * Restore full state from a parsed SVG project.
 */
export function restoreState(parsed) {
  state.image.dataURI = parsed.dataURI;
  state.image.naturalWidth = parsed.naturalWidth;
  state.image.naturalHeight = parsed.naturalHeight;
  state.image.rotation = parsed.rotation || 0;
  state.image.flipH = parsed.flipH || false;
  state.image.flipV = parsed.flipV || false;
  state.image.zoomScale = parsed.zoomScale || 1.0;
  state.image.zoomX = parsed.zoomX || 0;
  state.image.zoomY = parsed.zoomY || 0;
  state.hasImage = true;

  if (parsed.palette) state.palette = parsed.palette;
  if (parsed.thicknessPresets) state.thicknessPresets = parsed.thicknessPresets;

  // Clear layers
  dom.imageLayer.innerHTML = '';
  dom.annotationLayer.innerHTML = '';
  dom.handleLayer.innerHTML = '';
  state.elements = [];
  state.selectedId = null;

  // Recreate image
  dom.imageEl = svgEl('image', {
    href: state.image.dataURI,
    x: 0,
    y: 0,
    width: state.image.naturalWidth,
    height: state.image.naturalHeight,
    'data-type': 'background',
  });
  dom.imageLayer.appendChild(dom.imageEl);

  updateViewBox();
  updateImageTransform();

  dom.emptyState.classList.add('hidden');
  enableImageButtons(true);

  // Return parsed elements so caller can recreate them
  return parsed.elements || [];
}
