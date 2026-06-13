// ── Editor module: SVG setup, viewBox management, image rendering ──

import { svgEl } from './utils.js';

const DEFAULT_PALETTE = [
  '#000000', '#ffffff', '#ff0000', '#00aa00', '#0055ff', '#ffdd00',
  '#ff8800', '#8833cc', '#00cccc', '#ff00ff', '#888888', '#884400'
];

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
    fitScale: 1.0,
  },
  elements: [],         // { id, type, ...props }
  selectedId: null,
  activeTool: 'select', // 'select' | 'line' | 'text'
  activeColor: '#ff0000',
  bgColor: '#ffffff',
  activeOpacity: 255,
  bgOpacity: 255,
  activeThickness: 2,
  activeLineStyle: 'normal',
  activeLineMarkerSize: 30,
  activeLineEditMode: 'move',
  activeLineEndpoint: 'end',
  activeFreehandEpsilon: 0,
  activeCornerRadius: 0,
  activeFontSize: 64,
  palette: [...DEFAULT_PALETTE],

  viewerWidth: 0,
  viewerHeight: 0,
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
  state.image.fitScale = null;
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
 * Update the SVG viewBox and physical dimensions based on image, rotation, and zoom.
 */
export function updateViewBox() {
  if (!state.hasImage) return;
  const { naturalWidth, naturalHeight, rotation, zoomScale } = state.image;
  const isRotated = rotation === 90 || rotation === 270;
  const vbW = isRotated ? naturalHeight : naturalWidth;
  const vbH = isRotated ? naturalWidth : naturalHeight;
  
  // The SVG internal coordinate system always matches the image natural bounding box
  dom.svg.setAttribute('viewBox', `0 0 ${vbW} ${vbH}`);

  // Calculate fitScale if it's not set (e.g. on first load)
  const container = document.getElementById('editor-container');
  if (!state.image.fitScale) {
    const cW = container.clientWidth - 20; // 20px padding
    const cH = container.clientHeight - 20;
    state.image.fitScale = Math.min(1.0, Math.min(cW / vbW, cH / vbH));
  }

  // Calculate new physical dimensions
  const newW = vbW * state.image.fitScale * zoomScale;
  const newH = vbH * state.image.fitScale * zoomScale;

  state.viewerWidth = Math.round(newW);
  state.viewerHeight = Math.round(newH);

  dom.svg.style.width = newW + 'px';
  dom.svg.style.height = newH + 'px';

  // Center horizontally/vertically if smaller than container
  const padX = Math.max(0, (container.clientWidth - newW) / 2);
  const padY = Math.max(0, (container.clientHeight - newH) / 2);
  dom.svg.style.marginLeft = padX + 'px';
  dom.svg.style.marginTop = padY + 'px';

  updateLabels();
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

  updateLabels();
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

function updateLabels() {
  if (!state.hasImage) {
    document.getElementById('zoom-label').textContent = '';
    document.getElementById('image-size-label').textContent = '';
    return;
  }

  // Update zoom (effective = zoomScale × fitScale — the real visible scale)
  const zoomPercent = Math.round(state.image.zoomScale * state.image.fitScale * 100);
  document.getElementById('zoom-label').textContent =
    `${zoomPercent}% — ${state.viewerWidth}×${state.viewerHeight}`;

  // Update image size
  const dims = getViewBoxDims();
  document.getElementById('image-size-label').textContent = `${Math.round(dims.width)} × ${Math.round(dims.height)}`;
}

function enableImageButtons(enabled) {
  const ids = ['btn-save-svg', 'btn-export-jpg', 'btn-rotate-cw', 'btn-rotate-ccw', 'btn-flip-h', 'btn-flip-v', 'btn-zoom-in', 'btn-zoom-out', 'btn-zoom-fit', 'btn-zoom-11'];
  // btn-crop is a tool button, so it isn't strictly disabled on load natively, but let's leave it as is.
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
  state.image.fitScale = null;
  state.hasImage = true;

  if (parsed.palette) state.palette = parsed.palette;
  // parsed.thicknessPresets is ignored; slider uses fixed range

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
