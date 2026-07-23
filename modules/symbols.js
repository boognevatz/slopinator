import { state, dom } from './editor.js';
import { recreateElement } from './fileio.js';
import { generateId } from './utils.js';


var _selectedLib = null;
var _entries = [];
var _thumbUrls = [];

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function normalizeLineStyle(s) {
  if (!s || s === 'normal' || s === 'arrows' || s === 'circle') return s || 'normal';
  return 'normal';
}

function normalizeLineMarkerSize(v) {
  var n = parseFloat(v);
  return !isNaN(n) && n > 0 ? n : 30;
}

function normalizeLineDecoration(v) {
  if (v === 'arrow' || v === 'circle' || v === 'none' || !v) return v || undefined;
  return undefined;
}

export function initLibraryUI() {
  var content = document.getElementById('library-content');
  if (!content) return;

  content.addEventListener('click', function(e) {
    var entry = e.target.closest('.lib-entry');
    if (!entry) return;
    onLibClick(entry);
  });

  content.addEventListener('dblclick', function(e) {
    var entry = e.target.closest('.lib-entry');
    if (!entry) return;
    onLibOpen(entry);
  });

  document.addEventListener('opfs-changed', refreshLibrary);
}

export async function renderLibrary() {
  var content = document.getElementById('library-content');
  if (!content) return;

  _revokeThumbnails();

  content.innerHTML = '<div style="padding:12px;font-size:11px;color:#666;text-align:center;">Loading...</div>';

  try {
    var root = await navigator.storage.getDirectory();
    var libDir;
    try {
      libDir = await root.getDirectoryHandle('library');
    } catch {
      content.innerHTML = '<div style="padding:12px;font-size:11px;color:#666;text-align:center;">No symbols in library</div>';
      return;
    }

    var entries = [];
    for await (var entry of libDir.entries()) {
      var name = entry[0];
      var handle = entry[1];
      if (handle.kind === 'file' && name.toLowerCase().endsWith('.svg')) {
        entries.push({
          name: name.replace(/\.svg$/i, ''),
          displayName: name,
          handle: handle,
        });
      }
    }

    entries.sort(function(a, b) { return a.name.localeCompare(b.name); });
    _entries = entries;

    if (entries.length === 0) {
      content.innerHTML = '<div style="padding:12px;font-size:11px;color:#666;text-align:center;">No symbols in library</div>';
      return;
    }

    var html = '<div style="display:flex;align-items:center;gap:4px;padding:4px 8px;border-bottom:1px solid var(--color-border);">';
    html += '<span style="font-size:11px;color:#888;flex:1;font-family:monospace;">library/</span>';
    html += '<button id="btn-lib-refresh" style="font-size:10px;padding:1px 6px;">\u21BB</button>';
    html += '</div>';
    html += '<div id="library-entries" style="display:flex;flex-direction:column;">';

    for (var i = 0; i < entries.length; i++) {
      var name = entries[i].name;
      var cls = _selectedLib === name ? ' lib-entry selected' : ' lib-entry';
      html += '<div class="' + cls + '" data-name="' + name.replace(/"/g, '&quot;') + '" style="display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;border-bottom:1px solid var(--color-border);">';
      html += '<img class="lib-thumb" data-name="' + name.replace(/"/g, '&quot;') + '" style="width:36px;height:36px;object-fit:contain;background:var(--color-bg-dark);border-radius:2px;border:1px solid var(--color-border);flex-shrink:0;">';
      html += '<span style="font-size:11px;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(name) + '</span>';
      html += '</div>';
    }

    html += '</div>';
    html += '<div style="padding:2px 8px;font-size:10px;color:#666;border-top:1px solid var(--color-border);">' + entries.length + ' symbol' + (entries.length !== 1 ? 's' : '') + '</div>';

    content.innerHTML = html;

    document.getElementById('btn-lib-refresh').addEventListener('click', refreshLibrary);

    for (var i = 0; i < entries.length; i++) {
      _loadThumbnail(entries[i]);
    }
  } catch (e) {
    console.error('Library render error:', e);
    content.innerHTML = '<div style="padding:12px;font-size:11px;color:#c66;text-align:center;">Library unavailable</div>';
  }
}

function _revokeThumbnails() {
  for (var i = 0; i < _thumbUrls.length; i++) {
    URL.revokeObjectURL(_thumbUrls[i]);
  }
  _thumbUrls = [];
}

async function _loadThumbnail(entry) {
  try {
    var file = await entry.handle.getFile();
    var svgText = await file.text();

    // Embed as data URI so cross-origin SVG restrictions don't apply
    var dataUri = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgText)));
    _thumbUrls.push(dataUri);

    var img = document.querySelector('.lib-thumb[data-name="' + entry.name.replace(/"/g, '&quot;') + '"]');
    if (img) img.src = dataUri;
  } catch (e) {
    console.error('Thumbnail load error:', e);
  }
}

export function refreshLibrary() {
  _revokeThumbnails();
  renderLibrary();
}

