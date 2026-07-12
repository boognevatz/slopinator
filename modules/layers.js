import { dom, state } from './editor.js';
import { bindGridControls } from './grid.js';

var SYSTEM_LAYERS = {
  'watermark-layer': 'Watermark',
  'annotation-layer': 'Annotations',
  'grid-layer': 'Grid',
  'image-layer': 'Image',
};

export function initLayers() {
  // Toggle right panel
  var rightPanel = document.getElementById('right-panel');
  var layersIndicator = document.getElementById('layers-indicator');
  document.getElementById('btn-layers').addEventListener('click', function() {
    rightPanel.hidden = !rightPanel.hidden;
    layersIndicator.textContent = rightPanel.hidden ? '\u25B8' : '\u25C2';
  });

  // Watermark hidden by default
  var wmLayer = document.getElementById('watermark-layer');
  var wmEye = document.querySelector('.layer-entry[data-layer="watermark-layer"] .layer-eye');
  if (wmLayer) wmLayer.setAttribute('visibility', 'hidden');
  if (wmEye) wmEye.classList.add('hidden');

  // Eye toggle
  document.querySelectorAll('.layer-eye').forEach(function(el) {
    el.addEventListener('click', function(e) {
      e.stopPropagation();
      var entry = this.closest('.layer-entry');
      var layerId = entry.getAttribute('data-layer');
      var layer = document.getElementById(layerId);
      if (!layer) return;
      var isHidden = layer.getAttribute('visibility') === 'hidden';
      if (isHidden) {
        layer.removeAttribute('visibility');
        this.classList.remove('hidden');
      } else {
        layer.setAttribute('visibility', 'hidden');
        this.classList.add('hidden');
      }
      if (entry.classList.contains('selected')) {
        showLayerProps(entry);
      }
    });
  });

  // Layer header click → show props in bottom panel
  document.querySelectorAll('#right-panel .layer-header').forEach(function(el) {
    el.addEventListener('click', function() {
      var entry = this.closest('.layer-entry');
      if (entry.classList.contains('selected')) return;
      document.querySelectorAll('#right-panel .layer-entry').forEach(function(e) {
        e.classList.remove('selected');
      });
      entry.classList.add('selected');
      showLayerProps(entry);
    });
  });

  // Sliders
  document.getElementById('wm-thickness').addEventListener('input', function() {
    document.getElementById('wm-thickness-val').textContent = this.value;
    updateWatermark();
  });
  document.getElementById('wm-rotation').addEventListener('input', function() {
    document.getElementById('wm-rotation-val').textContent = this.value + '\u00B0';
    updateWatermark();
  });
  document.getElementById('wm-spacing').addEventListener('input', function() {
    document.getElementById('wm-spacing-val').textContent = this.value;
    updateWatermark();
  });

  // Re-render watermark when foreground color changes
  document.addEventListener('palette-color-changed', updateWatermark);
}

