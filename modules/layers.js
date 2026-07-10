import { dom, state } from './editor.js';

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