function onLibClick(entryEl) {
  document.querySelectorAll('.lib-entry.selected').forEach(function(el) {
    el.classList.remove('selected');
    el.style.background = '';
  });
  entryEl.classList.add('selected');
  entryEl.style.background = 'rgba(var(--color-accent-rgb), 0.2)';
  _selectedLib = entryEl.dataset.name;
}

function onLibOpen(entryEl) {
  var name = entryEl.dataset.name;
  var entry = null;
  for (var i = 0; i < _entries.length; i++) {
    if (_entries[i].name === name) { entry = _entries[i]; break; }
  }
  if (!entry) return;
  importLibrary(entry);
}

export async function importLibrary(entry) {
  try {
    var file = await entry.handle.getFile();
    var svgText = await file.text();

    var parser = new DOMParser();
    var doc = parser.parseFromString(svgText, 'image/svg+xml');
    var svgRoot = doc.documentElement;

    if (svgRoot.querySelector('parsererror')) {
      console.error('Library SVG parse error');
      return;
    }

    var elements = _parseLibraryElements(doc, svgText);
    if (elements.length === 0) return;

    _insertElements(elements);

    document.dispatchEvent(new CustomEvent('editor-dirty'));
  } catch (e) {
    console.error('Library import error:', e);
  }
}

function _parseLibraryElements(doc, svgText) {
  var svgRoot = doc.documentElement;
  var elements = [];

  // Lines (2-point)
  svgRoot.querySelectorAll('g[data-type="line"]').forEach(function(g) {
    var line = g.querySelector('line.annotation-line');
    if (!line) return;
    var lineStyleAttr = line.getAttribute('data-line-style') || g.getAttribute('data-line-style') || '';
    var markerStart = line.getAttribute('marker-start') || '';
    var markerEnd = line.getAttribute('marker-end') || '';
    var inferredStyle = lineStyleAttr || (markerStart.includes('circle') ? 'circle' : (markerStart.includes('arrow') || markerEnd.includes('arrow') ? 'arrows' : 'normal'));
    var rawStartDecor = g.getAttribute('data-start-decoration') || '';
    var rawEndDecor = g.getAttribute('data-end-decoration') || '';
    var rawStartSize = g.getAttribute('data-start-decoration-size') || '';
    var rawEndSize = g.getAttribute('data-end-decoration-size') || '';
    elements.push({
      id: g.id || generateId(),
      type: 'line',
      points: [
        { x: parseFloat(line.getAttribute('x1')), y: parseFloat(line.getAttribute('y1')) },
        { x: parseFloat(line.getAttribute('x2')), y: parseFloat(line.getAttribute('y2')) },
      ],
      x1: parseFloat(line.getAttribute('x1')),
      y1: parseFloat(line.getAttribute('y1')),
      x2: parseFloat(line.getAttribute('x2')),
      y2: parseFloat(line.getAttribute('y2')),
      stroke: line.getAttribute('stroke'),
      strokeWidth: parseFloat(line.getAttribute('stroke-width')),
      lineStyle: normalizeLineStyle(inferredStyle),
      lineMarkerSize: normalizeLineMarkerSize(g.getAttribute('data-line-marker-size') || line.getAttribute('data-line-marker-size') || 30),
      startDecoration: rawStartDecor ? normalizeLineDecoration(rawStartDecor) : undefined,
      endDecoration: rawEndDecor ? normalizeLineDecoration(rawEndDecor) : undefined,
      startDecorationSize: rawStartSize ? normalizeLineMarkerSize(rawStartSize) : undefined,
      endDecorationSize: rawEndSize ? normalizeLineMarkerSize(rawEndSize) : undefined,
    });
  });

  // Polylines (3+ points)
  function parsePolyPoints(p) {
    var ptsAttr = p.getAttribute('points') || '';
    return ptsAttr.trim().split(/\s+/).filter(Boolean).map(function(pair) {
      var parts = pair.split(',');
      return { x: Number(parts[0]), y: Number(parts[1]) };
    });
  }

  svgRoot.querySelectorAll('polyline[data-type="line"], polygon[data-type="line"]').forEach(function(p) {
    var pts = parsePolyPoints(p);
    if (pts.length < 2) return;
    var closed = p.tagName === 'polygon' || p.getAttribute('data-closed') === 'true';
    elements.push({
      id: p.id || generateId(),
      type: 'line',
      points: pts,
      x1: pts[0].x, y1: pts[0].y,
      x2: pts[pts.length - 1].x, y2: pts[pts.length - 1].y,
      stroke: p.getAttribute('stroke') || '#ff0000',
      strokeWidth: parseFloat(p.getAttribute('stroke-width')) || 2,
      lineStyle: normalizeLineStyle(p.getAttribute('data-line-style') || 'normal'),
      lineMarkerSize: normalizeLineMarkerSize(p.getAttribute('data-line-marker-size') || 30),
      closed: closed,
      fill: p.getAttribute('fill') || 'none',
    });
  });

  // Texts
  svgRoot.querySelectorAll('text[data-type="text"]').forEach(function(t) {
    var rotation = 0;
    var transform = t.getAttribute('transform');
    if (transform) {
      var match = transform.match(/rotate\(([-\d.]+)/);
      if (match) rotation = parseFloat(match[1]);
    }
    elements.push({
      id: t.id || generateId(),
      type: 'text',
      x: parseFloat(t.getAttribute('x')),
      y: parseFloat(t.getAttribute('y')),
      content: t.textContent,
      fontSize: parseFloat(t.getAttribute('font-size')),
      fill: t.getAttribute('fill'),
      stroke: t.getAttribute('stroke') || 'none',
      strokeWidth: parseFloat(t.getAttribute('stroke-width')) || 0,
      rotation: rotation,
    });
  });

  // Freehand
  svgRoot.querySelectorAll('polyline[data-type="freehand"]').forEach(function(p) {
    var ptsAttr = p.getAttribute('points') || '';
    var points = ptsAttr.trim().split(/\s+/).filter(Boolean).map(function(pair) {
      var parts = pair.split(',');
      return { x: Number(parts[0]), y: Number(parts[1]) };
    });
    elements.push({
      id: p.id || generateId(),
      type: 'freehand',
      points: points,
      rawPoints: null,
      epsilon: parseFloat(p.getAttribute('data-epsilon')) || 3,
      stroke: p.getAttribute('stroke') || '#ff0000',
      strokeWidth: parseFloat(p.getAttribute('stroke-width')) || 2,
    });
  });

  // Rectangles
  svgRoot.querySelectorAll('rect[data-type="rectangle"]').forEach(function(r) {
    var rotation = 0;
    var transform = r.getAttribute('transform');
    if (transform) {
      var m = transform.match(/rotate\(([-\d.]+)/);
      if (m) rotation = parseFloat(m[1]);
    }
    elements.push({
      id: r.id || generateId(),
      type: 'rectangle',
      x: parseFloat(r.getAttribute('x')),
      y: parseFloat(r.getAttribute('y')),
      width: parseFloat(r.getAttribute('width')),
      height: parseFloat(r.getAttribute('height')),
      rx: parseFloat(r.getAttribute('rx')) || 0,
      rotation: rotation,
      stroke: r.getAttribute('stroke') || 'none',
      strokeWidth: parseFloat(r.getAttribute('stroke-width')) || 2,
      fill: r.getAttribute('fill') || 'transparent',
    });
  });

  // Groups — match childIds after all elements are parsed
  var groupEls = [];
  svgRoot.querySelectorAll('g[data-type="group"]').forEach(function(g) {
    var groupId = g.id || generateId();
    var childIds = [];
    g.querySelectorAll('[id]').forEach(function(child) {
      if (child.id && child.id !== groupId) childIds.push(child.id);
    });
    groupEls.push({ id: groupId, type: 'group', childIds: childIds });
  });

  // Resolve parentId for group children
  for (var gi = 0; gi < groupEls.length; gi++) {
    var g = groupEls[gi];
    for (var ci = 0; ci < g.childIds.length; ci++) {
      var cid = g.childIds[ci];
      for (var ei = 0; ei < elements.length; ei++) {
        if (elements[ei].id === cid) {
          elements[ei].parentId = g.id;
          break;
        }
      }
    }
  }

  for (var i = 0; i < groupEls.length; i++) {
    elements.push(groupEls[i]);
  }

  return elements;
}

function _insertElements(elements) {
  var idMap = {};
  var newElements = [];

  // First pass: assign new IDs, build idMap
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    var oldId = el.id;
    var newId = generateId();
    idMap[oldId] = newId;
    el.id = newId;
  }

  // Remap parentId references for groups
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    if (el.parentId && idMap[el.parentId]) {
      el.parentId = idMap[el.parentId];
    }
    if (el.type === 'group' && el.childIds) {
      var newChildIds = [];
      for (var ci = 0; ci < el.childIds.length; ci++) {
        if (idMap[el.childIds[ci]]) {
          newChildIds.push(idMap[el.childIds[ci]]);
        }
      }
      el.childIds = newChildIds;
    }
  }

  var annotationLayer = dom.annotationLayer;

  // First pass: all elements except groups (including group children)
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    if (el.type === 'group') continue;
    recreateElement(el);
    newElements.push(el);
  }

  // Second pass: groups
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    if (el.type !== 'group') continue;
    var gEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    gEl.id = el.id;
    gEl.setAttribute('data-type', 'group');
    for (var ci = 0; ci < el.childIds.length; ci++) {
      var childDom = annotationLayer.querySelector('#' + CSS.escape(el.childIds[ci]));
      if (childDom) gEl.appendChild(childDom);
    }
    annotationLayer.appendChild(gEl);
    newElements.push(el);
  }

  for (var i = 0; i < newElements.length; i++) {
    state.elements.push(newElements[i]);
  }
}
