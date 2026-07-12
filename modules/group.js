import { state, dom } from './editor.js';
import { svgEl, generateId } from './utils.js';
import { pushAction } from './history.js';
import { drawHandles, selectElement } from './select.js';

export function groupSelected() {
  var ids = state.selectedIds.slice();
  if (ids.length < 2) return;

  for (var gi = 0; gi < ids.length; gi++) {
    var existing = state.elements.find(function(el) { return el.id === ids[gi]; });
    if (existing && existing.parentId) return;
  }

  var groupId = 'group-' + generateId();
  var snapshots = [];

  for (var gii = 0; gii < ids.length; gii++) {
    var elData = state.elements.find(function(e) { return e.id === ids[gii]; });
    if (!elData) return;
    elData.parentId = groupId;
    snapshots.push({ id: ids[gii] });
  }

  var groupData = { id: groupId, type: 'group', childIds: ids.slice() };
  state.elements.push(groupData);

  var g = svgEl('g', { id: groupId, 'data-type': 'group' });
  for (var gi2 = 0; gi2 < ids.length; gi2++) {
    var childSvg = dom.annotationLayer.querySelector('#' + CSS.escape(ids[gi2]));
    if (childSvg) g.appendChild(childSvg);
  }
  dom.annotationLayer.appendChild(g);

  state.selectedId = groupId;
  state.selectedIds = ids.slice();
  var primary = state.elements.find(function(el) { return el.id === ids[0]; });
  if (primary) drawHandles(primary);

  var btn = document.getElementById('btn-group');
  if (btn) btn.disabled = true;
  document.getElementById('btn-delete').disabled = false;
  document.dispatchEvent(new CustomEvent('selection-changed', { detail: { id: groupId, data: groupData } }));

  pushAction({
    description: 'Group ' + ids.length + ' elements',
    doFn: function() {
      for (var di = 0; di < ids.length; di++) {
        var de = state.elements.find(function(e) { return e.id === ids[di]; });
        if (de) de.parentId = groupId;
      }
      if (!state.elements.find(function(e) { return e.id === groupId; })) {
        state.elements.push({ id: groupId, type: 'group', childIds: ids.slice() });
      }
      var dg = dom.annotationLayer.querySelector('#' + CSS.escape(groupId));
      if (!dg) {
        dg = svgEl('g', { id: groupId, 'data-type': 'group' });
        dom.annotationLayer.appendChild(dg);
      }
      for (var dj = 0; dj < ids.length; dj++) {
        var ds = dom.annotationLayer.querySelector('#' + CSS.escape(ids[dj]));
        if (ds) dg.appendChild(ds);
      }
    },
    undoFn: function() {
      var dgEl = dom.annotationLayer.querySelector('#' + CSS.escape(groupId));
      if (dgEl) {
        while (dgEl.children.length > 0) {
          dom.annotationLayer.appendChild(dgEl.children[0]);
        }
        dgEl.remove();
      }
      var dgIdx = state.elements.findIndex(function(e) { return e.id === groupId; });
      if (dgIdx !== -1) state.elements.splice(dgIdx, 1);
      for (var ui = 0; ui < ids.length; ui++) {
        var ue = state.elements.find(function(e) { return e.id === ids[ui]; });
        if (ue) ue.parentId = undefined;
      }
    },
  });
}
