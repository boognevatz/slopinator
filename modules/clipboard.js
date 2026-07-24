import { state, dom } from './editor.js';
import { captureElementState } from './dom-utils.js';
import { serializeElement } from './fileio.js';
import { svgEl, screenToCoords, generateId } from './utils.js';
import { addLineElement } from './line.js';
import { addTextElement } from './text.js';
import { addFreehandElement } from './freehand.js';
import { addRectangleElement } from './rectangle.js';
import { pushAction } from './history.js';
import { selectElement } from './select.js';

var CLIPBOARD_FILENAME = 'ctrlc.svg';

function clipKey() {
  var app = document.querySelector('html').dataset.appname || 'index';
  return app + ':ctrlc';
}

function getBBoxFromClipData(data) {
  if (data.type === 'line') {
    var pts = data.points || [{x: data.x1, y: data.y1}, {x: data.x2, y: data.y2}];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var pi = 0; pi < pts.length; pi++) {
      if (pts[pi].x < minX) minX = pts[pi].x;
      if (pts[pi].y < minY) minY = pts[pi].y;
      if (pts[pi].x > maxX) maxX = pts[pi].x;
      if (pts[pi].y > maxY) maxY = pts[pi].y;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  if (data.type === 'text') {
    var charCount = (data.content || 'T').length;
    return { x: data.x, y: data.y - data.fontSize * 0.9, width: charCount * data.fontSize * 0.6, height: data.fontSize * 1.2 };
  }
  if (data.type === 'rectangle') {
    return { x: data.x, y: data.y, width: data.width || 0, height: data.height || 0 };
  }
  if (data.type === 'freehand') {
    var fxMin = Infinity, fyMin = Infinity, fxMax = -Infinity, fyMax = -Infinity;
    for (var fi = 0; fi < data.points.length; fi++) {
      var fp = data.points[fi];
      if (fp.x < fxMin) fxMin = fp.x;
      if (fp.y < fyMin) fyMin = fp.y;
      if (fp.x > fxMax) fxMax = fp.x;
      if (fp.y > fyMax) fyMax = fp.y;
    }
    return { x: fxMin, y: fyMin, width: fxMax - fxMin, height: fyMax - fyMin };
  }
  return { x: 0, y: 0, width: 0, height: 0 };
}

function parseClipElements(parentEl, out, groupParentId) {
  for (var ci = 0; ci < parentEl.children.length; ci++) {
    var el = parentEl.children[ci];
    var type = el.getAttribute('data-type');
    if (!type) continue;

    if (type === 'group') {
      var groupId = el.getAttribute('id');
      parseClipElements(el, out, groupId);
      out.push({ type: 'group', id: groupId, childIds: [], el: el });
    } else if (type === 'line') {
      var lineEl = el.querySelector('line.annotation-line');
      if (lineEl) {
        var pts = [
          { x: parseFloat(lineEl.getAttribute('x1')), y: parseFloat(lineEl.getAttribute('y1')) },
          { x: parseFloat(lineEl.getAttribute('x2')), y: parseFloat(lineEl.getAttribute('y2')) },
        ];
        var stroke = lineEl.getAttribute('stroke');
        var sw = parseFloat(lineEl.getAttribute('stroke-width'));
        var ls = el.getAttribute('data-line-style') || lineEl.getAttribute('data-line-style') || 'normal';
        var lms = el.getAttribute('data-line-marker-size') || lineEl.getAttribute('data-line-marker-size') || 30;
        var sd = el.getAttribute('data-start-decoration') || '';
        var ed = el.getAttribute('data-end-decoration') || '';
        var sds = el.getAttribute('data-start-decoration-size') || '';
        var eds = el.getAttribute('data-end-decoration-size') || '';
        var rot = 0;
        var transform = el.getAttribute('transform');
        if (transform) { var m = transform.match(/rotate\(([-\d.]+)/); if (m) rot = parseFloat(m[1]); }
        out.push({
          type: 'line',
          id: el.getAttribute('id'),
          parentId: groupParentId,
          points: pts,
          x1: pts[0].x, y1: pts[0].y,
          x2: pts[1].x, y2: pts[1].y,
          stroke: stroke,
          strokeWidth: sw,
          lineStyle: ls,
          lineMarkerSize: parseFloat(lms),
          startDecoration: sd || undefined,
          endDecoration: ed || undefined,
          startDecorationSize: sds || undefined,
          endDecorationSize: eds || undefined,
          rotation: rot || undefined,
        });
      } else {
        var poly = el.querySelector('polyline[data-type="line"], polygon[data-type="line"]') || el;
        if (poly && poly.tagName !== 'g') {
          parsePolyElement(poly, groupParentId, out);
        }
      }
    } else if (type === 'text') {
      var transform = el.getAttribute('transform');
      var rot = 0;
      if (transform) { var m = transform.match(/rotate\(([-\d.]+)/); if (m) rot = parseFloat(m[1]); }
      out.push({
        type: 'text',
        id: el.getAttribute('id'),
        parentId: groupParentId,
        x: parseFloat(el.getAttribute('x')),
        y: parseFloat(el.getAttribute('y')),
        content: el.textContent,
        fontSize: parseFloat(el.getAttribute('font-size')),
        fill: el.getAttribute('fill'),
        stroke: el.getAttribute('stroke') || 'none',
        strokeWidth: parseFloat(el.getAttribute('stroke-width')) || 0,
        rotation: rot || undefined,
      });
    } else if (type === 'freehand') {
      parsePolyElement(el, groupParentId, out);
    } else if (type === 'rectangle') {
      var transform = el.getAttribute('transform');
      var rot = 0;
      if (transform) { var m = transform.match(/rotate\(([-\d.]+)/); if (m) rot = parseFloat(m[1]); }
      out.push({
        type: 'rectangle',
        id: el.getAttribute('id'),
        parentId: groupParentId,
        x: parseFloat(el.getAttribute('x')),
        y: parseFloat(el.getAttribute('y')),
        width: parseFloat(el.getAttribute('width')),
        height: parseFloat(el.getAttribute('height')),
        rx: parseFloat(el.getAttribute('rx')) || 0,
        rotation: rot || undefined,
        stroke: el.getAttribute('stroke') || 'none',
        strokeWidth: parseFloat(el.getAttribute('stroke-width')) || 2,
        fill: el.getAttribute('fill') || 'transparent',
      });
    }
  }
}

function parsePolyElement(poly, groupParentId, out) {
  var ptsAttr = poly.getAttribute('points') || '';
  var points = ptsAttr.trim().split(/\s+/).filter(Boolean).map(function(pair) {
    var xy = pair.split(',').map(Number);
    return { x: xy[0], y: xy[1] };
  });
  if (points.length < 2) return;
  var elType = poly.getAttribute('data-type');
  if (elType === 'freehand') {
    out.push({
      type: 'freehand',
      id: poly.getAttribute('id') || generateId(),
      parentId: groupParentId,
      points: points,
      rawPoints: null,
      epsilon: parseFloat(poly.getAttribute('data-epsilon')) || 3,
      stroke: poly.getAttribute('stroke') || '#ff0000',
      strokeWidth: parseFloat(poly.getAttribute('stroke-width')) || 2,
    });
  } else {
    var closed = poly.tagName === 'polygon' || poly.getAttribute('data-closed') === 'true';
    out.push({
      type: 'line',
      id: poly.getAttribute('id') || generateId(),
      parentId: groupParentId,
      points: points,
      x1: points[0].x, y1: points[0].y,
      x2: points[points.length - 1].x, y2: points[points.length - 1].y,
      stroke: poly.getAttribute('stroke') || '#ff0000',
      strokeWidth: parseFloat(poly.getAttribute('stroke-width')) || 2,
      lineStyle: poly.getAttribute('data-line-style') || 'normal',
      lineMarkerSize: parseFloat(poly.getAttribute('data-line-marker-size')) || 30,
      closed: closed || undefined,
      fill: closed ? (poly.getAttribute('fill') || 'none') : undefined,
    });
  }
}

function isFullGroupSelection() {
  if (state.selectedIds.length < 2) return false;
  var groupEl = null;
  for (var i = 0; i < state.selectedIds.length; i++) {
    var el = document.getElementById(state.selectedIds[i]);
    if (!el) return false;
    var parent = el.parentElement;
    if (!parent || parent.dataset.type !== 'group') return false;
    if (i === 0) groupEl = parent;
    else if (parent !== groupEl) return false;
  }
  return groupEl !== null && groupEl.children.length === state.selectedIds.length;
}

function nextClipId() {
  var n = 1;
  var c;
  do {
    c = 'clip-' + n;
    n++;
  } while (document.getElementById(c) || document.querySelector('#' + CSS.escape(c)));
  return c;
}

export async function clipCopy() {
  if (state.selectedIds.length === 0) return;

  var svg = '';

  if (isFullGroupSelection()) {
    var groupEl = document.getElementById(state.selectedIds[0]).parentElement;
    var data = captureElementState(groupEl.id);
    if (data) svg += serializeElement(data);
  } else {
    for (var i = 0; i < state.selectedIds.length; i++) {
      var data = captureElementState(state.selectedIds[i]);
      if (data) svg += serializeElement(data);
    }
  }

  if (!svg) return;

  var fullSvg = '<svg xmlns="http://www.w3.org/2000/svg">\n';
  fullSvg += '<!-- cut from there -->\n';
  fullSvg += svg;
  fullSvg += '<!-- cut until here -->\n';
  fullSvg += '</svg>\n';

  try {
    var root = await navigator.storage.getDirectory();
    var handle = await root.getFileHandle(CLIPBOARD_FILENAME, { create: true });
    var writable = await handle.createWritable();
    await writable.write(fullSvg);
    await writable.close();
    localStorage.setItem(clipKey(), CLIPBOARD_FILENAME);
  } catch (err) {
    console.error('clipCopy failed:', err);
  }
}

export async function clipPaste() {
  var filename = localStorage.getItem(clipKey());
  if (!filename) return;

  var svgText;
  try {
    var root = await navigator.storage.getDirectory();
    var handle = await root.getFileHandle(filename, { create: false });
    var file = await handle.getFile();
    svgText = await file.text();
  } catch (err) {
    return;
  }

  if (!svgText) return;

  var parser = new DOMParser();
  var doc = parser.parseFromString(svgText, 'image/svg+xml');
  var svgRoot = doc.documentElement;
  var rootEl = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
  rootEl.id = 'clip-root';
  while (svgRoot.children.length > 0) {
    rootEl.appendChild(svgRoot.children[0]);
  }
  svgRoot.appendChild(rootEl);
  if (!rootEl.children.length) return;

  // Compute cursor position in SVG coords
  var mouseSvg = { x: 0, y: 0 };
  if (state._lastClientX != null) {
    mouseSvg = screenToCoords(dom.svg, dom.annotationLayer, state._lastClientX, state._lastClientY);
  }

  // Parse all elements from SVG
  var items = [];
  parseClipElements(rootEl, items, null);

  // Collect group entries (need to attach children after creation)
  var groupItems = [];

  // Separate groups from non-groups, build childId lists
  var flatItems = [];
  for (var ii = 0; ii < items.length; ii++) {
    if (items[ii].type === 'group') {
      groupItems.push(items[ii]);
    } else {
      flatItems.push(items[ii]);
    }
  }

  // Assign child IDs to group entries
  for (var gi = 0; gi < groupItems.length; gi++) {
    var g = groupItems[gi];
    for (var ii = 0; ii < flatItems.length; ii++) {
      if (flatItems[ii].parentId === g.id) {
        g.childIds.push(flatItems[ii].id);
        flatItems[ii]._groupIdx = gi;
      }
    }
  }

  if (flatItems.length === 0) return;

  // Collect all original pasted IDs (flat items + groups)
  var allOriginalIds = [];
  for (var ii = 0; ii < flatItems.length; ii++) allOriginalIds.push(flatItems[ii].id);
  for (var gi = 0; gi < groupItems.length; gi++) allOriginalIds.push(groupItems[gi].id);

  // Check if ANY original ID already exists in the document — if so, suffix ALL
  var needsSuffix = false;
  for (var ci = 0; ci < allOriginalIds.length; ci++) {
    if (document.getElementById(allOriginalIds[ci])) { needsSuffix = true; break; }
  }

  var suffix = '';
  if (needsSuffix) {
    var suffixNum = 0;
    var hasConflict;
    do {
      suffixNum++;
      suffix = '-' + suffixNum;
      hasConflict = false;
      for (var ci = 0; ci < allOriginalIds.length; ci++) {
        if (document.getElementById(allOriginalIds[ci] + suffix)) {
          hasConflict = true;
          break;
        }
      }
    } while (hasConflict);
  }

  // Build idMap and compute combined bbox
  var newIds = [];
  var idMap = {};
  var bbox = null;

  for (var ii = 0; ii < flatItems.length; ii++) {
    var item = flatItems[ii];
    idMap[item.id] = item.id + suffix;
    item._newId = idMap[item.id];
    var eb = getBBoxFromClipData(item);
    if (!bbox) bbox = eb;
    else {
      var x1 = Math.min(bbox.x, eb.x);
      var y1 = Math.min(bbox.y, eb.y);
      var x2 = Math.max(bbox.x + bbox.width, eb.x + eb.width);
      var y2 = Math.max(bbox.y + bbox.height, eb.y + eb.height);
      bbox = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    }
  }

  if (!bbox) return;

  // Offset to cursor
  var cx = bbox.x + bbox.width / 2;
  var cy = bbox.y + bbox.height / 2;
  var dx = mouseSvg.x - cx;
  var dy = mouseSvg.y - cy;

  function offsetCoords(item) {
    if (item.type === 'line') {
      if (item.points) {
        for (var pi = 0; pi < item.points.length; pi++) {
          item.points[pi].x += dx;
          item.points[pi].y += dy;
        }
      }
      item.x1 += dx; item.y1 += dy;
      item.x2 += dx; item.y2 += dy;
    } else if (item.type === 'text') {
      item.x += dx; item.y += dy;
    } else if (item.type === 'rectangle') {
      item.x += dx; item.y += dy;
    } else if (item.type === 'freehand') {
      for (var pi = 0; pi < item.points.length; pi++) {
        item.points[pi].x += dx;
        item.points[pi].y += dy;
      }
    }
  }

  for (var ii = 0; ii < flatItems.length; ii++) {
    offsetCoords(flatItems[ii]);
  }

  // Create all elements and track for history
  var created = [];
  var createdGroupIds = [];

  for (var ii = 0; ii < flatItems.length; ii++) {
    var item = flatItems[ii];
    item.id = item._newId;
    delete item._newId;
    delete item.parentId;

    if (item.type === 'line') addLineElement(item);
    else if (item.type === 'text') addTextElement(item);
    else if (item.type === 'freehand') addFreehandElement(item);
    else if (item.type === 'rectangle') addRectangleElement(item);

    created.push({ id: item.id, type: item.type });
    newIds.push(item.id);
  }

  // Create group wrappers and move children inside
  for (var gi = 0; gi < groupItems.length; gi++) {
    var g = groupItems[gi];
    var newGroupId = g.id + suffix;
    var newChildIds = [];
    for (var ci = 0; ci < g.childIds.length; ci++) {
      var mapped = idMap[g.childIds[ci]];
      if (mapped) newChildIds.push(mapped);
    }
    if (newChildIds.length === 0) continue;

    var gEl = svgEl('g', { id: newGroupId, 'data-type': 'group' });
    for (var ci = 0; ci < newChildIds.length; ci++) {
      var childSvg = dom.annotationLayer.querySelector('#' + CSS.escape(newChildIds[ci]));
      if (childSvg) gEl.appendChild(childSvg);
    }
    dom.annotationLayer.appendChild(gEl);
    created.push({ id: newGroupId, type: 'group' });
    createdGroupIds.push(newGroupId);
    newIds.push(newGroupId);
  }

  if (created.length === 0) return;

  // Select pasted elements — only top-level (direct children of annotationLayer) and group wrappers
  var topSelectIds = [];
  for (var ii = 0; ii < flatItems.length; ii++) {
    var el_ = document.getElementById(flatItems[ii].id);
    if (el_ && el_.parentElement === dom.annotationLayer) {
      topSelectIds.push(flatItems[ii].id);
    }
  }
  for (var gi = 0; gi < createdGroupIds.length; gi++) {
    topSelectIds.push(createdGroupIds[gi]);
  }

  if (topSelectIds.length > 0) {
    selectElement(topSelectIds[topSelectIds.length - 1], false);
    for (var si = 0; si < topSelectIds.length - 1; si++) {
      selectElement(topSelectIds[si], true);
    }
  }

  // Push history
  pushAction({
    description: 'Paste ' + created.length + ' element' + (created.length > 1 ? 's' : ''),
    doFn: function() {},
    undoFn: function() {
      for (var ui = 0; ui < created.length; ui++) {
        var el = dom.annotationLayer.querySelector('#' + CSS.escape(created[ui].id));
        if (el) el.remove();
      }
    },
  });
}