function showLayerProps(entry) {
  var layerId = entry.getAttribute('data-layer');
  var layer = document.getElementById(layerId);
  if (!layer) return;

  var name = entry.querySelector('.layer-name').textContent;
  var isHidden = layer.getAttribute('visibility') === 'hidden';
  var isSystem = !!SYSTEM_LAYERS[layerId];

  var body = document.getElementById('layer-props-body');

  if (layerId === 'grid-layer') {
    var vis = isHidden ? 'Off' : 'On';
    body.innerHTML =
      '<div class="layer-prop"><span class="layer-prop-label">Name:</span><span class="layer-prop-value">' + name + '</span></div>' +
      '<div class="layer-prop"><span class="layer-prop-label">Visibility:</span><span class="layer-prop-value">' + vis + '</span></div>' +
      '<div class="layer-prop"><span class="layer-prop-label">System layer:</span><span class="layer-prop-value">Yes</span></div>' +
      '<div style="border-top:1px solid var(--color-border);margin:6px 0 4px 0;"></div>' +
      '<div style="display:flex;flex-direction:column;gap:4px;">' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
          '<button id="btn-grid" class="active" style="flex:1;font-size:11px;padding:3px 6px;">Grid</button>' +
          '<button id="btn-snap" style="flex:1;font-size:11px;padding:3px 6px;">Snap</button>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:1px;">' +
          '<span style="font-size:11px;color:var(--color-text-muted);">Size</span>' +
          '<div style="display:flex;align-items:center;gap:4px;">' +
            '<input type="range" id="grid-cell-size" min="5" max="200" value="' + state.grid.cellSize + '" style="flex:1;min-width:0;">' +
            '<span id="grid-cell-size-val" style="font-size:11px;color:var(--color-text);width:1.5em;text-align:right;flex-shrink:0;">' + state.grid.cellSize + '</span>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:1px;">' +
          '<span style="font-size:11px;color:var(--color-text-muted);">Line width</span>' +
          '<div style="display:flex;align-items:center;gap:4px;">' +
            '<input type="range" id="grid-line-width" min="0.5" max="5" step="0.5" value="' + state.grid.lineWidth + '" style="flex:1;min-width:0;">' +
            '<span id="grid-line-width-val" style="font-size:11px;color:var(--color-text);width:1.5em;text-align:right;flex-shrink:0;">' + state.grid.lineWidth + '</span>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:1px;">' +
          '<span style="font-size:11px;color:var(--color-text-muted);">Opacity</span>' +
          '<div style="display:flex;align-items:center;gap:4px;">' +
            '<input type="range" id="grid-opacity" min="0" max="100" value="' + (state.grid.lineOpacity * 100) + '" style="flex:1;min-width:0;">' +
            '<span id="grid-opacity-val" style="font-size:11px;color:var(--color-text);width:2em;text-align:right;flex-shrink:0;">' + (state.grid.lineOpacity * 100) + '%</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    bindGridControls();
  } else {
    body.innerHTML =
      '<div class="layer-prop"><span class="layer-prop-label">Name:</span><span class="layer-prop-value">' + name + '</span></div>' +
      '<div class="layer-prop"><span class="layer-prop-label">Visibility:</span><span class="layer-prop-value">' + (isHidden ? 'Off' : 'On') + '</span></div>' +
      '<div class="layer-prop"><span class="layer-prop-label">System layer:</span><span class="layer-prop-value">' + (isSystem ? 'Yes' : 'No') + '</span></div>';
  }
}

export function isLayerVisible(layerId) {
  var el = document.getElementById(layerId);
  return el && el.getAttribute('visibility') !== 'hidden';
}

export function activateWatermark() {
  var layer = dom.watermarkLayer;
  var eye = document.querySelector('.layer-entry[data-layer="watermark-layer"] .layer-eye');
  if (layer) layer.removeAttribute('visibility');
  if (eye) eye.classList.remove('hidden');
  updateWatermark();
}

export function updateWatermark() {
  var layer = dom.watermarkLayer;
  if (!layer) return;

  // Clear old watermark content and pattern def
  layer.innerHTML = '';
  var oldPattern = document.getElementById('watermark-pattern');
  if (oldPattern) oldPattern.remove();

  if (!state.hasImage) return;

  // Don't render if watermark layer is hidden or color is transparent
  if (!isLayerVisible('watermark-layer')) return;
  if (!state.activeColor || state.activeColor === 'transparent') return;

  var thickness = parseFloat(document.getElementById('wm-thickness').value) || 1;
  var color = state.activeColor;
  var rotation = parseFloat(document.getElementById('wm-rotation').value) || 45;
  var spacing = parseFloat(document.getElementById('wm-spacing').value) || 40;

  var patternId = 'watermark-pattern';
  var defs = dom.svg.querySelector('defs');
  if (!defs) return;

  var pattern = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
  pattern.setAttribute('id', patternId);
  pattern.setAttribute('width', String(spacing));
  pattern.setAttribute('height', String(spacing));
  pattern.setAttribute('patternUnits', 'userSpaceOnUse');
  pattern.setAttribute('patternTransform', 'rotate(' + rotation + ')');

  var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M ' + spacing + ' 0 L 0 0 0 ' + spacing);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', String(thickness));
  path.setAttribute('opacity', '0.4');
  pattern.appendChild(path);
  defs.appendChild(pattern);

  var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', '0');
  rect.setAttribute('y', '0');
  rect.setAttribute('width', state.image.naturalWidth);
  rect.setAttribute('height', state.image.naturalHeight);
  rect.setAttribute('fill', 'url(#' + patternId + ')');
  rect.setAttribute('pointer-events', 'none');
  layer.appendChild(rect);
}
