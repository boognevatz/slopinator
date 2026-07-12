import { dom, state } from './editor.js';
import { bindGridControls, toggleGrid } from './grid.js';

var SYSTEM_LAYERS = {
  'image-layer': { name: 'Image', index: 0 },
  'annotation-layer': { name: 'Annotations', index: 1 },
  'watermark-layer': { name: 'Watermark', index: 3 },
  'grid-layer': { name: 'Grid', index: 4 },
};

// Ordered list: image → annotation → [user layers] → watermark → grid
var layerOrder = [];

var userLayerCounter = 0;
var _selectedRow = null;

export function initLayers() {
  initLayerOrder();

  // Watermark hidden by default
  var wmLayer = document.getElementById('watermark-layer');
  if (wmLayer) wmLayer.setAttribute('visibility', 'hidden');

  renderLayerList();
  selectLayer(layerOrder[0].id);

  // Toggle right panel
  var rightPanel = document.getElementById('right-panel');
  var layersIndicator = document.getElementById('layers-indicator');
  document.getElementById('btn-layers').addEventListener('click', function() {
    rightPanel.hidden = !rightPanel.hidden;
    layersIndicator.textContent = rightPanel.hidden ? '\u25B8' : '\u25C2';
  });

  // + / - / ^ / v buttons
  document.getElementById('btn-layer-add').addEventListener('click', addLayer);
  document.getElementById('btn-layer-remove').addEventListener('click', removeLayer);
  document.getElementById('btn-layer-up').addEventListener('click', moveLayerUp);
  document.getElementById('btn-layer-down').addEventListener('click', moveLayerDown);

  // Re-render watermark when foreground color changes
  document.addEventListener('palette-color-changed', updateWatermark);
}

function initLayerOrder() {
  layerOrder = [
    { id: 'image-layer', name: 'Image', system: true },
    { id: 'annotation-layer', name: 'Annotations', system: true },
    // user layers inserted here
    { id: 'watermark-layer', name: 'Watermark', system: true },
    { id: 'grid-layer', name: 'Grid', system: true },
  ];
}

function renderLayerList() {
  var container = document.getElementById('layer-entries');
  container.innerHTML = '';

  // Display top-to-bottom (reverse of SVG DOM order)
  for (var i = layerOrder.length - 1; i >= 0; i--) {
    let entry = layerOrder[i];
    var svgLayer = document.getElementById(entry.id);
    var isHidden = svgLayer && svgLayer.getAttribute('visibility') === 'hidden';

    var div = document.createElement('div');
    div.className = 'layer-entry' + (entry._selected ? ' selected' : '');
    div.dataset.layer = entry.id;

    var header = document.createElement('div');
    header.className = 'layer-header';

    var eye = document.createElement('span');
    eye.className = 'layer-eye' + (isHidden ? ' hidden' : '');
    eye.textContent = '\uD83D\uDC41';

    var nameSpan = document.createElement('span');
    nameSpan.className = 'layer-name';
    nameSpan.textContent = entry.name;

    if (!entry.system) {
      nameSpan.style.cursor = 'text';
      nameSpan.addEventListener('dblclick', function() {
        var currentName = entry.name;
        var input = document.createElement('input');
        input.type = 'text';
        input.value = currentName;
        input.style.cssText = 'font-size:11px;width:100%;background:var(--color-bg-light);color:var(--color-text);border:1px solid var(--color-accent);border-radius:2px;padding:1px 3px;font-family:inherit;outline:none;';
        this.replaceWith(input);
        input.focus();
        input.select();

        function commit() {
          var val = input.value.trim() || currentName;
          entry.name = val;
          renderLayerList();
          selectLayer(entry.id);
        }
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); entry.name = currentName; renderLayerList(); selectLayer(entry.id); }
        });
      });
    }

    header.appendChild(eye);
    header.appendChild(nameSpan);
    div.appendChild(header);
    container.appendChild(div);

    // Eye toggle
    eye.addEventListener('click', function(e) {
      e.stopPropagation();
      var entryData = getLayerData(this);
      if (!entryData) return;
      if (entryData.id === 'grid-layer') {
        toggleGrid(!state.grid.visible);
        if (entryData._selected) showLayerProps(entryData);
        return;
      }
      var el = document.getElementById(entryData.id);
      if (!el) return;
      var hidden = el.getAttribute('visibility') === 'hidden';
      if (hidden) {
        el.removeAttribute('visibility');
        this.classList.remove('hidden');
        if (entryData.id === 'watermark-layer') updateWatermark();
      } else {
        el.setAttribute('visibility', 'hidden');
        this.classList.add('hidden');
      }
      if (entryData._selected) showLayerProps(entryData);
    });

    // Header click → select
    header.addEventListener('click', function() {
      var entryData = getLayerData(this.closest('.layer-entry'));
      if (!entryData || entryData._selected) return;
      selectLayer(entryData.id);
    });
  }
}

