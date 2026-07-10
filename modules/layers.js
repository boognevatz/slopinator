import { dom } from './editor.js';

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
}

export function isLayerVisible(layerId) {
  var el = document.getElementById(layerId);
  return el && el.getAttribute('visibility') !== 'hidden';
}
