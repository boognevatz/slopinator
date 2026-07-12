// ── Grid overlay module ─────────────────────────────────────

import { dom, state } from './editor.js';
import { svgEl } from './utils.js';

export function initGrid() {
  dom.gridLayer = document.getElementById('grid-layer');

  // Grid hidden by default
  dom.gridLayer.setAttribute('visibility', 'hidden');
  const gridEye = document.querySelector('.layer-entry[data-layer="grid-layer"] .layer-eye');
  if (gridEye) gridEye.classList.add('hidden');

  document.getElementById('btn-grid').addEventListener('click', () => {
    toggleGrid(!state.grid.visible);
  });

  document.getElementById('btn-snap').addEventListener('click', () => {
    toggleSnapToGrid(!state.grid.snapToGrid);
  });

  document.getElementById('grid-cell-size').addEventListener('input', function () {
    state.grid.cellSize = parseInt(this.value);
    document.getElementById('grid-cell-size-val').textContent = this.value;
    if (state.grid.visible) updateGrid();
  });

  document.getElementById('grid-line-width').addEventListener('input', function () {
    state.grid.lineWidth = parseFloat(this.value);
    document.getElementById('grid-line-width-val').textContent = this.value;
    if (state.grid.visible) updateGrid();
  });

  document.getElementById('grid-opacity').addEventListener('input', function () {
    state.grid.lineOpacity = parseInt(this.value) / 100;
    document.getElementById('grid-opacity-val').textContent = this.value + '%';
    if (state.grid.visible) updateGrid();
  });

  document.addEventListener('palette-color-changed', () => {
    if (state.grid.visible) updateGrid();
  });

  updateGridButtonState();
  updateSnapButtonState();

  // Sync state when layers panel eye toggles grid layer
  const eye = document.querySelector('.layer-entry[data-layer="grid-layer"] .layer-eye');
  if (eye) {
    eye.addEventListener('click', () => {
      const hidden = dom.gridLayer.getAttribute('visibility') === 'hidden';
      state.grid.visible = !hidden;
      updateGridButtonState();
      if (state.grid.visible) updateGrid();
    });
  }
}

export function toggleGrid(visible) {
  state.grid.visible = visible;
  if (!dom.gridLayer) return;

  if (visible) {
    dom.gridLayer.removeAttribute('visibility');
    updateGrid();
  } else {
    dom.gridLayer.setAttribute('visibility', 'hidden');
    dom.gridLayer.innerHTML = '';
    const oldPattern = document.getElementById('grid-pattern');
    if (oldPattern) oldPattern.remove();
  }

  updateGridButtonState();

  const eye = document.querySelector('.layer-entry[data-layer="grid-layer"] .layer-eye');
  if (eye) eye.classList.toggle('hidden', !visible);
}

export function toggleSnapToGrid(enabled) {
  state.grid.snapToGrid = enabled;
  updateSnapButtonState();
}

export function snapToGrid(pt) {
  if (!state.grid.snapToGrid) return pt;
  const cellSize = state.grid.cellSize;
  return {
    x: Math.round(pt.x / cellSize) * cellSize,
    y: Math.round(pt.y / cellSize) * cellSize,
  };
}

export function updateGrid() {
  const layer = dom.gridLayer;
  if (!layer) return;

  layer.innerHTML = '';
  const oldPattern = document.getElementById('grid-pattern');
  if (oldPattern) oldPattern.remove();

  if (!state.hasImage || !state.grid.visible) return;

  const cellSize = state.grid.cellSize;
  const lineColor = state.activeColor || '#888888';
  const lineWidth = state.grid.lineWidth;
  const opacity = state.grid.lineOpacity;

  const defs = dom.svg.querySelector('defs');
  if (!defs) return;

  const pattern = svgEl('pattern', {
    id: 'grid-pattern',
    width: cellSize,
    height: cellSize,
    patternUnits: 'userSpaceOnUse',
  });

  const hLine = svgEl('line', {
    x1: 0, y1: 0,
    x2: cellSize, y2: 0,
    stroke: lineColor,
    'stroke-width': lineWidth,
  });
  pattern.appendChild(hLine);

  const vLine = svgEl('line', {
    x1: 0, y1: 0,
    x2: 0, y2: cellSize,
    stroke: lineColor,
    'stroke-width': lineWidth,
  });
  pattern.appendChild(vLine);

  defs.appendChild(pattern);

  const vb = dom.svg.viewBox.baseVal;
  const rect = svgEl('rect', {
    x: 0, y: 0,
    width: vb.width,
    height: vb.height,
    fill: 'url(#grid-pattern)',
    'pointer-events': 'none',
    opacity: opacity,
  });
  layer.appendChild(rect);
}

function updateGridButtonState() {
  const btn = document.getElementById('btn-grid');
  if (btn) btn.classList.toggle('active', state.grid.visible);
}

function updateSnapButtonState() {
  const btn = document.getElementById('btn-snap');
  if (btn) btn.classList.toggle('active', state.grid.snapToGrid);
}