function getLayerData(el) {
  var id = el.dataset ? el.dataset.layer : null;
  if (!id && el.closest) id = el.closest('.layer-entry')?.dataset.layer;
  return layerOrder.find(function(l) { return l.id === id; });
}

function selectLayer(id) {
  layerOrder.forEach(function(l) { l._selected = l.id === id; });
  renderLayerList();
  var entry = layerOrder.find(function(l) { return l.id === id; });
  if (entry) showLayerProps(entry);
}

function addLayer() {
  var selected = layerOrder.find(function(l) { return l._selected; });
  var insertIndex = 2; // default: bottom of user zone (after annotation)

  if (selected) {
    var selIdx = layerOrder.indexOf(selected);
    // System layers below user zone (image, annotation): insert at bottom of user zone
    if (selIdx < 2) insertIndex = 2;
    // System layers above user zone (watermark, grid): insert at top of user zone
    else if (selIdx >= 3 && selected.system) insertIndex = 3;
    // User layer: insert above selected (higher z = later in array)
    else insertIndex = selIdx + 1;
  }

  userLayerCounter++;
  var id = 'user-layer-' + userLayerCounter;
  var name = 'Layer ' + userLayerCounter;

  // Create SVG <g> element right before watermark-layer in DOM
  var watermarkG = document.getElementById('watermark-layer');
  var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('id', id);
  if (watermarkG && watermarkG.parentNode) {
    watermarkG.parentNode.insertBefore(g, watermarkG);
  } else {
    document.getElementById('annotation-layer').after(g);
  }

  layerOrder.splice(insertIndex, 0, { id: id, name: name, system: false });
  selectLayer(id);
}

function moveLayerUp() {
  var selected = layerOrder.find(function(l) { return l._selected; });
  if (!selected) return;
  if (selected.system) { showToast('Cannot reorder system layers.'); return; }
  var idx = layerOrder.indexOf(selected);
  var next = layerOrder[idx + 1];
  if (!next || next.system) return;
  layerOrder[idx] = next;
  layerOrder[idx + 1] = selected;
  var gSel = document.getElementById(selected.id);
  var gNext = document.getElementById(next.id);
  if (gSel && gNext) gNext.parentNode.insertBefore(gSel, gNext.nextSibling);
  selectLayer(selected.id);
}

function moveLayerDown() {
  var selected = layerOrder.find(function(l) { return l._selected; });
  if (!selected) return;
  if (selected.system) { showToast('Cannot reorder system layers.'); return; }
  var idx = layerOrder.indexOf(selected);
  var prev = layerOrder[idx - 1];
  if (!prev || prev.system) return;
  layerOrder[idx] = prev;
  layerOrder[idx - 1] = selected;
  var gSel = document.getElementById(selected.id);
  var gPrev = document.getElementById(prev.id);
  if (gSel && gPrev) gPrev.parentNode.insertBefore(gSel, gPrev);
  selectLayer(selected.id);
}

function removeLayer() {
  var selected = layerOrder.find(function(l) { return l._selected; });
  if (!selected) return;
  if (selected.system) {
    showToast('System layers cannot be removed.');
    return;
  }

  // Remove SVG <g>
  var g = document.getElementById(selected.id);
  if (g) g.remove();

  var idx = layerOrder.indexOf(selected);
  layerOrder.splice(idx, 1);

  // Select the next layer at the same index
  if (layerOrder.length === 0) return;
  var next = layerOrder[Math.min(idx, layerOrder.length - 1)];
  selectLayer(next.id);
}

function showToast(msg) {
  var existing = document.getElementById('layer-toast');
  if (existing) existing.remove();
  var div = document.createElement('div');
  div.id = 'layer-toast';
  div.textContent = msg;
  div.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#c44;color:#fff;padding:8px 16px;border-radius:4px;font-size:12px;z-index:9999;';
  document.body.appendChild(div);
  setTimeout(function() { div.remove(); }, 2500);
}

