import { dom, state } from './editor.js';

export function initLayers() {
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

  document.getElementById('watermark-select').addEventListener('change', updateWatermark);
}

export function isLayerVisible(layerId) {
  var el = document.getElementById(layerId);
  return el && el.getAttribute('visibility') !== 'hidden';
}

export function updateWatermark() {
  var select = document.getElementById('watermark-select');
  if (!select) return;
  var value = select.value;
  var layer = dom.watermarkLayer;
  if (!layer) return;

  // Clear old watermark content and defs
  layer.innerHTML = '';
  var oldPattern = document.getElementById('watermark-pattern');
  if (oldPattern) oldPattern.remove();

  if (value === 'none' || !state.hasImage) return;

  var colorMap = { 'blue-grid': '#4488ff', 'red-grid': '#ff4444', 'black-grid': '#000000' };
  var color = colorMap[value] || '#4488ff';

  var patternId = 'watermark-pattern';
  var defs = dom.svg.querySelector('defs');
  if (!defs) return;

  var pattern = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
  pattern.setAttribute('id', patternId);
  pattern.setAttribute('width', '40');
  pattern.setAttribute('height', '40');
  pattern.setAttribute('patternUnits', 'userSpaceOnUse');
  pattern.setAttribute('patternTransform', 'rotate(45)');

  var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M 40 0 L 0 0 0 40');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '1');
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