function showLayerProps(entry) {
  var isHidden = false;
  var svgLayer = document.getElementById(entry.id);
  if (svgLayer) isHidden = svgLayer.getAttribute('visibility') === 'hidden';

  var body = document.getElementById('layer-props-body');

  if (entry.id === 'watermark-layer') {
    body.innerHTML =
      '<div class="layer-prop"><span class="layer-prop-label">Name:</span><span class="layer-prop-value">' + entry.name + '</span></div>' +
      '<div class="layer-prop"><span class="layer-prop-label">Visibility:</span><span class="layer-prop-value">' + (isHidden ? 'Off' : 'On') + '</span></div>' +
      '<div class="layer-prop"><span class="layer-prop-label">System layer:</span><span class="layer-prop-value">Yes</span></div>' +
      '<div style="border-top:1px solid var(--color-border);margin:6px 0 4px 0;"></div>' +
      '<div style="display:flex;flex-direction:column;gap:4px;">' +
        '<div style="display:flex;flex-direction:column;gap:1px;">' +
          '<span style="font-size:11px;color:var(--color-text-muted);">Thickness</span>' +
          '<div style="display:flex;align-items:center;gap:4px;">' +
            '<input type="range" id="wm-thickness" min="0.5" max="5" step="0.5" value="' + state.activeThickness + '" style="flex:1;min-width:0;">' +
            '<span id="wm-thickness-val" style="font-size:11px;color:var(--color-text);width:2em;text-align:right;flex-shrink:0;">' + state.activeThickness + '</span>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:1px;">' +
          '<span style="font-size:11px;color:var(--color-text-muted);">Rotation</span>' +
          '<div style="display:flex;align-items:center;gap:4px;">' +
            '<input type="range" id="wm-rotation" min="0" max="90" step="1" value="45" style="flex:1;min-width:0;">' +
            '<span id="wm-rotation-val" style="font-size:11px;color:var(--color-text);width:2.5em;text-align:right;flex-shrink:0;">45\u00B0</span>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:1px;">' +
          '<span style="font-size:11px;color:var(--color-text-muted);">Spacing</span>' +
          '<div style="display:flex;align-items:center;gap:4px;">' +
            '<input type="range" id="wm-spacing" min="10" max="400" step="10" value="40" style="flex:1;min-width:0;">' +
            '<span id="wm-spacing-val" style="font-size:11px;color:var(--color-text);width:2.5em;text-align:right;flex-shrink:0;">40</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    bindWatermarkControls();
  } else if (entry.id === 'grid-layer') {
    body.innerHTML =
      '<div class="layer-prop"><span class="layer-prop-label">Name:</span><span class="layer-prop-value">' + entry.name + '</span></div>' +
      '<div class="layer-prop"><span class="layer-prop-label">Visibility:</span><span class="layer-prop-value">' + (isHidden ? 'Off' : 'On') + '</span></div>' +
      '<div class="layer-prop"><span class="layer-prop-label">System layer:</span><span class="layer-prop-value">Yes</span></div>' +
      '<div style="border-top:1px solid var(--color-border);margin:6px 0 4px 0;"></div>' +
      '<div style="display:flex;flex-direction:column;gap:4px;">' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
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
      '<div class="layer-prop"><span class="layer-prop-label">Name:</span><span class="layer-prop-value">' + entry.name + '</span></div>' +
      '<div class="layer-prop"><span class="layer-prop-label">Visibility:</span><span class="layer-prop-value">' + (isHidden ? 'Off' : 'On') + '</span></div>' +
      '<div class="layer-prop"><span class="layer-prop-label">System layer:</span><span class="layer-prop-value">' + (entry.system ? 'Yes' : 'No') + '</span></div>';
  }
}

function bindWatermarkControls() {
  var thickness = document.getElementById('wm-thickness');
  var rotation = document.getElementById('wm-rotation');
  var spacing = document.getElementById('wm-spacing');

  if (thickness) {
    thickness.replaceWith(thickness.cloneNode(true));
    document.getElementById('wm-thickness').addEventListener('input', function () {
      document.getElementById('wm-thickness-val').textContent = this.value;
      updateWatermark();
    });
  }
  if (rotation) {
    rotation.replaceWith(rotation.cloneNode(true));
    document.getElementById('wm-rotation').addEventListener('input', function () {
      document.getElementById('wm-rotation-val').textContent = this.value + '\u00B0';
      updateWatermark();
    });
  }
  if (spacing) {
    spacing.replaceWith(spacing.cloneNode(true));
    document.getElementById('wm-spacing').addEventListener('input', function () {
      document.getElementById('wm-spacing-val').textContent = this.value;
      updateWatermark();
    });
  }
}

export function isLayerVisible(layerId) {
  var el = document.getElementById(layerId);
  return el && el.getAttribute('visibility') !== 'hidden';
}

export function activateWatermark() {
  var layer = dom.watermarkLayer;
  if (layer) layer.removeAttribute('visibility');
  updateWatermark();
  renderLayerList();
}

export function updateWatermark() {
  var layer = dom.watermarkLayer;
  if (!layer) return;

  layer.innerHTML = '';
  var oldPattern = document.getElementById('watermark-pattern');
  if (oldPattern) oldPattern.remove();

  if (!state.hasImage) return;
  if (!isLayerVisible('watermark-layer')) return;
  if (!state.activeColor || state.activeColor === 'transparent') return;

  var thicknessEl = document.getElementById('wm-thickness');
  var rotationEl = document.getElementById('wm-rotation');
  var spacingEl = document.getElementById('wm-spacing');
  var thickness = thicknessEl ? parseFloat(thicknessEl.value) : state.activeThickness;
  var color = state.activeColor;
  var rotation = rotationEl ? parseFloat(rotationEl.value) : 45;
  var spacing = spacingEl ? parseFloat(spacingEl.value) : 40;

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
